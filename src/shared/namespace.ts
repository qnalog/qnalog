// 数据层命名空间：写在用户文件里的品牌字面量。
//
// QnALog 是独立项目，不读取其他项目的品牌标记。标签和标记只写入、读取 QnALog 字面量。
// Frontmatter 业务字段另有明确的别名表：兼容 QnALog 旧版的中文与未加前缀英文键，
// 新写入始终使用下方 canonical qnalog_* 键；这不构成旧项目数据迁移。

// 本模块是品牌与 Frontmatter 字面量的唯一来源。业务代码不得拼接 qnalog 前缀；
// 新增标记时在这里登记名字，读侧用 nsRe(name) 生成正则。

/** 命名空间。 */
export const NS_TAG = "qnalog";

/** 知识库数据根目录。 */
export const NS_ROOT = "QnALog";

/** Obsidian SecretStorage key prefix. */
export const NS_API_KEY_SECRET_PREFIX = nsRe("key");
/** Legacy API-key encoding identifiers; read-only after the SecretStorage migration. */
export const NS_LEGACY_KEY_OBFUSCATION_MARKER = "qnk1:";
export const NS_LEGACY_KEY_OBFUSCATION_SALT = "QnALog/local-key-obfuscation/v1";

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
/** 机器数据折叠壳（索引数据 / 沉淀数据）：喂给提示词或语义抽取前整块剔除。 */
export const NS_MACHINE_SHELL_RE =
  /<details>\s*<summary>[^<]*(?:索引数据|沉淀数据|Index data|Distilled data)[^<]*<\/summary>[\s\S]*?<\/details>/gi;
/** 分段逐字稿区块（开始到结束）。 */
export const NS_SEGMENTS_BLOCK_RE = new RegExp(
  `<!--\\s*${nsRe("segments-start")}(?::[^>]*)?\\s*-->[\\s\\S]*?<!--\\s*${nsRe("segments-end")}(?::[^>]*)?\\s*-->`,
  "gi",
);
/** Transcript source-record markers; persisted beside the visible transcript block. */
export const NS_TRANSCRIPT_START = nsRe("transcript-start");
export const NS_TRANSCRIPT_TEXT_START = nsRe("transcript-text-start");
export const NS_TRANSCRIPT_TEXT_END = nsRe("transcript-text-end");
export const NS_TRANSCRIPT_DATA = nsRe("transcript-data");
export const NS_TRANSCRIPT_END = nsRe("transcript-end");
/** Session knowledge snapshot stored as a hidden machine comment. */
export const NS_SESSION_KNOWLEDGE = nsRe("session-knowledge");
/** Source-material proof embedded in the current outline details. */
export const NS_REALTIME_OUTLINE_SOURCE_COVERAGE = nsRe("realtime-outline-source-coverage");
/** Vault-relative folder for exact pre-rebuild note backups. */
export const NS_OUTLINE_BACKUP_FOLDER = "qnalog-outline-backups";
/** Marker for an idempotently committed staged continuation. */
export const NS_CONTINUATION_COMMITTED_MARKER = "continuation-committed";
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
/** QnALog 管理的稳定 Frontmatter 字段；`tags` 保留为 Obsidian 标准属性。 */
export const NS_FM = {
  mode: "qnalog_mode",
  time: "qnalog_time",
  duration: "qnalog_duration",
  status: "qnalog_status",
  people: "qnalog_people",
  topic: "qnalog_topic",
  source: "qnalog_source",
  language: "qnalog_language",
  coreQuestion: "qnalog_core_question",
  participants: "qnalog_participants",
  interviewee: "qnalog_interviewee",
  interviewer: "qnalog_interviewer",
  seminarSubject: "qnalog_seminar_subject",
  decisionMaker: "qnalog_decision_maker",
  advisors: "qnalog_advisors",
  type: "qnalog_type",
  sourceId: "qnalog_source_id",
  variantKind: "qnalog_variant_kind",
  sourcePath: "qnalog_source_path",
  containsRaw: "qnalog_contains_raw",
  name: "qnalog_name",
  role: "qnalog_role",
  aliases: "qnalog_aliases",
  organization: "qnalog_organization",
  email: "qnalog_email",
  sources: "qnalog_sources",
  updatedAt: "qnalog_updated_at",
  note: "qnalog_note",
  relatedPeople: "qnalog_related_people",
  mentionedPeople: "qnalog_mentioned_people",
  todoOwners: "qnalog_todo_owners",
  mergedInto: "qnalog_merged_into",
  mergedAt: "qnalog_merged_at",
  topicId: "qnalog_topic_id",
  topicTags: "qnalog_topic_tags",
  topicMembers: "qnalog_topic_members",
  topicExcluded: "qnalog_topic_excluded",
  topicBasis: "qnalog_topic_basis",
  topicCreated: "qnalog_topic_created",
  topicUpdated: "qnalog_topic_updated",
  topicHash: "qnalog_topic_hash",
  topicUndoSnapshot: "qnalog_topic_undo_snapshot",
} as const;

