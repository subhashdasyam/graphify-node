import { readFile } from "node:fs/promises";
import path from "node:path";
import * as ts from "typescript";
import { DOC_EXTENSIONS, IMAGE_EXTENSIONS, PAPER_EXTENSIONS, VIDEO_EXTENSIONS } from "./detect.js";
import { extractTreeSitterSource, hasTreeSitterExtractor } from "./treeSitterExtract.js";
import type { Confidence, Extraction, FileType, GraphEdge, GraphNode, RawCall } from "./types.js";
import { fileStem, lineNumberFromOffset, makeId, relativeSource } from "./utils.js";

interface ExtractContext {
  root: string;
  filePath: string;
  sourceFile: string;
  fileNid: string;
  stem: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  rawCalls: RawCall[];
  seenNodes: Set<string>;
  seenEdges: Set<string>;
}

interface FunctionBody {
  nid: string;
  startLine: number;
  endLine: number;
}

const JS_TS_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx", ".vue", ".svelte"]);
const PY_EXTENSIONS = new Set([".py", ".pyw"]);
const RATIONALE_PREFIXES = ["# NOTE:", "# IMPORTANT:", "# HACK:", "# WHY:", "# RATIONALE:", "# TODO:", "# FIXME:"];
const TREE_SITTER_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

function createContext(filePath: string, root: string, fileType: FileType = "code"): ExtractContext {
  const abs = path.resolve(filePath);
  const sourceFile = relativeSource(root, abs);
  const fileNid = makeId(sourceFile);
  const stem = fileStem(sourceFile);
  const fileNode: GraphNode = {
    id: fileNid,
    label: path.basename(filePath),
    file_type: fileType,
    source_file: sourceFile,
    source_location: "L1"
  };
  return {
    root,
    filePath: abs,
    sourceFile,
    fileNid,
    stem,
    nodes: [fileNode],
    edges: [],
    rawCalls: [],
    seenNodes: new Set([fileNid]),
    seenEdges: new Set()
  };
}

function addNode(ctx: ExtractContext, id: string, label: string, line: number | null, fileType: FileType = "code"): void {
  if (ctx.seenNodes.has(id)) return;
  ctx.seenNodes.add(id);
  ctx.nodes.push({
    id,
    label,
    file_type: fileType,
    source_file: ctx.sourceFile,
    source_location: line ? `L${line}` : null
  });
}

function addEdge(
  ctx: ExtractContext,
  source: string,
  target: string,
  relation: string,
  line: number | null,
  confidence: Confidence = "EXTRACTED",
  context?: string,
  weight = 1
): void {
  const key = `${source}\u0000${target}\u0000${relation}\u0000${context ?? ""}`;
  if (ctx.seenEdges.has(key)) return;
  ctx.seenEdges.add(key);
  const edge: GraphEdge = {
    source,
    target,
    relation,
    confidence,
    source_file: ctx.sourceFile,
    source_location: line ? `L${line}` : null,
    weight
  };
  if (context) edge.context = context;
  if (confidence === "INFERRED") edge.confidence_score = 0.6;
  ctx.edges.push(edge);
}

function finish(ctx: ExtractContext): Extraction {
  return {
    nodes: ctx.nodes,
    edges: ctx.edges.filter((edge) => {
      if (!ctx.seenNodes.has(edge.source)) return false;
      if (ctx.seenNodes.has(edge.target)) return true;
      return edge.relation === "imports" || edge.relation === "imports_from";
    }),
    raw_calls: ctx.rawCalls,
    input_tokens: 0,
    output_tokens: 0
  };
}

function symbolMap(nodes: GraphNode[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const node of nodes) {
    const base = node.label.replace(/^\./, "").replace(/\(\)$/, "").toLowerCase();
    const ids = out.get(base) ?? [];
    ids.push(node.id);
    out.set(base, ids);
  }
  return out;
}

function resolveLocalImport(specifier: string, importer: string, root: string): string {
  if (!specifier.startsWith(".")) return makeId(specifier.split("/").filter(Boolean).at(-1) ?? specifier);
  const base = path.resolve(path.dirname(importer), specifier);
  const ext = path.extname(base);
  const resolved = ext ? base : `${base}.ts`;
  return makeId(relativeSource(root, resolved));
}

