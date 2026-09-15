/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：Obsidian callout 归一化

// 标准 Obsidian callout 类型全集 + Q&A Log 自定义类型。
// 用全集而非小白名单：DeepSeek 等模型常丢 `>` 前缀，规整器要能认出任意标准 callout 补回前缀。
// 风险：正文里出现字面 [!xxx] 才会误判，而中文纪要正文几乎不会写这种 Obsidian 专有语法，安全。
export const QNALOG_CALLOUT_NORMALIZE_TYPES = new Set([
  // 官方标准类型
  "note", "abstract", "summary", "tldr", "info", "todo", "tip", "hint",
  "important", "success", "check", "done", "question", "help", "faq",
  "warning", "caution", "attention", "failure", "fail", "missing",
  "danger", "error", "bug", "example", "quote", "cite",
  // Q&A Log 自定义
  "ai-eval",
]);

// 顶部摘要 / 一句话定调这类 callout 的"短标题"识别：
// 模型有时把 `> [!abstract] 摘要\n> 长正文...` 折叠成一行 `[!abstract] 摘要 长正文...`，
// 渲染出来标题超长。这里把"短标题 + 空格 + 长正文"拆开，正文挪到续行。
export function splitCalloutInlineBody(title) {
  const t = String(title || "").trim();
  if (!t) return { label: "", body: "" };
  // 找第一个空白分隔；只有当分隔后的"正文"足够长（≥12 字）才认为是被折叠的正文，
  // 否则像 "AI 评价" / "核心 摘要" 这种两词标题不拆。
  const m = t.match(/^(\S{1,8})\s+(.+)$/);
  if (m && String(m[2] || "").trim().length >= 12) {
    return { label: m[1].trim(), body: m[2].trim() };
  }
  return { label: t, body: "" };
}

export function getCalloutHeader(line) {
  const m = String(line || "").match(/^\s*(?:>\s*)?(?:[-*+•]\s+)?\[!([a-z][a-z0-9_-]*)([+-]?)\]\s*(.*)$/i);
  if (!m) return null;
  const type = String(m[1] || "").toLowerCase();
  if (!QNALOG_CALLOUT_NORMALIZE_TYPES.has(type)) return null;
  const fold = m[2] || "";
  const rawTitle = String(m[3] || "").trim();
  const { label, body } = splitCalloutInlineBody(rawTitle);
  return {
    type,
    text: `[!${type}${fold}]${label ? " " + label : ""}`,
    inlineBody: body,  // 若非空，规整时作为续行 `> <body>` 紧跟标题
  };
}

export function isCalloutBoundary(line) {
  const text = String(line || "");
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (getCalloutHeader(text)) return true;
  return /^#{1,6}\s+/.test(trimmed)
    || /^-{3,}$/.test(trimmed)
    || /^<details\b/i.test(trimmed)
    || /^<\/details>/i.test(trimmed)
    || /^<!--\s*qnalog-/i.test(trimmed)
    || /^\*\*[^*\n]{1,40}\*\*[:：]?/.test(trimmed)
    || /^####\s+/.test(trimmed);
}

export function ensureCalloutGapBeforeHeader(out) {
  if (!Array.isArray(out) || !out.length) return;
  // 删除上一块尾部的空行与「>」空引用行——它们是 blockquote 续行，会让 Obsidian 把相邻 callout 合并成一个块
  while (out.length) {
    const last = String(out[out.length - 1] || "");
    if (!last.trim() || /^\s*>\s*$/.test(last)) { out.pop(); continue; }
    break;
  }
  // 用一个「真正的空行」(行首无 >) 断开，使下一个 callout 成为独立块；位于开头时不补前导空行
  if (out.length) out.push("");
}

export function normalizeCallouts(markdown) {
  if (!markdown) return "";
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inFence = false;
  let inFixedCallout = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      inFixedCallout = false;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const header = getCalloutHeader(line);
    if (header) {
      ensureCalloutGapBeforeHeader(out);
      out.push(`> ${header.text}`);
      // 模型把标题和长正文折叠到同一行时，把正文拆到续行，避免标题超长
      if (header.inlineBody) out.push(`> ${header.inlineBody}`);
      inFixedCallout = true;
      continue;
    }

    if (inFixedCallout) {
      if (isCalloutBoundary(line)) {
        inFixedCallout = false;
        out.push(line);
        continue;
      }
      const trimmed = String(line || "").trim();
      if (!trimmed) {
        out.push(">");
        continue;
      }
      if (/^\s*>/.test(line)) {
        out.push(line.replace(/^\s*/, ""));
      } else {
        out.push(`> ${line.trimStart()}`);
      }
      continue;
    }

    out.push(line);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