export type NamespaceFrontmatterField = keyof typeof NS_FM;

const NS_FM_LEGACY_KEYS: Partial<Record<NamespaceFrontmatterField, readonly string[]>> = {
  mode: ["mode", "模式", "模板"],
  time: ["time"],
  duration: ["duration", "时长"],
  status: ["status", "状态"],
  people: ["people", "人物"],
  topic: ["topic", "topics", "主题", "录音主题"],
  source: ["source", "来源"],
  language: ["language", "语言"],
  coreQuestion: ["core_question", "核心问题"],
  participants: ["participants", "参会人", "与会人", "参与者", "出席人"],
  interviewee: ["interviewee", "受访者"],
  interviewer: ["interviewer", "访问者", "面试官"],
  seminarSubject: ["seminar_subject", "subject", "研讨对象", "议题"],
  decisionMaker: ["decision_maker", "当事人"],
  advisors: ["advisors", "参谋"],
  type: ["type", "类型"],
  sourceId: ["source_id"],
  variantKind: ["variant_kind"],
  sourcePath: ["source_path"],
  containsRaw: ["contains_raw"],
  name: ["name", "姓名", "人员", "person"],
  role: ["role", "角色", "岗位", "职能", "职位", "职称", "title"],
  aliases: ["aliases", "常用称呼", "称呼", "alias"],
  organization: ["organization", "组织", "公司", "团队", "部门", "机构", "institute"],
  email: ["email", "邮箱", "邮箱地址", "邮件", "mail", "e-mail"],
  sources: ["sources", "来源"],
  updatedAt: ["updated_at", "最近更新"],
  note: ["note", "备注", "说明", "简介", "abstract"],
  relatedPeople: ["relatedPeople", "相关人员"],
  mentionedPeople: ["mentioned_people", "被提到的人"],
  todoOwners: ["todo_owners", "待办责任人"],
  mergedInto: ["merged_into", "已合并到"],
  mergedAt: ["merged_at", "合并日期"],
};

/** canonical key 优先；没有 canonical key 时兼容旧中文/英文属性，并合并并列数组。 */
export function readNamespaceFrontmatter(frontmatter: unknown, field: NamespaceFrontmatterField): unknown {
  if (!frontmatter || typeof frontmatter !== "object") return undefined;
  const values = frontmatter as Record<string, unknown>;
  const canonical = NS_FM[field];
  if (Object.prototype.hasOwnProperty.call(values, canonical)) return values[canonical];
  const legacyKeys = NS_FM_LEGACY_KEYS[field] || [];
  let firstValue: unknown;
  let found = false;
  let merged: unknown[] | null = null;
  for (const legacyKey of legacyKeys) {
    if (!Object.prototype.hasOwnProperty.call(values, legacyKey)) continue;
    const value = values[legacyKey];
    if (!found) {
      firstValue = value;
      found = true;
      continue;
    }
    if (field !== "people" && field !== "participants" && field !== "advisors"
      && field !== "interviewee" && field !== "aliases" && field !== "sources"
      && field !== "relatedPeople" && field !== "mentionedPeople" && field !== "todoOwners"
      && !Array.isArray(firstValue) && !Array.isArray(value)) continue;
    if (!merged) merged = Array.isArray(firstValue) ? firstValue.slice() : [firstValue];
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null && !merged.includes(item)) merged.push(item);
    }
  }
  return merged || (found ? firstValue : undefined);
}

/** true when canonical or historical spelling is present, including an explicitly empty value. */
export function hasNamespaceFrontmatter(frontmatter: unknown, field: NamespaceFrontmatterField): boolean {
  if (!frontmatter || typeof frontmatter !== "object") return false;
  const values = frontmatter as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(values, NS_FM[field])) return true;
  for (const legacyKey of NS_FM_LEGACY_KEYS[field] || []) {
    if (Object.prototype.hasOwnProperty.call(values, legacyKey)) return true;
  }
  return false;
}

/** 写入 canonical key，并从本次更新的 frontmatter 副本中移除对应旧键。 */
export function setNamespaceFrontmatter(
  frontmatter: Record<string, unknown>,
  field: NamespaceFrontmatterField,
  value: unknown,
): void {
  frontmatter[NS_FM[field]] = value;
  for (const legacyKey of NS_FM_LEGACY_KEYS[field] || []) delete frontmatter[legacyKey];
}

/** frontmatter 类型值。 */
export const NS_TYPE_DERIVED = "QnALog派生版本";
export const NS_TYPE_VERSION_CACHE = "QnALog版本缓存";

