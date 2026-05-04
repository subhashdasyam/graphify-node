---
name: graphify
description: "Build, update, and query a project knowledge graph from code, docs, papers, images, and videos. Use when graphify-out/ exists or when the user asks about codebase architecture, project relationships, graphify queries, or /graphify."
trigger: /graphify
---

# graphify

Use the local `graphify` Node CLI to create and query a persistent project knowledge graph.

## Commands

```bash
graphify build .                  # build graphify-out/graph.json, GRAPH_REPORT.md, graph.html
graphify update .                 # deterministic re-extraction after code changes
graphify cluster-only .           # recluster existing graph.json and regenerate report
graphify query "question"         # graph traversal context for a natural-language question
graphify path "A" "B"             # shortest path between two concepts
graphify explain "concept"        # node details and neighbors
graphify tree                     # D3 collapsible tree HTML
graphify benchmark                # token reduction benchmark
graphify add <url>                # fetch URL into ./raw
graphify serve                    # MCP stdio server exposing graph tools
```

If `graphify` is not on PATH, use the installed npm package explicitly:

```bash
npx -p @graphify/node graphify build .
```

## Workflow

When the user asks to run graphify, use `.` if no path is given. Do not ask for a path unless multiple plausible roots exist.

## What You Must Do When Invoked

If invoked as `/graphify .`, `/graphify <path>`, or `/graphify` with no subcommand, run the graphify CLI. Do not manually inspect files and do not hand-write a replacement graph/report.

For a normal build:

```bash
graphify build INPUT_PATH
```

For an update after code edits:

```bash
graphify update INPUT_PATH
```

If `graphify` is missing:

```bash
npx -p @graphify/node graphify build INPUT_PATH
```

Only after the command finishes, summarize the generated files and key report findings. Never create ad hoc files like `.codex/knowledge-graph.md` as a substitute for `graphify-out/`.

Before answering architecture or codebase questions:

1. Check for `graphify-out/wiki/index.md`; if present, use the wiki first.
2. Otherwise read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure.
3. Use `graphify query`, `graphify path`, or `graphify explain` for cross-module relationship questions instead of relying only on search.

After modifying code files, run:

```bash
graphify update .
```

## Output Contract

Primary outputs live under `graphify-out/`:

- `graph.json`
- `GRAPH_REPORT.md`
- `graph.html`
- `manifest.json`
- optional wiki/tree/export artifacts

Edges are tagged `EXTRACTED`, `INFERRED`, or `AMBIGUOUS`. Preserve that audit trail when summarizing graph answers.
