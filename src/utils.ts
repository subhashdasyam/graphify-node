import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export function makeId(...parts: Array<string | undefined | null>): string {
  const combined = parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.trim().replace(/^[_ .]+|[_ .]+$/g, ""))
    .filter(Boolean)
    .join("_");
  return combined.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

export function normalizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

export function stripDiacritics(text: string): string {
  return text.normalize("NFKD").replace(/\p{Diacritic}/gu, "");
}

export function sanitizeLabel(text: unknown, maxLength = 256): string {
  const clean = String(text ?? "").replace(/[\x00-\x1f\x7f]/g, "");
  return clean.length > maxLength ? clean.slice(0, maxLength) : clean;
}

export function fileStem(filePath: string): string {
  const parsed = path.parse(filePath);
  const parent = path.basename(parsed.dir);
  return parent && parent !== "." ? `${parent}.${parsed.name}` : parsed.name;
}

export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").split(path.sep).join("/");
}

export function relativeSource(root: string, filePath: string): string {
  const rel = path.relative(root, filePath);
  return toPosixPath(rel && !rel.startsWith("..") ? rel : filePath);
}

export function lineNumberFromOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function md5File(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash("md5").update(buf).digest("hex");
}

export function countWords(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

export function escapeHtml(text: unknown): string {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeCommunityName(label: string): string {
  const cleaned = label
    .replace(/[\\/*?:"<>|#^[\]]/g, "")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\.(md|mdx|markdown)$/i, "")
    .trim();
  return cleaned || "unnamed";
}

export function parseFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function parseOption(args: string[], name: string, fallback?: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
