/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：待办墙的 Markdown 生成（内嵌 dataviewjs 模板，纯字符串）

import * as obsidian from "obsidian";
import { TODO_CARD_TAG } from "../shared/util-note";
import { DEFAULT_LIBRARY_PATHS, DEFAULT_SETTINGS } from "../shared/defaults";
import { NS_TAG } from "../shared/namespace";

import { t } from "../shared/i18n";
export function getBasesFolder(settings) {
  return obsidian.normalizePath((settings && settings.basesFolder) || DEFAULT_SETTINGS.basesFolder || DEFAULT_LIBRARY_PATHS.basesFolder);
}


export const TODO_WALL_FILE = "待办墙.md";


export function getWallPath(settings, fileName) {
  const folder = getBasesFolder(settings);
  return obsidian.normalizePath(folder + "/" + fileName);
}


export function insertGeneratedWallMarker(markdown) {
  const marker = `<!-- ${NS_TAG}-generated-wall -->`;
  const text = String(markdown || "");
  if (text.includes(marker)) return text;
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!fm) return marker + "\n" + text;
  const frontmatter = fm[0].replace(/\s*$/, "\n");
  const body = text.slice(fm[0].length).replace(/^\n*/, "");
  return frontmatter + "\n" + marker + "\n" + body;
}


