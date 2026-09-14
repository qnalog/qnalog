/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：当日日记的会议概要

import { extractActionItems, extractBriefingSummary, makeNoteLink } from "./note-markdown";

import { getModeMeta } from "../shared/mode-meta";

import { DEFAULT_DAILY_MEETING_OVERVIEW_HEADING, DEFAULT_DAILY_MEETING_OVERVIEW_TEMPLATE } from "../shared/defaults";

import { escapeRegExp, formatElapsed } from "../shared/util-common";

export function renderDailyTemplate(template, vars) {
  return String(template || DEFAULT_DAILY_MEETING_OVERVIEW_TEMPLATE)
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
      const value = vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : "";
      return value == null ? "" : String(value);
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildDailyMeetingOverviewEntry(session, polished, settings) {
  const meta = getModeMeta(settings, session.mode);
  const moment = window.moment;
  const startedAt = moment ? moment(session.startedAt) : null;
  const time = startedAt && startedAt.isValid && startedAt.isValid() ? startedAt.format("HH:mm") : "";
  const date = startedAt && startedAt.isValid && startedAt.isValid() ? startedAt.format("YYYY-MM-DD") : "";
  const totalMs = session.segments && session.segments.length ? session.segments[session.segments.length - 1].endOffsetMs : 0;
  const title = String(session.mdPath || "").split("/").pop().replace(/\.md$/i, "");
  const summary = extractBriefingSummary(polished) || "见完整纪要。";
  const tasks = extractActionItems(polished);
  const vars = {
    date,
    time,
    note_link: makeNoteLink(session.mdPath),
    note_path: String(session.mdPath || ""),
    title,
    mode: meta.prefix,
    duration: formatElapsed(totalMs),
    duration_text: formatElapsed(totalMs),
    segments: session.segments ? session.segments.length : 0,
    model: settings.llmModel || "",
    summary,
    todo_count: tasks.length,
    todos: tasks.join("\n"),
    todos_block: tasks.length ? ["#### 待办", ...tasks].join("\n") : "",
  };
  const body = renderDailyTemplate(settings.dailyMeetingOverviewTemplate || DEFAULT_DAILY_MEETING_OVERVIEW_TEMPLATE, vars)
    || renderDailyTemplate(DEFAULT_DAILY_MEETING_OVERVIEW_TEMPLATE, vars);
  return [
    `<!-- lexvoice-daily-overview:${session.id} -->`,
    body,
    `<!-- lexvoice-daily-overview-end:${session.id} -->`,
  ].join("\n");
}

// 为日记里插一条 Markdown 复选 todo 行（兼容 Tasks 插件 + Dataview 查询）
// 格式：- [ ] {task} 📅 {due} 👤 {owner} (来源: [[source]]) <!-- lexvoice-todo:{id} -->
// 备注：
//   - 📅 是 Tasks 插件识别的截止日期约定（仅当 due 能解析为日期时使用）
//   - 否则用 Dataview inline 字段 [截止:: {due}]
//   - 👤 owner 作为视觉标记（Tasks 插件没有 owner 约定）；同时给 Dataview 友好的 [责任人:: owner]
//   - HTML 注释里的 id 用于幂等 upsert（同 id 待办只插入一次）

// 把待办插入 / 更新到日记的指定标题下（默认 "## 待办"）。
// 同 id 的待办存在时整段（含子任务缩进行）替换；不存在时追加到 ## 待办 列表末尾；
// 标题都不存在时在文末新建 ## 待办 段。

export function upsertDailyMeetingOverview(content, sessionId, entry, settings) {
  const start = `<!-- lexvoice-daily-overview:${sessionId} -->`;
  const end = `<!-- lexvoice-daily-overview-end:${sessionId} -->`;
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end, startIdx);
  if (startIdx >= 0 && endIdx > startIdx) {
    return content.slice(0, startIdx) + entry + content.slice(endIdx + end.length);
  }

  const heading = String(settings && settings.dailyMeetingOverviewHeading || DEFAULT_DAILY_MEETING_OVERVIEW_HEADING).replace(/^#+\s*/, "").trim() || DEFAULT_DAILY_MEETING_OVERVIEW_HEADING;
  const headingRe = new RegExp("^##\\s+" + escapeRegExp(heading) + "\\s*$", "m");
  const match = headingRe.exec(content);
  if (!match) {
    const sep = content.trim() ? "\n\n" : "";
    return content.replace(/\s*$/, "") + sep + `## ${heading}\n\n` + entry + "\n";
  }

  const afterHeading = content.indexOf("\n", match.index) + 1;
  const rest = content.slice(afterHeading);
  const nextHeading = rest.search(/\n##\s+/);
  const insertAt = nextHeading >= 0 ? afterHeading + nextHeading : content.length;
  const before = content.slice(0, insertAt).replace(/\s*$/, "\n\n");
  const after = content.slice(insertAt).replace(/^\n*/, "\n");
  return before + entry + after;
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
