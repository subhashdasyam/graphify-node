import path from "node:path";
import { CODE_EXTENSIONS, DOC_EXTENSIONS, IMAGE_EXTENSIONS, PAPER_EXTENSIONS } from "./detect.js";
import type { GodNode, SuggestedQuestion, Surprise } from "./types.js";
import type { Graph } from "./graph.js";

const LANG_FAMILY: Record<string, string> = {
  ".py": "python",
  ".pyw": "python",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".ejs": "js",
  ".ts": "js",
  ".tsx": "js",
  ".vue": "js",
  ".svelte": "js",
  ".go": "go",
  ".rs": "rust",
  ".java": "jvm",
  ".kt": "jvm",
  ".kts": "jvm",
  ".scala": "jvm",
  ".c": "c",
  ".h": "c",
  ".cpp": "c",
  ".cc": "c",
  ".cxx": "c",
  ".hpp": "c",
  ".rb": "ruby",
  ".swift": "swift",
  ".cs": "dotnet",
  ".php": "php",
  ".r": "r"
};

export function nodeCommunityMap(communities: Record<number, string[]>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [cid, nodes] of Object.entries(communities)) {
    for (const node of nodes) out.set(node, Number(cid));
  }
  return out;
}

export function isFileNode(graph: Graph, nodeId: string): boolean {
  const node = graph.nodes.get(nodeId);
  if (!node) return false;
  const label = String(node.label ?? "");
  const source = String(node.source_file ?? "");
  if (source && label === path.posix.basename(source)) return true;
  if (label.startsWith(".") && label.endsWith("()")) return true;
  if (label.endsWith("()") && graph.degree(nodeId) <= 1) return true;
  return false;
}

export function isConceptNode(graph: Graph, nodeId: string): boolean {
  const node = graph.nodes.get(nodeId);
  if (!node) return false;
  const source = String(node.source_file ?? "");
  if (!source) return true;
  return !path.posix.basename(source).includes(".");
}

export function godNodes(graph: Graph, topN = 10): GodNode[] {
  return graph
    .nodeIds()
    .map((id) => ({ id, label: String(graph.nodes.get(id)?.label ?? id), degree: graph.degree(id) }))
    .filter((node) => !isFileNode(graph, node.id) && !isConceptNode(graph, node.id))
    .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label))
    .slice(0, topN);
}

function fileCategory(source: string): string {
  const ext = `.${source.split(".").at(-1)?.toLowerCase() ?? ""}`;
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (DOC_EXTENSIONS.has(ext)) return "doc";
  if (PAPER_EXTENSIONS.has(ext)) return "paper";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "doc";
}

function topLevelDir(source: string): string {
  return source.includes("/") ? source.split("/")[0] : source;
}

function crossLanguage(a: string, b: string): boolean {
  const famA = LANG_FAMILY[path.posix.extname(a).toLowerCase()];
  const famB = LANG_FAMILY[path.posix.extname(b).toLowerCase()];
  return Boolean(famA && famB && famA !== famB);
}

export function surprisingConnections(graph: Graph, communities: Record<number, string[]> = {}, topN = 5): Surprise[] {
  const communityByNode = nodeCommunityMap(communities);
  const candidates: Array<Surprise & { score: number }> = [];

  for (const edge of graph.edges()) {
    if (["imports", "imports_from", "contains", "method"].includes(edge.relation)) continue;
    if (isFileNode(graph, edge.source) || isFileNode(graph, edge.target)) continue;
    if (isConceptNode(graph, edge.source) || isConceptNode(graph, edge.target)) continue;
    const srcNode = graph.nodes.get(edge._src ?? edge.source) ?? graph.nodes.get(edge.source);
    const tgtNode = graph.nodes.get(edge._tgt ?? edge.target) ?? graph.nodes.get(edge.target);
    if (!srcNode || !tgtNode) continue;
    const srcFile = String(srcNode.source_file ?? "");
    const tgtFile = String(tgtNode.source_file ?? "");
    if (!srcFile || !tgtFile || srcFile === tgtFile) continue;

    let score = { AMBIGUOUS: 3, INFERRED: 2, STATIC_RESOLVED: 1, EXTRACTED: 1 }[edge.confidence] ?? 1;
    const reasons: string[] = [];
    if (edge.confidence !== "EXTRACTED") reasons.push(`${edge.confidence.toLowerCase()} connection`);
    if (edge.confidence === "INFERRED" && edge.relation === "calls" && crossLanguage(srcFile, tgtFile)) score = 0;
    const srcCategory = fileCategory(srcFile);
    const tgtCategory = fileCategory(tgtFile);
    if (srcCategory !== tgtCategory) {
      score += 2;
      reasons.push(`crosses file types (${srcCategory} <-> ${tgtCategory})`);
    }
    if (topLevelDir(srcFile) !== topLevelDir(tgtFile)) {
      score += 2;
      reasons.push("connects across different directories");
    }
    if (communityByNode.get(edge.source) !== communityByNode.get(edge.target)) {
      score += 1;
      reasons.push("bridges separate communities");
    }
    if (Math.min(graph.degree(edge.source), graph.degree(edge.target)) <= 2 && Math.max(graph.degree(edge.source), graph.degree(edge.target)) >= 5) {
      score += 1;
      reasons.push("peripheral node reaches a hub");
    }
    candidates.push({
      source: String(srcNode.label ?? edge.source),
      target: String(tgtNode.label ?? edge.target),
      source_files: [srcFile, tgtFile],
      confidence: edge.confidence,
      relation: edge.relation,
      confidence_score: edge.confidence_score,
      why: reasons.join("; ") || "cross-file semantic connection",
      score
    });
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, topN).map(({ score: _, ...item }) => item);
}

export function suggestQuestions(
  graph: Graph,
  communities: Record<number, string[]>,
  labels: Record<number, string>
): SuggestedQuestion[] {
  const gods = godNodes(graph, 3);
  const surprises = surprisingConnections(graph, communities, 3);
  const questions: SuggestedQuestion[] = [];
  for (const node of gods) {
    questions.push({
      question: `What depends on ${node.label}, and what would change if it moved?`,
      why: `${node.label} is one of the most connected nodes in the graph.`
    });
  }
  for (const surprise of surprises) {
    questions.push({
      question: `Why does ${surprise.source} connect to ${surprise.target}?`,
      why: surprise.why ?? "This edge crosses a structural boundary."
    });
  }
  const communityIds = Object.keys(communities).map(Number).slice(0, 2);
  if (communityIds.length >= 2) {
    questions.push({
      question: `How do ${labels[communityIds[0]]} and ${labels[communityIds[1]]} interact?`,
      why: "These are separate detected communities and may represent different subsystems."
    });
  }
  return questions.length ? questions.slice(0, 5) : [{ type: "no_signal", why: "The graph is too small to suggest high-signal questions." }];
}
