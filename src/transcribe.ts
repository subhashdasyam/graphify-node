import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { validateUrl } from "./security.js";

const execFileAsync = promisify(execFile);
const shellOnWindows = process.platform === "win32";
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".mp3", ".wav", ".m4a", ".ogg"]);
const URL_PREFIXES = ["http://", "https://", "www."];
const TRANSCRIPTS_DIR = "graphify-out/transcripts";
const FALLBACK_PROMPT = "Use proper punctuation and paragraph breaks.";

export function isUrl(value: string): boolean {
  return URL_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function buildWhisperPrompt(godNodes: Array<Record<string, unknown>>): string {
  if (process.env.GRAPHIFY_WHISPER_PROMPT) return process.env.GRAPHIFY_WHISPER_PROMPT;
  const labels = godNodes.slice(0, 10).map((node) => String(node.label ?? "")).filter(Boolean);
  if (!labels.length) return FALLBACK_PROMPT;
  return `Technical discussion about ${labels.slice(0, 5).join(", ")}. Use proper punctuation and paragraph breaks.`;
}

async function requireCommand(name: string, installHint: string): Promise<void> {
  try {
    await execFileAsync(name, ["--version"], { shell: shellOnWindows });
  } catch {
    throw new Error(`${name} is required. ${installHint}`);
  }
}

export async function downloadAudio(url: string, outputDir: string): Promise<string> {
  await validateUrl(url);
  await requireCommand("yt-dlp", "Install yt-dlp to download YouTube/URL audio.");
  await mkdir(outputDir, { recursive: true });
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 12);
  for (const ext of [".m4a", ".opus", ".mp3", ".ogg", ".wav", ".webm"]) {
    const candidate = path.join(outputDir, `yt_${hash}${ext}`);
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  const template = path.join(outputDir, `yt_${hash}.%(ext)s`);
  await execFileAsync("yt-dlp", ["-f", "bestaudio[ext=m4a]/bestaudio/best", "-o", template, "--no-playlist", "--quiet", "--no-warnings", url], { shell: shellOnWindows });
  for (const ext of [".m4a", ".opus", ".mp3", ".ogg", ".wav", ".webm"]) {
    const candidate = path.join(outputDir, `yt_${hash}${ext}`);
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return path.join(outputDir, `yt_${hash}.m4a`);
}

export async function transcribe(
  videoPath: string,
  options: { outputDir?: string; initialPrompt?: string; force?: boolean } = {}
): Promise<string> {
  const outputDir = options.outputDir ?? TRANSCRIPTS_DIR;
  await mkdir(outputDir, { recursive: true });
  const audioPath = isUrl(videoPath) ? await downloadAudio(videoPath, path.join(outputDir, "downloads")) : videoPath;
  const transcriptPath = path.join(outputDir, `${path.parse(audioPath).name}.txt`);
  if (!options.force && await access(transcriptPath).then(() => true, () => false)) return transcriptPath;

  const prompt = options.initialPrompt ?? FALLBACK_PROMPT;
  try {
    await requireCommand("whisper-ctranslate2", "Install whisper-ctranslate2 or create transcript files manually.");
    const { stdout } = await execFileAsync("whisper-ctranslate2", [audioPath, "--model", process.env.GRAPHIFY_WHISPER_MODEL ?? "base", "--print_colors", "False", "--initial_prompt", prompt], { maxBuffer: 50_000_000, shell: shellOnWindows });
    await writeFile(transcriptPath, stdout, "utf8");
  } catch (firstError) {
    try {
      await requireCommand("whisper", "Install OpenAI whisper or whisper-ctranslate2.");
      await execFileAsync("whisper", [audioPath, "--model", process.env.GRAPHIFY_WHISPER_MODEL ?? "base", "--output_dir", outputDir, "--output_format", "txt", "--initial_prompt", prompt], { maxBuffer: 50_000_000, shell: shellOnWindows });
    } catch {
      throw firstError;
    }
  }
  return transcriptPath;
}

export async function transcribeAll(videoFiles: string[], options: { outputDir?: string; initialPrompt?: string } = {}): Promise<string[]> {
  const out: string[] = [];
  for (const file of videoFiles) {
    try {
      out.push(await transcribe(file, options));
    } catch (error) {
      console.warn(`warning: could not transcribe ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out;
}
