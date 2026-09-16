/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：最近纪要列表、过滤与状态

import { normalizeModeFromLabel } from "../notes/note-markdown";

import { isSameVaultPath } from "../notes/audio-refs";

import { getActiveSessionProcessingState } from "../notes/session-progress";

import * as obsidian from "obsidian";
import { getModeMeta, getVisibleModeEntries, isKnownPolishMode } from "../shared/mode-meta";

import { parseDurationLabel } from "../shared/util-text";

import { getFrontmatterTags } from "../shared/util-note";

import { normalizePeopleSuggestionCache } from "../people";

import { isLlmConfigError, isLlmServiceBlockedError } from "../llm/core";

import { DEFAULT_SETTINGS } from "../shared/defaults";

import { MODE_META, MODE_PREFIX_TO_KEY } from "../shared/catalog-modes";

import { escapeRegExp, formatElapsed } from "../shared/util-common";

import { LIVE_ASR_TASK_STATUS } from "../asr/live-segment-policy";

import { getRecentNoteParentPath, getRecentNotePathRelativeToRoot, isPathUnderRecentNoteRoots, normalizeRecentNoteRoots } from "../recent-note-paths";
import { NS_TAG, isDerivedVersionType } from "../shared/namespace";

import { t } from "../shared/i18n";
export function detectRecentModeFromFrontmatter(settings, frontmatter) {
  const fm = frontmatter && typeof frontmatter === "object" ? frontmatter : {};
  const explicitMode = normalizeModeFromLabel(settings, fm.mode || fm["mode"] || "");
  if (explicitMode) return explicitMode;
  const explicitType = normalizeModeFromLabel(settings, fm["类型"] || fm.type || fm["模板"] || fm.template || "");
  if (explicitType) return explicitType;
  const tags = getFrontmatterTags(fm);
  for (const tag of tags) {
    const mode = normalizeModeFromLabel(settings, tag);
    if (mode) return mode;
  }
  return "";
}

export function stripRecentDatePrefix(basename) {
  return String(basename || "")
    .replace(/^\d{4}-\d{2}-\d{2}(?:\s+\d{4})?\s*/, "")
    .replace(/^[-·\s]+/, "")
    .trim();
}

export function getRecentModePrefixEntries(settings) {
  const entries = Object.entries(MODE_PREFIX_TO_KEY).map(([prefix, mode]) => [prefix, mode]);
  for (const [mode, label] of getVisibleModeEntries(settings, false)) entries.push([label, mode]);
  return entries
    .filter(([prefix, mode]) => prefix && mode && isKnownPolishMode(settings, mode))
    .sort((a, b) => String(b[0]).length - String(a[0]).length);
}

export function detectRecentModeFromFilename(settings, basename) {
  const stem = stripRecentDatePrefix(basename);
  if (!stem) return "off";
  const inlineTag = stem.match(/(?:^|·\s*)(访谈|会议|研讨会|研讨|沙龙|小会|手记|学习记录|学习|个人笔记|工作纪要|学术研讨|主题沙龙|访谈调研|圆桌讨论)(?=$|[-·\s])/);
  if (inlineTag) return normalizeModeFromLabel(settings, inlineTag[1]) || "off";
  for (const [prefix, mode] of getRecentModePrefixEntries(settings)) {
    const re = new RegExp("^" + escapeRegExp(prefix) + "(?:[-·\\s]|$)");
    if (re.test(stem)) return mode;
  }
  return "off";
}

export function detectRecentNoteMode(plugin, file, frontmatter) {
  const settings = plugin && plugin.settings ? plugin.settings : DEFAULT_SETTINGS;
  const fromFrontmatter = detectRecentModeFromFrontmatter(settings, frontmatter);
  const fromFilename = detectRecentModeFromFilename(settings, file && file.basename);
  if (fromFrontmatter && fromFrontmatter !== "off") return fromFrontmatter;
  if (fromFilename && fromFilename !== "off") return fromFilename;
  return fromFrontmatter || fromFilename || "off";
}

export const QNALOG_EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const RECENT_TIME_FILTER_OPTIONS = [
  { id: "week", label: t("This week") },
  { id: "today", label: t("Today") },
  { id: "month", label: t("This month") },
  { id: "all", label: t("All dates") },
];

export const RECENT_GROUP_OPTIONS = [
  { id: "time", label: t("By time") },
  { id: "folder", label: t("By folder") },
];

export const RECENT_TOPIC_FALLBACKS = ["学习", "会议", "访谈", "PPT", "AI"];

export function formatRecentDurationLabel(raw) {
  if (raw == null) return "";
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return formatElapsed(raw < 24 * 60 * 60 ? raw * 1000 : raw);
  }
  const text = String(raw || "").trim();
  if (!text) return "";
  const ms = parseDurationLabel(text);
  return ms > 0 ? formatElapsed(ms) : text;
}

