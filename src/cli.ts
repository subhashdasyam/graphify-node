#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { formatBenchmark, runBenchmark } from "./benchmark.js";
import { buildFromJson } from "./build.js";
import { installHooks, hookStatus, uninstallHooks } from "./hooks.js";
import { ingest, saveQueryResult } from "./ingest.js";
import { installPlatform, uninstallPlatform } from "./install.js";
import { Graph } from "./graph.js";
import { runBuild, runClusterOnly } from "./pipeline.js";
import { explainNode, queryGraphText, shortestPathText } from "./query.js";
import { serveStdio } from "./serve.js";
import { writeTreeHtml } from "./treeHtml.js";
import type { NodeLinkGraph } from "./types.js";
import { parseFlag, parseOption } from "./utils.js";
import { checkUpdate, watch } from "./watch.js";

const execFileAsync = promisify(execFile);

function usage(): void {
  console.log(`Usage: graphify <command> [args]

Commands:
  build [path]              build graphify-out from code files
    --documents             include lightweight document heading extraction
    --wiki                  also generate graphify-out/wiki markdown
    --wiki-dir PATH         write wiki markdown to PATH
  update [path]             alias for build; deterministic AST/regex only
  cluster-only [path]       recluster existing graphify-out/graph.json
    --wiki                  also regenerate graphify-out/wiki markdown
  query "<question>"        BFS/DFS traversal of graph.json
    --dfs                   use depth-first traversal
    --context C             explicit edge context filter; repeatable
    --budget N              cap output at N approximate tokens
    --graph PATH            graph.json path
  path "A" "B"              shortest path between two node labels
    --graph PATH            graph.json path
  explain "X"               node details and neighbors
    --graph PATH            graph.json path
  merge-graphs G1 G2 ...    merge graph.json files
    --out PATH              output path
  add <url>                 fetch URL into ./raw
  save-result               save Q&A result to graphify-out/memory
  watch [path]              watch and rebuild on code changes
  check-update <path>       print pending semantic-update notice
  tree                      emit D3 collapsible tree HTML
  benchmark [graph.json]    token reduction benchmark
  hook install|uninstall|status
  install [--platform P]    install assistant skill/rules
  <platform> install        claude|codex|opencode|aider|claw|droid|trae|trae-cn|gemini|cursor|vscode|copilot|kiro|pi|antigravity
  clone <github-url>        clone GitHub repo locally
  serve [graph.json]        MCP stdio graph query server
`);
}

function readRepeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === name && i + 1 < args.length) values.push(args[i + 1]);
    else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
  }
  return values;
}

function positionalArgs(args: string[], optionsWithValues: string[] = []): string[] {
  const valueOptions = new Set(optionsWithValues);
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (!arg.includes("=") && valueOptions.has(optionName)) i += 1;
      continue;
    }
    values.push(arg);
  }
  return values;
}

async function loadGraph(graphPath: string): Promise<Graph> {
  const raw = JSON.parse(await readFile(graphPath, "utf8")) as NodeLinkGraph;
  return Graph.fromNodeLink(raw);
}

async function commandBuild(args: string[]): Promise<void> {
  const root = positionalArgs(args, ["--wiki-dir"])[0] ?? ".";
  const wikiDir = parseOption(args, "--wiki-dir");
  const result = await runBuild({
    root,
    noViz: parseFlag(args, "--no-viz"),
    includeDocuments: parseFlag(args, "--documents"),
    wiki: parseFlag(args, "--wiki") || wikiDir !== undefined,
    wikiDir
  });
  console.log(`Built graph: ${result.nodes} nodes, ${result.edges} edges, ${result.communities} communities`);
  console.log(`Report: ${result.reportPath}`);
  console.log(`Graph:  ${result.graphPath}`);
  if (result.htmlPath) console.log(`HTML:   ${result.htmlPath}`);
  if (result.wikiPath) console.log(`Wiki:   ${result.wikiPath}`);
}

async function commandClusterOnly(args: string[]): Promise<void> {
  const root = positionalArgs(args, ["--wiki-dir"])[0] ?? ".";
  const wikiDir = parseOption(args, "--wiki-dir");
  const result = await runClusterOnly(root, {
    noViz: parseFlag(args, "--no-viz"),
    wiki: parseFlag(args, "--wiki") || wikiDir !== undefined,
    wikiDir
  });
  console.log(`Reclustered graph: ${result.nodes} nodes, ${result.edges} edges, ${result.communities} communities`);
  console.log(`Report: ${result.reportPath}`);
  if (result.wikiPath) console.log(`Wiki:   ${result.wikiPath}`);
}

