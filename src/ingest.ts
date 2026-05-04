import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeDownload, safeFetch, safeFetchText, validateUrl } from "./security.js";
import { downloadAudio } from "./transcribe.js";

function yamlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/\r?\n/g, " ");
}

function safeFilename(url: string, suffix: string): string {
  const parsed = new URL(url);
  const raw = `${parsed.hostname}${parsed.pathname}`;
  const name = raw.replace(/[^\w-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return `${name || "download"}${suffix}`;
}

export function detectUrlType(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes("twitter.com") || lower.includes("x.com")) return "tweet";
  if (lower.includes("arxiv.org")) return "arxiv";
  if (lower.includes("github.com")) return "github";
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "youtube";
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".pdf")) return "pdf";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].some((ext) => pathname.endsWith(ext))) return "image";
  return "webpage";
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => `${"#".repeat(Number(level))} ${stripHtml(text)}\n\n`)
    .replace(/<p[^>]*>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function fetchTweet(url: string, author?: string, contributor?: string): Promise<[string, string]> {
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url.replace("x.com", "twitter.com"))}&omit_script=true`;
  let tweetText = `Tweet at ${url} (could not fetch content)`;
  let tweetAuthor = "unknown";
  try {
    const data = JSON.parse(await safeFetchText(oembedUrl));
    tweetText = stripHtml(String(data.html ?? "")).trim();
    tweetAuthor = String(data.author_name ?? "unknown");
  } catch {
    // keep stub
  }
  const now = new Date().toISOString();
  return [
    `---\nsource_url: "${yamlString(url)}"\ntype: tweet\nauthor: "${yamlString(tweetAuthor)}"\ncaptured_at: ${now}\ncontributor: "${yamlString(contributor ?? author ?? "unknown")}"\n---\n\n# Tweet by @${tweetAuthor}\n\n${tweetText}\n\nSource: ${url}\n`,
    safeFilename(url, ".md")
  ];
}

async function fetchWebpage(url: string, author?: string, contributor?: string): Promise<[string, string]> {
  const html = await safeFetchText(url);
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? url).replace(/\s+/g, " ").trim();
  const markdown = stripHtml(html).slice(0, 12_000);
  const now = new Date().toISOString();
  return [
    `---\nsource_url: "${yamlString(url)}"\ntype: webpage\ntitle: "${yamlString(title)}"\ncaptured_at: ${now}\ncontributor: "${yamlString(contributor ?? author ?? "unknown")}"\n---\n\n# ${title}\n\nSource: ${url}\n\n---\n\n${markdown}\n`,
    safeFilename(url, ".md")
  ];
}

async function fetchArxiv(url: string, author?: string, contributor?: string): Promise<[string, string]> {
  const id = url.match(/(\d{4}\.\d{4,5})/)?.[1];
  if (!id) return fetchWebpage(url, author, contributor);
  let title = id;
  let abstract = "";
  let paperAuthors = "";
  try {
    const html = await safeFetchText(`https://export.arxiv.org/abs/${id}`);
    title = stripHtml(html.match(/class="title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? id).replace(/^Title:\s*/i, "").trim();
    abstract = stripHtml(html.match(/class="abstract[^"]*"[^>]*>([\s\S]*?)<\/blockquote>/i)?.[1] ?? "").replace(/^Abstract:\s*/i, "").trim();
    paperAuthors = stripHtml(html.match(/class="authors"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "").replace(/^Authors:\s*/i, "").trim();
  } catch {
    // leave fallback
  }
  const now = new Date().toISOString();
  return [
    `---\nsource_url: "${yamlString(url)}"\narxiv_id: "${yamlString(id)}"\ntype: paper\ntitle: "${yamlString(title)}"\npaper_authors: "${yamlString(paperAuthors)}"\ncaptured_at: ${now}\ncontributor: "${yamlString(contributor ?? author ?? "unknown")}"\n---\n\n# ${title}\n\n**Authors:** ${paperAuthors}\n**arXiv:** ${id}\n\n## Abstract\n\n${abstract}\n\nSource: ${url}\n`,
    `arxiv_${id.replace(".", "_")}.md`
  ];
}

export async function ingest(url: string, targetDir: string, options: { author?: string; contributor?: string } = {}): Promise<string> {
  await validateUrl(url);
  await mkdir(targetDir, { recursive: true });
  const type = detectUrlType(url);
  if (type === "pdf") {
    const out = path.join(targetDir, safeFilename(url, ".pdf"));
    await safeDownload(url, out);
    return out;
  }
  if (type === "image") {
    const suffix = path.extname(new URL(url).pathname) || ".jpg";
    const out = path.join(targetDir, safeFilename(url, suffix));
    await safeDownload(url, out);
    return out;
  }
  if (type === "youtube") return downloadAudio(url, path.join(targetDir, "downloads"));
  const [content, filename] =
    type === "tweet" ? await fetchTweet(url, options.author, options.contributor)
    : type === "arxiv" ? await fetchArxiv(url, options.author, options.contributor)
    : await fetchWebpage(url, options.author, options.contributor);
  let out = path.join(targetDir, filename);
  for (let i = 1; await exists(out) && i < 1000; i += 1) {
    out = path.join(targetDir, `${path.basename(filename, ".md")}_${i}.md`);
  }
  await writeFile(out, content, "utf8");
  return out;
}

async function exists(filePath: string): Promise<boolean> {
  return readFile(filePath).then(() => true, () => false);
}

export async function saveQueryResult(
  question: string,
  answer: string,
  memoryDir: string,
  options: { queryType?: string; sourceNodes?: string[] } = {}
): Promise<string> {
  await mkdir(memoryDir, { recursive: true });
  const now = new Date();
  const slug = question.toLowerCase().replace(/[^\w]/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
  const file = path.join(memoryDir, `query_${stamp}_${slug}.md`);
  const sourceNodes = (options.sourceNodes ?? []).slice(0, 10);
  const frontmatter = [
    "---",
    `type: "${yamlString(options.queryType ?? "query")}"`,
    `date: "${now.toISOString()}"`,
    `question: "${yamlString(question)}"`,
    'contributor: "graphify"',
    ...sourceNodes.map((node, index) => `source_node_${index + 1}: "${yamlString(node)}"`),
    "---",
    "",
    `# ${question}`,
    "",
    answer,
    ""
  ].join("\n");
  await writeFile(file, frontmatter, "utf8");
  return file;
}

export async function downloadBinaryToHash(url: string, targetDir: string, suffix: string): Promise<string> {
  await mkdir(targetDir, { recursive: true });
  const data = await safeFetch(url);
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 12);
  const out = path.join(targetDir, `download_${hash}${suffix}`);
  await writeFile(out, data);
  return out;
}
