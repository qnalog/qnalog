// 数据层命名空间：写在用户文件里的品牌字面量。
//
// Q&A Log 是独立项目，与任何历史项目不共享数据。因此这里的规则只有一条：
//
//   **写入与读取都只认 Q&A Log 字面量。**
//
// 本模块是这些字面量的唯一来源，业务代码不要自行拼接 `qnalog-` 前缀。
// 新增标记时在这里登记名字，读侧用 nsRe(name) 生成正则。

/** 命名空间。 */
export const NS_TAG = "qnalog";

/** 知识库数据根目录。 */
export const NS_ROOT = "QnALog";

/** 生成标记正则片段。`nsRe("session")` → `qnalog-session` */
export function nsRe(name: string): string {
  return `${NS_TAG}-${name}`;
}

/** 标记写入用字面量：`nsMarker("session", id)` → `<!-- qnalog-session:id -->`。 */
export function nsMarker(name: string, value?: string): string {
  return value == null ? `<!-- ${NS_TAG}-${name} -->` : `<!-- ${NS_TAG}-${name}:${value} -->`;
}

/** 匹配带可选 id 的完整标记，全局：`<!-- ns-segments-start:id -->`。 */
export function nsMarkerGlobalRe(name: string): RegExp {
  return new RegExp(`<!--\\s*${nsRe(name)}(?::[^>]*)?\\s*-->`, "g");
}

/** 匹配带可选 id 的完整标记：`<!-- ns-segments-end:id -->`。 */
export function nsMarkerAnyRe(name: string, flags = "i"): RegExp {
  return new RegExp(`<!--\\s*${nsRe(name)}(?::[^>]*)?\\s*-->`, flags);
}

// —— 常用读取正则 ——
// 这些是热点读路径，预先建好避免每次调用都重新构造 RegExp。

/** 匹配 `<!-- qnalog-segments-start`（前缀形式，不带结尾）。 */
export const NS_SEGMENTS_START_RE = new RegExp(`<!--\\s*${nsRe("segments-start")}`);
/** 匹配会话标记：`<!-- qnalog-session:xxx -->` 或 `<!-- qnalog-session -->`。 */
export const NS_SESSION_RE = new RegExp(`<!--\\s*${nsRe("session")}(?::|\\s*--)`);
/** 只匹配 `<!-- qnalog-segments-start -->`（不带捕获组）。 */
export const NS_SEGMENTS_START_ONLY_RE = nsMarkerAnyRe("segments-start");

/** 会话标记并捕获 id：`<!-- qnalog-session:VALUE -->`。 */
export const NS_SESSION_VALUE_RE = new RegExp(`<!--\\s*${nsRe("session")}:\\s*([^>\\s]+)\\s*-->`, "i");
/** 匹配版本块并捕获正文：`<!-- qnalog-active-version-start -->…<!-- qnalog-active-version-end -->`。 */
export const NS_ACTIVE_VERSION_BODY_RE = new RegExp(
  `<!--\\s*${nsRe("active-version-start")}\\s*-->([\\s\\S]*?)<!--\\s*${nsRe("active-version-end")}\\s*-->`,
  "i",
);
/** 合并块：`<!-- qnalog-merge … qnalog-merge-end -->`。 */
export const NS_MERGE_BLOCK_RE = new RegExp(
  `<!--\\s*${nsRe("merge")}[\\s\\S]*?${nsRe("merge-end")}\\s*-->`,
);

/** 沉淀块标记（大写形式）。 */
export const NS_SEDIMENT_BEGIN = "QNALOG_SEDIMENT_BEGIN";
export const NS_SEDIMENT_END = "QNALOG_SEDIMENT_END";
/** 匹配沉淀块：`<!--QNALOG_SEDIMENT_BEGIN … QNALOG_SEDIMENT_END-->`。 */
export const NS_SEDIMENT_BLOCK_RE =
  /<!--\s*QNALOG_SEDIMENT_BEGIN[\s\S]*?QNALOG_SEDIMENT_END\s*-->/gi;
/** 卡片块：`<!--QNALOG_CARDS_BEGIN…-->`。 */
export const NS_CARDS_BLOCK_RE = new RegExp(
  `<!--\\s*QNALOG_CARDS_BEGIN\\s*-->\\s*(?:\`\`\`json\\s*)?([\\s\\S]*?)(?:\\s*\`\`\`)?\\s*<!--\\s*QNALOG_CARDS_END\\s*-->`,
  "gi",
);

