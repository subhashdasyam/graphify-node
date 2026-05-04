import type { GraphEdge, GraphNode, Hyperedge, NodeLinkGraph } from "./types.js";
import { normalizeId } from "./utils.js";

function edgeKey(source: string, target: string, directed: boolean): string {
  if (directed) return `${source}\u0000${target}`;
  return source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
}

export class Graph {
  readonly directed: boolean;
  readonly nodes = new Map<string, GraphNode>();
  readonly edgesByKey = new Map<string, GraphEdge>();
  readonly hyperedges: Hyperedge[] = [];

  constructor(directed = false) {
    this.directed = directed;
  }

  addNode(node: GraphNode): void {
    const previous = this.nodes.get(node.id);
    this.nodes.set(node.id, { ...(previous ?? {}), ...node });
  }

  addEdge(edge: GraphEdge): void {
    if (!this.nodes.has(edge.source) || !this.nodes.has(edge.target)) return;
    const key = edgeKey(edge.source, edge.target, this.directed);
    const attrs: GraphEdge = {
      ...edge,
      _src: edge._src ?? edge.source,
      _tgt: edge._tgt ?? edge.target
    };
    this.edgesByKey.set(key, attrs);
  }

  numberOfNodes(): number {
    return this.nodes.size;
  }

  numberOfEdges(): number {
    return this.edgesByKey.size;
  }

  nodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  edges(): GraphEdge[] {
    return Array.from(this.edgesByKey.values());
  }

  neighbors(nodeId: string): string[] {
    const out = new Set<string>();
    for (const edge of this.edgesByKey.values()) {
      if (edge.source === nodeId) out.add(edge.target);
      if (!this.directed && edge.target === nodeId) out.add(edge.source);
      if (this.directed && edge.target === nodeId) out.add(edge.source);
    }
    return Array.from(out);
  }

  edgeBetween(a: string, b: string): GraphEdge | undefined {
    return this.edgesByKey.get(edgeKey(a, b, this.directed));
  }

  degree(nodeId: string): number {
    return this.neighbors(nodeId).length;
  }

  subgraph(nodeIds: Iterable<string>): Graph {
    const keep = new Set(nodeIds);
    const sub = new Graph(this.directed);
    for (const id of keep) {
      const node = this.nodes.get(id);
      if (node) sub.addNode({ ...node });
    }
    for (const edge of this.edges()) {
      if (keep.has(edge.source) && keep.has(edge.target)) sub.addEdge({ ...edge });
    }
    return sub;
  }

  connectedComponents(): string[][] {
    const seen = new Set<string>();
    const components: string[][] = [];
    for (const start of this.nodeIds().sort()) {
      if (seen.has(start)) continue;
      const stack = [start];
      const component: string[] = [];
      seen.add(start);
      while (stack.length) {
        const node = stack.pop()!;
        component.push(node);
        for (const neighbor of this.neighbors(node).sort()) {
          if (!seen.has(neighbor)) {
            seen.add(neighbor);
            stack.push(neighbor);
          }
        }
      }
      components.push(component.sort());
    }
    components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
    return components;
  }

  shortestPath(source: string, target: string): string[] | null {
    if (!this.nodes.has(source) || !this.nodes.has(target)) return null;
    const queue = [source];
    const prev = new Map<string, string | null>([[source, null]]);
    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i];
      if (current === target) break;
      for (const neighbor of this.neighbors(current).sort()) {
        if (!prev.has(neighbor)) {
          prev.set(neighbor, current);
          queue.push(neighbor);
        }
      }
    }
    if (!prev.has(target)) return null;
    const path: string[] = [];
    for (let at: string | null = target; at !== null; at = prev.get(at) ?? null) {
      path.push(at);
    }
    return path.reverse();
  }

  toNodeLink(): NodeLinkGraph {
    return {
      directed: this.directed,
      multigraph: false,
      graph: { hyperedges: this.hyperedges },
      nodes: Array.from(this.nodes.values()),
      links: this.edges()
    };
  }

  static fromNodeLink(data: Partial<NodeLinkGraph> & { edges?: GraphEdge[] }): Graph {
    const graph = new Graph(Boolean(data.directed));
    for (const node of data.nodes ?? []) {
      graph.addNode({
        ...node,
        id: node.id,
        source_file: typeof node.source_file === "string" ? node.source_file.replaceAll("\\", "/") : ""
      });
    }
    const nodeSet = new Set(graph.nodes.keys());
    const normToId = new Map<string, string>();
    for (const id of nodeSet) normToId.set(normalizeId(id), id);
    for (const rawEdge of data.links ?? data.edges ?? []) {
      const edge = { ...rawEdge };
      let source = edge.source;
      let target = edge.target;
      if (!nodeSet.has(source)) source = normToId.get(normalizeId(source)) ?? source;
      if (!nodeSet.has(target)) target = normToId.get(normalizeId(target)) ?? target;
      if (!nodeSet.has(source) || !nodeSet.has(target)) continue;
      graph.addEdge({
        ...edge,
        source,
        target,
        source_file: typeof edge.source_file === "string" ? edge.source_file.replaceAll("\\", "/") : ""
      });
    }
    const hyperedges = data.hyperedges ?? (data.graph?.hyperedges as Hyperedge[] | undefined) ?? [];
    graph.hyperedges.push(...hyperedges);
    return graph;
  }
}
