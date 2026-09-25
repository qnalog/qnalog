import { NS_TAG, NS_ACTIVE_VERSION_BODY_RE, NS_MACHINE_SHELL_RE, NS_SEGMENTS_BLOCK_RE } from "./shared/namespace";
import { QNALOG_ACTIVE_VERSION_END } from "./shared/limits";

const VERSION_FRONTMATTER_START = `<!-- ${NS_TAG}-version-frontmatter-start`;
const VERSION_FRONTMATTER_END = `${NS_TAG}-version-frontmatter-end -->`;
const ACTIVE_VERSION_PATTERN = NS_ACTIVE_VERSION_BODY_RE;
const EMPTY_VERSION_BODY_FALLBACK = "> [!warning] AI 整理未完成\n> 当前版本没有可显示的整理正文；原始转写仍保留在母本中。";

export function splitLeadingFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const text = String(markdown || "").replace(/^\uFEFF/, "");
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return { frontmatter: "", body: text };
  return {
    frontmatter: match[0].replace(/\r\n/g, "\n").replace(/\n*$/, "\n"),
    body: text.slice(match[0].length).replace(/^(?:\r?\n)+/, ""),
  };
}

function getFrontmatterYaml(frontmatter: string): string {
  const normalized = String(frontmatter || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  const parts = splitLeadingFrontmatter(`${normalized}\n`);
  if (!parts.frontmatter) return normalized;
  return parts.frontmatter
    .replace(/^---\n/, "")
    .replace(/\n---\n?$/, "")
    .trim();
}

function wrapFrontmatterYaml(yaml: string): string {
  const value = String(yaml || "").replace(/\r\n/g, "\n").trim();
  return value ? `---\n${value}\n---\n` : "";
}

export function splitVersionPayload(content: string): { frontmatter: string; body: string } {
  const text = String(content || "").replace(/^\uFEFF/, "");
  const markerPattern = new RegExp(
    `^\\s*${VERSION_FRONTMATTER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n([\\s\\S]*?)\\r?\\n${VERSION_FRONTMATTER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`,
  );
  const marker = text.match(markerPattern);
  if (marker) {
    return {
      frontmatter: wrapFrontmatterYaml(marker[1]),
      body: text.slice(marker[0].length).replace(/^(?:\r?\n)+/, ""),
    };
  }

  // Compatibility with version files written before payload markers existed.
  // Those files stored the generated document, including its YAML, as body text.
  return splitLeadingFrontmatter(text);
}

export function buildVersionPayload(frontmatter: string, body: string): string {
  const yaml = getFrontmatterYaml(frontmatter);
  const cleanBody = splitVersionPayload(body).body.trim() || EMPTY_VERSION_BODY_FALLBACK;
  if (!yaml) return cleanBody;
  return [
    VERSION_FRONTMATTER_START,
    yaml,
    VERSION_FRONTMATTER_END,
    "",
    cleanBody,
  ].join("\n");
}

// 活动版本块嵌在母本自己的标题之下。派生笔记 / 清稿 / 旧缓存的正文开头可能带自己的
// 一级标题与"指回母本"的回链行（在派生文件里合理，进母本就是第二条标题和指向自己的链接），
// 统一剥掉；母本标题由 applyVersionTitle 按当前显示版本重写。
const SELF_BACKLINK_LINE_RE = /^>\s*\[!(?:info|note)\]\s*(?:基于原始转写重新生成|从母本逐字稿忠实清理)[^\n]*\n+/;

export function sanitizeActiveVersionBody(body: string): string {
  let text = splitVersionPayload(body).body;
  for (let guard = 0; guard < 8; guard++) {
    const before = text;
    text = text.replace(/^\s*#\s+[^\n]*(?:\n+|$)/, "").replace(SELF_BACKLINK_LINE_RE, "");
    if (text === before) break;
  }
  return text.trim() || "_[当前版本无内容]_";
}

// 派生笔记 frontmatter = 母本字段 ∪ 生成字段 ∪ 派生记账字段。切回母本时只保留内容字段——
// 记账字段（类型/variant_*/source_* 等）写进母本会让母本被识别成派生笔记，
// 触发"跳回来源"等错误分支。只删顶层键；这些键的值都是单行标量，tags 等嵌套字段不受影响。
const VERSION_BOOKKEEPING_KEYS = [
  "类型", "variant_kind", "variant_label", "variant_mode", "variant_style",
  "source_path", "source_id", "contains_raw", "contains_frontmatter",
  "created", "payload_format", "version_id", "source_segments_hash",
];

export function stripVersionBookkeepingFrontmatter(frontmatter: string): string {
  const text = String(frontmatter || "").replace(/\r\n/g, "\n");
  if (!text.trim()) return "";
  const keys = VERSION_BOOKKEEPING_KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`^(?:${keys.join("|")})\\s*:`, "");
  return text
    .split("\n")
    .filter((line) => !re.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

/** `2026-09-18T11:07:46` / `2026-09-23 16:03:59` / `2026-09-18` → 标题用日期时间；识别不了返回空串。 */
export function normalizeTitleDatetime(value: string): string {
  const v = String(value || "").trim();
  const full = v.match(/^(\d{4}-\d{2}-\d{2})[T\s]+(\d{2}:\d{2})/);
  if (full && full[1] && full[2]) return `${full[1]} ${full[2]}`;
  const dateOnly = v.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateOnly && dateOnly[1]) return dateOnly[1];
  return "";
}

/**
 * 母本标题跟随当前显示版本：保留录制日期时间，模式段换成当前版本名。
 * 同一次改写消灭占位残留（录音中…）与旧时长后缀；识别不出日期时间的标题不动。
 * 无标题的母本把新标题插到活动块（或正文）之前，保证全文只有一条一级标题。
 */
export function applyVersionTitle(markdown: string, titleSuffix: string, fallbackDatetime = ""): string {
  const text = String(markdown || "");
  if (!text.trim()) return text;
  const suffix = String(titleSuffix || "").trim().split(" · ").shift() || "";
  const parts = splitLeadingFrontmatter(text);
  const body = parts.body.replace(/^\s+/, "");
  const head = parts.frontmatter ? parts.frontmatter.replace(/\n+$/, "\n") : "";
  const headingMatch = body.match(/^#\s+\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?[^\n]*/);
  if (headingMatch) {
    const datetime = normalizeTitleDatetime(headingMatch[0].replace(/^#\s+/, ""));
    if (!datetime || !suffix) return text;
    const rebuilt = `# ${datetime} · ${suffix}`;
    if (rebuilt === headingMatch[0]) return text;
    const nextBody = body.replace(/^#\s+\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?[^\n]*/, rebuilt);
    return head + nextBody;
  }
  // 正文首行已是非日期格式的一级标题（用户自定义标题）：不改写也不再插入，避免叠出第二条。
  if (/^#\s+[^\n]*/.test(body)) return text;
  const datetime = normalizeTitleDatetime(fallbackDatetime);
  if (!datetime) return text;
  const title = `# ${datetime}${suffix ? ` · ${suffix}` : ""}`;
  return head + `${title}\n\n${body}`;
}

/**
 * 原始转写区规范化（幂等，仅在激活版本时运行）：
 * 1. 裸露的分段块（只有会话标记、没进折叠区）包进「分段原始转写」details；
 * 2. 原始区缺「## 原始材料」标题时补在第一个原始块之前。
 * 已有该标题的笔记原样返回——健康的母本与后续切换都不受影响。
 */
export function foldRawTranscriptSection(markdown: string): string {
  const text = String(markdown || "");
  if (!text.trim() || /^##\s+(?:📁\s*)?原始材料\s*$/m.test(text)) return text;
  const endIdx = text.indexOf(QNALOG_ACTIVE_VERSION_END);
  if (endIdx < 0) return text;
  const head = text.slice(0, endIdx + QNALOG_ACTIVE_VERSION_END.length);
  let tail = text.slice(endIdx + QNALOG_ACTIVE_VERSION_END.length);
  if (!tail.trim()) return text;
  if (!/<summary>[^<]*分段原始转写/.test(tail)) {
    tail = tail.replace(NS_SEGMENTS_BLOCK_RE, (block) => {
      const count = (String(block).match(/^### 段落 /gm) || []).length;
      return `<details>\n<summary>分段原始转写（${count} 段）</summary>\n\n${String(block).trim()}\n\n</details>`;
    });
  }
  // 机器壳（索引数据/沉淀数据）不是原始材料锚点：等长遮蔽后再定位，
  // 否则裸尾（没有原始块）时标题会被插到折叠壳前面。
  const masked = tail.replace(NS_MACHINE_SHELL_RE, (m) => " ".repeat(m.length));
  const rawPos = masked.search(new RegExp(`<details\\b|<!--\\s*${NS_TAG}-segments-start`, "i"));
  if (rawPos < 0) return head + tail;
  const lineStart = tail.lastIndexOf("\n", rawPos) + 1;
  return head + tail.slice(0, lineStart) + "## 原始材料\n\n" + tail.slice(lineStart);
}

export function replaceExistingActiveVersionBlock(markdown: string, block: string): string | null {
  const text = String(markdown || "");
  if (!ACTIVE_VERSION_PATTERN.test(text)) return null;
  return text.replace(ACTIVE_VERSION_PATTERN, String(block || ""));
}

export function replaceLeadingFrontmatter(markdown: string, frontmatter: string): string {
  const yaml = getFrontmatterYaml(frontmatter);
  if (!yaml) return String(markdown || "");
  const current = splitLeadingFrontmatter(markdown);
  const body = current.body.replace(/^(?:\r?\n)+/, "");
  return `${wrapFrontmatterYaml(yaml).trimEnd()}${body ? `\n\n${body}` : "\n"}`;
}
