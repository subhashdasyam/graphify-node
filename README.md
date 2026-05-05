# graphify-node

Node/TypeScript port of `graphify`, packaged as an npm CLI.

`graphify-node` builds and queries a persistent knowledge graph for a project.
It is intended to work on Windows, macOS, and Linux with Node.js 20 or newer.

The package installs two binaries:

- `graphify` - primary CLI, intended to behave like Python `graphify`
- `graphify-ts` - compatibility/development alias for side-by-side testing

## Requirements

- Node.js `>=20`
- npm
- Git, if using `graphify hook install`
- Git for Windows on Windows, if using Git hooks

Optional external tools:

- `yt-dlp` for downloading video/audio URLs
- `whisper-ctranslate2` or `whisper` for transcription

## Installation

### Global Install From This Checkout

From the `graphify-node` folder:

```bash
npm install -g .
```

Then verify:

```bash
graphify --help
graphify build . --no-viz
```

### Global Install With Symlink During Development

Useful while editing this repo:

```bash
npm ci
npm run build
npm link
graphify --help
```

### Run Without Installing Globally

From inside `graphify-node`:

```bash
npm ci
npm run build
node dist/src/cli.js --help
node dist/src/cli.js build . --no-viz
```

After publishing to npm, users can run without global install:

```bash
npx -p @graphify/node graphify build .
```

## Package Layout

```text
graphify-node/
  src/                 TypeScript source
  test/                Node test suite
  skills/skill.md      bundled assistant skill installed by graphify install
  package.json         npm package metadata and bin definitions
  tsconfig.json
```

Generated files:

```text
dist/                  created by npm run build
node_modules/          created by npm ci / npm install
```

These generated folders are not source.

## Build And Test

```bash
npm ci
npm run build
npm test
npm pack --dry-run
```

Current local test coverage includes:

- extraction/build/query core behavior
- cache behavior
- manifest incremental detection
- graph path safety
- wiki/export helpers
- benchmark helper
- bundled skill install regression

## Basic Usage

Build a graph for the current project:

```bash
graphify build .
```

Update after code changes:

```bash
graphify update .
```

Skip HTML visualization:

```bash
graphify build . --no-viz
```

Include lightweight document heading extraction:

```bash
graphify build . --documents
```

Generate an agent-crawlable markdown wiki:

```bash
graphify build . --wiki
```

Primary outputs:

```text
graphify-out/
  graph.json
  GRAPH_REPORT.md
  graph.html
  wiki/
    index.md
  manifest.json
```

## Querying

Ask for graph context:

```bash
graphify query "who calls helper"
```

Use DFS instead of BFS:

```bash
graphify query "trace request flow" --dfs
```

Limit output size:

```bash
graphify query "authentication flow" --budget 1500
```

Use a custom graph path:

```bash
graphify query "who calls helper" --graph graphify-out/graph.json
```

Shortest path:

```bash
graphify path "AuthModule" "Database"
```

Explain a node:

```bash
graphify explain "SwinTransformer"
```

## CLI Commands

```text
graphify build [path]
  --wiki
graphify update [path]
graphify cluster-only [path]
graphify query "<question>"
graphify path "A" "B"
graphify explain "X"
graphify merge-graphs G1 G2 ... --out merged.json
graphify add <url>
graphify save-result --question Q --answer A
graphify watch [path]
graphify check-update [path]
graphify tree
graphify benchmark [graph.json]
graphify hook install|uninstall|status
graphify install [--platform P]
graphify <platform> install|uninstall
graphify clone <github-url>
graphify serve [graph.json]
```

Supported platform commands:

```text
claude
codex
opencode
aider
claw
droid
trae
trae-cn
hermes
gemini
cursor
vscode
copilot
kiro
pi
antigravity
```

## Assistant Skill Installation

Default install:

```bash
graphify install
```

On Linux/macOS, the default platform is `claude`. On Windows, the default
platform is `windows`.

Install for a specific platform:

```bash
graphify install --platform codex
graphify install --platform claude
graphify install --platform cursor
```

Equivalent platform-specific commands:

```bash
graphify claude install
graphify codex install
graphify cursor install
graphify gemini install
graphify vscode install
```

Uninstall:

```bash
graphify claude uninstall
graphify codex uninstall
graphify cursor uninstall
```

The installer writes:

- a global or project assistant skill/rule file for the selected platform
- local project guidance where the platform expects it, such as `CLAUDE.md`,
  `AGENTS.md`, `GEMINI.md`, `.cursor/rules/graphify.mdc`, or VS Code Copilot
  instructions

The bundled skill tells agents to call the `graphify` CLI directly. It also
uses this npm fallback if `graphify` is not on `PATH`:

```bash
npx -p @graphify/node graphify build .
```

## Git Hooks

Install hooks in the nearest Git repository:

```bash
graphify hook install
```

Check status:

```bash
graphify hook status
```

Uninstall:

```bash
graphify hook uninstall
```

Installed hooks:

- `post-commit` - starts `graphify update .` after commits
- `post-checkout` - starts `graphify update .` after branch switches

Hook behavior:

- Uses `graphify` or `graphify-ts` from `PATH` when available.
- Falls back to the exact Node executable and CLI file that installed the hook.
- Appends to existing hooks instead of overwriting them.
- Re-running `graphify hook install` updates the existing graphify hook block.
- Respects custom Git `core.hooksPath`.

