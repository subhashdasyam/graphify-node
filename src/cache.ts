import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Extraction, GraphEdge, GraphNode, Hyperedge } from "./types.js";

const GRAPHIFY_OUT = process.env.GRAPHIFY_OUT ?? "graphify-out";

export function bodyContent(content: Uint8Array): Uint8Array {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(content);
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) return new TextEncoder().encode(text.slice(end + 4));
  }
  return content;
}

export async function fileHash(filePath: string, root = "."): Promise<string> {
  const abs = path.resolve(filePath);
  const st = await stat(abs);
  if (!st.isFile()) throw new Error(`fileHash requires a file, got: ${abs}`);
  const raw = await readFile(abs);
  const content = path.extname(abs).toLowerCase() === ".md" ? bodyContent(raw) : raw;
  const hash = createHash("sha256");
  hash.update(content);
  hash.update(Buffer.from([0]));
  const resolvedRoot = path.resolve(root);
  let rel = path.relative(resolvedRoot, abs);
  if (rel.startsWith("..")) rel = abs;
  hash.update(rel);
  return hash.digest("hex");
}

export async function cacheDir(root = ".", kind = "ast"): Promise<string> {
  const out = path.isAbsolute(GRAPHIFY_OUT) ? GRAPHIFY_OUT : path.resolve(root, GRAPHIFY_OUT);
  const dir = path.join(out, "cache", kind);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function loadCached(filePath: string, root = ".", kind = "ast"): Promise<Extraction | null> {
  try {
    const hash = await fileHash(filePath, root);
    const entry = path.join(await cacheDir(root, kind), `${hash}.json`);
    try {
      return JSON.parse(await readFile(entry, "utf8")) as Extraction;
    } catch {
      if (kind === "ast") {
        const legacy = path.join(path.resolve(root), GRAPHIFY_OUT, "cache", `${hash}.json`);
        return JSON.parse(await readFile(legacy, "utf8")) as Extraction;
      }
      return null;
    }
  } catch {
    return null;
  }
}

export async function saveCached(filePath: string, result: Extraction, root = ".", kind = "ast"): Promise<void> {
  const st = await stat(filePath).catch(() => null);
  if (!st?.isFile()) return;
  const hash = await fileHash(filePath, root);
  const dir = await cacheDir(root, kind);
  const tmp = path.join(dir, `${hash}.${process.pid}.${Date.now()}.tmp`);
  const entry = path.join(dir, `${hash}.json`);
  await writeFile(tmp, JSON.stringify(result), "utf8");
  await rename(tmp, entry);
}

export async function cachedFiles(root = "."): Promise<Set<string>> {
  const hashes = new Set<string>();
  const base = path.join(path.resolve(root), GRAPHIFY_OUT, "cache");
  for (const dir of [base, path.join(base, "ast"), path.join(base, "semantic")]) {
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(dir).catch(() => []);
    for (const name of entries) if (name.endsWith(".json")) hashes.add(path.basename(name, ".json"));
  }
  return hashes;
}

export async function clearCache(root = "."): Promise<void> {
  const base = path.join(path.resolve(root), GRAPHIFY_OUT, "cache");
  for (const dir of [base, path.join(base, "ast"), path.join(base, "semantic")]) {
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(dir).catch(() => []);
    await Promise.all(entries.filter((name) => name.endsWith(".json")).map((name) => rm(path.join(dir, name), { force: true })));
  }
}

export async function checkSemanticCache(files: string[], root = "."): Promise<[GraphNode[], GraphEdge[], Hyperedge[], string[]]> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const hyperedges: Hyperedge[] = [];
  const uncached: string[] = [];
  for (const file of files) {
    const cached = await loadCached(file, root, "semantic");
    if (cached) {
      nodes.push(...(cached.nodes ?? []));
      edges.push(...(cached.edges ?? []));
      hyperedges.push(...(cached.hyperedges ?? []));
    } else {
      uncached.push(file);
    }
  }
  return [nodes, edges, hyperedges, uncached];
}

export async function saveSemanticCache(nodes: GraphNode[], edges: GraphEdge[], hyperedges: Hyperedge[] = [], root = "."): Promise<number> {
  const byFile = new Map<string, Extraction>();
  const ensure = (source: string): Extraction => {
    const item = byFile.get(source) ?? { nodes: [], edges: [], hyperedges: [] };
    byFile.set(source, item);
    return item;
  };
  for (const node of nodes) if (node.source_file) ensure(node.source_file).nodes.push(node);
  for (const edge of edges) if (edge.source_file) ensure(edge.source_file).edges.push(edge);
  for (const hyperedge of hyperedges) {
    const source = String(hyperedge.source_file ?? "");
    if (source) ensure(source).hyperedges!.push(hyperedge);
  }
  let saved = 0;
  for (const [source, result] of byFile) {
    const filePath = path.isAbsolute(source) ? source : path.join(root, source);
    const st = await stat(filePath).catch(() => null);
    if (st?.isFile()) {
      await saveCached(filePath, result, root, "semantic");
      saved += 1;
    }
  }
  return saved;
}
