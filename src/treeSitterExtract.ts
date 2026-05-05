import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node as TsNode } from "web-tree-sitter";
import type { Confidence, EvidenceSource, Extraction, FileType, GraphEdge, GraphNode, RawCall } from "./types.js";
import { fileStem, makeId, relativeSource } from "./utils.js";

interface TreeSitterLanguageConfig {
  name: string;
  wasmFile?: string;
  extensions: string[];
  methodIdIncludesOwner?: boolean;
}

interface ExtractContext {
  config: TreeSitterLanguageConfig;
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
  symbols: Map<string, string[]>;
  pendingCalls: Array<{ caller: string; callee: string; line: number; isMemberCall: boolean; callSiteNid: string }>;
  pendingInherits: Array<{ source: string; target: string; line: number }>;
}

interface WalkState {
  ownerNid: string;
  ownerName?: string;
  functionNid?: string;
  classNid?: string;
  className?: string;
}

const SUPPORTED_LANGUAGES: TreeSitterLanguageConfig[] = [
  { name: "python", wasmFile: "python.wasm", extensions: [".py", ".pyw"], methodIdIncludesOwner: true },
  { name: "javascript", wasmFile: "javascript.wasm", extensions: [".js", ".jsx", ".mjs"] },
  { name: "typescript", wasmFile: "typescript.wasm", extensions: [".ts"] },
  { name: "tsx", wasmFile: "tsx.wasm", extensions: [".tsx"] },
  { name: "go", wasmFile: "go.wasm", extensions: [".go"] },
  { name: "rust", wasmFile: "rust.wasm", extensions: [".rs"] },
  { name: "java", wasmFile: "java.wasm", extensions: [".java"] },
  { name: "c", wasmFile: "c.wasm", extensions: [".c", ".h"] },
  { name: "cpp", wasmFile: "cpp.wasm", extensions: [".cpp", ".cc", ".cxx", ".hpp"] },
  { name: "ruby", wasmFile: "ruby.wasm", extensions: [".rb"] },
  { name: "c_sharp", wasmFile: "c_sharp.wasm", extensions: [".cs"] },
  { name: "kotlin", extensions: [".kt", ".kts"] },
  { name: "scala", wasmFile: "scala.wasm", extensions: [".scala"] },
  { name: "php", wasmFile: "php.wasm", extensions: [".php"] },
  { name: "swift", extensions: [".swift"] },
  { name: "lua", extensions: [".lua", ".toc"] },
  { name: "zig", extensions: [".zig"] },
  { name: "elixir", wasmFile: "elixir.wasm", extensions: [".ex", ".exs"] },
  { name: "objc", wasmFile: "objc.wasm", extensions: [".m", ".mm"] },
  { name: "julia", wasmFile: "julia.wasm", extensions: [".jl"] },
  { name: "fortran", extensions: [".f", ".F", ".f90", ".F90", ".f95", ".F95", ".f03", ".F03", ".f08", ".F08"] },
  { name: "vue", extensions: [".vue"] },
  { name: "svelte", extensions: [".svelte"] },
  { name: "dart", wasmFile: "dart.wasm", extensions: [".dart"] },
  { name: "verilog", extensions: [".v", ".sv"] },
  { name: "sql", extensions: [".sql"] }
];

const CONFIG_BY_EXTENSION = new Map<string, TreeSitterLanguageConfig>(
  SUPPORTED_LANGUAGES.flatMap((config) => config.extensions.map((ext) => [ext.toLowerCase(), config] as const))
);

const CLASS_TYPES = new Set([
  "class_definition", "class_declaration", "class", "class_specifier", "class_item", "class_definition",
  "interface_declaration", "interface_definition", "trait_definition", "trait_declaration", "trait_item",
  "struct_declaration", "struct_specifier", "struct_item", "struct_definition", "union_specifier",
  "enum_declaration", "enum_specifier", "enum_item", "enum_definition",
  "module_definition", "module_declaration", "object_definition", "namespace_definition",
  "protocol_declaration", "actor_declaration", "extension_declaration", "impl_item", "abstract_definition",
  "type_declaration", "type_spec"
]);

