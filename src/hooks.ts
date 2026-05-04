import { execFile } from "node:child_process";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HOOK_MARKER = "# graphify-hook-start";
const HOOK_MARKER_END = "# graphify-hook-end";
const CHECKOUT_MARKER = "# graphify-checkout-hook-start";
const CHECKOUT_MARKER_END = "# graphify-checkout-hook-end";

interface HookFallback {
  node: string;
  cli: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function currentHookFallback(): HookFallback {
  return {
    node: process.execPath,
    cli: path.resolve(process.argv[1] ?? "")
  };
}

function graphifyCommandBlock(fallback: HookFallback): string {
  return `\
GRAPHIFY_TS_BIN=$(command -v graphify-ts 2>/dev/null || command -v graphify 2>/dev/null)
GRAPHIFY_NODE=${shellQuote(fallback.node)}
GRAPHIFY_CLI=${shellQuote(fallback.cli)}
if [ -z "$GRAPHIFY_TS_BIN" ] && [ ! -f "$GRAPHIFY_CLI" ]; then
  exit 0
fi`;
}

const runGraphifyUpdateDetached = `\
if command -v nohup >/dev/null 2>&1; then
  if [ -n "$GRAPHIFY_TS_BIN" ]; then
    nohup "$GRAPHIFY_TS_BIN" update . > "$_GRAPHIFY_LOG" 2>&1 < /dev/null &
  else
    nohup "$GRAPHIFY_NODE" "$GRAPHIFY_CLI" update . > "$_GRAPHIFY_LOG" 2>&1 < /dev/null &
  fi
else
  if [ -n "$GRAPHIFY_TS_BIN" ]; then
    "$GRAPHIFY_TS_BIN" update . > "$_GRAPHIFY_LOG" 2>&1 < /dev/null &
  else
    "$GRAPHIFY_NODE" "$GRAPHIFY_CLI" update . > "$_GRAPHIFY_LOG" 2>&1 < /dev/null &
  fi
fi`;

function hookScript(fallback: HookFallback): string {
  return `\
# graphify-hook-start
# Auto-rebuilds the knowledge graph after each commit (code files only, no LLM needed).
# Installed by: graphify hook install

GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
[ -d "$GIT_DIR/rebase-merge" ] && exit 0
[ -d "$GIT_DIR/rebase-apply" ] && exit 0
[ -f "$GIT_DIR/MERGE_HEAD" ] && exit 0
[ -f "$GIT_DIR/CHERRY_PICK_HEAD" ] && exit 0

CHANGED=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || git diff --name-only HEAD 2>/dev/null)
[ -z "$CHANGED" ] && exit 0

${graphifyCommandBlock(fallback)}
_GRAPHIFY_LOG=$(git rev-parse --git-path graphify-rebuild.log 2>/dev/null || printf '%s\\n' ".git/graphify-rebuild.log")
mkdir -p "$(dirname "$_GRAPHIFY_LOG")"
echo "[graphify hook] launching background rebuild (log: $_GRAPHIFY_LOG)"
${runGraphifyUpdateDetached}
disown 2>/dev/null || true
# graphify-hook-end
`;
}

function checkoutScript(fallback: HookFallback): string {
  return `\
# graphify-checkout-hook-start
# Auto-rebuilds the knowledge graph when switching branches.
# Installed by: graphify hook install

BRANCH_SWITCH=$3
[ "$BRANCH_SWITCH" != "1" ] && exit 0
[ ! -d "graphify-out" ] && exit 0
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
[ -d "$GIT_DIR/rebase-merge" ] && exit 0
[ -d "$GIT_DIR/rebase-apply" ] && exit 0
[ -f "$GIT_DIR/MERGE_HEAD" ] && exit 0
[ -f "$GIT_DIR/CHERRY_PICK_HEAD" ] && exit 0

${graphifyCommandBlock(fallback)}
_GRAPHIFY_LOG=$(git rev-parse --git-path graphify-rebuild.log 2>/dev/null || printf '%s\\n' ".git/graphify-rebuild.log")
mkdir -p "$(dirname "$_GRAPHIFY_LOG")"
echo "[graphify] Branch switched - launching background rebuild (log: $_GRAPHIFY_LOG)"
${runGraphifyUpdateDetached}
disown 2>/dev/null || true
# graphify-checkout-hook-end
`;
}

export async function gitRoot(start = "."): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", path.resolve(start), "rev-parse", "--show-toplevel"]);
    const root = stdout.trim();
    if (root) return path.resolve(root);
  } catch {
    // fall back to walking for environments where git is unavailable
  }
  let current = path.resolve(start);
  while (true) {
    try {
      await access(path.join(current, ".git"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

async function hooksDir(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "config", "core.hooksPath"]);
    const custom = stdout.trim();
    if (custom) {
      const dir = path.isAbsolute(custom) ? custom : path.join(root, custom);
      await mkdir(dir, { recursive: true });
      return dir;
    }
  } catch {
    // use default
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "--git-path", "hooks"]);
    const resolved = stdout.trim();
    if (resolved) {
      const dir = path.isAbsolute(resolved) ? resolved : path.join(root, resolved);
      await mkdir(dir, { recursive: true });
      return dir;
    }
  } catch {
    // use conventional .git/hooks fallback
  }
  const dir = path.join(root, ".git", "hooks");
  await mkdir(dir, { recursive: true });
  return dir;
}