async function commandQuery(args: string[]): Promise<void> {
  const question = args.find((arg) => !arg.startsWith("-"));
  if (!question) throw new Error('Usage: graphify query "<question>" [--graph path]');
  const graphPath = parseOption(args, "--graph", path.join(process.env.GRAPHIFY_OUT ?? "graphify-out", "graph.json"))!;
  const graph = await loadGraph(graphPath);
  const budget = Number(parseOption(args, "--budget", "2000"));
  console.log(queryGraphText(graph, question, {
    mode: parseFlag(args, "--dfs") ? "dfs" : "bfs",
    depth: Number(parseOption(args, "--depth", "2")),
    tokenBudget: Number.isFinite(budget) ? budget : 2000,
    contextFilters: readRepeatedOption(args, "--context")
  }));
}

async function commandPath(args: string[]): Promise<void> {
  const labels = args.filter((arg) => !arg.startsWith("-"));
  if (labels.length < 2) throw new Error('Usage: graphify path "A" "B" [--graph path]');
  const graphPath = parseOption(args, "--graph", path.join(process.env.GRAPHIFY_OUT ?? "graphify-out", "graph.json"))!;
  const graph = await loadGraph(graphPath);
  console.log(shortestPathText(graph, labels[0], labels[1]));
}

async function commandExplain(args: string[]): Promise<void> {
  const label = args.find((arg) => !arg.startsWith("-"));
  if (!label) throw new Error('Usage: graphify explain "X" [--graph path]');
  const graphPath = parseOption(args, "--graph", path.join(process.env.GRAPHIFY_OUT ?? "graphify-out", "graph.json"))!;
  const graph = await loadGraph(graphPath);
  console.log(explainNode(graph, label));
}