/** Frontmatter type values for generated link targets. */
export const NS_TYPE_PERSON = "qnalog-person";
export const NS_TYPE_PERSON_MERGED = "qnalog-person-merged";
export const NS_TYPE_TODO_CARD = "qnalog-todo-card";
/** Frontmatter type value for a user-owned topic page. */
export const NS_TYPE_TOPIC = "qnalog-topic";

/** `qnalog_type`（历史别名 `类型`）是否表示派生版本。 */
export function isDerivedVersionType(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  return text === NS_TYPE_DERIVED;
}

/** 视图类型。 */
export const NS_VIEW_OUTLINE = "qnalog-outline-view";
export const NS_VIEW_MINUTES_KANBAN = "qnalog-minutes-kanban-view";

/** Custom icon shared by the ribbon entry, sidebar title and live-minutes view. */
export const QNALOG_PLUGIN_ICON_ID = nsRe("plugin-icon");

/** 语义 Canvas 的 JSON 键。 */
export const NS_FM_SEMANTIC = "qnalogSemantic";

/**
 * 音频文件名前缀。
 *
 * `lex-` 不是 LexVoice 的数据，而是 **1.0.0 自身的输出**：改名时漏掉了生成录音
 * 文件名的那几处，于是 1.0.0 用户的知识库里已经有 `lex-<时间戳>.webm` 与
 * `lex-<时间戳>-segNN.webm`，笔记里也有 `[[lex-…webm]]` 链接。
 *
 * 因此这里是**写入用新前缀、读取同时接受两者**：只写不读会让已发布的 1.0.0 用户
 * 找不到自己的分段缓存与主录音（多段导入分组、重试找回主音频都会失效）。
 */
export const NS_AUDIO_PREFIX = NS_TAG;
export const NS_AUDIO_PREFIX_LEGACY = "lex";

/** 生成匹配音频文件名前缀的正则片段：`(?:qnalog|lex)`。 */
export const NS_AUDIO_ALT = `(?:${NS_AUDIO_PREFIX}|${NS_AUDIO_PREFIX_LEGACY})`;

/** 从一段文本里剥掉音频文件名前缀，得到裸时间戳（两侧前缀都认）。 */
export function stripAudioPrefix(name: unknown): string {
  return String(typeof name === "string" ? name : "").replace(new RegExp(`^${NS_AUDIO_ALT}-`, "i"), "");
}

/** 沉淀对象的稳定 id 前缀；1.0.0 写的是 `lv-sed-`，读取要认。 */
export const NS_SEDIMENT_ID_PREFIX = `${NS_TAG}-sed`;
export const NS_SEDIMENT_ID_PREFIX_LEGACY = "lv-sed";

/**
 * 生成同一个沉淀 id 的旧写法。
 *
 * 1.0.0 把 `lv-sed-todo-<hash>` 写进了用户的日记（`<!-- qnalog-todo:… -->`）。
 * 升级后新 id 是 `qnalog-sed-todo-<hash>`——哈希输入相同，只有前缀不同。
 * 查找时必须两种都试，否则同一条待办会被当成新条目再写一遍（日记里出现重复行）。
 */
export function legacySedimentIdVariants(id: unknown): string[] {
  const text = typeof id === "string" ? id : "";
  if (!text.startsWith(`${NS_SEDIMENT_ID_PREFIX}-`)) return [];
  return [NS_SEDIMENT_ID_PREFIX_LEGACY + text.slice(NS_SEDIMENT_ID_PREFIX.length)];
}

/**
 * 会话进行中的实时转写块标记名（`<!-- <前缀>-live-start:会话id -->`）。
 * 1.0.0 写的是 `lv-live-*`；收尾清理时要两种都找，否则中断的录音会留下孤儿块
 * （用户笔记里一条卡住的"实时转写中…"引用块）。
 */
export const NS_LIVE_MARKER_START = "live-start";
export const NS_LIVE_MARKER_END = "live-end";
export const NS_LIVE_MARKER_PREFIX_LEGACY = "lv";

/** 一个标记的两种写法（新前缀 + 1.0.0 的旧前缀）。 */
export function nsMarkerLegacyVariants(name: string, value?: string): string[] {
  const suffix = value == null ? "" : `:${value}`;
  return [
    `<!-- ${NS_LIVE_MARKER_PREFIX_LEGACY}-${name}${suffix} -->`,
  ];
}

/** 内部不透明 id 前缀（`genId()`）；1.0.0 写的是 `lv-`。无人解析前缀，改生成器安全。 */
export const NS_ID_PREFIX = NS_TAG;


/** 从 Canvas 文档里读语义元数据。 */
export function readSemanticMeta<T = unknown>(document: unknown): T | undefined {
  if (!document || typeof document !== "object") return undefined;
  return (document as Record<string, unknown>)[NS_FM_SEMANTIC] as T | undefined;
}

/** 把语义元数据写到 Canvas 文档上。 */
export function writeSemanticMeta(document: Record<string, unknown>, meta: unknown): void {
  document[NS_FM_SEMANTIC] = meta;
}
