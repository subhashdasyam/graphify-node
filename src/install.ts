import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const graphifySection = `## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer graphify query "<question>", graphify path "<A>" "<B>", or graphify explain "<concept>" over grep
- After modifying code files in this session, run graphify update . to keep the graph current
`;

const platformConfig: Record<string, { skillFile: string; skillDst: string; localFile?: string }> = {
  claude: { skillFile: "skill.md", skillDst: ".claude/skills/graphify/SKILL.md", localFile: "CLAUDE.md" },
  windows: { skillFile: "skill-windows.md", skillDst: ".claude/skills/graphify/SKILL.md", localFile: "CLAUDE.md" },
  codex: { skillFile: "skill-codex.md", skillDst: ".agents/skills/graphify/SKILL.md", localFile: "AGENTS.md" },
  opencode: { skillFile: "skill-opencode.md", skillDst: ".config/opencode/skills/graphify/SKILL.md", localFile: "AGENTS.md" },
  aider: { skillFile: "skill-aider.md", skillDst: ".aider/graphify/SKILL.md", localFile: "AGENTS.md" },
  copilot: { skillFile: "skill-copilot.md", skillDst: ".copilot/skills/graphify/SKILL.md" },
  claw: { skillFile: "skill-claw.md", skillDst: ".openclaw/skills/graphify/SKILL.md", localFile: "AGENTS.md" },
  droid: { skillFile: "skill-droid.md", skillDst: ".factory/skills/graphify/SKILL.md", localFile: "AGENTS.md" },
  trae: { skillFile: "skill-trae.md", skillDst: ".trae/skills/graphify/SKILL.md", localFile: "AGENTS.md" },
  "trae-cn": { skillFile: "skill-trae.md", skillDst: ".trae-cn/skills/graphify/SKILL.md", localFile: "AGENTS.md" },
  hermes: { skillFile: "skill-claw.md", skillDst: ".hermes/skills/graphify/SKILL.md", localFile: "AGENTS.md" },
  kiro: { skillFile: "skill-kiro.md", skillDst: ".kiro/skills/graphify/SKILL.md" },
  pi: { skillFile: "skill-pi.md", skillDst: ".pi/agent/skills/graphify/SKILL.md" },
  antigravity: { skillFile: "skill.md", skillDst: ".agents/skills/graphify/SKILL.md" }
};

async function bundledSkillPath(skillFile: string): Promise<string | null> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "..", "skills", skillFile),
    path.resolve(moduleDir, "..", "skills", "skill.md"),
    path.resolve(moduleDir, "..", "..", "skills", skillFile),
    path.resolve(moduleDir, "..", "..", "skills", "skill.md"),
    path.resolve(process.cwd(), "skills", skillFile),
    path.resolve(process.cwd(), "skills", "skill.md"),
    path.resolve(process.cwd(), "graphify", skillFile),
    path.resolve(process.cwd(), "..", "graphify", skillFile)
  ];
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return null;
}

async function writeFallbackSkill(dst: string): Promise<void> {
  await mkdir(path.dirname(dst), { recursive: true });
  await writeFile(dst, `# graphify\n\nUse graphify build/update/query/path/explain to manage and query the project knowledge graph.\n`, "utf8");
}

async function installSkill(platform: string): Promise<string> {
  const cfg = platformConfig[platform];
  if (!cfg) throw new Error(`unknown platform '${platform}'. Choose from: ${Object.keys(platformConfig).join(", ")}, gemini, cursor, vscode`);
  const dst = path.join(os.homedir(), cfg.skillDst);
  await mkdir(path.dirname(dst), { recursive: true });
  const src = await bundledSkillPath(cfg.skillFile);
  if (src) {
    await copyFile(src, dst);
  } else {
    await writeFallbackSkill(dst);
  }
  return dst;
}

async function addLocalSection(file: string): Promise<string> {
  const existing = await readFile(file, "utf8").catch(() => "");
  if (existing.includes("## graphify")) return `${file} already configured`;
  await writeFile(file, existing ? `${existing.trimEnd()}\n\n${graphifySection}` : graphifySection, "utf8");
  return `graphify section written to ${path.resolve(file)}`;
}

