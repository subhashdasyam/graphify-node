import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Graph } from "./graph.js";
import { applyCommunities } from "./cluster.js";
import { escapeHtml, sanitizeLabel } from "./utils.js";
import type { NodeLinkGraph } from "./types.js";

const COMMUNITY_COLORS = [
  "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
  "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC"
];

export async function toJson(graph: Graph, communities: Record<number, string[]>, outputPath: string): Promise<void> {
  applyCommunities(graph, communities);
  for (const edge of graph.edges()) {
    if (edge.confidence_score === undefined) {
      edge.confidence_score = edge.confidence === "EXTRACTED" ? 1.0 : edge.confidence === "AMBIGUOUS" ? 0.2 : 0.5;
    }
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(graph.toNodeLink(), null, 2)}\n`, "utf8");
}

function cypherEscape(value: unknown): string {
  return String(value ?? "").replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export async function toCypher(graph: Graph, outputPath: string): Promise<void> {
  const lines: string[] = [];
  for (const [id, node] of graph.nodes) {
    lines.push(`MERGE (n:Node {id:'${cypherEscape(id)}'}) SET n.label='${cypherEscape(node.label)}', n.file_type='${cypherEscape(node.file_type)}', n.source_file='${cypherEscape(node.source_file)}';`);
  }
  let i = 0;
  for (const edge of graph.edges()) {
    lines.push(`MATCH (a:Node {id:'${cypherEscape(edge.source)}'}), (b:Node {id:'${cypherEscape(edge.target)}'}) MERGE (a)-[r:RELATED {id:'e${i++}'}]->(b) SET r.relation='${cypherEscape(edge.relation)}', r.confidence='${cypherEscape(edge.confidence)}';`);
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

export async function toGraphml(graph: Graph, communities: Record<number, string[]>, outputPath: string): Promise<void> {
  applyCommunities(graph, communities);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '<key id="label" for="node" attr.name="label" attr.type="string"/>',
    '<key id="community" for="node" attr.name="community" attr.type="int"/>',
    '<key id="relation" for="edge" attr.name="relation" attr.type="string"/>',
    '<graph edgedefault="undirected">'
  ];
  for (const [id, node] of graph.nodes) {
    lines.push(`<node id="${escapeHtml(id)}"><data key="label">${escapeHtml(node.label)}</data><data key="community">${escapeHtml(node.community ?? "")}</data></node>`);
  }
  let i = 0;
  for (const edge of graph.edges()) {
    lines.push(`<edge id="e${i++}" source="${escapeHtml(edge.source)}" target="${escapeHtml(edge.target)}"><data key="relation">${escapeHtml(edge.relation)}</data></edge>`);
  }
  lines.push("</graph>", "</graphml>");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

export async function toCanvas(graph: Graph, communities: Record<number, string[]>, outputPath: string): Promise<void> {
  applyCommunities(graph, communities);
  const nodes = graph.nodeIds().map((id, index) => ({
    id,
    type: "file",
    file: `${safeCanvasName(String(graph.nodes.get(id)?.label ?? id))}.md`,
    x: (index % 8) * 320,
    y: Math.floor(index / 8) * 180,
    width: 260,
    height: 120
  }));
  const edges = graph.edges().map((edge, index) => ({
    id: `e${index}`,
    fromNode: edge.source,
    toNode: edge.target,
    label: edge.relation
  }));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ nodes, edges }, null, 2)}\n`, "utf8");
}