Windows note: Git hooks require Git for Windows or another Git distribution that
can execute standard hook shell scripts.

## URL Ingestion

Fetch a URL into `./raw`:

```bash
graphify add https://example.com/article
```

With metadata:

```bash
graphify add https://example.com/article --author "Author Name" --contributor "Your Name"
```

Custom directory:

```bash
graphify add https://example.com/article --dir raw
```

Supported URL handling includes webpages, tweets, arXiv pages, PDFs, images, and
YouTube/audio URLs when `yt-dlp` is installed.

## Exports

The build command writes JSON, Markdown report, and HTML by default.

Additional helpers are available through the library and supporting commands:

- JSON node-link graph
- interactive HTML graph
- Cypher
- GraphML
- Obsidian Canvas
- SVG
- wiki markdown
- D3 collapsible tree HTML

Tree export:

```bash
graphify tree --graph graphify-out/graph.json --output graphify-out/GRAPH_TREE.html
```

## MCP Server

Start the MCP-style stdio server:

```bash
graphify serve graphify-out/graph.json
```

Exposed tool names:

```text
query_graph
get_node
get_neighbors
get_community
god_nodes
graph_stats
shortest_path
```

The server supports JSON-RPC initialization, `tools/list`, and `tools/call`.

## Cross-Platform Notes

The code is written to run on:

- Windows
- macOS
- Linux

Platform handling:

- Uses Node `path` and `os` APIs for filesystem paths.
- npm creates the correct command shims:
  - Linux/macOS: shell shims
  - Windows: `.cmd` shims
- Hook installer embeds a fallback to the installing Node executable and CLI file.
- External commands such as Whisper use Windows shell mode when needed.
- Git hooks on Windows require Git for Windows.

Recommended verification matrix:

```bash
npm ci
npm test
npm pack --dry-run
graphify --help
graphify hook install
graphify hook status
graphify hook uninstall
```

Run that on:

- `ubuntu-latest`
- `macos-latest`
- `windows-latest`

## Local Smoke Tests

Create a small project and build a graph:

```bash
tmp=$(mktemp -d)
cat > "$tmp/main.ts" <<'EOF'
export function helper() { return 1; }
export function run() { return helper(); }
EOF

graphify build "$tmp" --no-viz
graphify query "who calls helper" --graph "$tmp/graphify-out/graph.json"
graphify path "run" "helper" --graph "$tmp/graphify-out/graph.json"
```

Hook smoke test:

```bash
tmp=$(mktemp -d)
git -C "$tmp" init
cd "$tmp"

graphify hook install
graphify hook status
ls .git/hooks/post-commit .git/hooks/post-checkout
graphify hook uninstall
```

PowerShell version:

```powershell
$tmp = New-Item -ItemType Directory -Path ([System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.Guid]::NewGuid()))
Set-Content -Path "$tmp\main.ts" -Value "export function helper() { return 1; }`nexport function run() { return helper(); }"
graphify build "$tmp" --no-viz
graphify query "who calls helper" --graph "$tmp\graphify-out\graph.json"
```

## Publishing Checklist

Before publishing:

```bash
npm ci
npm test
npm pack --dry-run --json
```

Install the generated tarball into a fresh project:

```bash
npm pack
tmp=$(mktemp -d)
cd "$tmp"
npm init -y
npm install /path/to/graphify-node/graphify-node-0.1.0.tgz
npx graphify --help
npx graphify build . --no-viz
```

After publishing:

```bash
npm install -g @graphify/node
graphify --help
npx -p @graphify/node graphify --help
```

## Troubleshooting

### `graphify` Is Not Found

Check npm global prefix:

```bash
npm prefix -g
```

Make sure the global binary directory is on `PATH`:

- Linux/macOS: `$(npm prefix -g)/bin`
- Windows: `$(npm prefix -g)`

Temporary fallback:

```bash
npx -p @graphify/node graphify --help
```

### Claude Loaded The Old Minimal Skill

Reinstall the skill:

```bash
graphify install --platform claude
```

Then start a fresh Claude Code session so the skill is reloaded.

The correct installed skill contains:

```text
What You Must Do When Invoked
Do not manually inspect files and do not hand-write a replacement graph/report.
```

### Hooks Do Not Fire

Check hook status:

```bash
graphify hook status
```

Inspect Git hook path:

```bash
git config core.hooksPath
git rev-parse --git-path hooks
```

Reinstall:

```bash
graphify hook install
```

### Hook Runs But Cannot Find `graphify`

Reinstall hooks from a shell where `graphify` works:

```bash
graphify --help
graphify hook install
```

The hook block stores a fallback to the installing Node executable and CLI file.

### Windows Hook Notes

Use Git for Windows. Run the hook commands from a Git Bash or PowerShell session
where `graphify --help` works.

## Development Notes

Main modules:

```text
src/detect.ts       file detection and manifest helpers
src/extract.ts      structural extraction
src/build.ts        graph construction
src/cluster.ts      community assignment
src/analyze.ts      god nodes, surprises, questions
src/report.ts       GRAPH_REPORT.md generation
src/export.ts       JSON/HTML/Cypher/GraphML/Canvas/SVG helpers
src/query.ts        query/path/explain behavior
src/cli.ts          command-line entrypoint
src/install.ts      assistant platform installs
src/hooks.ts        Git hook install/status/uninstall
src/serve.ts        MCP-style stdio server
```

Keep generated `dist/` out of source reviews unless publishing artifacts are
explicitly requested.