function extractPythonSource(filePath: string, source: string, root: string): Extraction {
  const ctx = createContext(filePath, root, "code");
  const lines = source.split(/\r?\n/);
  const functions: FunctionBody[] = [];
  const classStack: Array<{ indent: number; nid: string; name: string }> = [];
  const localSymbols = new Map<string, string>();

  function currentClass(indent: number): { indent: number; nid: string; name: string } | undefined {
    while (classStack.length && indent <= classStack[classStack.length - 1].indent) classStack.pop();
    return classStack[classStack.length - 1];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = lines[index];
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const stripped = line.trim();
    if (!stripped) continue;

    const importMatch = stripped.match(/^import\s+(.+)$/);
    if (importMatch) {
      for (const part of importMatch[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].split(".")[0];
        if (name) addEdge(ctx, ctx.fileNid, makeId(name), "imports", lineNo, "EXTRACTED", "import");
      }
      continue;
    }
    const fromMatch = stripped.match(/^from\s+([.\w]+)\s+import\s+/);
    if (fromMatch) {
      const raw = fromMatch[1].replace(/^\.+/, "");
      addEdge(ctx, ctx.fileNid, makeId(raw), "imports_from", lineNo, "EXTRACTED", "import");
      continue;
    }

    const classMatch = line.match(/^(\s*)class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?:/);
    if (classMatch) {
      currentClass(indent);
      const className = classMatch[2];
      const classNid = makeId(ctx.stem, className);
      addNode(ctx, classNid, className, lineNo);
      addEdge(ctx, ctx.fileNid, classNid, "contains", lineNo);
      localSymbols.set(className.toLowerCase(), classNid);
      const bases = (classMatch[3] ?? "")
        .split(",")
        .map((base) => base.trim().split(/[.(]/)[0])
        .filter(Boolean);
      for (const base of bases) {
        const baseNid = localSymbols.get(base.toLowerCase()) ?? makeId(base);
        if (!ctx.seenNodes.has(baseNid)) addNode(ctx, baseNid, base, lineNo);
        addEdge(ctx, classNid, baseNid, "inherits", lineNo);
      }
      classStack.push({ indent, nid: classNid, name: className });
      continue;
    }

    const funcMatch = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (funcMatch) {
      const owner = currentClass(indent);
      const funcName = funcMatch[2];
      const funcNid = owner ? makeId(owner.nid, funcName) : makeId(ctx.stem, funcName);
      addNode(ctx, funcNid, owner ? `.${funcName}()` : `${funcName}()`, lineNo);
      addEdge(ctx, owner?.nid ?? ctx.fileNid, funcNid, owner ? "method" : "contains", lineNo);
      localSymbols.set(funcName.toLowerCase(), funcNid);
      const nextEnd = findPythonBlockEnd(lines, index + 1, indent);
      functions.push({ nid: funcNid, startLine: lineNo + 1, endLine: nextEnd });
      continue;
    }

    if (RATIONALE_PREFIXES.some((prefix) => stripped.startsWith(prefix))) {
      const rationaleNid = makeId(ctx.stem, "rationale", String(lineNo));
      addNode(ctx, rationaleNid, stripped.slice(0, 80), lineNo, "rationale");
      addEdge(ctx, rationaleNid, ctx.fileNid, "rationale_for", lineNo);
    }
  }

  const byLabel = symbolMap(ctx.nodes);
  for (const body of functions) {
    const bodyText = lines.slice(body.startLine - 1, body.endLine).join("\n");
    for (const call of findCallNames(bodyText)) {
      const ids = byLabel.get(call.toLowerCase()) ?? [];
      if (ids.length === 1 && ids[0] !== body.nid) {
        addEdge(ctx, body.nid, ids[0], "calls", body.startLine, "EXTRACTED", "call");
      } else if (ids.length === 0) {
        ctx.rawCalls.push({
          caller_nid: body.nid,
          callee: call,
          source_file: ctx.sourceFile,
          source_location: `L${body.startLine}`,
          is_member_call: false
        });
      }
    }
  }

  return finish(ctx);
}

function findPythonBlockEnd(lines: string[], startIndex: number, parentIndent: number): number {
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= parentIndent && /^(class|async\s+def|def)\b/.test(line.trim())) return i;
  }
  return lines.length;
}

