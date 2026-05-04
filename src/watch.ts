import { readdir, stat, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { CODE_EXTENSIONS, DOC_EXTENSIONS, IMAGE_EXTENSIONS, PAPER_EXTENSIONS } from "./detect.js";
import { runBuild } from "./pipeline.js";

const GRAPHIFY_OUT = process.env.GRAPHIFY_OUT ?? "graphify-out";
const WATCHED_EXTENSIONS = new Set([...CODE_EXTENSIONS, ...DOC_EXTENSIONS, ...PAPER_EXTENSIONS, ...IMAGE_EXTENSIONS]);

export function hasNonCode(paths: string[]): boolean {
  return paths.some((p) => !CODE_EXTENSIONS.has(path.extname(p).toLowerCase()));
}

export async function notifyOnly(root: string): Promise<void> {
  const flag = path.join(root, GRAPHIFY_OUT, "needs_update");
  await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(flag), { recursive: true }));
  await writeFile(flag, "1", "utf8");
  console.log(`[graphify watch] Non-code files changed - semantic re-extraction requires LLM.`);
  console.log(`[graphify watch] Flag written to ${flag}`);
}

export async function checkUpdate(root: string): Promise<boolean> {
  const flag = path.join(root, GRAPHIFY_OUT, "needs_update");
  if (await stat(flag).then(() => true, () => false)) {
    console.log(`[graphify check-update] Pending non-code changes in ${root}.`);
    console.log("[graphify check-update] Run graphify update to apply deterministic extraction, or semantic extraction for docs.");
  }
  return true;
}

async function snapshot(root: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === GRAPHIFY_OUT) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (WATCHED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const st = await stat(abs).catch(() => null);
        if (st) out.set(abs, st.mtimeMs);
      }
    }
  }
  await walk(root);
  return out;
}

export async function rebuildCode(root: string, options: { noViz?: boolean } = {}): Promise<boolean> {
  try {
    const result = await runBuild({ root, noViz: options.noViz });
    const flag = path.join(root, GRAPHIFY_OUT, "needs_update");
    await rm(flag, { force: true }).catch(() => undefined);
    console.log(`[graphify watch] Rebuilt: ${result.nodes} nodes, ${result.edges} edges, ${result.communities} communities`);
    return true;
  } catch (error) {
    console.error(`[graphify watch] Rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function watch(root = ".", options: { debounceMs?: number; pollMs?: number } = {}): Promise<void> {
  const resolved = path.resolve(root);
  let previous = await snapshot(resolved);
  let timer: NodeJS.Timeout | null = null;
  const debounceMs = options.debounceMs ?? 3000;
  console.log(`[graphify watch] Watching ${resolved} - press Ctrl+C to stop`);
  setInterval(async () => {
    const next = await snapshot(resolved);
    const changed: string[] = [];
    for (const [file, mtime] of next) if (previous.get(file) !== mtime) changed.push(file);
    for (const file of previous.keys()) if (!next.has(file)) changed.push(file);
    previous = next;
    if (!changed.length) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (hasNonCode(changed)) await notifyOnly(resolved);
      else await rebuildCode(resolved);
    }, debounceMs);
  }, options.pollMs ?? 1000);
}
