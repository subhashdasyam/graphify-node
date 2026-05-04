import type { Graph } from "./graph.js";
import { Graph as GraphClass } from "./graph.js";
import { sanitizeLabel, stripDiacritics } from "./utils.js";

const EXACT_MATCH_BONUS = 100;

const CONTEXT_HINTS: Array<[string, string[]]> = [
  ["call", ["call", "calls", "called", "invoke", "invokes", "invoked"]],
  ["import", ["import", "imports", "imported", "module", "modules"]],
  ["field", ["field", "fields", "member", "members", "property", "properties"]],
  ["parameter_type", ["parameter", "parameters", "param", "params", "argument", "arguments"]],
  ["return_type", ["return", "returns", "returned"]],
  ["generic_arg", ["generic", "generics", "template", "templates"]]
];

export function scoreNodes(graph: Graph, terms: string[]): Array<[number, string]> {
  const normTerms = terms.map((term) => stripDiacritics(term).toLowerCase());
  const scored: Array<[number, string]> = [];
  for (const [id, node] of graph.nodes) {
    const normLabel = String(node.norm_label ?? stripDiacritics(String(node.label ?? "")).toLowerCase());
    const source = String(node.source_file ?? "").toLowerCase();
    let score = 0;
    for (const term of normTerms) {
      if (normLabel.includes(term)) score += 1;
      if (source.includes(term)) score += 0.5;
      if (term === normLabel || term === normLabel.replace(/\(\)$/, "")) score += EXACT_MATCH_BONUS;
    }
    if (score > 0) scored.push([score, id]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
}

function normalizeContextFilters(filters: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const filter of filters ?? []) {
    const key = stripDiacritics(filter).trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function inferContextFilters(question: string): string[] {
  const tokens = new Set(question.replace(/[?,]/g, " ").split(/\s+/).map((token) => stripDiacritics(token).toLowerCase()));
  const inferred: string[] = [];
  for (const [context, hints] of CONTEXT_HINTS) {
    if (hints.some((hint) => tokens.has(hint))) inferred.push(context);
  }
  return inferred;
}

function resolveContextFilters(question: string, explicit?: string[]): [string[], string | null] {
  const normalized = normalizeContextFilters(explicit);
  if (normalized.length) return [normalized, "explicit"];
  const inferred = inferContextFilters(question);
  return inferred.length ? [inferred, "heuristic"] : [[], null];
}

function filterGraphByContext(graph: Graph, filters: string[]): Graph {
  if (!filters.length) return graph;
  const keep = new Set(filters);
  const sub = new GraphClass(graph.directed);
  for (const node of graph.nodes.values()) sub.addNode({ ...node });
  for (const edge of graph.edges()) {
    if (edge.context && keep.has(edge.context)) sub.addEdge({ ...edge });
  }
  return sub;
}

function bfs(graph: Graph, starts: string[], depth: number): [Set<string>, Array<[string, string]>] {
  const visited = new Set(starts);
  let frontier = new Set(starts);
  const edges: Array<[string, string]> = [];
  for (let level = 0; level < depth; level += 1) {
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
  return [visited, edges];
}

function dfs(graph: Graph, starts: string[], depth: number): [Set<string>, Array<[string, string]>] {
  const visited = new Set<string>();
  const edges: Array<[string, string]> = [];
  const stack = starts.slice().reverse().map((node): [string, number] => [node, 0]);
  while (stack.length) {
    const [node, level] = stack.pop()!;
    if (visited.has(node) || level > depth) continue;
    visited.add(node);
    for (const neighbor of graph.neighbors(node).sort().reverse()) {
      if (!visited.has(neighbor)) {
        stack.push([neighbor, level + 1]);
        edges.push([node, neighbor]);
      }
    }
  }
  return [visited, edges];
}

function subgraphToText(graph: Graph, nodes: Set<string>, edges: Array<[string, string]>, tokenBudget: number, seeds: string[]): string {
  const charBudget = tokenBudget * 3;
  const seedSet = new Set(seeds);
  const ordered = [
    ...seeds.filter((node) => nodes.has(node)),
    ...Array.from(nodes).filter((node) => !seedSet.has(node)).sort((a, b) => graph.degree(b) - graph.degree(a))
  ];
  const lines: string[] = [];
  for (const id of ordered) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    lines.push(`NODE ${sanitizeLabel(node.label)} [src=${node.source_file ?? ""} loc=${node.source_location ?? ""} community=${node.community ?? ""}]`);
  }
  for (const [source, target] of edges) {
    if (!nodes.has(source) || !nodes.has(target)) continue;
    const edge = graph.edgeBetween(source, target);
    if (!edge) continue;
    const contextSuffix = edge.context ? ` context=${edge.context}` : "";
    lines.push(
      `EDGE ${sanitizeLabel(graph.nodes.get(source)?.label ?? source)} --${edge.relation} [${edge.confidence}${contextSuffix}]--> ${sanitizeLabel(graph.nodes.get(target)?.label ?? target)}`
    );
  }
  const output = lines.join("\n");
  return output.length > charBudget ? `${output.slice(0, charBudget)}\n... (truncated to ~${tokenBudget} token budget)` : output;
}

export function queryGraphText(
  graph: Graph,
  question: string,
  options: { mode?: "bfs" | "dfs"; depth?: number; tokenBudget?: number; contextFilters?: string[] } = {}
): string {
  const terms = question.split(/\s+/).map((term) => term.toLowerCase()).filter((term) => term.length > 2);
  const starts = scoreNodes(graph, terms).slice(0, 3).map(([, id]) => id);
  if (!starts.length) return "No matching nodes found.";
  const [filters, filterSource] = resolveContextFilters(question, options.contextFilters);
  const traversalGraph = filterGraphByContext(graph, filters);
  const mode = options.mode ?? "bfs";
  const depth = options.depth ?? 3;
  const [nodes, edges] = mode === "dfs" ? dfs(traversalGraph, starts, depth) : bfs(traversalGraph, starts, depth);
  const headerParts = [
    `Traversal: ${mode.toUpperCase()} depth=${depth}`,
    `Start: ${JSON.stringify(starts.map((id) => graph.nodes.get(id)?.label ?? id))}`
  ];
  if (filters.length) headerParts.push(`Context: ${filters.join(", ")} (${filterSource})`);
  headerParts.push(`${nodes.size} nodes found`);
  return `${headerParts.join(" | ")}\n\n${subgraphToText(traversalGraph, nodes, edges, options.tokenBudget ?? 2000, starts)}`;
}

export function findNode(graph: Graph, label: string): string[] {
  const term = stripDiacritics(label).toLowerCase();
  return graph.nodeIds().filter((id) => {
    const node = graph.nodes.get(id);
    const normLabel = stripDiacritics(String(node?.label ?? "")).toLowerCase();
    return normLabel.includes(term) || id.toLowerCase() === term;
  });
}

export function explainNode(graph: Graph, label: string): string {
  const matches = findNode(graph, label);
  if (!matches.length) return `No node matching '${label}' found.`;
  const id = matches[0];
  const node = graph.nodes.get(id)!;
  const lines = [
    `Node: ${node.label}`,
    `  ID:        ${id}`,
    `  Source:    ${node.source_file ?? ""} ${node.source_location ?? ""}`.trimEnd(),
    `  Type:      ${node.file_type ?? ""}`,
    `  Community: ${node.community ?? ""}`,
    `  Degree:    ${graph.degree(id)}`
  ];
  const neighbors = graph.neighbors(id);
  if (neighbors.length) {
    lines.push("", `Connections (${neighbors.length}):`);
    for (const neighbor of neighbors.sort((a, b) => graph.degree(b) - graph.degree(a)).slice(0, 20)) {
      const edge = graph.edgeBetween(id, neighbor);
      lines.push(`  --> ${graph.nodes.get(neighbor)?.label ?? neighbor} [${edge?.relation ?? ""}] [${edge?.confidence ?? ""}]`);
    }
    if (neighbors.length > 20) lines.push(`  ... and ${neighbors.length - 20} more`);
  }
  return lines.join("\n");
}

export function shortestPathText(graph: Graph, sourceLabel: string, targetLabel: string): string {
  const source = scoreNodes(graph, sourceLabel.split(/\s+/).map((t) => t.toLowerCase()))[0]?.[1];
  const target = scoreNodes(graph, targetLabel.split(/\s+/).map((t) => t.toLowerCase()))[0]?.[1];
  if (!source) return `No node matching '${sourceLabel}' found.`;
  if (!target) return `No node matching '${targetLabel}' found.`;
  const path = graph.shortestPath(source, target);
  if (!path) return `No path found between '${sourceLabel}' and '${targetLabel}'.`;
  const segments: string[] = [];
  for (let i = 0; i < path.length - 1; i += 1) {
    const current = path[i];
    const next = path[i + 1];
    const edge = graph.edgeBetween(current, next);
    if (i === 0) segments.push(String(graph.nodes.get(current)?.label ?? current));
    segments.push(`--${edge?.relation ?? ""}${edge?.confidence ? ` [${edge.confidence}]` : ""}--> ${graph.nodes.get(next)?.label ?? next}`);
  }
  return `Shortest path (${path.length - 1} hops):\n  ${segments.join(" ")}`;
}