async function installOne(dir: string, name: string, script: string, marker: string, markerEnd: string): Promise<string> {
  const hookPath = path.join(dir, name);
  const existing = await readFile(hookPath, "utf8").catch(() => null);
  if (existing !== null) {
    if (existing.includes(marker)) {
      const replaced = existing.replace(new RegExp(`${escapeRegExp(marker)}[\\s\\S]*?${escapeRegExp(markerEnd)}\\n?`, "g"), script);
      if (replaced === existing) return `already installed at ${hookPath}`;
      await writeFile(hookPath, `${replaced.trimEnd()}\n`, "utf8");
      await chmod(hookPath, 0o755);
      return `updated existing ${name} hook at ${hookPath}`;
    }
    await writeFile(hookPath, `${existing.trimEnd()}\n\n${script}`, "utf8");
    await chmod(hookPath, 0o755);
    return `appended to existing ${name} hook at ${hookPath}`;
  }
  await writeFile(hookPath, `#!/bin/sh\n${script}`, "utf8");
  await chmod(hookPath, 0o755);
  return `installed at ${hookPath}`;
}

async function uninstallOne(dir: string, name: string, marker: string, markerEnd: string): Promise<string> {
  const hookPath = path.join(dir, name);
  const existing = await readFile(hookPath, "utf8").catch(() => null);
  if (existing === null) return `no ${name} hook found - nothing to remove.`;
  if (!existing.includes(marker)) return `graphify hook not found in ${name} - nothing to remove.`;
  const cleaned = existing.replace(new RegExp(`${escapeRegExp(marker)}[\\s\\S]*?${escapeRegExp(markerEnd)}\\n?`, "g"), "").trim();
  if (!cleaned || cleaned === "#!/bin/sh" || cleaned === "#!/bin/bash") {
    await rm(hookPath, { force: true });
    return `removed ${name} hook at ${hookPath}`;
  }
  await writeFile(hookPath, `${cleaned}\n`, "utf8");
  return `graphify removed from ${name} at ${hookPath} (other hook content preserved)`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function installHooks(start = "."): Promise<string> {
  const root = await gitRoot(start);
  if (!root) throw new Error(`No git repository found at or above ${path.resolve(start)}`);
  const dir = await hooksDir(root);
  const fallback = currentHookFallback();
  const commit = await installOne(dir, "post-commit", hookScript(fallback), HOOK_MARKER, HOOK_MARKER_END);
  const checkout = await installOne(dir, "post-checkout", checkoutScript(fallback), CHECKOUT_MARKER, CHECKOUT_MARKER_END);
  return `post-commit: ${commit}\npost-checkout: ${checkout}`;
}

export async function uninstallHooks(start = "."): Promise<string> {
  const root = await gitRoot(start);
  if (!root) throw new Error(`No git repository found at or above ${path.resolve(start)}`);
  const dir = await hooksDir(root);
  const commit = await uninstallOne(dir, "post-commit", HOOK_MARKER, HOOK_MARKER_END);
  const checkout = await uninstallOne(dir, "post-checkout", CHECKOUT_MARKER, CHECKOUT_MARKER_END);
  return `post-commit: ${commit}\npost-checkout: ${checkout}`;
}

export async function hookStatus(start = "."): Promise<string> {
  const root = await gitRoot(start);
  if (!root) return "Not in a git repository.";
  const dir = await hooksDir(root);
  async function check(name: string, marker: string): Promise<string> {
    const existing = await readFile(path.join(dir, name), "utf8").catch(() => null);
    if (existing === null) return "not installed";
    return existing.includes(marker) ? "installed" : "not installed (hook exists but graphify not found)";
  }
  return `post-commit: ${await check("post-commit", HOOK_MARKER)}\npost-checkout: ${await check("post-checkout", CHECKOUT_MARKER)}`;
}