function findCallNames(source: string): string[] {
  const ignored = new Set([
    "if", "for", "while", "switch", "catch", "return", "yield", "await", "sizeof",
    "typeof", "new", "class", "function", "def", "print", "console", "super"
  ]);
  const calls = new Set<string>();
  for (const match of source.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = match[1];
    if (!ignored.has(name)) calls.add(name);
  }
  return Array.from(calls);
}

function extractTypeScriptSource(filePath: string, source: string, root: string): Extraction {
  const ctx = createContext(filePath, root, "code");
  const kind = filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, kind);
  const bodies: Array<{ nid: string; body: ts.Node }> = [];
  const localSymbols = new Map<string, string>();

  function nodeText(node: ts.Node): string {
    return node.getText(sf);
  }

  function addFunction(name: string, line: number, parentClass?: string): string {
    const nid = parentClass ? makeId(parentClass, name) : makeId(ctx.stem, name);
    addNode(ctx, nid, parentClass ? `.${name}()` : `${name}()`, line);
    addEdge(ctx, parentClass ?? ctx.fileNid, nid, parentClass ? "method" : "contains", line);
    localSymbols.set(name.toLowerCase(), nid);
    return nid;
  }

  function visitDefinitions(node: ts.Node, parentClass?: string): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const raw = node.moduleSpecifier.text;
      const line = lineNumberFromOffset(source, node.getStart(sf));
      const targetId = resolveLocalImport(raw, filePath, root);
      addEdge(ctx, ctx.fileNid, targetId, "imports_from", line, "EXTRACTED", "import");
      if (raw.startsWith(".") && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        const resolvedSource = relativeSource(root, path.resolve(path.dirname(filePath), raw));
        for (const element of node.importClause.namedBindings.elements) {
          addEdge(ctx, ctx.fileNid, makeId(fileStem(resolvedSource), element.name.text), "imports", line, "EXTRACTED", "import");
        }
      }
      return;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      const line = lineNumberFromOffset(source, node.getStart(sf));
      const classNid = makeId(ctx.stem, className);
      addNode(ctx, classNid, className, line);
      addEdge(ctx, ctx.fileNid, classNid, "contains", line);
      localSymbols.set(className.toLowerCase(), classNid);
      for (const clause of node.heritageClauses ?? []) {
        for (const typeNode of clause.types) {
          const base = typeNode.expression.getText(sf).split(".").at(-1) ?? typeNode.expression.getText(sf);
          const baseNid = localSymbols.get(base.toLowerCase()) ?? makeId(base);
          if (!ctx.seenNodes.has(baseNid)) addNode(ctx, baseNid, base, line);
          addEdge(ctx, classNid, baseNid, clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements", line);
        }
      }
      for (const member of node.members) visitDefinitions(member, classNid);
      return;
    }

    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
      const name = propertyNameText(node.name);
      if (name) {
        const line = lineNumberFromOffset(source, node.getStart(sf));
        const nid = addFunction(name, line, parentClass);
        if (node.body) bodies.push({ nid, body: node.body });
      }
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          const line = lineNumberFromOffset(source, decl.getStart(sf));
          const nid = addFunction(decl.name.text, line, parentClass);
          if (decl.initializer.body) bodies.push({ nid, body: decl.initializer.body });
        }
      }
      return;
    }

    ts.forEachChild(node, (child) => visitDefinitions(child, parentClass));
  }

  function walkCalls(node: ts.Node, callerNid: string): void {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const line = lineNumberFromOffset(source, node.getStart(sf));
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const first = node.arguments[0];
        if (first && ts.isStringLiteralLike(first)) {
          addEdge(ctx, callerNid, resolveLocalImport(first.text, filePath, root), "imports_from", line, "EXTRACTED", "import");
        }
      } else {
        const callee = callExpressionName(node.expression);
        if (callee) {
          const localTarget = localSymbols.get(callee.toLowerCase());
          if (localTarget && localTarget !== callerNid) {
            addEdge(ctx, callerNid, localTarget, "calls", line, "EXTRACTED", "call");
          } else if (!localTarget) {
            ctx.rawCalls.push({
              caller_nid: callerNid,
              callee,
              source_file: ctx.sourceFile,
              source_location: `L${line}`,
              is_member_call: ts.isPropertyAccessExpression(node.expression)
            });
          }
        }
      }
    }
    ts.forEachChild(node, (child) => walkCalls(child, callerNid));
  }

  visitDefinitions(sf);
  for (const body of bodies) walkCalls(body.body, body.nid);
  return finish(ctx);
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text.replace(/^#/, "");
  return null;
}

