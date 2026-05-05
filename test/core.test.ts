import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFromJson, extractFiles, queryGraphText, runBuild, shortestPathText } from "../src/index.js";
import { makeId } from "../src/utils.js";

test("makeId normalizes identifiers like the Python implementation", () => {
  assert.equal(makeId("_auth"), "auth");
  assert.equal(makeId(".httpx._client"), "httpx_client");
  assert.equal(makeId("foo", "Bar"), "foo_bar");
});

test("extractFiles finds Python classes, functions, and calls", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "graphify-ts-"));
  try {
    const file = path.join(dir, "sample.py");
    await writeFile(file, "class Transformer:\n    def forward(self):\n        normalize()\n\ndef normalize():\n    return 1\n");
    const extraction = await extractFiles([file], { root: dir });
    const labels = extraction.nodes.map((node) => node.label);
    assert(labels.includes("Transformer"));
    assert(labels.includes(".forward()"));
    assert(labels.includes("normalize()"));
    assert(extraction.edges.some((edge) => edge.relation === "calls" && ["EXTRACTED", "STATIC_RESOLVED"].includes(edge.confidence)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extractFiles uses tree-sitter when a bundled grammar is available", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "graphify-ts-tree-sitter-"));
  try {
    const file = path.join(dir, "main.ts");
    await writeFile(file, "export function helper() { return 1; }\nexport function run() { return helper(); }\n");
    const extraction = await extractFiles([file], { root: dir });
    assert(extraction.nodes.some((node) => node.parser === "tree-sitter" && node.language === "typescript"));
    assert(extraction.edges.some((edge) => edge.relation === "calls" && edge.confidence === "STATIC_RESOLVED"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildFromJson accepts node-link graph data and query context filters", () => {
  const graph = buildFromJson({
    nodes: [
      { id: "n1", label: "extract", file_type: "code", source_file: "extract.ts" },
      { id: "n2", label: "cluster", file_type: "code", source_file: "cluster.ts" },
      { id: "n3", label: "build", file_type: "code", source_file: "build.ts" }
    ],
    edges: [
      { source: "n1", target: "n2", relation: "calls", confidence: "EXTRACTED", context: "call", source_file: "extract.ts" },
      { source: "n2", target: "n3", relation: "imports", confidence: "EXTRACTED", context: "import", source_file: "cluster.ts" }
    ]
  });
  const output = queryGraphText(graph, "who calls extract", { contextFilters: ["call"] });
  assert.match(output, /Context: call \(explicit\)/);
  assert.match(output, /cluster/);
  assert.doesNotMatch(output, /build/);
});

test("shortestPathText renders relations", () => {
  const graph = buildFromJson({
    nodes: [
      { id: "n1", label: "A", file_type: "code", source_file: "a.ts" },
      { id: "n2", label: "B", file_type: "code", source_file: "b.ts" }
    ],
    edges: [{ source: "n1", target: "n2", relation: "calls", confidence: "EXTRACTED", source_file: "a.ts" }]
  });
  assert.match(shortestPathText(graph, "A", "B"), /--calls \[EXTRACTED\]-->/);
});

test("runBuild writes graph outputs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "graphify-ts-build-"));
  try {
    await writeFile(path.join(dir, "main.ts"), "export function helper() { return 1; }\nexport function run() { return helper(); }\n");
    const result = await runBuild({ root: dir, noViz: true, wiki: true });
    assert(result.nodes >= 3);
    assert(result.edges >= 2);
    const graphJson = await readFile(result.graphPath, "utf8");
    assert.match(graphJson, /helper/);
    const report = await readFile(result.reportPath, "utf8");
    assert.match(report, /Graph Report/);
    assert(result.wikiPath);
    const wikiIndex = await readFile(path.join(result.wikiPath, "index.md"), "utf8");
    assert.match(wikiIndex, /Knowledge Graph Index/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