export function normalizeRecentTopicToken(raw) {
  let text = String(raw == null ? "" : raw).trim();
  if (!text) return "";
  text = text
    .replace(/^#/, "")
    .replace(/^主题[:：]/, "")
    .replace(/^topic[:：]/i, "")
    .trim();
  if (!text || new RegExp(`^${NS_TAG}(?:/|$)`, "i").test(text)) return "";
  if (/^(recording|transcript|meeting|learning-card)$/i.test(text)) return "";
  if (text.length > 18) text = text.slice(0, 18);
  return text;
}

export function collectRecentTopicValues(value, out) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectRecentTopicValues(item, out);
    return;
  }
  const text = String(value || "");
  const parts = text.split(/[，,、;；\n\r]+|\s+#/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts.length ? parts : [text]) {
    const token = normalizeRecentTopicToken(part);
    if (token) out.add(token);
  }
}

export function collectRecentNoteTopics(frontmatter, title, mode) {
  const topics = new Set();
  const fm = frontmatter || {};
  collectRecentTopicValues(fm["主题"], topics);
  collectRecentTopicValues(fm.topic, topics);
  collectRecentTopicValues(fm.topics, topics);
  collectRecentTopicValues(fm.tags, topics);
  collectRecentTopicValues(fm["tags"], topics);

  const source = `${title || ""} ${mode || ""}`;
  if (mode === "learning" || /学习|课程|讲座|视频|B站|YouTube/i.test(source)) topics.add("学习");
  if (["meeting", "huddle", "seminar"].includes(mode) || /会议|纪要|同步|复盘|研讨/.test(source)) topics.add("会议");
  if (mode === "interview" || /访谈|调研|用户研究/.test(source)) topics.add("访谈");
  if (/PPT|幻灯片|AIPPT/i.test(source)) topics.add("PPT");
  if (/\bAI\b|大模型|LLM|智能/.test(source)) topics.add("AI");
  return Array.from(topics).slice(0, 8);
}

export function getRecentPendingDepositPathSet(plugin) {
  const pending = normalizePeopleSuggestionCache(plugin && plugin.settings && plugin.settings.peopleSuggestionCache).pending || [];
  const set = new Set();
  for (const record of pending) {
    const path = record && (record.sourcePath || record.source);
    if (path) set.add(obsidian.normalizePath(path));
  }
  return set;
}

export function getRecentNoteQuickStatus(plugin, file, pendingPathSet) {
  const queueState = getRecentQueueProcessingState(plugin, file);
  if (queueState) return queueState.kind;
  const path = file && file.path ? obsidian.normalizePath(file.path) : "";
  if (path && pendingPathSet && pendingPathSet.has(path)) return "pending";
  const frontmatter = ((plugin.app.metadataCache.getFileCache(file) || {}).frontmatter) || {};
  const statusText = String(frontmatter.status || frontmatter["状态"] || "").trim();
  if (/失败|failed/i.test(statusText)) return "failed";
  if (/待|草稿|未整理|raw|draft/i.test(statusText)) return "raw";
  return "done";
}

export function getRecentNoteRoots(plugin) {
  return normalizeRecentNoteRoots([
    plugin && plugin.settings ? plugin.settings.mdFolder : "",
  ]);
}

export function getMarkdownFilesUnderRecentRoots(plugin) {
  if (!plugin || !plugin.app || !plugin.app.vault) return [];
  const roots = getRecentNoteRoots(plugin);
  return plugin.app.vault.getMarkdownFiles()
    .filter((file) => file instanceof obsidian.TFile
      && isPathUnderRecentNoteRoots(file.path, roots));
}

export function getRecentRootForPath(plugin, pathValue) {
  const path = obsidian.normalizePath(String(pathValue || ""));
  const roots = getRecentNoteRoots(plugin);
  return roots
    .filter((root) => !root || path === root || path.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length)[0] || "";
}

export function getRecentFolderInfo(plugin, file) {
  const folderPath = getRecentNoteParentPath(file && file.path);
  const root = getRecentRootForPath(plugin, folderPath || (file && file.path));
  const relativeFolder = getRecentNotePathRelativeToRoot(folderPath, root);
  const rootLabel = root ? root.split("/").pop() : "库根目录";
  const label = relativeFolder || rootLabel || "库根目录";
  return {
    key: folderPath || "__root__",
    label,
    path: folderPath,
    depth: relativeFolder ? relativeFolder.split("/").length : 0,
  };
}

