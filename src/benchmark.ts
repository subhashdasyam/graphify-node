import { readFile } from "node:fs/promises";
import { Graph } from "./graph.js";
import { scoreNodes } from "./query.js";
import type { NodeLinkGraph } from "./types.js";

const CHARS_PER_TOKEN = 4;
const SAMPLE_QUESTIONS = [
  "how does authentication work",
  "what is the main entry point",
  "how are errors handled",
  "what connects the data layer to the api",
  "what are the core abstractions"
];

export function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / CHARS_PER_TOKEN));
}

export function querySubgraphTokens(graph: Graph, question: string, depth = 3): number {
  const terms = question.split(/\s+/).filter((term) => term.length > 2).map((term) => term.toLowerCase());
  const starts = scoreNodes(graph, terms).slice(0, 3).map(([, id]) => id);
  if (!starts.length) return 0;
  const visited = new Set(starts);
  let frontier = new Set(starts);
  const edges: Array<[string, string]> = [];
  for (let i = 0; i < depth; i += 1) {
    const next = new Set<string>();
    for (const node of frontier) {
      for (const neighbor of graph.neighbors(node)) {
        if (!visited.has(neighbor)) {
          next.add(neighbor);
          edges.push([node, neighbor]);
        }
      }
    }
    for (const node of next) visited.add(node);
    frontier = next;
  }
  const lines: string[] = [];
  for (const id of visited) {
    const node = graph.nodes.get(id);
    lines.push(`NODE ${node?.label ?? id} src=${node?.source_file ?? ""} loc=${node?.source_location ?? ""}`);
  }
  for (const [source, target] of edges) {
    const edge = graph.edgeBetween(source, target);
    lines.push(`EDGE ${graph.nodes.get(source)?.label ?? source} --${edge?.relation ?? ""}--> ${graph.nodes.get(target)?.label ?? target}`);
  }
  return estimateTokens(lines.join("\n"));
}

export async function runBenchmark(graphPath = "graphify-out/graph.json", corpusWords?: number, questions = SAMPLE_QUESTIONS): Promise<Record<string, unknown>> {
  const data = JSON.parse(await readFile(graphPath, "utf8")) as NodeLinkGraph;
  const graph = Graph.fromNodeLink(data);
  const words = corpusWords ?? graph.numberOfNodes() * 50;
  const corpusTokens = Math.floor((words * 100) / 75);
  const perQuestion = questions
    .map((question) => ({ question, query_tokens: querySubgraphTokens(graph, question) }))
    .filter((item) => item.query_tokens > 0)
    .map((item) => ({ ...item, reduction: Math.round((corpusTokens / item.query_tokens) * 10) / 10 }));
  if (!perQuestion.length) return { error: "No matching nodes found for sample questions. Build the graph first." };
  const avgQueryTokens = Math.floor(perQuestion.reduce((sum, item) => sum + item.query_tokens, 0) / perQuestion.length);
  return {
    corpus_tokens: corpusTokens,
    corpus_words: words,
    nodes: graph.numberOfNodes(),
    edges: graph.numberOfEdges(),
    avg_query_tokens: avgQueryTokens,
    reduction_ratio: Math.round((corpusTokens / avgQueryTokens) * 10) / 10,
    per_question: perQuestion
  };
}

export function formatBenchmark(result: Record<string, unknown>): string {
  if ("error" in result) return `Benchmark error: ${String(result.error)}`;
  const per = result.per_question as Array<{ reduction: number; question: string }>;
  return [
    "",
    "graphify token reduction benchmark",
    "--------------------------------------------------",
    `  Corpus:          ${Number(result.corpus_words).toLocaleString()} words -> ~${Number(result.corpus_tokens).toLocaleString()} tokens (naive)`,
    `  Graph:           ${Number(result.nodes).toLocaleString()} nodes, ${Number(result.edges).toLocaleString()} edges`,
    `  Avg query cost:  ~${Number(result.avg_query_tokens).toLocaleString()} tokens`,
    `  Reduction:       ${result.reduction_ratio}x fewer tokens per query`,
    "",
    "  Per question:",
    ...per.map((item) => `    [${item.reduction}x] ${item.question.slice(0, 55)}`),
    ""
  ].join("\n");
}
