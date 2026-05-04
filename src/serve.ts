import { readFile } from "node:fs/promises";
import path from "node:path";
import { Graph } from "./graph.js";
import { explainNode, findNode, queryGraphText, shortestPathText } from "./query.js";
import { godNodes } from "./analyze.js";
import type { NodeLinkGraph } from "./types.js";

export async function loadGraph(graphPath: string): Promise<Graph> {
  const resolved = path.resolve(graphPath);
  if (path.extname(resolved).toLowerCase() !== ".json") throw new Error(`Graph path must be a .json file, got: ${graphPath}`);
  return Graph.fromNodeLink(JSON.parse(await readFile(resolved, "utf8")) as NodeLinkGraph);
}

export function communitiesFromGraph(graph: Graph): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const [id, node] of graph.nodes) {
    if (node.community !== undefined) (out[Number(node.community)] ??= []).push(id);
  }
  return out;
}

export function getNeighbors(graph: Graph, label: string, relationFilter = ""): string {
  const matches = findNode(graph, label);
  if (!matches.length) return `No node matching '${label}' found.`;
  const id = matches[0];
  const lines = [`Neighbors of ${graph.nodes.get(id)?.label ?? id}:`];
  for (const neighbor of graph.neighbors(id)) {
    const edge = graph.edgeBetween(id, neighbor);
    if (relationFilter && !String(edge?.relation ?? "").toLowerCase().includes(relationFilter.toLowerCase())) continue;
    lines.push(`  --> ${graph.nodes.get(neighbor)?.label ?? neighbor} [${edge?.relation ?? ""}] [${edge?.confidence ?? ""}]`);
  }
  return lines.join("\n");
}

export function getCommunity(graph: Graph, communityId: number): string {
  const communities = communitiesFromGraph(graph);
  const nodes = communities[communityId] ?? [];
  if (!nodes.length) return `Community ${communityId} not found.`;
  const lines = [`Community ${communityId} (${nodes.length} nodes):`];
  for (const id of nodes) {
    const node = graph.nodes.get(id);
    lines.push(`  ${node?.label ?? id} [${node?.source_file ?? ""}]`);
  }
  return lines.join("\n");
}

export function graphStats(graph: Graph): string {
  const confs = graph.edges().map((edge) => edge.confidence ?? "EXTRACTED");
  const total = confs.length || 1;
  return [
    `Nodes: ${graph.numberOfNodes()}`,
    `Edges: ${graph.numberOfEdges()}`,
    `Communities: ${Object.keys(communitiesFromGraph(graph)).length}`,
    `EXTRACTED: ${Math.round((confs.filter((c) => c === "EXTRACTED").length / total) * 100)}%`,
    `INFERRED: ${Math.round((confs.filter((c) => c === "INFERRED").length / total) * 100)}%`,
    `AMBIGUOUS: ${Math.round((confs.filter((c) => c === "AMBIGUOUS").length / total) * 100)}%`
  ].join("\n");
}

const toolDefinitions = [
  {
    name: "query_graph",
    description: "Search the knowledge graph using BFS or DFS. Returns relevant nodes and edges as text context.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Natural language question or keyword search" },
        mode: { type: "string", enum: ["bfs", "dfs"], default: "bfs" },
        depth: { type: "integer", default: 3 },
        token_budget: { type: "integer", default: 2000 },
        context_filter: { type: "array", items: { type: "string" } }
      },
      required: ["question"]
    }
  },
  {
    name: "get_node",
    description: "Get full details for a specific node by label or ID.",
    inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] }
  },
  {
    name: "get_neighbors",
    description: "Get all direct neighbors of a node with edge details.",
    inputSchema: {
      type: "object",
      properties: { label: { type: "string" }, relation_filter: { type: "string" } },
      required: ["label"]
    }
  },
  {
    name: "get_community",
    description: "Get all nodes in a community by community ID.",
    inputSchema: { type: "object", properties: { community_id: { type: "integer" } }, required: ["community_id"] }
  },
  {
    name: "god_nodes",
    description: "Return the most connected nodes - the core abstractions of the knowledge graph.",
    inputSchema: { type: "object", properties: { top_n: { type: "integer", default: 10 } } }
  },
  {
    name: "graph_stats",
    description: "Return summary statistics: node count, edge count, communities, confidence breakdown.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "shortest_path",
    description: "Find the shortest path between two concepts in the knowledge graph.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        target: { type: "string" },
        max_hops: { type: "integer", default: 8 }
      },
      required: ["source", "target"]
    }
  }
];

export async function serveStdio(graphPath = "graphify-out/graph.json"): Promise<void> {
  const graph = await loadGraph(graphPath);
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      void handleLine(graph, line);
    }
  });
}

async function handleLine(graph: Graph, line: string): Promise<void> {
  try {
    const msg = JSON.parse(line);
    if (msg.method === "notifications/initialized") return;
    if (msg.method === "initialize") {
      writeResult(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "graphify", version: "0.1.0" }
      });
      return;
    }
    if (msg.method === "tools/list") {
      writeResult(msg.id, { tools: toolDefinitions });
      return;
    }
    const name = msg.method === "tools/call" ? msg.params?.name : msg.params?.name ?? msg.name;
    const args = msg.method === "tools/call" ? msg.params?.arguments ?? {} : msg.params?.arguments ?? msg.arguments ?? {};
    writeResult(msg.id, { content: [{ type: "text", text: runTool(graph, name, args) }] });
  } catch (error) {
    writeError(undefined, error instanceof Error ? error.message : String(error));
  }
}

function runTool(graph: Graph, name: string, args: Record<string, unknown>): string {
  if (name === "query_graph") {
    return queryGraphText(graph, String(args.question ?? ""), {
      mode: args.mode === "dfs" ? "dfs" : "bfs",
      depth: Math.min(Number(args.depth ?? 3), 6),
      tokenBudget: Number(args.token_budget ?? 2000),
      contextFilters: Array.isArray(args.context_filter) ? args.context_filter.map(String) : undefined
    });
  }
  if (name === "get_node") return explainNode(graph, String(args.label ?? ""));
  if (name === "get_neighbors") return getNeighbors(graph, String(args.label ?? ""), String(args.relation_filter ?? ""));
  if (name === "get_community") return getCommunity(graph, Number(args.community_id ?? 0));
  if (name === "god_nodes") return godNodes(graph, Number(args.top_n ?? 10)).map((n, i) => `  ${i + 1}. ${n.label} - ${n.degree} edges`).join("\n");
  if (name === "graph_stats") return graphStats(graph);
  if (name === "shortest_path") {
    const text = shortestPathText(graph, String(args.source ?? ""), String(args.target ?? ""));
    const match = text.match(/Shortest path \((\d+) hops\)/);
    const maxHops = Number(args.max_hops ?? 8);
    if (match && Number(match[1]) > maxHops) return `Path exceeds max_hops=${maxHops} (${match[1]} hops found).`;
    return text;
  }
  return `Unknown tool: ${name}`;
}

function writeResult(id: unknown, result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id: unknown, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
}
