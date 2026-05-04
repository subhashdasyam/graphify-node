import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DetectionResult, FileType } from "./types.js";
import { countWords, relativeSource } from "./utils.js";
import { md5File } from "./utils.js";

type DetectedFileType = keyof DetectionResult["files"];

export const CODE_EXTENSIONS = new Set([
  ".py", ".ts", ".js", ".jsx", ".tsx", ".mjs", ".ejs", ".go", ".rs", ".java",
  ".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".rb", ".swift", ".kt", ".kts",
  ".cs", ".scala", ".php", ".lua", ".toc", ".zig", ".ps1", ".ex", ".exs",
  ".m", ".mm", ".jl", ".vue", ".svelte", ".dart", ".v", ".sv", ".sql", ".r"
]);

export const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".html", ".yaml", ".yml"]);
export const PAPER_EXTENSIONS = new Set([".pdf"]);
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
export const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx"]);
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".mp3", ".wav", ".m4a", ".ogg"]);

const skipDirs = new Set([
  "venv", ".venv", "env", ".env", "node_modules", "__pycache__", ".git",
  "dist", "build", "target", "out", "site-packages", "lib64",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".eggs", "graphify-out"
]);

const skipFiles = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock",
  "Gemfile.lock", "composer.lock", "go.sum", "go.work.sum"
]);

const sensitivePatterns = [
  /(^|[\\/])\.(env|envrc)(\.|$)/i,
  /\.(pem|key|p12|pfx|cert|crt|der|p8)$/i,
  /(credential|secret|passwd|password|token|private_key)/i,
  /(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/,
  /(\.netrc|\.pgpass|\.htpasswd)$/i
];

const paperSignals = [
  /\barxiv\b/i,
  /\bdoi\s*:/i,
  /\babstract\b/i,
  /\bproceedings\b/i,
  /\bjournal\b/i,
  /\bpreprint\b/i,
  /\\cite\{/,
  /\[\d+\]/,
  /\d{4}\.\d{4,5}/,
  /\bwe propose\b/i,
  /\bliterature\b/i
];
const assetDirMarkers = [".imageset", ".xcassets", ".appiconset", ".colorset", ".launchimage"];

interface IgnoreRule {
  pattern: string;
  negated: boolean;
}

function isNoiseDir(name: string): boolean {
  return skipDirs.has(name) || name.endsWith("_venv") || name.endsWith("_env") || name.endsWith(".egg-info");
}

function isSensitive(filePath: string): boolean {
  return sensitivePatterns.some((pattern) => pattern.test(filePath));
}

function classifyByExtension(filePath: string, previewText?: string): DetectedFileType | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".blade.php")) return "code";
  const ext = path.extname(lower);
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (PAPER_EXTENSIONS.has(ext)) {
    if (lower.split(/[\\/]/).some((part) => assetDirMarkers.some((marker) => part.endsWith(marker)))) return null;
    return "paper";
  }
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (OFFICE_EXTENSIONS.has(ext)) return "document";
  if (DOC_EXTENSIONS.has(ext)) {
    const hits = previewText ? paperSignals.filter((pattern) => pattern.test(previewText)).length : 0;
    return hits >= 3 ? "paper" : "document";
  }
  return null;
}

export async function classifyFile(filePath: string): Promise<DetectedFileType | null> {
  let preview = "";
  if (DOC_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    preview = await readFile(filePath, "utf8").then((text) => text.slice(0, 3000), () => "");
  }
  return classifyByExtension(filePath, preview);
}

function parseIgnoreLine(raw: string): IgnoreRule | null {
  let line = raw.replace(/\r?\n$/, "").trimStart();
  if (!line || line.startsWith("#")) return null;
  line = line.replace(/\s+#+[^\\].*$/, "").replaceAll("\\#", "#").replace(/(?<!\\) +$/, "");
  if (!line) return null;
  const negated = line.startsWith("!");
  return { pattern: (negated ? line.slice(1) : line).replace(/^\/+|\/+$/g, ""), negated };
}

async function loadGraphifyIgnore(root: string): Promise<IgnoreRule[]> {
  const dirs: string[] = [];
  const ceiling = await findVcsRoot(root) ?? root;
  let current = path.resolve(root);
  while (true) {
    dirs.push(current);
    if (current === ceiling) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  dirs.reverse();
  const rules: IgnoreRule[] = [];
  for (const dir of dirs) {
    const text = await readFile(path.join(dir, ".graphifyignore"), "utf8").catch(() => "");
    rules.push(...text.split(/\r?\n/).map(parseIgnoreLine).filter((rule): rule is IgnoreRule => Boolean(rule)));
  }
  return rules;
}

async function findVcsRoot(start: string): Promise<string | null> {
  let current = path.resolve(start);
  const home = osHome();
  while (true) {
    for (const marker of [".git", ".hg", ".svn", "_darcs", ".fossil"]) {
      if (await stat(path.join(current, marker)).then(() => true, () => false)) return current;
    }
    const parent = path.dirname(current);
    if (parent === current || current === home) return null;
    current = parent;
  }
}

function osHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`(^|/)${escaped}($|/)`);
}

function isIgnored(relPath: string, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    const pattern = rule.pattern;
    if (!pattern) continue;
    const matcher = globToRegExp(pattern);
    const name = path.posix.basename(relPath);
    if (matcher.test(relPath) || matcher.test(name)) ignored = !rule.negated;
  }
  return ignored;
}