function callExpressionName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression)) return expr.argumentExpression.text;
  return null;
}

function extractGenericCodeSource(filePath: string, source: string, root: string): Extraction {
  const ctx = createContext(filePath, root, "code");
  const lines = source.split(/\r?\n/);
  const bodies: FunctionBody[] = [];
  const localSymbols = new Map<string, string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNo = index + 1;
    const stripped = line.trim();
    if (!stripped) continue;

    const importTarget = extractGenericImport(stripped);
    if (importTarget) addEdge(ctx, ctx.fileNid, makeId(importTarget), "imports", lineNo, "EXTRACTED", "import");

    const className = matchFirst(stripped, [
      /\b(?:class|interface|struct|enum|object|module|trait)\s+([A-Za-z_]\w*)/,
      /\b(?:namespace)\s+([A-Za-z_][\w.]*)/
    ]);
    if (className) {
      const nid = makeId(ctx.stem, className.split(".").at(-1) ?? className);
      addNode(ctx, nid, className, lineNo);
      addEdge(ctx, ctx.fileNid, nid, "contains", lineNo);
      localSymbols.set(className.toLowerCase(), nid);
      continue;
    }

    const funcName = matchFirst(stripped, [
      /\bfunction\s+([A-Za-z_]\w*)\s*\(/,
      /\bfunc\s+([A-Za-z_]\w*)\s*\(/,
      /\bfn\s+([A-Za-z_]\w*)\s*\(/,
      /\bdef\s+([A-Za-z_]\w*)\s*\(/,
      /\bsub\s+([A-Za-z_]\w*)\s*\(/,
      /^\s*(?:public|private|protected|static|async|override|virtual|final|\w+)\s+([A-Za-z_]\w*)\s*\(/
    ]);
    if (funcName && !["if", "for", "while", "switch", "catch"].includes(funcName)) {
      const nid = makeId(ctx.stem, funcName);
      addNode(ctx, nid, `${funcName}()`, lineNo);
      addEdge(ctx, ctx.fileNid, nid, "contains", lineNo);
      localSymbols.set(funcName.toLowerCase(), nid);
      bodies.push({ nid, startLine: lineNo + 1, endLine: Math.min(lines.length, lineNo + 80) });
    }
  }

  const byLabel = symbolMap(ctx.nodes);
  for (const body of bodies) {
    const text = lines.slice(body.startLine - 1, body.endLine).join("\n");
    for (const call of findCallNames(text)) {
      const ids = byLabel.get(call.toLowerCase()) ?? [];
      if (ids.length === 1 && ids[0] !== body.nid) addEdge(ctx, body.nid, ids[0], "calls", body.startLine, "EXTRACTED", "call");
      else if (ids.length === 0) {
        ctx.rawCalls.push({ caller_nid: body.nid, callee: call, source_file: ctx.sourceFile, source_location: `L${body.startLine}` });
      }
    }
  }

  return finish(ctx);
}

function extractGenericImport(stripped: string): string | null {
  return matchFirst(stripped, [
    /^import\s+["']([^"']+)["']/,
    /^import\s+([\w.*/{} ,]+);?$/,
    /^using\s+([\w.]+);?/,
    /^#include\s+[<"]([^>"]+)/,
    /^require\s*\(?["']([^"']+)["']\)?/,
    /^use\s+([\\\w]+);?/,
    /^package\s+([\w.]+);?/
  ]);
}

function matchFirst(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function extractDocumentSource(filePath: string, source: string, root: string): Extraction {
  const ctx = createContext(filePath, root, "document");
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const label = heading[2].trim();
      const nid = makeId(ctx.stem, label);
      addNode(ctx, nid, label, index + 1, "document");
      addEdge(ctx, ctx.fileNid, nid, "contains", index + 1);
    }
  }
  return finish(ctx);
}

function extractFileOnly(filePath: string, root: string, fileType: FileType): Extraction {
  return finish(createContext(filePath, root, fileType));
}

export async function extractFile(filePath: string, options: { root?: string } = {}): Promise<Extraction> {
  const root = path.resolve(options.root ?? process.cwd());
  const abs = path.resolve(filePath);
  const ext = path.extname(abs).toLowerCase();
  if (PAPER_EXTENSIONS.has(ext)) return extractFileOnly(abs, root, "paper");
  if (IMAGE_EXTENSIONS.has(ext)) return extractFileOnly(abs, root, "image");
  if (VIDEO_EXTENSIONS.has(ext)) return extractFileOnly(abs, root, "video");

  let source = "";
  try {
    source = await readFile(abs, "utf8");
  } catch (error) {
    return { nodes: [], edges: [], error: `cannot read ${filePath}: ${String(error)}`, input_tokens: 0, output_tokens: 0 };
  }

  if (DOC_EXTENSIONS.has(ext)) return extractDocumentSource(abs, source, root);
  if (shouldUseTreeSitter(abs)) {
    const treeSitterExtraction = await extractTreeSitterSource(abs, source, root);
    if (treeSitterExtraction && !treeSitterExtraction.error && treeSitterExtraction.nodes.length > 0) {
      return treeSitterExtraction;
    }
  }
  if (PY_EXTENSIONS.has(ext)) return extractPythonSource(abs, source, root);
  if (JS_TS_EXTENSIONS.has(ext)) return extractTypeScriptSource(abs, source, root);
  return extractGenericCodeSource(abs, source, root);
}

function shouldUseTreeSitter(filePath: string): boolean {
  const setting = process.env.GRAPHIFY_TREE_SITTER?.toLowerCase();
  if (setting && TREE_SITTER_DISABLED_VALUES.has(setting)) return false;
  return hasTreeSitterExtractor(filePath);
}

export async function extractFiles(filePaths: string[], options: { root?: string } = {}): Promise<Extraction> {
  const root = path.resolve(options.root ?? process.cwd());
  const parts = await Promise.all(filePaths.map((filePath) => extractFile(filePath, { root })));
  const nodes = parts.flatMap((part) => part.nodes);
  const edges = parts.flatMap((part) => part.edges);
  const rawCalls = parts.flatMap((part) => part.raw_calls ?? []);
  const nameToIds = symbolMap(nodes);
  const seenPairs = new Set(edges.map((edge) => `${edge.source}\u0000${edge.target}\u0000${edge.relation}`));

  for (const rawCall of rawCalls) {
    const ids = nameToIds.get(rawCall.callee.toLowerCase()) ?? [];
    if (ids.length !== 1 || ids[0] === rawCall.caller_nid) continue;
    const key = `${rawCall.caller_nid}\u0000${ids[0]}\u0000calls`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    edges.push({
      source: rawCall.caller_nid,
      target: ids[0],
      relation: "calls",
      confidence: "INFERRED",
      confidence_score: 0.6,
      source_file: rawCall.source_file,
      source_location: rawCall.source_location ?? null,
      context: "call",
      weight: 0.6
    });
    if (rawCall.call_site_nid) {
      const resolveKey = `${rawCall.call_site_nid}\u0000${ids[0]}\u0000resolves_to`;
      if (!seenPairs.has(resolveKey)) {
        seenPairs.add(resolveKey);
        edges.push({
          source: rawCall.call_site_nid,
          target: ids[0],
          relation: "resolves_to",
          confidence: "INFERRED",
          confidence_score: 0.6,
          source_file: rawCall.source_file,
          source_location: rawCall.source_location ?? null,
          context: "call",
          weight: 0.6
        });
      }
    }
  }

  return {
    nodes,
    edges,
    hyperedges: parts.flatMap((part) => part.hyperedges ?? []),
    input_tokens: 0,
    output_tokens: 0
  };
}