async function commandMergeGraphs(args: string[]): Promise<void> {
  const outPath = parseOption(args, "--out", path.join(process.env.GRAPHIFY_OUT ?? "graphify-out", "merged-graph.json"))!;
  const graphPaths: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--out") {
      i += 1;
      continue;
    }
    if (args[i].startsWith("--out=")) continue;
    graphPaths.push(args[i]);
  }
  if (graphPaths.length < 2) throw new Error("Usage: graphify merge-graphs <graph1.json> <graph2.json> [...] [--out merged.json]");
  const merged = new Graph(false);
  for (const graphPath of graphPaths) {
    const graph = await loadGraph(graphPath);
    const repo = path.basename(path.dirname(path.dirname(path.resolve(graphPath))));
    for (const node of graph.nodes.values()) merged.addNode({ ...node, repo });
    for (const edge of graph.edges()) merged.addEdge({ ...edge });
  }
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(merged.toNodeLink(), null, 2)}\n`, "utf8");
  console.log(`Merged ${graphPaths.length} graphs -> ${merged.numberOfNodes()} nodes, ${merged.numberOfEdges()} edges`);
  console.log(`Written to: ${outPath}`);
}

async function commandHook(args: string[]): Promise<void> {
  const sub = args[0] ?? "";
  if (sub === "install") console.log(await installHooks("."));
  else if (sub === "uninstall") console.log(await uninstallHooks("."));
  else if (sub === "status") console.log(await hookStatus("."));
  else throw new Error("Usage: graphify hook [install|uninstall|status]");
}

async function commandInstall(args: string[]): Promise<void> {
  let platform = process.platform === "win32" ? "windows" : "claude";
  const fromArg = parseOption(args, "--platform");
  if (fromArg) platform = fromArg;
  console.log(await installPlatform(platform));
}

async function commandPlatform(platform: string, args: string[]): Promise<void> {
  const sub = args[0] ?? "";
  if (sub === "install") console.log(await installPlatform(platform));
  else if (sub === "uninstall") console.log(await uninstallPlatform(platform));
  else throw new Error(`Usage: graphify ${platform} [install|uninstall]`);
}

async function commandAdd(args: string[]): Promise<void> {
  const url = args[0];
  if (!url) throw new Error("Usage: graphify add <url> [--author Name] [--contributor Name] [--dir ./raw]");
  const targetDir = parseOption(args, "--dir", "raw")!;
  const saved = await ingest(url, targetDir, { author: parseOption(args, "--author"), contributor: parseOption(args, "--contributor") });
  console.log(`Saved to ${saved}`);
}

async function commandSaveResult(args: string[]): Promise<void> {
  const question = parseOption(args, "--question");
  const answer = parseOption(args, "--answer");
  if (!question || !answer) throw new Error("Usage: graphify save-result --question Q --answer A [--type T] [--nodes N1 N2]");
  const nodeIdx = args.indexOf("--nodes");
  const nodes = nodeIdx >= 0 ? args.slice(nodeIdx + 1).filter((arg) => !arg.startsWith("--")) : [];
  const out = await saveQueryResult(question, answer, parseOption(args, "--memory-dir", "graphify-out/memory")!, { queryType: parseOption(args, "--type", "query"), sourceNodes: nodes });
  console.log(`Saved to ${out}`);
}

async function commandTree(args: string[]): Promise<void> {
  const graphPath = parseOption(args, "--graph", path.join(process.env.GRAPHIFY_OUT ?? "graphify-out", "graph.json"))!;
  const outputPath = parseOption(args, "--output", path.join(path.dirname(graphPath), "GRAPH_TREE.html"))!;
  const out = await writeTreeHtml(graphPath, outputPath, {
    root: parseOption(args, "--root"),
    maxChildren: Number(parseOption(args, "--max-children", "200")),
    projectLabel: parseOption(args, "--label")
  });
  console.log(`wrote ${out}`);
}

async function commandBenchmark(args: string[]): Promise<void> {
  const graphPath = args.find((arg) => !arg.startsWith("-")) ?? "graphify-out/graph.json";
  console.log(formatBenchmark(await runBenchmark(graphPath)));
}

async function commandWatch(args: string[]): Promise<void> {
  const root = args.find((arg) => !arg.startsWith("-")) ?? ".";
  await watch(root);
}

async function commandCheckUpdate(args: string[]): Promise<void> {
  const root = args[0] ?? ".";
  await checkUpdate(path.resolve(root));
}

async function commandClone(args: string[]): Promise<void> {
  const url = args[0];
  if (!url) throw new Error("Usage: graphify clone <github-url> [--branch branch] [--out dir]");
  const match = url.replace(/\.git$/, "").match(/github\.com[:/]([^/]+)\/([^/]+)$/);
  if (!match) throw new Error(`not a recognised GitHub URL: ${url}`);
  const dest = parseOption(args, "--out") ?? path.join(os.homedir(), ".graphify", "repos", match[1], match[2]);
  const branch = parseOption(args, "--branch");
  try {
    await readFile(path.join(dest, ".git", "HEAD"));
    const pullArgs = ["-C", dest, "pull"];
    if (branch) pullArgs.push("origin", "--", branch);
    await execFileAsync("git", pullArgs);
  } catch {
    await mkdir(path.dirname(dest), { recursive: true });
    const cloneArgs = ["clone", "--depth", "1"];
    if (branch) cloneArgs.push("--branch", branch);
    cloneArgs.push("--", url.endsWith(".git") ? url : `${url}.git`, dest);
    await execFileAsync("git", cloneArgs);
  }
  console.log(dest);
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command || command === "-h" || command === "--help") {
    usage();
    return;
  }
  const platformCommands = new Set(["claude", "codex", "opencode", "aider", "claw", "droid", "trae", "trae-cn", "hermes", "gemini", "cursor", "vscode", "copilot", "kiro", "pi", "antigravity"]);
  if (!["build", "update", "cluster-only", "query", "path", "explain", "merge-graphs", "hook", "install", "add", "save-result", "watch", "check-update", "tree", "benchmark", "clone", "serve", "hook-check"].includes(command) && !platformCommands.has(command) && !command.startsWith("-")) {
    if (!command.startsWith("-") && command !== "install") {
      await commandBuild([command, ...args]);
      return;
    }
  }
  switch (command) {
    case "build":
    case "update":
      await commandBuild(args);
      break;
    case "cluster-only":
      await commandClusterOnly(args);
      break;
    case "query":
      await commandQuery(args);
      break;
    case "path":
      await commandPath(args);
      break;
    case "explain":
      await commandExplain(args);
      break;
    case "merge-graphs":
      await commandMergeGraphs(args);
      break;
    case "hook":
      await commandHook(args);
      break;
    case "install":
      await commandInstall(args);
      break;
    case "add":
      await commandAdd(args);
      break;
    case "save-result":
      await commandSaveResult(args);
      break;
    case "watch":
      await commandWatch(args);
      break;
    case "check-update":
      await commandCheckUpdate(args);
      break;
    case "tree":
      await commandTree(args);
      break;
    case "benchmark":
      await commandBenchmark(args);
      break;
    case "clone":
      await commandClone(args);
      break;
    case "serve":
      await serveStdio(args[0] ?? "graphify-out/graph.json");
      break;
    case "hook-check":
      break;
    default:
      if (platformCommands.has(command)) await commandPlatform(command, args);
      else {
        usage();
        process.exitCode = 1;
      }
  }
}

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