const FUNCTION_TYPES = new Set([
  "function_definition", "function_declaration", "function_item", "method_declaration", "method_definition",
  "constructor_declaration", "destructor_declaration", "function", "singleton_method", "arrow_function",
  "function_expression", "function_declarator", "subroutine", "subroutine_definition",
  "procedure_declaration", "method", "macro_definition"
]);

const IMPORT_TYPES = new Set([
  "import_statement", "import_from_statement", "import_declaration", "import_directive", "namespace_use_declaration",
  "using_directive", "use_declaration", "use_statement", "preproc_include", "preproc_import", "include",
  "require", "require_relative", "export_statement", "using_statement"
]);

const CALL_TYPES = new Set([
  "call", "call_expression", "method_invocation", "invocation_expression", "function_call", "function_call_expression",
  "scoped_call_expression", "member_call_expression", "message_expression", "object_creation_expression",
  "new_expression", "macro_invocation", "command", "call_suffix"
]);

const VARIABLE_TYPES = new Set([
  "variable_declaration", "local_variable_declaration", "lexical_declaration", "variable_declarator",
  "init_declarator", "field_declaration", "property_declaration", "let_declaration", "const_declaration",
  "short_var_declaration", "var_declaration", "val_definition", "var_definition", "assignment",
  "assignment_expression", "declaration", "parameter_declaration"
]);

const PARAMETER_TYPES = new Set([
  "parameter", "formal_parameter", "required_parameter", "optional_parameter", "typed_parameter",
  "simple_parameter", "parameter_declaration"
]);

const DECORATOR_TYPES = new Set([
  "decorator", "annotation", "marker_annotation", "attribute", "attribute_item", "mod_attribute",
  "attribute_specifier", "meta"
]);

const CONTROL_TYPES = new Set([
  "if_statement", "unless_statement", "for_statement", "for_in_statement", "enhanced_for_statement",
  "while_statement", "do_statement", "switch_statement", "case_statement", "match_statement", "try_statement",
  "catch_clause", "except_clause", "with_statement", "foreach_statement", "guard_statement", "defer_statement"
]);

const BODY_TYPES = new Set([
  "block", "class_body", "declaration_list", "compound_statement", "body", "do_block"
]);

const IDENTIFIER_TYPES = new Set([
  "identifier", "type_identifier", "field_identifier", "constant", "simple_identifier", "property_identifier",
  "name", "namespace_name", "module_name", "scoped_identifier", "qualified_name", "dotted_name"
]);

const LITERAL_TYPES = new Set([
  "string", "string_literal", "interpreted_string_literal", "raw_string_literal", "template_string",
  "integer", "integer_literal", "number", "number_literal", "float", "float_literal", "real_literal",
  "true", "false", "null", "nil", "none", "boolean_literal", "character_literal", "char_literal",
  "array", "array_literal", "list", "list_literal", "dictionary", "dictionary_literal", "hash",
  "map_literal", "object", "object_literal", "set", "set_literal"
]);

let initialized: Promise<void> | null = null;
const languageCache = new Map<string, Promise<Language | null>>();

export function hasTreeSitterExtractor(filePath: string): boolean {
  const ext = treeSitterExtension(filePath);
  const config = CONFIG_BY_EXTENSION.get(ext);
  return Boolean(config?.wasmFile);
}

export function treeSitterSupportedExtensions(): string[] {
  return SUPPORTED_LANGUAGES.flatMap((config) => config.extensions);
}