async function countFileWords(filePath: string, fileType: DetectedFileType): Promise<number> {
  if (fileType === "image" || fileType === "video" || fileType === "paper") return 0;
  try {
    return countWords(await readFile(filePath, "utf8"));
  } catch {
    return 0;
  }
}

export async function detect(rootPath = ".", options: { followSymlinks?: boolean } = {}): Promise<DetectionResult> {
  const root = path.resolve(rootPath);
  const rules = await loadGraphifyIgnore(root);
  const files: DetectionResult["files"] = { code: [], document: [], paper: [], image: [], video: [] };
  const skippedSensitive: string[] = [];
  let totalWords = 0;
  const seenDirs = new Set<string>();

  async function walk(dir: string): Promise<void> {
    const realDir = await realpath(dir).catch(() => path.resolve(dir));
    if (seenDirs.has(realDir)) return;
    seenDirs.add(realDir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relativeSource(root, abs);
      if (entry.name.startsWith(".") && entry.name !== ".graphifyignore") continue;
      if (isIgnored(rel, rules)) continue;

      if (entry.isSymbolicLink() && options.followSymlinks) {
        const st = await stat(abs).catch(() => null);
        if (st?.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!st?.isFile()) continue;
      } else if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (isNoiseDir(entry.name)) continue;
        await walk(abs);
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (skipFiles.has(entry.name)) continue;
      if (isSensitive(abs)) {
        skippedSensitive.push(rel);
        continue;
      }

      let preview = "";
      if (DOC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        try {
          preview = (await readFile(abs, "utf8")).slice(0, 3000);
        } catch {
          preview = "";
        }
      }

      const fileType = classifyByExtension(abs, preview);
      if (!fileType) {
        if (!path.extname(entry.name)) {
          try {
            const first = (await readFile(abs, "utf8")).slice(0, 128);
            if (/^#!.*\b(python|node|ruby|bash|sh|zsh|fish|lua|php|julia)\b/.test(first)) {
              files.code.push(abs);
            }
          } catch {
            // ignore unreadable extensionless files
          }
        }
        continue;
      }
      files[fileType].push(abs);
      totalWords += await countFileWords(abs, fileType);
    }
  }

  const rootStat = await stat(root);
  if (rootStat.isFile()) {
    const preview = await readFile(root, "utf8").catch(() => "");
    const fileType = classifyByExtension(root, preview.slice(0, 3000));
    if (fileType) {
      files[fileType].push(root);
      totalWords += await countFileWords(root, fileType);
    }
  } else {
    await walk(root);
  }

  const totalFiles = Object.values(files).reduce((sum, values) => sum + values.length, 0);
  const warning =
    totalWords < 50_000
      ? `Corpus is ~${totalWords.toLocaleString()} words - fits in a single context window. You may not need a graph.`
      : totalWords >= 500_000 || totalFiles >= 200
        ? `Large corpus: ${totalFiles} files · ~${totalWords.toLocaleString()} words. Semantic extraction may be expensive.`
        : null;

  return {
    files,
    total_files: totalFiles,
    total_words: totalWords,
    needs_graph: totalWords >= 50_000,
    warning,
    skipped_sensitive: skippedSensitive,
    graphifyignore_patterns: rules.length
  };
}

export function collectCodeFiles(detection: DetectionResult): string[] {
  return detection.files.code;
}

export async function loadManifest(manifestPath = path.join("graphify-out", "manifest.json")): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function saveManifest(files: DetectionResult["files"], manifestPath = path.join("graphify-out", "manifest.json")): Promise<void> {
  const manifest: Record<string, { mtime: number; hash: string }> = {};
  for (const fileList of Object.values(files)) {
    for (const file of fileList) {
      const st = await stat(file).catch(() => null);
      if (!st) continue;
      manifest[file] = { mtime: st.mtimeMs, hash: await md5File(file) };
    }
  }
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function emptyFiles(): DetectionResult["files"] {
  return { code: [], document: [], paper: [], image: [], video: [] };
}

export async function detectIncremental(root: string, manifestPath = path.join("graphify-out", "manifest.json")): Promise<DetectionResult> {
  const full = await detect(root);
  const manifest = await loadManifest(manifestPath);
  const newFiles = emptyFiles();
  const unchangedFiles = emptyFiles();

  if (!Object.keys(manifest).length) {
    return {
      ...full,
      incremental: true,
      new_files: full.files,
      unchanged_files: unchangedFiles,
      new_total: full.total_files,
      deleted_files: []
    };
  }

  for (const [ftype, fileList] of Object.entries(full.files) as Array<[keyof DetectionResult["files"], string[]]>) {
    for (const file of fileList) {
      const stored = manifest[file];
      const st = await stat(file).catch(() => null);
      const currentMtime = st?.mtimeMs ?? 0;
      let changed = true;
      if (typeof stored === "number") {
        changed = currentMtime > stored;
      } else if (stored && typeof stored === "object") {
        const entry = stored as { mtime?: unknown; hash?: unknown };
        if (typeof entry.mtime === "number" && currentMtime === entry.mtime) changed = false;
        else changed = await md5File(file) !== String(entry.hash ?? "");
      }
      (changed ? newFiles : unchangedFiles)[ftype].push(file);
    }
  }

  const currentFiles = new Set(Object.values(full.files).flat());
  const deletedFiles = Object.keys(manifest).filter((file) => !currentFiles.has(file));
  return {
    ...full,
    incremental: true,
    new_files: newFiles,
    unchanged_files: unchangedFiles,
    new_total: Object.values(newFiles).reduce((sum, list) => sum + list.length, 0),
    deleted_files: deletedFiles
  };
}
