import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Extraction } from "./types.js";

const FILE_CHAR_CAP = 20_000;
const PER_FILE_OVERHEAD_CHARS = 80;
const CHARS_PER_TOKEN = 4;

export const BACKENDS = {
  claude: {
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-6",
    envKey: "ANTHROPIC_API_KEY",
    pricing: { input: 3.0, output: 15.0 }
  },
  kimi: {
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2.6",
    envKey: "MOONSHOT_API_KEY",
    pricing: { input: 0.74, output: 4.66 }
  }
} as const;

const EXTRACTION_SYSTEM = `You are a graphify semantic extraction agent. Extract a knowledge graph fragment from the files provided.
Output ONLY valid JSON - no explanation, no markdown fences, no preamble.

Rules:
- EXTRACTED: relationship explicit in source
- INFERRED: reasonable inference
- AMBIGUOUS: uncertain - flag for review

Output schema:
{"nodes":[{"id":"stem_entity","label":"Human Readable Name","file_type":"code|document|paper|image|concept","source_file":"relative/path","source_location":null}],"edges":[{"source":"node_id","target":"node_id","relation":"calls|implements|references|cites|conceptually_related_to|shares_data_with|semantically_similar_to","confidence":"EXTRACTED|INFERRED|AMBIGUOUS","confidence_score":1.0,"source_file":"relative/path","source_location":null,"weight":1.0}],"hyperedges":[],"input_tokens":0,"output_tokens":0}`;

export async function readFilesForPrompt(files: string[], root = "."): Promise<string> {
  const parts: string[] = [];
  for (const file of files) {
    const rel = path.relative(root, file).startsWith("..") ? file : path.relative(root, file);
    const content = await readFile(file, "utf8").catch(() => "");
    if (content) parts.push(`=== ${rel} ===\n${content.slice(0, FILE_CHAR_CAP)}`);
  }
  return parts.join("\n\n");
}

export function parseLlmJson(raw: string): Extraction {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  }
  try {
    return JSON.parse(text) as Extraction;
  } catch {
    return { nodes: [], edges: [], hyperedges: [] };
  }
}

export async function callOpenAICompat(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  userMessage: string;
  temperature?: number | null;
}): Promise<Extraction> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM },
      { role: "user", content: options.userMessage }
    ],
    max_completion_tokens: 8192
  };
  if (options.temperature !== null) body.temperature = options.temperature ?? 0;
  if (options.baseUrl.includes("moonshot")) body.extra_body = { thinking: { type: "disabled" } };
  const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`LLM request failed: HTTP ${response.status} ${await response.text()}`);
  const data = await response.json() as any;
  const result = parseLlmJson(data.choices?.[0]?.message?.content ?? "{}");
  result.input_tokens = data.usage?.prompt_tokens ?? 0;
  result.output_tokens = data.usage?.completion_tokens ?? 0;
  result.model = options.model;
  result.finish_reason = data.choices?.[0]?.finish_reason ?? "stop";
  return result;
}

export async function callClaude(apiKey: string, model: string, userMessage: string): Promise<Extraction> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system: EXTRACTION_SYSTEM,
      messages: [{ role: "user", content: userMessage }]
    })
  });
  if (!response.ok) throw new Error(`Claude request failed: HTTP ${response.status} ${await response.text()}`);
  const data = await response.json() as any;
  const result = parseLlmJson(data.content?.[0]?.text ?? "{}");
  result.input_tokens = data.usage?.input_tokens ?? 0;
  result.output_tokens = data.usage?.output_tokens ?? 0;
  result.model = model;
  result.finish_reason = data.stop_reason === "max_tokens" ? "length" : "stop";
  return result;
}

export async function extractFilesDirect(options: {
  files: string[];
  backend?: keyof typeof BACKENDS;
  apiKey?: string;
  model?: string;
  root?: string;
}): Promise<Extraction> {
  const backend = options.backend ?? "kimi";
  const cfg = BACKENDS[backend];
  const apiKey = options.apiKey ?? process.env[cfg.envKey] ?? "";
  if (!apiKey) throw new Error(`No API key for backend '${backend}'. Set ${cfg.envKey} or pass apiKey.`);
  const userMessage = await readFilesForPrompt(options.files, options.root ?? ".");
  const model = options.model ?? cfg.defaultModel;
  return backend === "claude"
    ? callClaude(apiKey, model, userMessage)
    : callOpenAICompat({ baseUrl: cfg.baseUrl, apiKey, model, userMessage, temperature: backend === "kimi" ? null : 0 });
}

export async function estimateFileTokens(file: string): Promise<number> {
  const st = await import("node:fs/promises").then((fs) => fs.stat(file)).catch(() => null);
  if (!st) return 0;
  return Math.floor((Math.min(st.size, FILE_CHAR_CAP) + PER_FILE_OVERHEAD_CHARS) / CHARS_PER_TOKEN);
}

export async function packChunksByTokens(files: string[], tokenBudget: number): Promise<string[][]> {
  if (tokenBudget <= 0) throw new Error(`tokenBudget must be positive, got ${tokenBudget}`);
  const byDir = new Map<string, string[]>();
  for (const file of files) byDir.set(path.dirname(file), [...(byDir.get(path.dirname(file)) ?? []), file]);
  const chunks: string[][] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const dir of Array.from(byDir.keys()).sort()) {
    for (const file of byDir.get(dir)!.sort()) {
      const estimated = await estimateFileTokens(file);
      if (current.length && tokens + estimated > tokenBudget) {
        chunks.push(current);
        current = [];
        tokens = 0;
      }
      current.push(file);
      tokens += estimated;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function estimateCost(backend: keyof typeof BACKENDS, inputTokens: number, outputTokens: number): number {
  const pricing = BACKENDS[backend].pricing;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export function detectBackend(): keyof typeof BACKENDS | null {
  if (process.env.MOONSHOT_API_KEY) return "kimi";
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  return null;
}