export async function extractTreeSitterSource(filePath: string, source: string, root: string): Promise<Extraction | null> {
  const ext = treeSitterExtension(filePath);
  const config = CONFIG_BY_EXTENSION.get(ext);
  if (!config?.wasmFile) return null;

  const language = await loadLanguage(config);
  if (!language) return null;

  const parser = new Parser();
  let tree;
  try {
    parser.setLanguage(language);
    tree = parser.parse(source);
    if (!tree) return null;
    const ctx = createContext(filePath, root, config);
    walkNode(ctx, tree.rootNode, { ownerNid: ctx.fileNid });
    resolvePending(ctx);
    return finish(ctx);
  } catch (error) {
    return {
      nodes: [],
      edges: [],
      raw_calls: [],
      input_tokens: 0,
      output_tokens: 0,
      error: `tree-sitter ${config.name} failed: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    tree?.delete();
    parser.delete();
  }
}

function treeSitterExtension(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".blade.php")) return ".php";
  return path.extname(filePath);
}

async function ensureInitialized(): Promise<void> {
  initialized ??= Parser.init();
  await initialized;
}

async function loadLanguage(config: TreeSitterLanguageConfig): Promise<Language | null> {
  if (!config.wasmFile) return null;
  const cached = languageCache.get(config.name);
  if (cached) return cached;
  const promise = (async () => {
    await ensureInitialized();
    const wasmPath = await findWasm(config.wasmFile!);
    if (!wasmPath) return null;
    return Language.load(wasmPath);
  })().catch(() => null);
  languageCache.set(config.name, promise);
  return promise;
}

async function findWasm(wasmFile: string): Promise<string | null> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const envDir = process.env.GRAPHIFY_TREE_SITTER_WASM_DIR;
  const candidates = [
    envDir ? path.resolve(envDir, wasmFile) : "",
    path.resolve(process.cwd(), "vendor", "tree-sitter", wasmFile),
    path.resolve(moduleDir, "..", "vendor", "tree-sitter", wasmFile),
    path.resolve(moduleDir, "..", "..", "vendor", "tree-sitter", wasmFile),
    path.resolve(moduleDir, "..", "..", "..", "vendor", "tree-sitter", wasmFile)
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return null;
}

function createContext(filePath: string, root: string, config: TreeSitterLanguageConfig): ExtractContext {
  const abs = path.resolve(filePath);
  const sourceFile = relativeSource(root, abs);
  const fileNid = makeId(sourceFile);
  const stem = fileStem(sourceFile);
  const fileNode: GraphNode = {
    id: fileNid,
    label: path.basename(filePath),
    file_type: "code",
    source_file: sourceFile,
    source_location: "L1",
    kind: "file",
    parser: "tree-sitter",
    language: config.name
  };
  return {
    config,
    root,
    filePath: abs,
    sourceFile,
    fileNid,
    stem,
    nodes: [fileNode],
    edges: [],
    rawCalls: [],
    seenNodes: new Set([fileNid]),
    seenEdges: new Set(),
    symbols: new Map(),
    pendingCalls: [],
    pendingInherits: []
  };
}

function addNode(
  ctx: ExtractContext,
  id: string,
  label: string,
  line: number | null,
  fileType: FileType = "code",
  attributes: Record<string, unknown> = {}
): void {
  if (ctx.seenNodes.has(id)) return;
  ctx.seenNodes.add(id);
  ctx.nodes.push({
    id,
    label,
    file_type: fileType,
    source_file: fileType === "dependency" ? "" : ctx.sourceFile,
    source_location: fileType === "dependency" ? null : line ? `L${line}` : null,
    ...attributes
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
  weight = 1,
  evidenceSource: EvidenceSource = "ast"
): void {
  const key = `${source}\u0000${target}\u0000${relation}\u0000${context ?? ""}\u0000${line ?? ""}\u0000${confidence}\u0000${evidenceSource}`;
  if (ctx.seenEdges.has(key)) return;
  ctx.seenEdges.add(key);
  const edge: GraphEdge = {
    source,
    target,
    relation,
    confidence,
    source_file: ctx.sourceFile,
    source_location: line ? `L${line}` : null,
    weight,
    evidence_source: evidenceSource,
    evidence: { source: evidenceSource, extractor: "tree-sitter" }
  };
  if (context) edge.context = context;
  if (confidence === "STATIC_RESOLVED") edge.confidence_score = 0.8;
  else if (confidence === "INFERRED") edge.confidence_score = 0.6;
  else if (confidence === "AMBIGUOUS") edge.confidence_score = 0.2;
  ctx.edges.push(edge);
}

function addCallSite(ctx: ExtractContext, ownerNid: string, callee: string, lineNo: number, isMemberCall: boolean, startIndex: number): string {
  const nid = makeId(ownerNid, "call_site", callee, String(lineNo), String(startIndex));
  addNode(ctx, nid, `${callee}()`, lineNo, "code", {
    kind: "call_site",
    callee,
    is_member_call: isMemberCall,
    parser: "tree-sitter",
    evidence_source: "ast",
    evidence: { source: "ast", extractor: "tree-sitter" }
  });
  addEdge(ctx, ownerNid, nid, "contains", lineNo, "EXTRACTED", "call_site");
  return nid;
}

function addUnresolvedCall(ctx: ExtractContext, callSiteNid: string, callee: string, lineNo: number, isMemberCall: boolean): void {
  const nid = makeId("unresolved", "call", callee);
  addNode(ctx, nid, callee, lineNo, "code", {
    kind: "unresolved_call",
    callee,
    unresolved: true,
    is_member_call: isMemberCall,
    parser: "tree-sitter",
    evidence_source: "ast",
    evidence: { source: "ast", extractor: "tree-sitter" }
  });
  addEdge(ctx, callSiteNid, nid, "unresolved_call", lineNo, "AMBIGUOUS", "call_site", 0.2);
}

function addResolvedCall(ctx: ExtractContext, callerNid: string, callSiteNid: string, targetNid: string, lineNo: number): void {
  addEdge(ctx, callerNid, targetNid, "calls", lineNo, "STATIC_RESOLVED", "call", 0.8);
  addEdge(ctx, callSiteNid, targetNid, "resolves_to", lineNo, "STATIC_RESOLVED", "call", 0.8);
}

function addSymbol(ctx: ExtractContext, name: string, nid: string): void {
  const key = normalizeSymbolName(name);
  if (!key) return;
  const ids = ctx.symbols.get(key) ?? [];
  if (!ids.includes(nid)) ids.push(nid);
  ctx.symbols.set(key, ids);
}

function normalizeSymbolName(name: string): string {
  return name.replace(/^[@.$]+/, "").replace(/\(\)$/, "").trim().toLowerCase();
}

function line(node: TsNode): number {
  return node.startPosition.row + 1;
}

function compactText(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function literalKind(type: string): string {
  if (type.includes("string") || type.includes("char")) return "string";
  if (type.includes("integer") || type.includes("number") || type.includes("float") || type.includes("real")) return "number";
  if (type === "true" || type === "false" || type.includes("boolean")) return "boolean";
  if (type === "null" || type === "nil" || type === "none") return "null";
  if (type.includes("array") || type.includes("list")) return "array";
  if (type.includes("dictionary") || type.includes("hash") || type.includes("map") || type.includes("object")) return "object";
  if (type.includes("set")) return "set";
  return type;
}

function addLiteral(ctx: ExtractContext, ownerNid: string, node: TsNode): void {
  const nid = makeId(ownerNid, "literal", String(line(node)), String(node.startIndex));
  addNode(ctx, nid, compactText(node.text, 80), line(node), "code", {
    kind: "literal",
    literal_kind: literalKind(node.type),
    syntax_kind: node.type,
    source_text: compactText(node.text),
    parser: "tree-sitter",
    evidence_source: "ast",
    evidence: { source: "ast", extractor: "tree-sitter" }
  });
  addEdge(ctx, ownerNid, nid, "contains", line(node), "EXTRACTED", "literal");
}

function walkNode(ctx: ExtractContext, node: TsNode, state: WalkState): void {
  if (!node.isNamed || node.isMissing) return;
  if (IMPORT_TYPES.has(node.type)) {
    addImports(ctx, node, state);
  }

  if (CLASS_TYPES.has(node.type)) {
    const name = declarationName(node) ?? fallbackNamedIdentifier(node);
    if (name) {
      const classNid = makeId(ctx.stem, name);
      addNode(ctx, classNid, name, line(node), "code", { kind: classKind(node.type), syntax_kind: node.type, parser: "tree-sitter" });
      addEdge(ctx, state.ownerNid, classNid, "contains", line(node), "EXTRACTED", "structure");
      addSymbol(ctx, name, classNid);
      addDecorators(ctx, node, classNid);
      collectInherits(ctx, node, classNid);
      for (const child of node.namedChildren) {
        walkNode(ctx, child, { ownerNid: classNid, ownerName: name, classNid, className: name });
      }
      return;
    }
  }

  if (FUNCTION_TYPES.has(node.type)) {
    const name = declarationName(node) ?? fallbackNamedIdentifier(node);
    if (name && !isOnlyDeclarator(node)) {
      const isMethod = Boolean(state.classNid) || node.type.includes("method") || node.type.includes("constructor");
      const idParts = isMethod && ctx.config.methodIdIncludesOwner && state.className
        ? [ctx.stem, state.className, name]
        : [ctx.stem, name];
      const fnNid = makeId(...idParts);
      const label = isMethod && !name.startsWith(".") ? `.${name}()` : `${name}()`;
      addNode(ctx, fnNid, label, line(node), "code", {
        kind: node.type.includes("constructor") ? "constructor" : isMethod ? "method" : "function",
        syntax_kind: node.type,
        parser: "tree-sitter"
      });
      addEdge(ctx, state.ownerNid, fnNid, isMethod ? "method" : "contains", line(node), "EXTRACTED", "structure");
      addSymbol(ctx, name, fnNid);
      addDecorators(ctx, node, fnNid);
      addParameters(ctx, node, fnNid);
      for (const child of node.namedChildren) {
        walkNode(ctx, child, { ...state, ownerNid: fnNid, ownerName: name, functionNid: fnNid });
      }
      return;
    }
  }

  if (PARAMETER_TYPES.has(node.type) && state.functionNid) {
    for (const name of declaredNames(node).slice(0, 1)) {
      addVariableLike(ctx, state.functionNid, name, line(node), "parameter", "parameter");
    }
  } else if (VARIABLE_TYPES.has(node.type)) {
    const owner = state.functionNid ?? state.classNid ?? ctx.fileNid;
    const relation = state.classNid && !state.functionNid ? "field" : "declares";
    for (const name of declaredNames(node)) {
      if (!name || name === state.ownerName || name === state.className) continue;
      addVariableLike(ctx, owner, name, line(node), relation, relation === "field" ? "field" : "variable", relation === "field" ? ctx.fileNid : owner);
    }
  }

  if (CONTROL_TYPES.has(node.type)) {
    const owner = state.functionNid ?? state.ownerNid;
    const relation = controlRelation(node.type);
    const nid = makeId(owner, node.type, String(line(node)), String(node.startIndex));
    addNode(ctx, nid, controlLabel(node.type), line(node), "code", { kind: "control_flow", syntax_kind: node.type, parser: "tree-sitter" });
    addEdge(ctx, owner, nid, relation, line(node), "EXTRACTED", "control_flow");
  }

  if (LITERAL_TYPES.has(node.type)) {
    addLiteral(ctx, state.functionNid ?? state.classNid ?? state.ownerNid, node);
  }

  if (CALL_TYPES.has(node.type) && state.functionNid) {
    const callee = callName(node);
    if (callee) {
      const isMember = isMemberCall(node);
      const callSiteNid = addCallSite(ctx, state.functionNid, callee, line(node), isMember, node.startIndex);
      ctx.pendingCalls.push({
        caller: state.functionNid,
        callee,
        line: line(node),
        isMemberCall: isMember,
        callSiteNid
      });
    }
  }

  for (const child of node.namedChildren) {
    walkNode(ctx, child, state);
  }
}

function classKind(type: string): string {
  if (type.includes("interface") || type.includes("protocol") || type.includes("trait")) return "interface";
  if (type.includes("enum")) return "enum";
  if (type.includes("struct")) return "struct";
  if (type.includes("module") || type.includes("namespace") || type.includes("object")) return "module";
  return "class";
}

function isOnlyDeclarator(node: TsNode): boolean {
  return node.type === "function_declarator" && node.parent?.type === "function_definition";
}

function declarationName(node: TsNode): string | null {
  for (const field of ["name", "declarator", "pattern", "identifier"]) {
    const child = node.childForFieldName(field);
    const name = nameFromNode(child);
    if (name) return name;
  }
  return null;
}

function fallbackNamedIdentifier(node: TsNode): string | null {
  for (const child of node.namedChildren) {
    const name = nameFromNode(child);
    if (name) return name;
  }
  return null;
}

function nameFromNode(node: TsNode | null, depth = 0): string | null {
  if (!node || depth > 5) return null;
  if (IDENTIFIER_TYPES.has(node.type)) return cleanIdentifier(node.text);
  for (const field of ["name", "declarator", "pattern", "field", "property", "attribute"]) {
    const named = nameFromNode(node.childForFieldName(field), depth + 1);
    if (named) return named;
  }
  for (const child of node.namedChildren) {
    const named = nameFromNode(child, depth + 1);
    if (named) return named;
  }
  return null;
}

function cleanIdentifier(text: string): string {
  return text.replace(/^[:@$]+/, "").replace(/[(){}[\];,].*$/s, "").trim();
}

function declaredNames(node: TsNode): string[] {
  const names = new Set<string>();
  const direct = declarationName(node);
  if (direct) names.add(direct);

  function visit(current: TsNode, depth: number): void {
    if (depth > 5) return;
    for (let i = 0; i < current.namedChildCount; i += 1) {
      const child = current.namedChild(i);
      if (!child) continue;
      const field = current.fieldNameForNamedChild(i);
      if (["name", "pattern", "left"].includes(field ?? "")) {
        const name = nameFromNode(child);
        if (name) names.add(name);
      }
      if (["declarator", "declarators", "left", "parameter", "parameters"].includes(field ?? "") || VARIABLE_TYPES.has(child.type) || PARAMETER_TYPES.has(child.type)) {
        visit(child, depth + 1);
      }
    }
  }

  visit(node, 0);
  return Array.from(names).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && !reservedWords.has(name));
}

function addVariableLike(ctx: ExtractContext, ownerNid: string, name: string, lineNo: number, relation: string, kind: string, idOwner = ownerNid): void {
  const nid = makeId(idOwner, name);
  addNode(ctx, nid, name, lineNo, "code", { kind, parser: "tree-sitter" });
  addEdge(ctx, ownerNid, nid, relation, lineNo, "EXTRACTED", kind);
  addSymbol(ctx, name, nid);
}

function addDecorators(ctx: ExtractContext, node: TsNode, targetNid: string): void {
  const root = node.parent?.type === "decorated_definition" ? node.parent : node;
  const decorators: TsNode[] = [];

  function visit(current: TsNode, depth: number): void {
    if (depth > 4 || BODY_TYPES.has(current.type)) return;
    if (DECORATOR_TYPES.has(current.type)) decorators.push(current);
    for (const child of current.namedChildren) visit(child, depth + 1);
  }

  visit(root, 0);
  decorators.forEach((decorator, index) => {
    const raw = decorator.text.split(/\r?\n/)[0].trim();
    const label = raw.startsWith("@") || raw.startsWith("#[") ? raw : `@${raw}`;
    const nid = makeId(targetNid, "decorator", label, String(line(decorator)), String(index));
    addNode(ctx, nid, label, line(decorator), "code", { kind: "decorator", syntax_kind: decorator.type, parser: "tree-sitter" });
    addEdge(ctx, targetNid, nid, "decorated_by", line(decorator), "EXTRACTED", "decorator");
  });
}

function addParameters(ctx: ExtractContext, node: TsNode, ownerNid: string): void {
  const paramsNode = node.childForFieldName("parameters") ?? node.childForFieldName("parameter");
  if (!paramsNode) return;
  const seen = new Set<string>();
  for (const param of paramsNode.namedChildren) {
    if (!PARAMETER_TYPES.has(param.type) && !IDENTIFIER_TYPES.has(param.type)) continue;
    const name = nameFromNode(param);
    if (!name || seen.has(name) || name === "self" || name === "cls" || reservedWords.has(name)) continue;
    seen.add(name);
    addVariableLike(ctx, ownerNid, name, line(param), "parameter", "parameter");
  }
}

function collectInherits(ctx: ExtractContext, node: TsNode, source: string): void {
  const fields = ["superclass", "interfaces", "super_interfaces", "base", "type", "protocols", "supertype"];
  for (const field of fields) {
    for (const child of node.childrenForFieldName(field)) {
      for (const target of typeNames(child)) {
        if (target && target !== declarationName(node)) ctx.pendingInherits.push({ source, target, line: line(child) });
      }
    }
  }
  const text = node.text.slice(0, Math.min(node.text.length, 500));
  for (const match of text.matchAll(/\b(?:extends|implements|is|<:)\s+([A-Za-z_][\w.]+)/g)) {
    ctx.pendingInherits.push({ source, target: match[1], line: line(node) });
  }
}

function typeNames(node: TsNode): string[] {
  const names = new Set<string>();
  function visit(current: TsNode, depth: number): void {
    if (depth > 4) return;
    if (IDENTIFIER_TYPES.has(current.type)) names.add(cleanIdentifier(current.text));
    for (const child of current.namedChildren) visit(child, depth + 1);
  }
  visit(node, 0);
  return Array.from(names).filter(Boolean);
}

function addImports(ctx: ExtractContext, node: TsNode, state: WalkState): void {
  const targets = extractImportTargets(node);
  for (const target of targets) {
    const depId = addDependencyNode(ctx, target, line(node));
    const source = state.functionNid ?? ctx.fileNid;
    addEdge(ctx, source, depId, node.type.includes("from") ? "imports_from" : "imports", line(node), "EXTRACTED", importContext(node.type));
  }
}

function extractImportTargets(node: TsNode): string[] {
  const text = node.text.trim();
  const out = new Set<string>();
  for (const match of text.matchAll(/["'<]([^"'>\n]+)["'>]/g)) out.add(match[1]);

  if (node.type === "import_from_statement") {
    const match = text.match(/^from\s+([.\w]+)/);
    if (match) out.add(match[1].replace(/^\.+/, ""));
  } else if (node.type === "import_statement") {
    const match = text.match(/^import\s+(.+)/);
    if (match) {
      for (const part of match[1].split(",")) out.add(part.trim().split(/\s+as\s+/i)[0]);
    }
  } else if (node.type === "using_directive") {
    const match = text.match(/^using\s+([^=;]+)/);
    if (match) out.add(match[1].trim());
  } else if (node.type === "use_declaration" || node.type === "use_statement") {
    const match = text.match(/^use\s+([^;]+)/);
    if (match) out.add(match[1].replace(/[{}]/g, "").split(/[,:\s]+/)[0]);
  } else if (node.type === "namespace_use_declaration") {
    const match = text.match(/^use\s+([^;]+)/);
    if (match) out.add(match[1].trim());
  } else if (node.type === "import_declaration" || node.type === "import_directive") {
    const match = text.match(/^import\s+(?:static\s+)?([^;]+)/);
    if (match) out.add(match[1].replace(/\.\*$/, "").trim());
  } else if (node.type === "preproc_include" || node.type === "preproc_import") {
    const match = text.match(/[<"]([^>"]+)[>"]/);
    if (match) out.add(match[1]);
  }

  return Array.from(out).map((target) => target.trim()).filter((target) => target && target !== "*");
}

function callName(node: TsNode): string | null {
  for (const field of ["name", "function", "method", "command", "constructor"]) {
    const child = node.childForFieldName(field);
    const name = nameFromCallTarget(child);
    if (name) return name;
  }
  return nameFromCallTarget(node.firstNamedChild);
}

function nameFromCallTarget(node: TsNode | null, depth = 0): string | null {
  if (!node || depth > 5) return null;
  if (IDENTIFIER_TYPES.has(node.type)) return cleanIdentifier(node.text.split(".").pop() ?? node.text);
  for (const field of ["name", "property", "field", "attribute", "function", "method"]) {
    const name = nameFromCallTarget(node.childForFieldName(field), depth + 1);
    if (name) return name;
  }
  for (let i = node.namedChildren.length - 1; i >= 0; i -= 1) {
    const name = nameFromCallTarget(node.namedChildren[i], depth + 1);
    if (name) return name;
  }
  return null;
}

function isMemberCall(node: TsNode): boolean {
  return /[.>:]\s*[A-Za-z_$][\w$]*\s*\(/.test(node.text) || node.type.includes("member") || node.type.includes("method_invocation");
}

function resolvePending(ctx: ExtractContext): void {
  for (const inherit of ctx.pendingInherits) {
    const ids = ctx.symbols.get(normalizeSymbolName(inherit.target)) ?? [];
    const target = ids.length === 1 ? ids[0] : addExternalTypeNode(ctx, inherit.target);
    if (target !== inherit.source) addEdge(ctx, inherit.source, target, "inherits", inherit.line, "EXTRACTED", "inheritance");
  }

  for (const call of ctx.pendingCalls) {
    const ids = ctx.symbols.get(normalizeSymbolName(call.callee)) ?? [];
    if (ids.length === 1 && ids[0] !== call.caller) {
      addResolvedCall(ctx, call.caller, call.callSiteNid, ids[0], call.line);
    } else {
      addUnresolvedCall(ctx, call.callSiteNid, call.callee, call.line, call.isMemberCall);
      ctx.rawCalls.push({
        caller_nid: call.caller,
        callee: call.callee,
        source_file: ctx.sourceFile,
        source_location: `L${call.line}`,
        is_member_call: call.isMemberCall,
        call_site_nid: call.callSiteNid
      });
    }
  }
}

function addExternalTypeNode(ctx: ExtractContext, name: string): string {
  const id = makeId("dep", name);
  addNode(ctx, id, name, null, "dependency", {
    external: true,
    kind: "external_type",
    package: dependencyPackage(name),
    module: name
  });
  return id;
}

function addDependencyNode(ctx: ExtractContext, specifier: string, lineNo: number): string {
  const id = makeId("dep", specifier);
  addNode(ctx, id, specifier, null, "dependency", {
    external: true,
    kind: "dependency",
    package: dependencyPackage(specifier),
    module: specifier
  });
  addSymbol(ctx, specifier.split(/[/.\\]/).pop() ?? specifier, id);
  return id;
}

function dependencyPackage(specifier: string): string {
  if (specifier.startsWith("node:")) return "node";
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split(/[/.\\]/)[0] || specifier;
}

function importContext(type: string): string {
  if (type.includes("include")) return "include";
  if (type.includes("use") || type.includes("using")) return "use";
  return "import";
}

function controlRelation(type: string): string {
  if (type.includes("if") || type.includes("switch") || type.includes("case") || type.includes("match") || type.includes("unless")) return "branches";
  if (type.includes("for") || type.includes("while") || type.includes("foreach") || type.includes("do_statement")) return "loops";
  if (type.includes("try") || type.includes("catch") || type.includes("except")) return "handles";
  return "control_flow";
}

function controlLabel(type: string): string {
  return type.replace(/_statement$|_clause$/g, "").replace(/_/g, " ");
}

function finish(ctx: ExtractContext): Extraction {
  return {
    nodes: ctx.nodes,
    edges: ctx.edges.filter((edge) => ctx.seenNodes.has(edge.source) && ctx.seenNodes.has(edge.target)),
    raw_calls: ctx.rawCalls,
    input_tokens: 0,
    output_tokens: 0
  };
}

const reservedWords = new Set([
  "if", "else", "for", "while", "switch", "case", "return", "class", "interface", "struct", "enum",
  "function", "def", "var", "let", "const", "public", "private", "protected", "static", "final", "void",
  "int", "string", "boolean", "true", "false", "null", "none", "nil", "self", "this", "super", "new"
]);