export function getRecentNotes(plugin, limit) {
  const moment = window.moment;
  const currentYear = moment ? moment().year() : new Date().getFullYear();
  const items = [];
  const variantFiles = [];
  const pendingPathSet = getRecentPendingDepositPathSet(plugin);
  for (const f of getMarkdownFilesUnderRecentRoots(plugin)) {
    if (!(f instanceof obsidian.TFile) || f.extension !== "md") continue;
    const frontmatter = ((plugin.app.metadataCache.getFileCache(f) || {}).frontmatter) || {};
    // 派生版本（清稿/另存版本等）不当独立会议罗列——收集起来，稍后按 source_path 挂到母本下。
    if (isDerivedVersionType(frontmatter["类型"]) || frontmatter.contains_raw === false) {
      variantFiles.push({ file: f, fm: frontmatter });
      continue;
    }
    const mode = detectRecentNoteMode(plugin, f, frontmatter);
    // 是否 Q&A Log 纪要：能识别出 mode（非 off）或 frontmatter 自带 mode / qnalog 标记。
    // 手动改名（丢掉日期前缀）的纪要也要保留，否则在纪要面板里找不到、没法重新整理。
    const isNoteRef = (mode && mode !== "off") || !!frontmatter.mode
      || new RegExp(NS_TAG, "i").test(String(frontmatter.tags || frontmatter.tag || ""));
    const m = f.basename.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{4}))?/);
    if (!m && !isNoteRef) continue;
    let t = null;
    if (m) {
      const stamp = m[2] ? `${m[1]} ${m[2]}` : m[1];
      t = moment(stamp, m[2] ? "YYYY-MM-DD HHmm" : "YYYY-MM-DD", true);
    }
    if (!t || !t.isValid()) {
      // 无合法日期前缀（典型=被手动改名）→ 退回 frontmatter 时间，再退回文件 ctime/mtime。
      const fmTime = frontmatter.time || frontmatter["时间"] || frontmatter.date || frontmatter["日期"];
      t = fmTime ? moment(fmTime) : null;
      if (!t || !t.isValid()) t = moment((f.stat && (f.stat.ctime || f.stat.mtime)) || undefined);
    }
    const meta = getModeMeta(plugin.settings, mode) || MODE_META.off;
    let title = stripRecentDatePrefix(f.basename);
    // 去掉标题开头的"模板名 + 分隔符"——含历史别名（会议 / 研讨 / 手记…），图标 + 元信息已标类型，
    // 标题不必再重复，去掉后行首也更齐。逐个已知前缀（当前 prefix + 该 mode 的所有别名）按长到短试一次。
    const modePrefixes = [meta && meta.prefix]
      .concat(Object.keys(MODE_PREFIX_TO_KEY).filter((k) => MODE_PREFIX_TO_KEY[k] === mode))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    for (const p of modePrefixes) {
      const re = new RegExp("^" + escapeRegExp(p) + "[-·\\s]*");
      if (re.test(title)) { title = title.replace(re, "").trim(); break; }
    }
    if (!title) title = f.basename;
    const weekday = QNALOG_EN_WEEKDAYS[t.day()] || t.format("dddd");
    const sameYear = t.year() === currentYear;
    const durationLabel = formatRecentDurationLabel(frontmatter["时长"] || frontmatter.duration || frontmatter["duration"]);
    const topics = collectRecentNoteTopics(frontmatter, title, mode);
    const quickStatus = getRecentNoteQuickStatus(plugin, f, pendingPathSet);
    const folder = getRecentFolderInfo(plugin, f);
    items.push({
      file: f,
      timestamp: t.valueOf(),
      mode,
      title,
      topics,
      quickStatus,
      dateKey: t.format("YYYY-MM-DD"),
      groupTitle: weekday,
      axisPrimary: sameYear ? t.format("DD") : t.format("YYYY"),
      axisSecondary: sameYear ? t.format("M月") : t.format("M月D日"),
      displayTime: t.format(m && m[2] ? "HH:mm" : "MM-DD"),
      durationLabel,
      folderKey: folder.key,
      folderLabel: folder.label,
      folderPath: folder.path,
      folderDepth: folder.depth,
    });
  }
  // 把派生版本挂到各自母本下（按 source_path 归并；母本不在列表里的派生暂不显示，仍可经反链/文件树找到）。
  if (variantFiles.length) {
    const byPath = new Map();
    for (const it of items) byPath.set(obsidian.normalizePath(it.file.path), it);
    for (const v of variantFiles) {
      const sp = v.fm.source_path ? obsidian.normalizePath(String(v.fm.source_path)) : "";
      const host = sp ? byPath.get(sp) : null;
      if (!host) continue;
      (host.variants || (host.variants = [])).push({
        file: v.file,
        label: String(v.fm.variant_label || v.fm.variant_kind || "派生版本"),
        kind: String(v.fm.variant_kind || ""),
        sourcePath: sp,
        mtime: (v.file.stat && v.file.stat.mtime) || 0,
      });
    }
    for (const it of items) if (it.variants) it.variants.sort((a, b) => a.mtime - b.mtime);
  }
  items.sort((a, b) => b.timestamp - a.timestamp);
  return items.slice(0, limit || 24);
}

