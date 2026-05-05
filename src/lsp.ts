import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Graph } from "./graph.js";
import type { GraphEdge, GraphNode } from "./types.js";
import { makeId, relativeSource } from "./utils.js";

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface LspCallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  detail?: string;
}

interface LspOutgoingCall {
  to: LspCallHierarchyItem;
  fromRanges: LspRange[];
}

export interface LspServerConfig {
  name: string;
  command: string;
  args: string[];
  languageIds: string[];
}

export interface LspEnrichmentOptions {
  root: string;
  files: string[];
  enabled?: boolean;
  servers?: LspServerConfig[];
  maxSymbols?: number;
  requestTimeoutMs?: number;
}

export interface LspServerResult {
  name: string;
  attempted: boolean;
  callHierarchyProvider: boolean;
  addedEdges: number;
  addedNodes: number;
  skippedReason?: string;
}

export interface LspEnrichmentResult {
  enabled: boolean;
  addedEdges: number;
  addedNodes: number;
  servers: LspServerResult[];
}

interface LspResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const EXTENSION_LANGUAGE_IDS = new Map<string, string>([
  [".ts", "typescript"],
  [".tsx", "typescriptreact"],
  [".js", "javascript"],
  [".jsx", "javascriptreact"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".pyw", "python"],
  [".go", "go"],
  [".rs", "rust"]
]);

const CALLABLE_KINDS = new Set(["function", "method", "constructor", "callback"]);

export async function enrichGraphWithLsp(graph: Graph, options: LspEnrichmentOptions): Promise<LspEnrichmentResult> {
  if (options.enabled === false || process.env.GRAPHIFY_LSP === "0") {
    return { enabled: false, addedEdges: 0, addedNodes: 0, servers: [] };
  }

  const root = path.resolve(options.root);
  const files = options.files.map((file) => path.resolve(file));
  const servers = options.servers ?? await discoverLspServers(root, files);
  const result: LspEnrichmentResult = { enabled: true, addedEdges: 0, addedNodes: 0, servers: [] };

  for (const server of servers) {
    const serverResult = await enrichWithServer(graph, root, files, server, {
      maxSymbols: options.maxSymbols ?? 200,
      requestTimeoutMs: options.requestTimeoutMs ?? 2500
    });
    result.servers.push(serverResult);
    result.addedEdges += serverResult.addedEdges;
    result.addedNodes += serverResult.addedNodes;
  }

  return result;
}

async function enrichWithServer(
  graph: Graph,
  root: string,
  files: string[],
  server: LspServerConfig,
  options: { maxSymbols: number; requestTimeoutMs: number }
): Promise<LspServerResult> {
  const languageFiles = files.filter((file) => server.languageIds.includes(languageIdForFile(file) ?? ""));
  if (!languageFiles.length) {
    return { name: server.name, attempted: false, callHierarchyProvider: false, addedEdges: 0, addedNodes: 0, skippedReason: "no matching files" };
  }

  const connection = new LspConnection(server, options.requestTimeoutMs);
  let addedEdges = 0;
  let addedNodes = 0;
  try {
    const initialize = await connection.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: path.basename(root) || root }],
      capabilities: {
        textDocument: {
          callHierarchy: { dynamicRegistration: false },
          synchronization: { didOpen: true, didClose: true }
        },
        workspace: { workspaceFolders: true }
      }
    }) as { capabilities?: { callHierarchyProvider?: unknown } };

    const hasCallHierarchy = Boolean(initialize.capabilities?.callHierarchyProvider);
    if (!hasCallHierarchy) {
      await connection.dispose();
      return { name: server.name, attempted: true, callHierarchyProvider: false, addedEdges: 0, addedNodes: 0, skippedReason: "callHierarchyProvider unavailable" };
    }

    connection.notify("initialized", {});
    const fileTexts = await readLanguageFiles(root, languageFiles);
    const opened = new Set<string>();
    const seeds = callableNodes(graph, root, languageFiles, options.maxSymbols);

    for (const seed of seeds) {
      const abs = path.resolve(root, seed.source_file);
      const text = fileTexts.get(abs);
      const languageId = languageIdForFile(abs);
      if (!text || !languageId) continue;
      const uri = pathToFileURL(abs).href;
      if (!opened.has(uri)) {
        connection.notify("textDocument/didOpen", {
          textDocument: { uri, languageId, version: 1, text }
        });
        opened.add(uri);
      }

      const position = positionForNode(text, seed);
      if (!position) continue;
      const prepared = await connection.request("textDocument/prepareCallHierarchy", {
        textDocument: { uri },
        position
      }).catch(() => null) as LspCallHierarchyItem[] | null;
      if (!Array.isArray(prepared) || !prepared.length) continue;

      for (const item of prepared.slice(0, 2)) {
        const outgoing = await connection.request("callHierarchy/outgoingCalls", { item }).catch(() => null) as LspOutgoingCall[] | null;
        if (!Array.isArray(outgoing)) continue;
        for (const call of outgoing) {
          const beforeNodes = graph.numberOfNodes();
          const targetId = resolveOrAddLspNode(graph, root, call.to, server.name);
          if (graph.numberOfNodes() > beforeNodes) addedNodes += 1;
          if (!targetId || targetId === seed.id) continue;
          const edge: GraphEdge = {
            source: seed.id,
            target: targetId,
            relation: "calls",
            confidence: "STATIC_RESOLVED",
            confidence_score: 0.85,
            source_file: seed.source_file,
            source_location: seed.source_location ?? null,
            context: "lsp_call_hierarchy",
            evidence_source: "lsp",
            evidence: { source: "lsp", server: server.name },
            weight: 0.85
          };
          const beforeEdges = graph.numberOfEdges();
          graph.addEdge(edge);
          if (graph.numberOfEdges() > beforeEdges) addedEdges += 1;
        }
      }
    }

    for (const uri of opened) connection.notify("textDocument/didClose", { textDocument: { uri } });
    await connection.dispose();
    return { name: server.name, attempted: true, callHierarchyProvider: true, addedEdges, addedNodes };
  } catch (error) {
    await connection.dispose();
    return {
      name: server.name,
      attempted: true,
      callHierarchyProvider: false,
      addedEdges,
      addedNodes,
      skippedReason: error instanceof Error ? error.message : String(error)
    };
  }
}

class LspConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private seq = 1;
  private buffer = Buffer.alloc(0);
  private lastStdout = "";
  private lastStderr = "";
  addedNodes = 0;

  constructor(private readonly server: LspServerConfig, private readonly requestTimeoutMs: number) {
    this.child = spawn(server.command, server.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" && server.command.toLowerCase().endsWith(".cmd")
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.lastStderr = chunk.toString("utf8");
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => {
      if (this.pending.size) this.rejectAll(new Error(`${this.server.name} exited with code ${code ?? "unknown"}`));
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.seq++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.server.name} timed out on ${method}${this.lastStdout ? `; last stdout: ${this.lastStdout.slice(0, 120)}` : ""}${this.lastStderr ? `; last stderr: ${this.lastStderr.slice(0, 120)}` : ""}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(payload);
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async dispose(): Promise<void> {
    try {
      if (!this.child.killed && this.child.exitCode === null) {
        await this.request("shutdown", {}).catch(() => null);
        this.notify("exit", {});
      }
    } finally {
      for (const pending of this.pending.values()) clearTimeout(pending.timer);
      this.pending.clear();
      if (!this.child.killed && this.child.exitCode === null) this.child.kill();
    }
  }

  private write(payload: unknown): void {
    const body = JSON.stringify(payload);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  private onData(chunk: Buffer): void {
    this.lastStdout = chunk.toString("utf8");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + length;
      if (this.buffer.length < messageEnd) return;
      const raw = this.buffer.slice(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.slice(messageEnd);
      this.handleMessage(raw);
    }
  }

  private handleMessage(raw: string): void {
    let message: LspResponse;
    try {
      message = JSON.parse(raw) as LspResponse;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

async function discoverLspServers(root: string, files: string[]): Promise<LspServerConfig[]> {
  const languageIds = new Set(files.map(languageIdForFile).filter((id): id is string => Boolean(id)));
  const servers: LspServerConfig[] = [];
  const customCommand = process.env.GRAPHIFY_LSP_COMMAND;
  if (customCommand) {
    servers.push({
      name: "custom",
      command: customCommand,
      args: (process.env.GRAPHIFY_LSP_ARGS ?? "").split(/\s+/).filter(Boolean),
      languageIds: Array.from(languageIds)
    });
    return servers;
  }

  if (["typescript", "typescriptreact", "javascript", "javascriptreact"].some((id) => languageIds.has(id))) {
    const command = await findExecutable(root, "typescript-language-server");
    if (command) {
      servers.push({
        name: "typescript-language-server",
        command,
        args: ["--stdio"],
        languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"]
      });
    }
  }

  if (languageIds.has("python")) {
    const command = await findExecutable(root, "pyright-langserver");
    if (command) servers.push({ name: "pyright-langserver", command, args: ["--stdio"], languageIds: ["python"] });
  }

  if (languageIds.has("go")) {
    const command = await findExecutable(root, "gopls");
    if (command) servers.push({ name: "gopls", command, args: ["serve"], languageIds: ["go"] });
  }

  if (languageIds.has("rust")) {
    const command = await findExecutable(root, "rust-analyzer");
    if (command) servers.push({ name: "rust-analyzer", command, args: [], languageIds: ["rust"] });
  }

  return servers;
}

async function findExecutable(root: string, name: string): Promise<string | null> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(root, "node_modules", ".bin", name),
    path.join(root, "node_modules", ".bin", `${name}.cmd`),
    path.resolve(moduleDir, "..", "node_modules", ".bin", name),
    path.resolve(moduleDir, "..", "node_modules", ".bin", `${name}.cmd`),
    path.resolve(moduleDir, "..", "..", "node_modules", ".bin", name),
    path.resolve(moduleDir, "..", "..", "node_modules", ".bin", `${name}.cmd`),
    ...pathCandidates(name)
  ];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function pathCandidates(name: string): string[] {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((ext) => ext.toLowerCase())
    : [""];
  const out: string[] = [];
  for (const dir of dirs) {
    for (const ext of extensions) out.push(path.join(dir, `${name}${ext}`));
  }
  return out;
}

async function isExecutable(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

function languageIdForFile(filePath: string): string | null {
  return EXTENSION_LANGUAGE_IDS.get(path.extname(filePath).toLowerCase()) ?? null;
}

async function readLanguageFiles(root: string, files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(files.map(async (file) => {
    const abs = path.resolve(file);
    const rel = relativeSource(root, abs);
    if (!rel.startsWith("..")) out.set(abs, await readFile(abs, "utf8").catch(() => ""));
  }));
  return out;
}

function callableNodes(graph: Graph, root: string, files: string[], maxSymbols: number): GraphNode[] {
  const fileSet = new Set(files.map((file) => relativeSource(root, file)));
  return Array.from(graph.nodes.values())
    .filter((node) => fileSet.has(node.source_file))
    .filter((node) => CALLABLE_KINDS.has(String(node.kind ?? "")))
    .filter((node) => typeof node.source_location === "string" && /^L\d+/.test(node.source_location))
    .slice(0, maxSymbols);
}

function positionForNode(text: string, node: GraphNode): { line: number; character: number } | null {
  const lineNumber = Number(String(node.source_location ?? "").match(/^L(\d+)/)?.[1] ?? 0);
  if (!lineNumber) return null;
  const line = text.split(/\r?\n/)[lineNumber - 1] ?? "";
  const name = symbolName(node);
  const index = name ? line.indexOf(name) : -1;
  return { line: lineNumber - 1, character: index >= 0 ? index : 0 };
}

function symbolName(node: GraphNode): string {
  return String(node.label)
    .replace(/^\./, "")
    .replace(/\(\)$/, "")
    .replace(/^callback@L\d+$/, "")
    .trim();
}

function resolveOrAddLspNode(graph: Graph, root: string, item: LspCallHierarchyItem, server: string): string | null {
  const rel = uriToRelativePath(root, item.uri);
  if (!rel) return null;
  const line = item.selectionRange.start.line + 1;
  const existing = findGraphNode(graph, rel, item.name, line);
  if (existing) return existing.id;

  const id = makeId(fileStemNoExt(rel), item.name);
  graph.addNode({
    id,
    label: `${item.name}()`,
    file_type: "code",
    source_file: rel,
    source_location: `L${line}`,
    kind: "function",
    lsp_symbol: true,
    evidence_source: "lsp",
    evidence: { source: "lsp", server }
  });
  return id;
}

function findGraphNode(graph: Graph, sourceFile: string, name: string, line: number): GraphNode | null {
  const normalized = normalizeSymbol(name);
  const sameFile = Array.from(graph.nodes.values()).filter((node) => node.source_file === sourceFile);
  return sameFile.find((node) => node.source_location === `L${line}` && normalizeSymbol(symbolName(node)) === normalized)
    ?? sameFile.find((node) => normalizeSymbol(symbolName(node)) === normalized)
    ?? null;
}

function normalizeSymbol(value: string): string {
  return value.replace(/^\./, "").replace(/\(\)$/, "").toLowerCase();
}

function uriToRelativePath(root: string, uri: string): string | null {
  try {
    return relativeSource(root, fileURLToPath(uri));
  } catch {
    return null;
  }
}

function fileStemNoExt(filePath: string): string {
  const parsed = path.parse(filePath);
  return parsed.dir ? path.join(parsed.dir, parsed.name).replaceAll(path.sep, "_") : parsed.name;
}