export function formatWallMarkdown(title, folder, tag, emptyText) {
  const folderQuery = JSON.stringify('"' + obsidian.normalizePath(folder || "") + '"');
  const tagQuery = JSON.stringify("#" + String(tag || "").replace(/^#/, ""));
  return [
    "---", "cssclasses:", "  - qnalog-wall-page", "---", "", "# " + title, "", "```dataviewjs",
    "const root = dv.el(\"div\", \"\", { cls: \"qnalog-wall\" });",
    "const folderQuery = " + folderQuery + ";",
    "const targetTag = " + tagQuery + ";",
    "const esc = s => String(s ?? \"\").replace(/[&<>\\\"]/g, c => c === \"&\" ? \"&amp;\" : c === \"<\" ? \"&lt;\" : c === \">\" ? \"&gt;\" : \"&quot;\");",
    "function columnCount(width){ if (width >= 1320) return 4; if (width >= 960) return 3; if (width >= 620) return 2; return 1; }",
    "function layoutWidth(){ const selectors = [\".workspace-leaf-content\", \".view-content\", \".markdown-preview-view\", \".markdown-reading-view\", \".markdown-source-view\"]; const nodes = selectors.map(sel => root.closest(sel)).filter(Boolean); nodes.push(root.parentElement, root); for (const node of nodes) { const rect = node && node.getBoundingClientRect ? node.getBoundingClientRect() : null; const width = Math.floor(Math.max(node && node.clientWidth || 0, rect && rect.width || 0)); if (width > 120) return width; } return window.innerWidth || 0; }",
    "function cardWeight(card){ return 10 + card.title.length * 1.5 + card.sum.length * 0.38 + card.src.length * 0.18 + card.tagCount * 3; }",
    "const pages = dv.pages(folderQuery).where(p => (p.file.tags || []).includes(targetTag)).sort(p => p.file.ctime, \"desc\");",
    "const cards = [];",
    "for (const p of pages) {",
    "  const type = esc(p[\"卡片类型\"] || p[\"类型\"] || p[\"状态\"] || \"卡片\");",
    "  const title = esc(p[\"标题\"] || p[\"事项\"] || p.file.name);",
    "  const sum = esc(p[\"摘要\"] || p[\"说明\"] || p[\"任务\"] || p[\"事项\"] || \"\");",
    "  const srcR = p[\"来源笔记\"] || p[\"来源\"]; let src = \"\";",
    "  if (srcR) src = esc(String(srcR.path ?? srcR).split(\"/\").pop().replace(/\\.md$|[\\[\\]]/g, \"\"));",
    "  const rawTags = p.file.tags || [];",
    "  const tags = rawTags.map(t => '<span class=\\\"qnalog-wall-tag\\\">' + esc(String(t).replace(/^#/, \"\")) + '</span>').join(\"\");",
    "  const ct = p.file.ctime ? p.file.ctime.toFormat(\"yyyy-MM-dd HH:mm\") : \"\";",
    "  const html = '<div class=\\\"qnalog-wall-card\\\" data-path=\\\"' + esc(p.file.path) + '\\\">' + '<div class=\\\"qnalog-wall-head\\\"><span class=\\\"qnalog-wall-type\\\">' + type + '</span><span class=\\\"qnalog-wall-brand\\\">QNALOG CARD</span></div>' + '<div class=\\\"qnalog-wall-title\\\">' + title + '</div>' + (sum ? '<div class=\\\"qnalog-wall-k\\\">摘要</div><div class=\\\"qnalog-wall-sum\\\">' + sum + '</div>' : '') + (src ? '<div class=\\\"qnalog-wall-k\\\">来源</div><div class=\\\"qnalog-wall-src\\\">' + src + '</div>' : '') + (tags ? '<div class=\\\"qnalog-wall-tags\\\">' + tags + '</div>' : '') + (ct ? '<div class=\\\"qnalog-wall-time\\\">' + ct + '</div>' : '') + '</div>';",
    "  cards.push({ html, title, sum, src, tagCount: rawTags.length });",
    "}",
    "let lastCols = 0; let raf = 0;",
    "function bindCards(){ root.querySelectorAll(\".qnalog-wall-card\").forEach(el => el.addEventListener(\"click\", () => app.workspace.openLinkText(el.dataset.path, \"\", false))); }",
    "function renderWall(){",
    "  const width = layoutWidth();",
    "  const cols = columnCount(width);",
    "  root.style.setProperty(\"--qnalog-wall-columns\", String(cols));",
    "  root.style.setProperty(\"--qnalog-wall-gutter\", (width < 680 ? 18 : 24) + \"px\");",
    "  if (!cards.length) { root.classList.add(\"is-empty\"); root.innerHTML = " + JSON.stringify("<p>" + emptyText + "</p>") + "; return; }",
    "  root.classList.remove(\"is-empty\");",
    "  const buckets = Array.from({ length: cols }, () => ({ weight: 0, html: \"\" }));",
    "  for (const card of cards) {",
    "    let target = 0;",
    "    for (let i = 1; i < buckets.length; i++) if (buckets[i].weight < buckets[target].weight) target = i;",
    "    buckets[target].html += card.html;",
    "    buckets[target].weight += cardWeight(card);",
    "  }",
    "  root.innerHTML = buckets.map(b => '<div class=\\\"qnalog-wall-col\\\">' + b.html + '</div>').join(\"\");",
    "  bindCards();",
    "  lastCols = cols;",
    "}",
    "function scheduleLayout(){",
    "  if (raf) cancelAnimationFrame(raf);",
    "  raf = requestAnimationFrame(() => {",
    "    raf = 0;",
    "    const width = layoutWidth();",
    "    const cols = columnCount(width);",
    "    root.style.setProperty(\"--qnalog-wall-columns\", String(cols));",
    "    root.style.setProperty(\"--qnalog-wall-gutter\", (width < 680 ? 18 : 24) + \"px\");",
    "    if (cols !== lastCols) renderWall();",
    "  });",
    "}",
    "renderWall();",
    "if (typeof ResizeObserver !== \"undefined\") { const ro = new ResizeObserver(scheduleLayout); [root, root.parentElement, root.closest(\".markdown-preview-view\"), root.closest(\".markdown-reading-view\"), root.closest(\".markdown-source-view\"), root.closest(\".view-content\"), root.closest(\".workspace-leaf-content\")].filter(Boolean).forEach(el => ro.observe(el)); }",
    "window.addEventListener(\"resize\", scheduleLayout, { passive: true });",
    "```", "",
  ].join("\n");
}


/** 对象墙（待办墙）生成选项；四项都有默认值，缺省即可。 */
export interface QnALogObjectWallOptions {
  title?: string;
  initialFilter?: string;
  showFilters?: boolean;
  emptyText?: string;
}

export function formatObjectWallMarkdown(settings, options: QnALogObjectWallOptions = {}) {
  const title = options.title || "待办墙";
  const initialFilter = options.initialFilter || "all";
  const showFilters = options.showFilters !== false;
  const emptyText = options.emptyText || "还没有找到待办。会议纪要中的明确行动项可在确认后沉淀为待办。";
  const todoFolderQuery = JSON.stringify('"' + obsidian.normalizePath(settings && settings.todoCardsFolder || DEFAULT_SETTINGS.todoCardsFolder || "") + '"');
  const todoTag = JSON.stringify("#" + TODO_CARD_TAG);
  return [
    "---", "cssclasses:", "  - qnalog-wall-page", "---", "", "# " + title, "", "```dataviewjs",
    "const shell = dv.el(\"div\", \"\", { cls: \"qnalog-wall-shell\" });",
    "const toolbar = document.createElement(\"div\");",
    "toolbar.className = \"qnalog-wall-filterbar\";",
    "const root = document.createElement(\"div\");",
    "root.className = \"qnalog-wall qnalog-wall-object\";",
    "shell.appendChild(toolbar);",
    "shell.appendChild(root);",
    "const todoFolderQuery = " + todoFolderQuery + ";",
    "const todoTag = " + todoTag + ";",
    "const showFilters = " + (showFilters ? "true" : "false") + ";",
    "let activeFilter = " + JSON.stringify(initialFilter) + ";",
    "const labels = { todo: \"待办\" };",
    "const records = [];",
    "const seen = new Set();",
    "const esc = s => String(s ?? \"\").replace(/[&<>\\\"]/g, c => c === \"&\" ? \"&amp;\" : c === \"<\" ? \"&lt;\" : c === \">\" ? \"&gt;\" : \"&quot;\");",
    "const cleanTag = t => String(t || \"\").replace(/^#/, \"\");",
    "const hasTag = (p, tag) => (p.file.tags || []).map(cleanTag).includes(cleanTag(tag));",
    "const sourceName = src => src ? String(src.path ?? src).split(\"/\").pop().replace(/\\.md$|[\\[\\]]/g, \"\") : \"\";",
    "function pushRecord(record){ if (!record || !record.id || seen.has(record.id)) return; seen.add(record.id); records.push(record); }",
    "function columnCount(width, mode){ if (mode === \"todo\") return width >= 720 ? 2 : 1; if (width >= 1320) return 4; if (width >= 960) return 3; if (width >= 620) return 2; return 1; }",
    "function layoutWidth(){ const selectors = [\".workspace-leaf-content\", \".view-content\", \".markdown-preview-view\", \".markdown-reading-view\", \".markdown-source-view\"]; const nodes = selectors.map(sel => root.closest(sel)).filter(Boolean); nodes.push(root.parentElement, root); for (const node of nodes) { const rect = node && node.getBoundingClientRect ? node.getBoundingClientRect() : null; const width = Math.floor(Math.max(node && node.clientWidth || 0, rect && rect.width || 0)); if (width > 120) return width; } return window.innerWidth || 0; }",
    "function cardWeight(card){ return 10 + String(card.title || \"\").length * 1.2 + String(card.sum || \"\").length * 0.34 + String(card.src || \"\").length * 0.16 + (card.tagCount || 0) * 3; }",
    "function stripTodoMarker(text){ return String(text || \"\").replace(/<!--\\\\s*qnalog-todo:[\\\\s\\\\S]*?-->/g, \"\").trim(); }",
    "function readField(text, label){ const m = String(text || \"\").match(new RegExp(label + \"：([^\\\\n]+?)(?=\\\\s+(?:日期|责任人|事项|截止|时间)：|\\\\s+👤|\\\\s+\\\\(来源:|$)\")); return m ? m[1].trim() : \"\"; }",
    "function addTodoRecord(p, task){",
    "  const raw = stripTodoMarker(task && task.text || \"\");",
    "  const markerMatch = String(task && task.text || \"\").match(/qnalog-todo:([^\\\\s>]+)/);",
    "  const marker = markerMatch ? markerMatch[1] : \"\";",
    "  const title = String(p[\"事项\"] || readField(raw, \"事项\") || raw || p.file.name || \"未命名待办\").replace(/^[-*]\\s*/, \"\");",
    "  const owner = String(p[\"责任人\"] || readField(raw, \"责任人\") || (raw.match(/👤\\s*([^\\s]+)/) || [])[1] || \"\").trim();",
    "  const due = String(p[\"截止\"] || readField(raw, \"截止\") || \"\").trim();",
    "  const src = sourceName(p[\"来源笔记\"] || p[\"来源\"]);",
    "  const children = Array.from(task && task.children || []).map(item => stripTodoMarker(item.text)).filter(Boolean).slice(0, 4);",
    "  const line = Number(task && task.line);",
    "  const id = \"todo:\" + p.file.path + \":\" + (Number.isFinite(line) ? line : marker || title);",
    "  pushRecord({ id, kind: \"todo\", type: \"待办\", title, sum: owner || due ? [owner && \"责任人：\" + owner, due && \"截止：\" + due].filter(Boolean).join(\" · \") : \"\", owner, due, src, subtasks: children, path: p.file.path, line, marker, completed: !!(task && task.completed), tagCount: 0 });",
    "}",
    "for (const p of dv.pages(todoFolderQuery)) {",
    "  if (!hasTag(p, todoTag)) continue;",
    "  const tasks = Array.from(p.file.tasks || []).filter(t => !t.parent);",
    "  if (tasks.length) tasks.forEach(t => addTodoRecord(p, t));",
    "  else pushRecord({ id: \"todo-page:\" + p.file.path, kind: \"todo\", type: \"待办\", title: String(p[\"事项\"] || p.file.name), sum: [p[\"责任人\"] && \"责任人：\" + p[\"责任人\"], p[\"截止\"] && \"截止：\" + p[\"截止\"]].filter(Boolean).join(\" · \"), path: p.file.path, completed: String(p[\"状态\"] || \"\") === \"完成\", tagCount: 0 });",
    "}",
    "for (const p of dv.pages()) {",
    "  for (const task of Array.from(p.file.tasks || [])) {",
    "    if (/qnalog-todo:/.test(String(task.text || \"\"))) addTodoRecord(p, task);",
    "  }",
    "}",
    "records.sort((a, b) => String(b.time || b.path || \"\").localeCompare(String(a.time || a.path || \"\")));",
    "function filteredRecords(){ return activeFilter === \"all\" ? records : records.filter(r => r.kind === activeFilter); }",
    "function recordHtml(record){",
    "  const subtasks = (record.subtasks || []).map(item => '<li>' + esc(item) + '</li>').join(\"\");",
    "  return '<div class=\\\"qnalog-wall-card qnalog-wall-todo-card' + (record.completed ? ' is-completed' : '') + '\\\" data-kind=\\\"todo\\\" data-id=\\\"' + esc(record.id) + '\\\" data-path=\\\"' + esc(record.path) + '\\\">' + '<label class=\\\"qnalog-wall-todo-check\\\" title=\\\"切换完成状态\\\"><input type=\\\"checkbox\\\" data-id=\\\"' + esc(record.id) + '\\\" ' + (record.completed ? 'checked' : '') + '><span></span></label>' + '<div class=\\\"qnalog-wall-todo-body\\\"><div class=\\\"qnalog-wall-head\\\"><span class=\\\"qnalog-wall-type\\\">待办</span><span class=\\\"qnalog-wall-brand\\\">ACTION</span></div><div class=\\\"qnalog-wall-title\\\">' + esc(record.title) + '</div>' + (record.sum ? '<div class=\\\"qnalog-wall-sum\\\">' + esc(record.sum) + '</div>' : '') + (subtasks ? '<ul class=\\\"qnalog-wall-subtasks\\\">' + subtasks + '</ul>' : '') + (record.src ? '<div class=\\\"qnalog-wall-k\\\">来源</div><div class=\\\"qnalog-wall-src\\\">' + esc(record.src) + '</div>' : '') + '</div></div>';",
    "}",
    "async function setTaskDone(record, done){",
    "  if (!record || !record.path) return;",
    "  const file = app.vault.getAbstractFileByPath(record.path);",
    "  if (!file) return;",
    "  const text = await app.vault.cachedRead(file);",
    "  const eol = text.includes(\"\\r\\n\") ? \"\\r\\n\" : \"\\n\";",
    "  const lines = text.split(/\\r?\\n/);",
    "  let idx = Number(record.line);",
    "  if (!Number.isFinite(idx) || !lines[idx] || !/^\\s*-\\s\\[[ xX/-]\\]/.test(lines[idx])) {",
    "    idx = record.marker ? lines.findIndex(line => new RegExp(\"qnalog-todo:\" + record.marker).test(line)) : -1;",
    "  }",
    "  if (idx < 0 || !lines[idx]) return;",
    "  lines[idx] = lines[idx].replace(/^(\\s*-\\s\\[)[ xX/-](\\]\\s*)/, '$1' + (done ? 'x' : ' ') + '$2');",
    "  await app.vault.modify(file, lines.join(eol));",
    "  record.completed = done;",
    "}",
    "function renderToolbar(){",
    "  toolbar.innerHTML = \"\";",
    "  if (!showFilters) { toolbar.style.display = \"none\"; return; }",
    "  const filters = [\"todo\"];",
    "  for (const key of filters) {",
    "    const count = key === \"all\" ? records.length : records.filter(r => r.kind === key).length;",
    "    const btn = document.createElement(\"button\");",
    "    btn.type = \"button\";",
    "    btn.className = \"qnalog-wall-filter\" + (activeFilter === key ? \" is-active\" : \"\");",
    "    btn.textContent = labels[key] + \" \" + count;",
    "    btn.addEventListener(\"click\", () => { activeFilter = key; renderToolbar(); renderWall(); });",
    "    toolbar.appendChild(btn);",
    "  }",
    "}",
    "function bindCards(){",
    "  root.querySelectorAll(\".qnalog-wall-card\").forEach(el => el.addEventListener(\"click\", event => { if (event.target && event.target.closest && event.target.closest(\"input,label,button\")) return; const path = el.dataset.path; if (path) app.workspace.openLinkText(path, \"\", false); }));",
    "  root.querySelectorAll(\".qnalog-wall-todo-check input\").forEach(input => input.addEventListener(\"change\", async event => { event.stopPropagation(); const record = records.find(r => r.id === input.dataset.id); if (!record) return; const card = input.closest(\".qnalog-wall-todo-card\"); try { await setTaskDone(record, input.checked); if (card) card.classList.toggle(\"is-completed\", input.checked); } catch(e) { console.error(e); new Notice(\"待办状态写回失败：\" + (e.message || e)); input.checked = !input.checked; } }));",
    "}",
    "let lastCols = 0; let raf = 0;",
    "function renderWall(){",
    "  const visible = filteredRecords();",
    "  const width = layoutWidth();",
    "  const cols = columnCount(width, activeFilter);",
    "  root.className = \"qnalog-wall qnalog-wall-object\" + (activeFilter === \"todo\" ? \" qnalog-wall-todos\" : \"\");",
    "  root.style.setProperty(\"--qnalog-wall-columns\", String(cols));",
    "  root.style.setProperty(\"--qnalog-wall-gutter\", (width < 680 ? 18 : 24) + \"px\");",
    "  if (!visible.length) { root.classList.add(\"is-empty\"); root.innerHTML = " + JSON.stringify("<p>" + emptyText + "</p>") + "; return; }",
    "  root.classList.remove(\"is-empty\");",
    "  const buckets = Array.from({ length: cols }, () => ({ weight: 0, html: \"\" }));",
    "  for (const record of visible) {",
    "    let target = 0;",
    "    for (let i = 1; i < buckets.length; i++) if (buckets[i].weight < buckets[target].weight) target = i;",
    "    buckets[target].html += recordHtml(record);",
    "    buckets[target].weight += cardWeight(record);",
    "  }",
    "  root.innerHTML = buckets.map(b => '<div class=\\\"qnalog-wall-col\\\">' + b.html + '</div>').join(\"\");",
    "  bindCards();",
    "  lastCols = cols;",
    "}",
    "function scheduleLayout(){ if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { raf = 0; const width = layoutWidth(); const cols = columnCount(width, activeFilter); root.style.setProperty(\"--qnalog-wall-columns\", String(cols)); root.style.setProperty(\"--qnalog-wall-gutter\", (width < 680 ? 18 : 24) + \"px\"); if (cols !== lastCols) renderWall(); }); }",
    "renderToolbar();",
    "renderWall();",
    "if (typeof ResizeObserver !== \"undefined\") { const ro = new ResizeObserver(scheduleLayout); [root, root.parentElement, shell, shell.parentElement, root.closest(\".markdown-preview-view\"), root.closest(\".markdown-reading-view\"), root.closest(\".markdown-source-view\"), root.closest(\".view-content\"), root.closest(\".workspace-leaf-content\")].filter(Boolean).forEach(el => ro.observe(el)); }",
    "window.addEventListener(\"resize\", scheduleLayout, { passive: true });",
    "```", "",
  ].join("\n");
}

export function formatTodoWallMarkdown(settings) {
  return formatObjectWallMarkdown(settings, {
    title: t("To-do wall"),
    initialFilter: "todo",
    showFilters: false,
    emptyText: "没有找到待办卡片。会议纪要中的明确行动项可在确认后沉淀为待办。"
  });
}


/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