async function removeLocalSection(file: string): Promise<string> {
  const existing = await readFile(file, "utf8").catch(() => null);
  if (existing === null) return `No ${file} found - nothing to do`;
  if (!existing.includes("## graphify")) return `graphify section not found in ${file} - nothing to do`;
  const cleaned = existing.replace(/\n*## graphify\n[\s\S]*?(?=\n## |\s*$)/, "").trim();
  if (cleaned) await writeFile(file, `${cleaned}\n`, "utf8");
  else await rm(file, { force: true });
  return `graphify section removed from ${path.resolve(file)}`;
}

export async function installPlatform(platform = os.platform() === "win32" ? "windows" : "claude"): Promise<string> {
  if (platform === "cursor") return cursorInstall();
  if (platform === "gemini") return geminiInstall();
  if (platform === "vscode") return vscodeInstall();
  const cfg = platformConfig[platform];
  const skill = await installSkill(platform);
  const lines = [`skill installed -> ${skill}`];
  if (cfg.localFile) lines.push(await addLocalSection(cfg.localFile));
  if (platform === "opencode") lines.push(await opencodePluginInstall());
  return lines.join("\n");
}

export async function uninstallPlatform(platform: string): Promise<string> {
  if (platform === "cursor") return cursorUninstall();
  if (platform === "gemini") return geminiUninstall();
  if (platform === "vscode") return vscodeUninstall();
  const cfg = platformConfig[platform];
  if (!cfg) throw new Error(`unknown platform '${platform}'`);
  const lines: string[] = [];
  if (cfg.localFile) lines.push(await removeLocalSection(cfg.localFile));
  const skill = path.join(os.homedir(), cfg.skillDst);
  await rm(skill, { force: true });
  lines.push(`skill removed -> ${skill}`);
  if (platform === "opencode") lines.push(await opencodePluginUninstall());
  return lines.join("\n");
}

export async function cursorInstall(): Promise<string> {
  const file = path.join(".cursor", "rules", "graphify.mdc");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `---\ndescription: graphify knowledge graph context\nalwaysApply: true\n---\n\n${graphifySection}`, "utf8");
  return `graphify rule written to ${path.resolve(file)}`;
}

export async function cursorUninstall(): Promise<string> {
  const file = path.join(".cursor", "rules", "graphify.mdc");
  await rm(file, { force: true });
  return `graphify Cursor rule removed from ${path.resolve(file)}`;
}

export async function geminiInstall(): Promise<string> {
  const local = await addLocalSection("GEMINI.md");
  const settingsPath = path.join(".gemini", "settings.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const settings = JSON.parse(await readFile(settingsPath, "utf8").catch(() => "{}"));
  settings.hooks ??= {};
  settings.hooks.BeforeTool = [...(settings.hooks.BeforeTool ?? []).filter((h: unknown) => !String(JSON.stringify(h)).includes("graphify")), { matcher: "read_file|list_directory", hooks: [{ type: "command", command: "graphify hook-check" }] }];
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  return `${local}\n.gemini/settings.json -> BeforeTool hook registered`;
}

export async function geminiUninstall(): Promise<string> {
  return removeLocalSection("GEMINI.md");
}

export async function vscodeInstall(): Promise<string> {
  const file = path.join(".github", "copilot-instructions.md");
  await mkdir(path.dirname(file), { recursive: true });
  return addLocalSection(file);
}

export async function vscodeUninstall(): Promise<string> {
  return removeLocalSection(path.join(".github", "copilot-instructions.md"));
}

async function opencodePluginInstall(): Promise<string> {
  const plugin = path.join(".opencode", "plugins", "graphify.js");
  await mkdir(path.dirname(plugin), { recursive: true });
  await writeFile(plugin, `import { existsSync } from "fs";\nimport { join } from "path";\nexport const GraphifyPlugin = async ({ directory }) => ({ "tool.execute.before": async (input, output) => { if (input.tool === "bash" && existsSync(join(directory, "graphify-out", "graph.json"))) output.args.command = 'echo "[graphify] Knowledge graph available. Read graphify-out/GRAPH_REPORT.md first." && ' + output.args.command; } });\n`, "utf8");
  return ".opencode/plugins/graphify.js -> tool.execute.before hook written";
}

async function opencodePluginUninstall(): Promise<string> {
  await rm(path.join(".opencode", "plugins", "graphify.js"), { force: true });
  return ".opencode/plugins/graphify.js -> removed";
}
