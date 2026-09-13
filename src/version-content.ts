const VERSION_FRONTMATTER_START = "<!-- lexvoice-version-frontmatter-start";
const VERSION_FRONTMATTER_END = "lexvoice-version-frontmatter-end -->";
const ACTIVE_VERSION_PATTERN = /<!--\s*lexvoice-active-version-start\s*-->[\s\S]*?<!--\s*lexvoice-active-version-end\s*-->/;
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

export function splitLexVoiceVersionPayload(content: string): { frontmatter: string; body: string } {
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

export function buildLexVoiceVersionPayload(frontmatter: string, body: string): string {
  const yaml = getFrontmatterYaml(frontmatter);
  const cleanBody = splitLexVoiceVersionPayload(body).body.trim() || EMPTY_VERSION_BODY_FALLBACK;
  if (!yaml) return cleanBody;
  return [
    VERSION_FRONTMATTER_START,
    yaml,
    VERSION_FRONTMATTER_END,
    "",
    cleanBody,
  ].join("\n");
}

export function sanitizeLexVoiceActiveVersionBody(body: string): string {
  return splitLexVoiceVersionPayload(body).body.trim() || "_[当前版本无内容]_";
}

export function replaceExistingLexVoiceActiveVersionBlock(markdown: string, block: string): string | null {
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
