import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isIP } from "node:net";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const MAX_FETCH_BYTES = 52_428_800;
const MAX_TEXT_BYTES = 10_485_760;
const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata.google.com"]);

function isPrivateIp(address: string): boolean {
  if (!isIP(address)) return false;
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address.startsWith("10.")) return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("169.254.")) return true;
  if (address.startsWith("192.168.")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  const lower = address.toLowerCase();
  return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

export async function validateUrl(url: string): Promise<string> {
  const parsed = new URL(url);
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Blocked URL scheme '${parsed.protocol.replace(/:$/, "")}' - only http and https are allowed. Got: ${url}`);
  }
  if (BLOCKED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Blocked cloud metadata endpoint '${parsed.hostname}'. Got: ${url}`);
  }
  const addresses = await lookup(parsed.hostname, { all: true });
  for (const address of addresses) {
    if (isPrivateIp(address.address)) {
      throw new Error(`Blocked private/internal IP ${address.address} (resolved from '${parsed.hostname}'). Got: ${url}`);
    }
  }
  return url;
}

export async function safeFetch(url: string, options: { maxBytes?: number; timeoutMs?: number } = {}): Promise<Uint8Array> {
  await validateUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 graphify/1.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const maxBytes = options.maxBytes ?? MAX_FETCH_BYTES;
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Response from ${url} exceeds size limit (${Math.floor(maxBytes / 1_048_576)} MB). Aborting download.`);
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export async function safeFetchText(url: string, options: { maxBytes?: number; timeoutMs?: number } = {}): Promise<string> {
  const bytes = await safeFetch(url, { maxBytes: options.maxBytes ?? MAX_TEXT_BYTES, timeoutMs: options.timeoutMs ?? 15_000 });
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export async function safeDownload(url: string, outputPath: string, options: { maxBytes?: number; timeoutMs?: number } = {}): Promise<string> {
  const bytes = await safeFetch(url, options);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await pipeline(Readable.from(Buffer.from(bytes)), createWriteStream(outputPath));
  return outputPath;
}

function inferGraphBase(resolvedPath: string): string {
  let current = resolvedPath;
  while (true) {
    if (path.basename(current) === "graphify-out") return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve("graphify-out");
}

function isInsidePath(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function validateGraphPath(graphPath: string, base?: string): Promise<string> {
  const resolved = path.resolve(graphPath);
  const root = base ? path.resolve(base) : inferGraphBase(resolved);
  try {
    await access(root);
  } catch {
    throw new Error(`Graph base directory does not exist: ${root}. Run graphify first to build the graph.`);
  }
  if (!isInsidePath(root, resolved)) throw new Error(`Path ${graphPath} escapes the allowed directory ${root}. Only paths inside graphify-out/ are permitted.`);
  const st = await stat(resolved).catch(() => null);
  if (!st) throw new Error(`Graph file not found: ${resolved}`);
  return resolved;
}

export function sanitizeLabel(text: unknown, maxLength = 256): string {
  const clean = String(text ?? "").replace(/[\x00-\x1f\x7f]/g, "");
  return clean.length > maxLength ? clean.slice(0, maxLength) : clean;
}