/** 行首的沉淀块开始标记（用于「这一行是否属于沉淀块」判断）。 */
export const NS_SEDIMENT_LINE_BEGIN_RE = /<!--\s*QNALOG_SEDIMENT_BEGIN/i;
/** 分段逐字稿区块（开始到结束）。 */
export const NS_SEGMENTS_BLOCK_RE = new RegExp(
  `<!--\\s*${nsRe("segments-start")}(?::[^>]*)?\\s*-->[\\s\\S]*?<!--\\s*${nsRe("segments-end")}(?::[^>]*)?\\s*-->`,
  "gi",
);
/** 独占一行的会话标记。 */
export const NS_SESSION_LINE_RE = new RegExp(
  `^[ \\t]*<!--\\s*${nsRe("session")}(?::[^>]*|\\s*--)[^>]*-->[ \\t]*\\r?\\n?`,
  "gm",
);
/** 标签建议注释：`<!-- qnalog-tags: a, b -->`。 */
export const NS_TAGS_RE = new RegExp(`<!--\\s*${nsRe("tags")}(?:-suggest)?\\s*:\\s*([\\s\\S]*?)\\s*-->`, "i");
/** 人员机器块：`<!-- qnalog-people: 张三, 李四 -->`。 */
export const NS_PEOPLE_RE = new RegExp(`<!--\\s*${nsRe("people")}\\s*:\\s*([\\s\\S]*?)\\s*-->`, "i");
/** 分部正文块并捕获正文。 */
export const NS_PART_BODY_RE = new RegExp(
  `<!--\\s*${nsRe("part-body-start")}\\s*-->([\\s\\S]*?)<!--\\s*${nsRe("part-body-end")}\\s*-->`,
  "i",
);
/** 分部小结并捕获内容。 */
export const NS_PART_SUMMARY_RE = new RegExp(`<!--\\s*${nsRe("part-summary")}\\s*:\\s*([\\s\\S]*?)\\s*-->`, "i");
/** 分部小结（整行，含引用块前缀变体）。 */
export const NS_PART_SUMMARY_LINE_RE = new RegExp(
  `^\\s*>?\\s*${nsRe("part-summary")}(?:\\s*:.*)?\\s*$(?:\\r?\\n\\s*>[^\\n]*)*`,
  "gim",
);
export const NS_PART_SUMMARY_ONLY_RE = new RegExp(`^\\s*>?\\s*${nsRe("part-summary")}(?:\\s*:.*)?\\s*$`, "i");
export const NS_PART_SUMMARY_STRIP_RE = new RegExp(`^\\s*>?\\s*${nsRe("part-summary")}\\s*:?\\s*`, "i");
export const NS_PART_SUMMARY_BLOCK_RE = new RegExp(`<!--\\s*${nsRe("part-summary")}\\s*:[\\s\\S]*?-->`, "gi");
/** 分部末尾的人员/标签注释行。 */
export const NS_PART_ENTITY_LINE_RE = new RegExp(`^\\s*>?\\s*${NS_TAG}-(?:people|tags)(?:\\s*:.*)?\\s*$`, "gim");
/** 生成墙标记。 */
export const NS_WALL_MARKER_RE = new RegExp(`<!--\\s*${nsRe("generated-wall")}\\s*-->`, "i");

/** 标签前缀：`qnalog/`。 */
export const NS_TAG_PREFIX = `${NS_TAG}/`;

/** 判断标签是否属于本插件的系统标签。 */
export function isNamespaceTag(tag: unknown): boolean {
  const text = typeof tag === "string" ? tag.trim().toLowerCase() : "";
  return text.startsWith(NS_TAG_PREFIX);
}

/** frontmatter 键：说话人映射。 */
export const NS_FM_SPEAKERS = "qnalog_speakers";

/** frontmatter 类型值。 */
export const NS_TYPE_DERIVED = "QnALog派生版本";
export const NS_TYPE_VERSION_CACHE = "QnALog版本缓存";

/** `类型` 字段是否为「派生版本」。 */
export function isDerivedVersionType(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  return text === NS_TYPE_DERIVED;
}

/** 视图类型。 */
export const NS_VIEW_OUTLINE = "qnalog-outline-view";
export const NS_VIEW_MINUTES_KANBAN = "qnalog-minutes-kanban-view";

/** 语义 Canvas 的 JSON 键。 */
export const NS_FM_SEMANTIC = "qnalogSemantic";

/** 从 Canvas 文档里读语义元数据。 */
export function readSemanticMeta<T = unknown>(document: unknown): T | undefined {
  if (!document || typeof document !== "object") return undefined;
  return (document as Record<string, unknown>)[NS_FM_SEMANTIC] as T | undefined;
}

/** 把语义元数据写到 Canvas 文档上。 */
export function writeSemanticMeta(document: Record<string, unknown>, meta: unknown): void {
  document[NS_FM_SEMANTIC] = meta;
}