/** 过滤队列任务的选项；三项都缺省，缺省即不过滤。 */
export interface QueueTaskFilterOptions {
  types?: string[];
  statuses?: string[];
  failedOnly?: boolean;
}

/** 按类型与状态过滤队列任务；用于任务面板只列出相关的转写/合并任务。 */
export function getQueueTasksForMarkdown(plugin, file, opts: QueueTaskFilterOptions = {}) {
  if (!plugin || !plugin.queue || !Array.isArray(plugin.queue.tasks) || !(file instanceof obsidian.TFile)) return [];
  const mdPath = obsidian.normalizePath(file.path);
  const types = opts.types && opts.types.length ? new Set(opts.types) : null;
  const statuses = opts.statuses && opts.statuses.length ? new Set(opts.statuses) : null;
  return plugin.queue.tasks.filter((task) => {
    if (!task || !task.mdPath || !isSameVaultPath(task.mdPath, mdPath)) return false;
    if (types && !types.has(task.type)) return false;
    const status = task.status || "pending";
    if (statuses && !statuses.has(status)) return false;
    if (opts.failedOnly && !["failed", "missing"].includes(status)) return false;
    return true;
  });
}

export function getRecentQueueProcessingState(plugin, file) {
  const liveState = getActiveSessionProcessingState(plugin, file);
  if (liveState) return liveState;
  const tasks = getQueueTasksForMarkdown(plugin, file, { types: ["transcribe", "merge"] });
  if (!tasks.length) return null;
  const statusOf = (task) => String((task && task.status) || "pending");
  const transcribeTasks = tasks.filter((task) => task && task.type === "transcribe");
  const mergeTasks = tasks.filter((task) => task && task.type === "merge");
  const failedStatuses = new Set(["failed", "missing"]);
  const activeStatuses = new Set(["running", "processing", LIVE_ASR_TASK_STATUS]);
  const blockedMergeTask = mergeTasks.find((task) => statusOf(task) === "blocked");
  if (blockedMergeTask) {
    const serviceBlocked = isLlmServiceBlockedError(blockedMergeTask.lastError || "");
    const configBlocked = isLlmConfigError(blockedMergeTask.lastError || "");
    return {
      kind: "raw",
      label: configBlocked ? "待配置" : "AI 不可用",
      title: configBlocked
        ? "AI 整理需要先补齐大模型配置；补齐后可重新整理"
        : (serviceBlocked ? "大模型服务端或账号池暂不可用；可切换模型/端点后重试" : "AI 整理请求不可自动重试；请检查错误后手动重试"),
    };
  }
  if (transcribeTasks.some((task) => failedStatuses.has(statusOf(task)))) {
    return {
      kind: "failed",
      label: t("Transcription failed"),
      title: t("Some audio segments failed to transcribe; click to retry the segments"),
    };
  }
  if (mergeTasks.some((task) => activeStatuses.has(statusOf(task)))) {
    return {
      kind: "processing",
      label: t("Organizing"),
      title: t("Transcription complete; calling the LLM to organize the summary"),
      percent: 65,
    };
  }
  if (transcribeTasks.some((task) => activeStatuses.has(statusOf(task)))) {
    return {
      kind: "processing",
      label: t("Transcribing"),
      title: t("Audio segments are being sent to the transcription service"),
    };
  }
  if (transcribeTasks.some((task) => statusOf(task) === "pending")) {
    return {
      kind: "processing",
      label: t("Pending transcription"),
      title: t("The transcription task is queued and waiting to be processed"),
    };
  }
  if (mergeTasks.some((task) => statusOf(task) === "pending")) {
    return {
      kind: "processing",
      label: t("Pending organization"),
      title: t("Transcription has entered the follow-up organization queue"),
    };
  }
  if (mergeTasks.some((task) => failedStatuses.has(statusOf(task)))) {
    return {
      kind: "raw",
      label: t("Organization failed"),
      title: t("AI organization failed; the original transcript can still be re-organized"),
    };
  }
  return null;
}

// \u5265\u6389 <details>...</details> \u6298\u53E0\u5757\uFF08\u542B\u5D4C\u5957\uFF09\uFF0C\u7528\u4E8E\u5224\u5B9A\u5F53\u524D\u6001\u65F6\u8DF3\u8FC7\u5386\u53F2\u5F52\u6863\u3002
// \u5386\u53F2\u5F52\u6863\u91CC\u6B8B\u7559\u7684\u5931\u8D25\u6807\u8BB0\u4E0D\u5E94\u8BA9"\u5F53\u524D\u5DF2\u6210\u529F"\u7684\u7EAA\u8981\u7EE7\u7EED\u4EAE\u8B66\u544A\u3002

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
