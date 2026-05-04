import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bodyContent,
  buildFromJson,
  detectIncremental,
  fileHash,
  formatBenchmark,
  installPlatform,
  loadCached,
  runBenchmark,
  saveCached,
  saveManifest,
  toCypher,
  toGraphml,
  toWiki,
  validateGraphPath
} from "../src/index.js";

test("Markdown cache hashing ignores frontmatter-only changes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "graphify-ts-cache-"));
  try {
    const file = path.join(dir, "note.md");
    await writeFile(file, "---\ntitle: A\n---\n\n# Body\n\nText\n", "utf8");
    const first = await fileHash(file, dir);
    await writeFile(file, "---\ntitle: B\n---\n\n# Body\n\nText\n", "utf8");
    const second = await fileHash(file, dir);
    assert.equal(first, second);
    assert.equal(new TextDecoder().decode(bodyContent(new TextEncoder().encode("---\na: b\n---\nbody"))), "\nbody");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache roundtrips extraction payloads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "graphify-ts-cache-roundtrip-"));
  try {
    const file = path.join(dir, "main.ts");
    await writeFile(file, "export function run() {}\n", "utf8");
    const payload = {
      nodes: [{ id: "main", label: "main.ts", file_type: "code" as const, source_file: "main.ts" }],
      edges: []
    };
    await saveCached(file, payload, dir);
    assert.deepEqual(await loadCached(file, dir), payload);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateGraphPath allows graph files inside graphify-out and blocks traversal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "graphify-ts-sec-"));
  try {
    const graphDir = path.join(dir, "graphify-out");
    const graphPath = path.join(graphDir, "graph.json");
    const outsidePath = path.join(dir, "outside.json");
    await writeFile(graphPath, "{}", "utf8").catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await (await import("node:fs/promises")).mkdir(graphDir, { recursive: true });
        await writeFile(graphPath, "{}", "utf8");
      } else {
        throw error;
      }
    });
    await writeFile(outsidePath, "{}", "utf8");
    assert.equal(await validateGraphPath(graphPath, graphDir), path.resolve(graphPath));
    await assert.rejects(() => validateGraphPath(outsidePath, graphDir), /escapes the allowed directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manifest incremental detection separates changed and unchanged files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "graphify-ts-manifest-"));
  try {
    const file = path.join(dir, "main.ts");
    const manifest = path.join(dir, "graphify-out", "manifest.json");
    await writeFile(file, "export function run() { return 1; }\n", "utf8");
    const initial = await detectIncremental(dir, manifest);
    assert.equal(initial.new_total, 1);
    await saveManifest(initial.files, manifest);
    const unchanged = await detectIncremental(dir, manifest);
    assert.equal(unchanged.new_total, 0);
    await writeFile(file, "export function run() { return 2; }\n", "utf8");
    const changed = await detectIncremental(dir, manifest);
    assert.equal(changed.new_total, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wiki and export helpers write Python-compatible artifacts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "graphify-ts-export-"));
  try {
    const graph = buildFromJson({
      nodes: [
        { id: "parser", label: "parse", file_type: "code", source_file: "parser.ts", community: 0 },
        { id: "validator", label: "validate", file_type: "code", source_file: "parser.ts", community: 0 }
      ],
      edges: [{ source: "parser", target: "validator", relation: "calls", confidence: "EXTRACTED", source_file: "parser.ts" }]
    });
    const wikiDir = path.join(dir, "wiki");
    const count = await toWiki(graph, { 0: ["parser", "validator"] }, wikiDir, { godNodes: [{ id: "parser", label: "parse", degree: 1 }] });
    assert.equal(count, 2);
    assert.match(await readFile(path.join(wikiDir, "index.md"), "utf8"), /Community 0/);
    const graphml = path.join(dir, "graph.graphml");
    const cypher = path.join(dir, "graph.cypher");
    await toGraphml(graph, { 0: ["parser", "validator"] }, graphml);
    await toCypher(graph, cypher);
    assert.match(await readFile(graphml, "utf8"), /<graphml/);
    assert.match(await readFile(cypher, "utf8"), /MERGE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("benchmark reports token reduction for query subgraphs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "graphify-ts-bench-"));
  try {
    const graphPath = path.join(dir, "graph.json");
    const graph = buildFromJson({
      nodes: [
        { id: "a", label: "extract", file_type: "code", source_file: "extract.ts" },
        { id: "b", label: "cluster", file_type: "code", source_file: "cluster.ts" }
      ],
      edges: [{ source: "a", target: "b", relation: "calls", confidence: "EXTRACTED", source_file: "extract.ts" }]
    });
    await writeFile(graphPath, `${JSON.stringify(graph.toNodeLink(), null, 2)}\n`, "utf8");
    const result = await runBenchmark(graphPath, 10_000, ["extract cluster"]);
    assert(Number(result.reduction_ratio) > 0);
    assert.match(formatBenchmark(result), /token reduction benchmark/);
    assert(await stat(graphPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installPlatform copies the bundled Node skill instead of fallback text", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "graphify-ts-install-"));
  const oldCwd = process.cwd();
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  try {
    const home = path.join(dir, "home");
    const project = path.join(dir, "project");
    await mkdir(project, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.chdir(project);
    await installPlatform("claude");
    const skill = await readFile(path.join(home, ".claude", "skills", "graphify", "SKILL.md"), "utf8");
    assert.match(skill, /What You Must Do When Invoked/);
    assert.match(skill, /Do not manually inspect files and do not hand-write a replacement graph\/report/);
    assert.notEqual(skill.trim(), "# graphify\n\nUse graphify build/update/query/path/explain to manage and query the project knowledge graph.");
    const claude = await readFile(path.join(project, "CLAUDE.md"), "utf8");
    assert.match(claude, /graphify query/);
  } finally {
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
    await rm(dir, { recursive: true, force: true });
  }
});
