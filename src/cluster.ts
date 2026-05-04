import type { Graph } from "./graph.js";

const MAX_COMMUNITY_FRACTION = 0.25;
const MIN_SPLIT_SIZE = 10;

export function cluster(graph: Graph): Record<number, string[]> {
  if (graph.numberOfNodes() === 0) return {};
  const components = graph.connectedComponents();
  const maxSize = Math.max(MIN_SPLIT_SIZE, Math.floor(graph.numberOfNodes() * MAX_COMMUNITY_FRACTION));
  const communities: string[][] = [];

  for (const component of components) {
    if (component.length > maxSize) communities.push(...splitLargeComponent(graph, component));
    else communities.push(component);
  }

  communities.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  return Object.fromEntries(communities.map((nodes, index) => [index, nodes.sort()]));
}

function splitLargeComponent(graph: Graph, nodes: string[]): string[][] {
  const byTopLevel = new Map<string, string[]>();
  for (const nodeId of nodes) {
    const source = String(graph.nodes.get(nodeId)?.source_file ?? "");
    const key = source.includes("/") ? source.split("/")[0] : source || "unknown";
    const bucket = byTopLevel.get(key) ?? [];
    bucket.push(nodeId);
    byTopLevel.set(key, bucket);
  }
  if (byTopLevel.size > 1) return Array.from(byTopLevel.values()).map((bucket) => bucket.sort());
  return [nodes.sort()];
}

export function cohesionScore(graph: Graph, communityNodes: string[]): number {
  const n = communityNodes.length;
  if (n <= 1) return 1;
  const keep = new Set(communityNodes);
  const actual = graph.edges().filter((edge) => keep.has(edge.source) && keep.has(edge.target)).length;
  const possible = (n * (n - 1)) / 2;
  return possible > 0 ? Math.round((actual / possible) * 100) / 100 : 0;
}

export function scoreAll(graph: Graph, communities: Record<number, string[]>): Record<number, number> {
  return Object.fromEntries(Object.entries(communities).map(([cid, nodes]) => [Number(cid), cohesionScore(graph, nodes)]));
}

export function applyCommunities(graph: Graph, communities: Record<number, string[]>): void {
  for (const [cidText, nodes] of Object.entries(communities)) {
    const cid = Number(cidText);
    for (const nodeId of nodes) {
      const node = graph.nodes.get(nodeId);
      if (node) node.community = cid;
    }
  }
}

export function labelCommunities(graph: Graph, communities: Record<number, string[]>): Record<number, string> {
  const labels: Record<number, string> = {};
  for (const [cidText, nodes] of Object.entries(communities)) {
    const cid = Number(cidText);
    const candidates = nodes
      .map((nodeId) => graph.nodes.get(nodeId))
      .filter(Boolean)
      .filter((node) => !String(node!.label).endsWith(".py") && !String(node!.label).endsWith(".ts"))
      .map((node) => String(node!.label).replace(/^\./, "").replace(/\(\)$/, ""));
    labels[cid] = candidates.slice(0, 3).join(", ") || `Community ${cid}`;
  }
  return labels;
}
