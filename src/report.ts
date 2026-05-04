import { isConceptNode, isFileNode } from "./analyze.js";
import type { Graph } from "./graph.js";
import type { DetectionResult, GodNode, SuggestedQuestion, Surprise } from "./types.js";
import { safeCommunityName } from "./utils.js";

export interface ReportInput {
  graph: Graph;
  communities: Record<number, string[]>;
  cohesionScores: Record<number, number>;
  communityLabels: Record<number, string>;
  godNodes: GodNode[];
  surprises: Surprise[];
  detection: DetectionResult | { warning?: string | null; total_files?: number; total_words?: number };
  tokenCost?: { input?: number; output?: number };
  root: string;
  suggestedQuestions?: SuggestedQuestion[];
  minCommunitySize?: number;
}

export function generateReport(input: ReportInput): string {
  const {
    graph,
    communities,
    cohesionScores,
    communityLabels,
    godNodes,
    surprises,
    detection,
    tokenCost = { input: 0, output: 0 },
    root,
    suggestedQuestions = [],
    minCommunitySize = 3
  } = input;

  const today = new Date().toISOString().slice(0, 10);
  const confidences = graph.edges().map((edge) => edge.confidence ?? "EXTRACTED");
  const total = confidences.length || 1;
  const extractedPct = Math.round((confidences.filter((c) => c === "EXTRACTED").length / total) * 100);
  const inferredPct = Math.round((confidences.filter((c) => c === "INFERRED").length / total) * 100);
  const ambiguousPct = Math.round((confidences.filter((c) => c === "AMBIGUOUS").length / total) * 100);
  const inferredEdges = graph.edges().filter((edge) => edge.confidence === "INFERRED");
  const inferredAvg = inferredEdges.length
    ? Math.round((inferredEdges.reduce((sum, edge) => sum + Number(edge.confidence_score ?? 0.5), 0) / inferredEdges.length) * 100) / 100
    : null;

  const lines: string[] = [`# Graph Report - ${root}  (${today})`, "", "## Corpus Check"];
  if (detection.warning) {
    lines.push(`- ${detection.warning}`);
  } else {
    lines.push(`- ${detection.total_files ?? 0} files · ~${Number(detection.total_words ?? 0).toLocaleString()} words`);
    lines.push("- Verdict: corpus is large enough that graph structure adds value.");
  }

  const nonEmpty = Object.fromEntries(
    Object.entries(communities).filter(([, nodes]) => nodes.some((node) => !isFileNode(graph, node)))
  );

  lines.push("");
  lines.push("## Summary");
  lines.push(`- ${graph.numberOfNodes()} nodes · ${graph.numberOfEdges()} edges · ${Object.keys(nonEmpty).length} communities detected`);
  lines.push(
    `- Extraction: ${extractedPct}% EXTRACTED · ${inferredPct}% INFERRED · ${ambiguousPct}% AMBIGUOUS` +
      (inferredAvg !== null ? ` · INFERRED: ${inferredEdges.length} edges (avg confidence: ${inferredAvg})` : "")
  );
  lines.push(`- Token cost: ${Number(tokenCost.input ?? 0).toLocaleString()} input · ${Number(tokenCost.output ?? 0).toLocaleString()} output`);

  if (Object.keys(nonEmpty).length) {
    lines.push("", "## Community Hubs (Navigation)");
    for (const cid of Object.keys(nonEmpty).map(Number)) {
      const label = communityLabels[cid] ?? `Community ${cid}`;
      lines.push(`- [[_COMMUNITY_${safeCommunityName(label)}|${label}]]`);
    }
  }

  lines.push("", "## God Nodes (most connected - your core abstractions)");
  if (godNodes.length) {
    godNodes.forEach((node, index) => lines.push(`${index + 1}. \`${node.label}\` - ${node.degree} edges`));
  } else {
    lines.push("- None detected.");
  }

  lines.push("", "## Surprising Connections (you probably didn't know these)");
  if (surprises.length) {
    for (const surprise of surprises) {
      const confidenceTag =
        surprise.confidence === "INFERRED" && surprise.confidence_score !== undefined
          ? `INFERRED ${surprise.confidence_score.toFixed(2)}`
          : surprise.confidence;
      lines.push(`- \`${surprise.source}\` --${surprise.relation}--> \`${surprise.target}\`  [${confidenceTag}]`);
      lines.push(`  ${surprise.source_files[0]} -> ${surprise.source_files[1]}${surprise.why ? `  _${surprise.why}_` : ""}`);
    }
  } else {
    lines.push("- None detected - all connections are within the same source files.");
  }

  if (graph.hyperedges.length) {
    lines.push("", "## Hyperedges (group relationships)");
    for (const hyperedge of graph.hyperedges) {
      const conf = hyperedge.confidence ?? "INFERRED";
      const score = hyperedge.confidence_score !== undefined ? ` ${hyperedge.confidence_score.toFixed(2)}` : "";
      lines.push(`- **${hyperedge.label ?? hyperedge.id}** - ${(hyperedge.nodes ?? []).join(", ")} [${conf}${score}]`);
    }
  }

  const thinCount = Object.values(communities).filter((nodes) => {
    const real = nodes.filter((node) => !isFileNode(graph, node));
    return real.length > 0 && real.length < minCommunitySize;
  }).length;

  lines.push("", `## Communities (${Object.keys(communities).length} total, ${thinCount} thin omitted)`);
  for (const [cidText, nodes] of Object.entries(communities)) {
    const cid = Number(cidText);
    const realNodes = nodes.filter((node) => !isFileNode(graph, node));
    if (realNodes.length < minCommunitySize) continue;
    const display = realNodes.slice(0, 8).map((node) => String(graph.nodes.get(node)?.label ?? node));
    const suffix = realNodes.length > 8 ? ` (+${realNodes.length - 8} more)` : "";
    lines.push("", `### Community ${cid} - "${communityLabels[cid] ?? `Community ${cid}`}"`);
    lines.push(`Cohesion: ${cohesionScores[cid] ?? 0}`);
    lines.push(`Nodes (${realNodes.length}): ${display.join(", ")}${suffix}`);
  }

  const ambiguous = graph.edges().filter((edge) => edge.confidence === "AMBIGUOUS");
  if (ambiguous.length) {
    lines.push("", "## Ambiguous Edges - Review These");
    for (const edge of ambiguous) {
      const source = graph.nodes.get(edge.source)?.label ?? edge.source;
      const target = graph.nodes.get(edge.target)?.label ?? edge.target;
      lines.push(`- \`${source}\` -> \`${target}\`  [AMBIGUOUS]`);
      lines.push(`  ${edge.source_file} · relation: ${edge.relation}`);
    }
  }

  const isolated = graph
    .nodeIds()
    .filter((node) => graph.degree(node) <= 1 && !isFileNode(graph, node) && !isConceptNode(graph, node));
  const thinCommunities = Object.entries(communities).filter(([, nodes]) => {
    const real = nodes.filter((node) => !isFileNode(graph, node));
    return real.length > 0 && real.length < minCommunitySize;
  });

  if (isolated.length || thinCommunities.length || ambiguousPct > 20) {
    lines.push("", "## Knowledge Gaps");
    if (isolated.length) {
      const labels = isolated.slice(0, 5).map((node) => `\`${graph.nodes.get(node)?.label ?? node}\``);
      lines.push(`- **${isolated.length} isolated node(s):** ${labels.join(", ")}${isolated.length > 5 ? ` (+${isolated.length - 5} more)` : ""}`);
      lines.push("  These have <=1 connection - possible missing edges or undocumented components.");
    }
    if (thinCommunities.length) lines.push(`- **${thinCommunities.length} thin communities (<${minCommunitySize} nodes) omitted from report** - run graphify query to explore isolated nodes.`);
    if (ambiguousPct > 20) lines.push(`- **High ambiguity: ${ambiguousPct}% of edges are AMBIGUOUS.** Review the Ambiguous Edges section above.`);
  }

  if (suggestedQuestions.length) {
    lines.push("", "## Suggested Questions");
    if (suggestedQuestions.length === 1 && suggestedQuestions[0].type === "no_signal") {
      lines.push(`_${suggestedQuestions[0].why}_`);
    } else {
      lines.push("_Questions this graph is uniquely positioned to answer:_", "");
      for (const question of suggestedQuestions) {
        if (!question.question) continue;
        lines.push(`- **${question.question}**`);
        lines.push(`  _${question.why}_`);
      }
    }
  }

  return lines.join("\n");
}
