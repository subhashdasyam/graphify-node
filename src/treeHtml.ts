import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { NodeLinkGraph } from "./types.js";
import { escapeHtml } from "./utils.js";

export const DEFAULT_MAX_CHILDREN = 200;

function commonRoot(paths: string[]): string {
  if (!paths.length) return "";
  const split = paths.filter(Boolean).map((p) => p.split(/[\\/]/));
  if (!split.length) return "";
  let common = split[0];
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i += 1;
    common = common.slice(0, i);
  }
  return common.join("/");
}

interface TreeNode {
  name: string;
  total_count: number;
  children: TreeNode[];
}

function truncationLeaf(extra: number): TreeNode {
  return { name: `(+${extra} more)`, total_count: extra, children: [] };
}

export function buildTree(graph: Partial<NodeLinkGraph>, options: { root?: string; maxChildren?: number; projectLabel?: string } = {}): TreeNode {
  const nodes = graph.nodes ?? [];
  const fileNodes = nodes.filter((node) => node.source_file);
  if (!fileNodes.length) return { name: "(empty graph)", total_count: 0, children: [] };
  const root = options.root ?? commonRoot(fileNodes.map((node) => String(node.source_file)));
  const maxChildren = options.maxChildren ?? DEFAULT_MAX_CHILDREN;
  const labelRoot = options.projectLabel ?? (path.basename(root) || root || "/");
  const rootNode: TreeNode = { name: labelRoot, total_count: 0, children: [] };
  const dirs = new Map<string, TreeNode>([[root, rootNode]]);
  const byFile = new Map<string, typeof nodes>();
  for (const node of fileNodes) {
    const list = byFile.get(node.source_file) ?? [];
    list.push(node);
    byFile.set(node.source_file, list);
  }
  const ensureDir = (dir: string): TreeNode => {
    if (dirs.has(dir)) return dirs.get(dir)!;
    const parentPath = path.posix.dirname(dir);
    const parent = parentPath === dir || !parentPath ? rootNode : ensureDir(parentPath);
    const node = { name: path.posix.basename(dir), total_count: 0, children: [] };
    dirs.set(dir, node);
    parent.children.push(node);
    return node;
  };
  for (const [source, syms] of Array.from(byFile.entries()).sort()) {
    const parent = ensureDir(path.posix.dirname(source));
    let children = syms
      .filter((node) => !(node.label === path.posix.basename(source) && node.file_type === "code"))
      .map((node): TreeNode => ({ name: String(node.label ?? node.id), total_count: 1, children: [] }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (children.length > maxChildren) children = [...children.slice(0, maxChildren), truncationLeaf(children.length - maxChildren)];
    parent.children.push({ name: path.posix.basename(source), total_count: children.length || 1, children });
  }
  function finalize(node: TreeNode): number {
    node.children.sort((a, b) => Number(!a.children.length) - Number(!b.children.length) || a.name.localeCompare(b.name));
    node.total_count = node.children.length ? node.children.reduce((sum, child) => sum + finalize(child), 0) : node.total_count || 1;
    return node.total_count;
  }
  finalize(rootNode);
  return rootNode;
}

export function emitTreeHtml(tree: TreeNode, options: { title?: string; header?: string } = {}): string {
  const title = options.title ?? `${tree.name} - graphify tree viewer`;
  const header = options.header ?? `${tree.name} - Knowledge Graph`;
  const data = JSON.stringify(tree).replaceAll("</", "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #f8fafc; color: #1f2937; }
    header { padding: 16px 24px; border-bottom: 1px solid #d1d5db; background: white; }
    button { margin-right: 8px; padding: 7px 12px; border: 1px solid #94a3b8; background: white; border-radius: 5px; }
    #tree { height: calc(100vh - 72px); overflow: auto; }
    .node circle { fill: #fff; stroke: #2563eb; stroke-width: 2px; }
    .node text { font-size: 12px; }
    .link { fill: none; stroke: #94a3b8; stroke-width: 1.5px; }
  </style>
</head>
<body>
  <header><strong>${escapeHtml(header)}</strong> <button onclick="expandAll()">Expand All</button><button onclick="collapseAll()">Collapse All</button></header>
  <div id="tree"><svg width="6000" height="8000"></svg></div>
  <script>
const data = ${data};
const svg = d3.select("svg"), g = svg.append("g").attr("transform", "translate(160,40)");
const tree = d3.tree().nodeSize([28, 260]);
let root = d3.hierarchy(data);
root.x0 = 0; root.y0 = 0;
function collapse(d){ if(d.children){ d._children=d.children; d._children.forEach(collapse); d.children=null; } }
function expand(d){ if(d._children){ d.children=d._children; d._children=null; } if(d.children) d.children.forEach(expand); }
if(root.children) root.children.forEach(collapse);
window.expandAll=()=>{expand(root); update(root);};
window.collapseAll=()=>{if(root.children) root.children.forEach(collapse); update(root);};
function diagonal(s,d){ return \`M \${s.y} \${s.x} C \${(s.y+d.y)/2} \${s.x}, \${(s.y+d.y)/2} \${d.x}, \${d.y} \${d.x}\`; }
let i = 0;
function update(source){
  const data = tree(root), nodes = data.descendants(), links = data.descendants().slice(1);
  nodes.forEach(d=>d.y=d.depth*260);
  const node = g.selectAll("g.node").data(nodes, d=>d.id || (d.id=++i));
  const enter = node.enter().append("g").attr("class","node").attr("transform",()=>\`translate(\${source.y0},\${source.x0})\`).on("click",(e,d)=>{ if(d.children){d._children=d.children; d.children=null;} else {d.children=d._children; d._children=null;} update(d); });
  enter.append("circle").attr("r",1e-6);
  enter.append("text").attr("dy",".35em").attr("x",d=>d.children||d._children?-12:12).attr("text-anchor",d=>d.children||d._children?"end":"start").text(d=>d.data.name + (d.data.total_count ? \` (Total Count: \${d.data.total_count})\` : ""));
  const merged = enter.merge(node);
  merged.transition().duration(250).attr("transform",d=>\`translate(\${d.y},\${d.x})\`);
  merged.select("circle").attr("r",7).style("fill",d=>d._children?"#bfdbfe":"#fff");
  node.exit().remove();
  const link = g.selectAll("path.link").data(links, d=>d.id);
  link.enter().insert("path","g").attr("class","link").merge(link).transition().duration(250).attr("d",d=>diagonal(d,d.parent));
  link.exit().remove();
  nodes.forEach(d=>{d.x0=d.x; d.y0=d.y;});
}
update(root);
  </script>
</body>
</html>`;
}

export async function writeTreeHtml(graphPath: string, outputPath: string, options: { root?: string; maxChildren?: number; projectLabel?: string } = {}): Promise<string> {
  const graph = JSON.parse(await readFile(graphPath, "utf8")) as NodeLinkGraph;
  const tree = buildTree(graph, options);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, emitTreeHtml(tree), "utf8");
  return outputPath;
}
