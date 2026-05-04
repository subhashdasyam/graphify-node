import type { Extraction, GraphEdge, GraphNode } from "./types.js";
import { Graph } from "./graph.js";
import { normalizeId } from "./utils.js";
import { validateExtraction } from "./validate.js";

function normalizeSourceFile(value: unknown): string {
  return typeof value === "string" ? value.replaceAll("\\", "/") : "";
}

function canonicalizeExtraction(input: Extraction | Record<string, unknown>): Extraction {
  const extraction = { ...input } as Extraction & { links?: GraphEdge[] };
  if (!Array.isArray(extraction.edges) && Array.isArray(extraction.links)) {
    extraction.edges = extraction.links;
  }
  extraction.nodes = (extraction.nodes ?? []).map((raw) => {
    const node = { ...raw } as Record<string, unknown>;
    if ("source" in node && !("source_file" in node)) {
      node.source_file = String(node.source ?? "");
      delete node.source;
    }
    node.source_file = normalizeSourceFile(node.source_file);
    return node as unknown as GraphNode;
  });
  extraction.edges = (extraction.edges ?? []).map((raw) => {
    const edge = { ...raw } as GraphEdge & { from?: string; to?: string };
    if (!edge.source && edge.from) edge.source = edge.from;
    if (!edge.target && edge.to) edge.target = edge.to;
    delete edge.from;
    delete edge.to;
    edge.source_file = normalizeSourceFile(edge.source_file);
    return edge;
  });
  return extraction;
}

export function buildFromJson(input: Extraction | Record<string, unknown>, options: { directed?: boolean } = {}): Graph {
  const extraction = canonicalizeExtraction(input);
  const errors = validateExtraction(extraction);
  const realErrors = errors.filter((error) => !error.includes("does not match any node id"));
  if (realErrors.length) {
    console.warn(`[graphify] Extraction warning (${realErrors.length} issue(s)): ${realErrors[0]}`);
  }

  const graph = new Graph(Boolean(options.directed));
  for (const node of extraction.nodes) graph.addNode(node);

  const nodeSet = new Set(graph.nodes.keys());
  const normToId = new Map<string, string>();
  for (const id of nodeSet) normToId.set(normalizeId(id), id);

  for (const edge of extraction.edges) {
    let source = edge.source;
    let target = edge.target;
    if (!nodeSet.has(source)) source = normToId.get(normalizeId(source)) ?? source;
    if (!nodeSet.has(target)) target = normToId.get(normalizeId(target)) ?? target;
    if (!nodeSet.has(source) || !nodeSet.has(target)) continue;
    graph.addEdge({ ...edge, source, target, _src: edge._src ?? source, _tgt: edge._tgt ?? target });
  }
  if (extraction.hyperedges?.length) graph.hyperedges.push(...extraction.hyperedges);
  return graph;
}

export function build(extractions: Extraction[], options: { directed?: boolean } = {}): Graph {
  const combined: Extraction = { nodes: [], edges: [], hyperedges: [], input_tokens: 0, output_tokens: 0 };
  for (const extraction of extractions) {
    combined.nodes.push(...(extraction.nodes ?? []));
    combined.edges.push(...(extraction.edges ?? []));
    combined.hyperedges!.push(...(extraction.hyperedges ?? []));
    combined.input_tokens = (combined.input_tokens ?? 0) + (extraction.input_tokens ?? 0);
    combined.output_tokens = (combined.output_tokens ?? 0) + (extraction.output_tokens ?? 0);
  }
  return buildFromJson(combined, options);
}