function safeCanvasName(label: string): string {
  return label.replace(/[\\/*?:"<>|#^[\]]/g, "").replace(/\.(md|mdx|markdown)$/i, "").slice(0, 180) || "unnamed";
}

export async function toSvg(graph: Graph, communities: Record<number, string[]>, outputPath: string): Promise<void> {
  applyCommunities(graph, communities);
  const ids = graph.nodeIds();
  const width = 1200;
  const height = 900;
  const radius = Math.min(width, height) * 0.38;
  const positions = new Map<string, [number, number]>();
  ids.forEach((id, i) => {
    const angle = (Math.PI * 2 * i) / Math.max(1, ids.length);
    positions.set(id, [width / 2 + Math.cos(angle) * radius, height / 2 + Math.sin(angle) * radius]);
  });
  const lines = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`, `<rect width="100%" height="100%" fill="#ffffff"/>`];
  for (const edge of graph.edges()) {
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (a && b) lines.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#94a3b8" stroke-width="1"/>`);
  }
  for (const id of ids) {
    const p = positions.get(id)!;
    const node = graph.nodes.get(id)!;
    lines.push(`<circle cx="${p[0]}" cy="${p[1]}" r="${Math.max(5, Math.min(18, graph.degree(id) + 5))}" fill="#4E79A7"/>`);
    lines.push(`<text x="${p[0] + 8}" y="${p[1] - 8}" font-size="10" font-family="sans-serif">${escapeHtml(node.label)}</text>`);
  }
  lines.push("</svg>");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, lines.join("\n"), "utf8");
}

export async function toHtml(
  graph: Graph,
  communities: Record<number, string[]>,
  outputPath: string,
  communityLabels: Record<number, string> = {}
): Promise<void> {
  applyCommunities(graph, communities);
  const nodes = graph.nodeIds().map((id) => {
    const node = graph.nodes.get(id)!;
    const community = Number(node.community ?? 0);
    const degree = graph.degree(id);
    const color = COMMUNITY_COLORS[community % COMMUNITY_COLORS.length];
    return {
      id,
      label: sanitizeLabel(node.label),
      title: `${sanitizeLabel(node.label)}\n${sanitizeLabel(node.source_file)} ${sanitizeLabel(node.source_location ?? "")}`,
      color: { background: color, border: "#111827" },
      size: Math.max(8, Math.min(34, 8 + degree * 2)),
      community,
      community_name: communityLabels[community] ?? `Community ${community}`,
      source_file: node.source_file,
      file_type: node.file_type,
      degree
    };
  });
  const edges = graph.edges().map((edge) => ({
    from: edge._src ?? edge.source,
    to: edge._tgt ?? edge.target,
    title: `${edge.relation} [${edge.confidence}]`,
    width: edge.confidence === "INFERRED" ? 1.5 : 2,
    dashes: edge.confidence !== "EXTRACTED",
    color: edge.confidence === "AMBIGUOUS" ? "#E15759" : "#9CA3AF"
  }));
  const legend = Object.entries(communities).map(([cid, list]) => ({
    cid: Number(cid),
    label: communityLabels[Number(cid)] ?? `Community ${cid}`,
    count: list.length,
    color: COMMUNITY_COLORS[Number(cid) % COMMUNITY_COLORS.length]
  }));

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>graphify</title>
  <script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; display: flex; font-family: system-ui, -apple-system, Segoe UI, sans-serif; color: #e5e7eb; background: #111827; }
    #graph { flex: 1; min-width: 0; }
    aside { width: 320px; border-left: 1px solid #374151; background: #0f172a; display: flex; flex-direction: column; }
    input { margin: 12px; padding: 9px 10px; border-radius: 6px; border: 1px solid #475569; background: #020617; color: #e5e7eb; }
    #info, #legend { padding: 12px; border-top: 1px solid #1f2937; overflow: auto; }
    #legend { flex: 1; }
    .legend-item { display: flex; gap: 8px; align-items: center; padding: 4px 0; font-size: 12px; }
    .dot { width: 11px; height: 11px; border-radius: 999px; display: inline-block; }
    .muted { color: #94a3b8; }
  </style>
</head>
<body>
  <main id="graph"></main>
  <aside>
    <input id="search" placeholder="Search nodes">
    <section id="info"><div class="muted">Click a node to inspect it</div></section>
    <section id="legend"></section>
  </aside>
  <script>
    const RAW_NODES = ${JSON.stringify(nodes)};
    const RAW_EDGES = ${JSON.stringify(edges)};
    const LEGEND = ${JSON.stringify(legend)};
    const nodes = new vis.DataSet(RAW_NODES);
    const edges = new vis.DataSet(RAW_EDGES);
    const network = new vis.Network(document.getElementById("graph"), { nodes, edges }, {
      physics: { solver: "forceAtlas2Based", stabilization: { iterations: 180 } },
      interaction: { hover: true, hideEdgesOnDrag: true },
      nodes: { shape: "dot", font: { color: "#e5e7eb" } },
      edges: { arrows: { to: { enabled: true, scaleFactor: 0.45 } }, smooth: { type: "continuous" } }
    });
    network.once("stabilizationIterationsDone", () => network.setOptions({ physics: false }));
    function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
    function show(id) {
      const n = nodes.get(id);
      const neighbors = network.getConnectedNodes(id).map(nid => nodes.get(nid)).filter(Boolean);
      document.getElementById("info").innerHTML =
        '<strong>' + esc(n.label) + '</strong>' +
        '<div class="muted">' + esc(n.source_file || "-") + '</div>' +
        '<div>Type: ' + esc(n.file_type) + '</div>' +
        '<div>Community: ' + esc(n.community_name) + '</div>' +
        '<div>Degree: ' + esc(n.degree) + '</div>' +
        '<h4>Neighbors</h4>' + neighbors.slice(0, 24).map(nb => '<div>' + esc(nb.label) + '</div>').join("");
    }
    network.on("click", params => { if (params.nodes.length) show(params.nodes[0]); });
    document.getElementById("search").addEventListener("input", event => {
      const q = event.target.value.toLowerCase();
      const match = RAW_NODES.find(n => q && n.label.toLowerCase().includes(q));
      if (match) { network.focus(match.id, { scale: 1.4, animation: true }); network.selectNodes([match.id]); show(match.id); }
    });
    document.getElementById("legend").innerHTML = LEGEND.map(item =>
      '<div class="legend-item"><span class="dot" style="background:' + item.color + '"></span><span>' +
      esc(item.label) + '</span><span class="muted">(' + item.count + ')</span></div>').join("");
  </script>
</body>
</html>`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");
}

export async function loadNodeLinkGraph(graphPath: string): Promise<NodeLinkGraph> {
  return JSON.parse(await readFile(graphPath, "utf8")) as NodeLinkGraph;
}

export async function writeReport(reportPath: string, text: string): Promise<void> {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, text, "utf8");
}

export function graphStatsLine(graph: Graph): string {
  return `${graph.numberOfNodes()} nodes, ${graph.numberOfEdges()} edges`;
}

export function htmlOpenHint(outputPath: string): string {
  return `file://${path.resolve(outputPath)}`;
}

export function renderSmallNodeTable(graph: Graph, ids: string[]): string {
  return ids.map((id) => {
    const node = graph.nodes.get(id);
    return node ? `${escapeHtml(node.label)} [${escapeHtml(node.source_file)}]` : id;
  }).join("\n");
}
