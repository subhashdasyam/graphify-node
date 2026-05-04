import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { godNodes, suggestQuestions, surprisingConnections } from "./analyze.js";
import { buildFromJson } from "./build.js";
import { applyCommunities, cluster, labelCommunities, scoreAll } from "./cluster.js";
import { detect, saveManifest } from "./detect.js";
import { toHtml, toJson, writeReport } from "./export.js";
import { extractFiles } from "./extract.js";
import { generateReport } from "./report.js";
import type { DetectionResult } from "./types.js";

export interface BuildOptions {
  root?: string;
  outDir?: string;
  noViz?: boolean;
  includeDocuments?: boolean;
}

export interface BuildResult {
  graphPath: string;
  reportPath: string;
  htmlPath?: string;
  nodes: number;
  edges: number;
  communities: number;
  detection: DetectionResult;
}

export async function runBuild(options: BuildOptions = {}): Promise<BuildResult> {
  const root = path.resolve(options.root ?? ".");
  const outDir = path.resolve(root, options.outDir ?? process.env.GRAPHIFY_OUT ?? "graphify-out");
  const detection = await detect(root);
  const files = [
    ...detection.files.code,
    ...(options.includeDocuments ? detection.files.document : [])
  ];
  const extraction = await extractFiles(files, { root });
  const graph = buildFromJson(extraction);
  const communities = cluster(graph);
  applyCommunities(graph, communities);
  const cohesion = scoreAll(graph, communities);
  const labels = labelCommunities(graph, communities);
  const gods = godNodes(graph);
  const surprises = surprisingConnections(graph, communities);
  const questions = suggestQuestions(graph, communities, labels);
  const report = generateReport({
    graph,
    communities,
    cohesionScores: cohesion,
    communityLabels: labels,
    godNodes: gods,
    surprises,
    detection,
    tokenCost: { input: 0, output: 0 },
    root: path.basename(root) || root,
    suggestedQuestions: questions
  });

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, ".graphify_root"), root, "utf8");
  const graphPath = path.join(outDir, "graph.json");
  const reportPath = path.join(outDir, "GRAPH_REPORT.md");
  await toJson(graph, communities, graphPath);
  await saveManifest(detection.files, path.join(outDir, "manifest.json"));
  await writeReport(reportPath, report);
  let htmlPath: string | undefined;
  if (!options.noViz) {
    htmlPath = path.join(outDir, "graph.html");
    await toHtml(graph, communities, htmlPath, labels);
  }

  return {
    graphPath,
    reportPath,
    htmlPath,
    nodes: graph.numberOfNodes(),
    edges: graph.numberOfEdges(),
    communities: Object.keys(communities).length,
    detection
  };
}

export async function runClusterOnly(root = ".", options: { noViz?: boolean } = {}): Promise<BuildResult> {
  const resolvedRoot = path.resolve(root);
  const outDir = path.resolve(resolvedRoot, process.env.GRAPHIFY_OUT ?? "graphify-out");
  const graphPath = path.join(outDir, "graph.json");
  const raw = JSON.parse(await (await import("node:fs/promises")).readFile(graphPath, "utf8"));
  const graph = buildFromJson(raw, { directed: Boolean(raw.directed) });
  const communities = cluster(graph);
  applyCommunities(graph, communities);
  const cohesion = scoreAll(graph, communities);
  const labels = labelCommunities(graph, communities);
  const gods = godNodes(graph);
  const surprises = surprisingConnections(graph, communities);
  const questions = suggestQuestions(graph, communities, labels);
  const detection = {
    files: { code: [], document: [], paper: [], image: [], video: [] },
    total_files: 0,
    total_words: 0,
    needs_graph: true,
    warning: "cluster-only mode - file stats not available",
    skipped_sensitive: [],
    graphifyignore_patterns: 0
  };
  const report = generateReport({
    graph,
    communities,
    cohesionScores: cohesion,
    communityLabels: labels,
    godNodes: gods,
    surprises,
    detection,
    root: path.basename(resolvedRoot) || resolvedRoot,
    suggestedQuestions: questions
  });
  const reportPath = path.join(outDir, "GRAPH_REPORT.md");
  await toJson(graph, communities, graphPath);
  await writeReport(reportPath, report);
  let htmlPath: string | undefined;
  if (!options.noViz) {
    htmlPath = path.join(outDir, "graph.html");
    await toHtml(graph, communities, htmlPath, labels);
  }
  return {
    graphPath,
    reportPath,
    htmlPath,
    nodes: graph.numberOfNodes(),
    edges: graph.numberOfEdges(),
    communities: Object.keys(communities).length,
    detection
  };
}
