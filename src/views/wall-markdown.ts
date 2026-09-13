/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// @ts-nocheck
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：卡片墙 / 对象总览的 Markdown 生成（内嵌 dataviewjs 模板，纯字符串）

import * as obsidian from "obsidian";
import { CONCEPT_CARD_TAG, LEARNING_CARD_TAG, TODO_CARD_TAG } from "../shared/util-note";
import { DEFAULT_LIBRARY_PATHS, DEFAULT_SETTINGS } from "../shared/defaults";

export function getLexVoiceBasesFolder(settings) {
  return obsidian.normalizePath((settings && settings.lexVoiceBasesFolder) || DEFAULT_SETTINGS.lexVoiceBasesFolder || DEFAULT_LIBRARY_PATHS.lexVoiceBasesFolder);
}


export const LEARNING_WALL_FILE = "学习卡片瀑布墙.md";

export const CONCEPT_WALL_FILE = "概念墙.md";

export const TODO_WALL_FILE = "待办墙.md";

export const OBJECT_WALL_FILE = "对象总览.md";


export function getLexVoiceWallPath(settings, fileName) {
  const folder = getLexVoiceBasesFolder(settings);
  return obsidian.normalizePath(folder + "/" + fileName);
}


export function insertGeneratedWallMarker(markdown) {
  const marker = "<!-- lexvoice-generated-wall -->";
  const text = String(markdown || "");
  if (text.includes(marker)) return text;
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!fm) return marker + "\n" + text;
  const frontmatter = fm[0].replace(/\s*$/, "\n");
  const body = text.slice(fm[0].length).replace(/^\n*/, "");
  return frontmatter + "\n" + marker + "\n" + body;
}


export function formatLexVoiceWallMarkdown(title, folder, tag, emptyText) {
  const folderQuery = JSON.stringify('"' + obsidian.normalizePath(folder || "") + '"');
  const tagQuery = JSON.stringify("#" + String(tag || "").replace(/^#/, ""));
  return [
    "---", "cssclasses:", "  - lvwall-page", "---", "", "# " + title, "", "```dataviewjs",
    "const root = dv.el(\"div\", \"\", { cls: \"lvwall\" });",
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
    "  const tags = rawTags.map(t => '<span class=\\\"lvwall-tag\\\">' + esc(String(t).replace(/^#/, \"\")) + '</span>').join(\"\");",
    "  const ct = p.file.ctime ? p.file.ctime.toFormat(\"yyyy-MM-dd HH:mm\") : \"\";",
    "  const html = '<div class=\\\"lvwall-card\\\" data-path=\\\"' + esc(p.file.path) + '\\\">' + '<div class=\\\"lvwall-head\\\"><span class=\\\"lvwall-type\\\">' + type + '</span><span class=\\\"lvwall-brand\\\">LEXVOICE CARD</span></div>' + '<div class=\\\"lvwall-title\\\">' + title + '</div>' + (sum ? '<div class=\\\"lvwall-k\\\">摘要</div><div class=\\\"lvwall-sum\\\">' + sum + '</div>' : '') + (src ? '<div class=\\\"lvwall-k\\\">来源</div><div class=\\\"lvwall-src\\\">' + src + '</div>' : '') + (tags ? '<div class=\\\"lvwall-tags\\\">' + tags + '</div>' : '') + (ct ? '<div class=\\\"lvwall-time\\\">' + ct + '</div>' : '') + '</div>';",
    "  cards.push({ html, title, sum, src, tagCount: rawTags.length });",
    "}",
    "let lastCols = 0; let raf = 0;",
    "function bindCards(){ root.querySelectorAll(\".lvwall-card\").forEach(el => el.addEventListener(\"click\", () => app.workspace.openLinkText(el.dataset.path, \"\", false))); }",
    "function renderWall(){",
    "  const width = layoutWidth();",
    "  const cols = columnCount(width);",
    "  root.style.setProperty(\"--lvwall-columns\", String(cols));",
    "  root.style.setProperty(\"--lvwall-gutter\", (width < 680 ? 18 : 24) + \"px\");",
    "  if (!cards.length) { root.classList.add(\"is-empty\"); root.innerHTML = " + JSON.stringify("<p>" + emptyText + "</p>") + "; return; }",
    "  root.classList.remove(\"is-empty\");",
    "  const buckets = Array.from({ length: cols }, () => ({ weight: 0, html: \"\" }));",
    "  for (const card of cards) {",
    "    let target = 0;",
    "    for (let i = 1; i < buckets.length; i++) if (buckets[i].weight < buckets[target].weight) target = i;",
    "    buckets[target].html += card.html;",
    "    buckets[target].weight += cardWeight(card);",
    "  }",
    "  root.innerHTML = buckets.map(b => '<div class=\\\"lvwall-col\\\">' + b.html + '</div>').join(\"\");",
    "  bindCards();",
    "  lastCols = cols;",
    "}",
    "function scheduleLayout(){",
    "  if (raf) cancelAnimationFrame(raf);",
    "  raf = requestAnimationFrame(() => {",
    "    raf = 0;",
    "    const width = layoutWidth();",
    "    const cols = columnCount(width);",
    "    root.style.setProperty(\"--lvwall-columns\", String(cols));",
    "    root.style.setProperty(\"--lvwall-gutter\", (width < 680 ? 18 : 24) + \"px\");",
    "    if (cols !== lastCols) renderWall();",
    "  });",
    "}",
    "renderWall();",
    "if (typeof ResizeObserver !== \"undefined\") { const ro = new ResizeObserver(scheduleLayout); [root, root.parentElement, root.closest(\".markdown-preview-view\"), root.closest(\".markdown-reading-view\"), root.closest(\".markdown-source-view\"), root.closest(\".view-content\"), root.closest(\".workspace-leaf-content\")].filter(Boolean).forEach(el => ro.observe(el)); }",
    "window.addEventListener(\"resize\", scheduleLayout, { passive: true });",
    "```", "",
  ].join("\n");
}


export function formatLexVoiceObjectWallMarkdown(settings, options = {}) {
  const title = options.title || "对象总览";
  const initialFilter = options.initialFilter || "all";
  const showFilters = options.showFilters !== false;
  const emptyText = options.emptyText || "还没有找到沉淀对象。完成纪要沉淀后，学习卡片、概念和待办会出现在这里。";
  const learningFolderQuery = JSON.stringify('"' + obsidian.normalizePath(settings && settings.learningCardsFolder || DEFAULT_SETTINGS.learningCardsFolder || "") + '"');
  const todoFolderQuery = JSON.stringify('"' + obsidian.normalizePath(settings && settings.todoCardsFolder || DEFAULT_SETTINGS.todoCardsFolder || "") + '"');
  const learningTag = JSON.stringify("#" + LEARNING_CARD_TAG);
  const conceptTag = JSON.stringify("#" + CONCEPT_CARD_TAG);
  const todoTag = JSON.stringify("#" + TODO_CARD_TAG);
  return [
    "---", "cssclasses:", "  - lvwall-page", "---", "", "# " + title, "", "```dataviewjs",
    "const shell = dv.el(\"div\", \"\", { cls: \"lvwall-shell\" });",
    "const toolbar = document.createElement(\"div\");",
    "toolbar.className = \"lvwall-filterbar\";",
    "const root = document.createElement(\"div\");",
    "root.className = \"lvwall lvwall-object\";",
    "shell.appendChild(toolbar);",
    "shell.appendChild(root);",
    "const learningFolderQuery = " + learningFolderQuery + ";",
    "const todoFolderQuery = " + todoFolderQuery + ";",
    "const learningTag = " + learningTag + ";",
    "const conceptTag = " + conceptTag + ";",
    "const todoTag = " + todoTag + ";",
    "const showFilters = " + (showFilters ? "true" : "false") + ";",
    "let activeFilter = " + JSON.stringify(initialFilter) + ";",
    "const labels = { all: \"全部\", learning: \"学习卡片\", concept: \"概念\", todo: \"待办\" };",
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
    "function addPageCard(p, kind){",
    "  const kindLabel = kind === \"concept\" ? \"概念\" : \"学习卡片\";",
    "  const type = String(p[\"卡片类型\"] || p[\"类型\"] || kindLabel);",
    "  const title = String(p[\"标题\"] || p[\"事项\"] || p.file.name || kindLabel);",
    "  const sum = String(p[\"摘要\"] || p[\"说明\"] || p[\"任务\"] || p[\"事项\"] || \"\");",
    "  const src = sourceName(p[\"来源笔记\"] || p[\"来源\"]);",
    "  const tags = (p.file.tags || []).map(t => '<span class=\\\"lvwall-tag\\\">' + esc(cleanTag(t)) + '</span>').join(\"\");",
    "  const ct = p.file.ctime ? p.file.ctime.toFormat(\"yyyy-MM-dd HH:mm\") : \"\";",
    "  pushRecord({ id: kind + \":\" + p.file.path, kind, type, title, sum, src, tags, time: ct, path: p.file.path, tagCount: (p.file.tags || []).length });",
    "}",
    "function stripTodoMarker(text){ return String(text || \"\").replace(/<!--\\s*lexvoice-todo:[\\s\\S]*?-->/g, \"\").trim(); }",
    "function readField(text, label){ const m = String(text || \"\").match(new RegExp(label + \"：([^\\\\n]+?)(?=\\\\s+(?:日期|责任人|事项|截止|时间)：|\\\\s+👤|\\\\s+\\\\(来源:|$)\")); return m ? m[1].trim() : \"\"; }",
    "function addTodoRecord(p, task){",
    "  const raw = stripTodoMarker(task && task.text || \"\");",
    "  const markerMatch = String(task && task.text || \"\").match(/lexvoice-todo:([^\\s>]+)/);",
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
    "for (const p of dv.pages(learningFolderQuery)) {",
    "  const concept = hasTag(p, conceptTag);",
    "  const learning = hasTag(p, learningTag);",
    "  if (concept) addPageCard(p, \"concept\");",
    "  else if (learning) addPageCard(p, \"learning\");",
    "}",
    "for (const p of dv.pages(todoFolderQuery)) {",
    "  if (!hasTag(p, todoTag)) continue;",
    "  const tasks = Array.from(p.file.tasks || []).filter(t => !t.parent);",
    "  if (tasks.length) tasks.forEach(t => addTodoRecord(p, t));",
    "  else pushRecord({ id: \"todo-page:\" + p.file.path, kind: \"todo\", type: \"待办\", title: String(p[\"事项\"] || p.file.name), sum: [p[\"责任人\"] && \"责任人：\" + p[\"责任人\"], p[\"截止\"] && \"截止：\" + p[\"截止\"]].filter(Boolean).join(\" · \"), path: p.file.path, completed: String(p[\"状态\"] || \"\") === \"完成\", tagCount: 0 });",
    "}",
    "for (const p of dv.pages()) {",
    "  for (const task of Array.from(p.file.tasks || [])) {",
    "    if (String(task.text || \"\").includes(\"lexvoice-todo:\")) addTodoRecord(p, task);",
    "  }",
    "}",
    "records.sort((a, b) => String(b.time || b.path || \"\").localeCompare(String(a.time || a.path || \"\")));",
    "function filteredRecords(){ return activeFilter === \"all\" ? records : records.filter(r => r.kind === activeFilter); }",
    "function recordHtml(record){",
    "  if (record.kind === \"todo\") {",
    "    const subtasks = (record.subtasks || []).map(item => '<li>' + esc(item) + '</li>').join(\"\");",
    "    return '<div class=\\\"lvwall-card lvwall-todo-card' + (record.completed ? ' is-completed' : '') + '\\\" data-kind=\\\"todo\\\" data-id=\\\"' + esc(record.id) + '\\\" data-path=\\\"' + esc(record.path) + '\\\">' + '<label class=\\\"lvwall-todo-check\\\" title=\\\"切换完成状态\\\"><input type=\\\"checkbox\\\" data-id=\\\"' + esc(record.id) + '\\\" ' + (record.completed ? 'checked' : '') + '><span></span></label>' + '<div class=\\\"lvwall-todo-body\\\"><div class=\\\"lvwall-head\\\"><span class=\\\"lvwall-type\\\">待办</span><span class=\\\"lvwall-brand\\\">ACTION</span></div><div class=\\\"lvwall-title\\\">' + esc(record.title) + '</div>' + (record.sum ? '<div class=\\\"lvwall-sum\\\">' + esc(record.sum) + '</div>' : '') + (subtasks ? '<ul class=\\\"lvwall-subtasks\\\">' + subtasks + '</ul>' : '') + (record.src ? '<div class=\\\"lvwall-k\\\">来源</div><div class=\\\"lvwall-src\\\">' + esc(record.src) + '</div>' : '') + '</div></div>';",
    "  }",
    "  return '<div class=\\\"lvwall-card\\\" data-kind=\\\"' + esc(record.kind) + '\\\" data-path=\\\"' + esc(record.path) + '\\\">' + '<div class=\\\"lvwall-head\\\"><span class=\\\"lvwall-type\\\">' + esc(record.type) + '</span><span class=\\\"lvwall-brand\\\">' + (record.kind === 'concept' ? 'CONCEPT' : 'LEARNING') + '</span></div>' + '<div class=\\\"lvwall-title\\\">' + esc(record.title) + '</div>' + (record.sum ? '<div class=\\\"lvwall-k\\\">摘要</div><div class=\\\"lvwall-sum\\\">' + esc(record.sum) + '</div>' : '') + (record.src ? '<div class=\\\"lvwall-k\\\">来源</div><div class=\\\"lvwall-src\\\">' + esc(record.src) + '</div>' : '') + (record.tags ? '<div class=\\\"lvwall-tags\\\">' + record.tags + '</div>' : '') + (record.time ? '<div class=\\\"lvwall-time\\\">' + esc(record.time) + '</div>' : '') + '</div>';",
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
    "    idx = record.marker ? lines.findIndex(line => line.includes(\"lexvoice-todo:\" + record.marker)) : -1;",
    "  }",
    "  if (idx < 0 || !lines[idx]) return;",
    "  lines[idx] = lines[idx].replace(/^(\\s*-\\s\\[)[ xX/-](\\]\\s*)/, '$1' + (done ? 'x' : ' ') + '$2');",
    "  await app.vault.modify(file, lines.join(eol));",
    "  record.completed = done;",
    "}",
    "function renderToolbar(){",
    "  toolbar.innerHTML = \"\";",
    "  if (!showFilters) { toolbar.style.display = \"none\"; return; }",
    "  const filters = [\"all\", \"learning\", \"concept\", \"todo\"];",
    "  for (const key of filters) {",
    "    const count = key === \"all\" ? records.length : records.filter(r => r.kind === key).length;",
    "    const btn = document.createElement(\"button\");",
    "    btn.type = \"button\";",
    "    btn.className = \"lvwall-filter\" + (activeFilter === key ? \" is-active\" : \"\");",
    "    btn.textContent = labels[key] + \" \" + count;",
    "    btn.addEventListener(\"click\", () => { activeFilter = key; renderToolbar(); renderWall(); });",
    "    toolbar.appendChild(btn);",
    "  }",
    "}",
    "function bindCards(){",
    "  root.querySelectorAll(\".lvwall-card\").forEach(el => el.addEventListener(\"click\", event => { if (event.target && event.target.closest && event.target.closest(\"input,label,button\")) return; const path = el.dataset.path; if (path) app.workspace.openLinkText(path, \"\", false); }));",
    "  root.querySelectorAll(\".lvwall-todo-check input\").forEach(input => input.addEventListener(\"change\", async event => { event.stopPropagation(); const record = records.find(r => r.id === input.dataset.id); if (!record) return; const card = input.closest(\".lvwall-todo-card\"); try { await setTaskDone(record, input.checked); if (card) card.classList.toggle(\"is-completed\", input.checked); } catch(e) { console.error(e); new Notice(\"待办状态写回失败：\" + (e.message || e)); input.checked = !input.checked; } }));",
    "}",
    "let lastCols = 0; let raf = 0;",
    "function renderWall(){",
    "  const visible = filteredRecords();",
    "  const width = layoutWidth();",
    "  const cols = columnCount(width, activeFilter);",
    "  root.className = \"lvwall lvwall-object\" + (activeFilter === \"todo\" ? \" lvwall-todos\" : \"\");",
    "  root.style.setProperty(\"--lvwall-columns\", String(cols));",
    "  root.style.setProperty(\"--lvwall-gutter\", (width < 680 ? 18 : 24) + \"px\");",
    "  if (!visible.length) { root.classList.add(\"is-empty\"); root.innerHTML = " + JSON.stringify("<p>" + emptyText + "</p>") + "; return; }",
    "  root.classList.remove(\"is-empty\");",
    "  const buckets = Array.from({ length: cols }, () => ({ weight: 0, html: \"\" }));",
    "  for (const record of visible) {",
    "    let target = 0;",
    "    for (let i = 1; i < buckets.length; i++) if (buckets[i].weight < buckets[target].weight) target = i;",
    "    buckets[target].html += recordHtml(record);",
    "    buckets[target].weight += cardWeight(record);",
    "  }",
    "  root.innerHTML = buckets.map(b => '<div class=\\\"lvwall-col\\\">' + b.html + '</div>').join(\"\");",
    "  bindCards();",
    "  lastCols = cols;",
    "}",
    "function scheduleLayout(){ if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { raf = 0; const width = layoutWidth(); const cols = columnCount(width, activeFilter); root.style.setProperty(\"--lvwall-columns\", String(cols)); root.style.setProperty(\"--lvwall-gutter\", (width < 680 ? 18 : 24) + \"px\"); if (cols !== lastCols) renderWall(); }); }",
    "renderToolbar();",
    "renderWall();",
    "if (typeof ResizeObserver !== \"undefined\") { const ro = new ResizeObserver(scheduleLayout); [root, root.parentElement, shell, shell.parentElement, root.closest(\".markdown-preview-view\"), root.closest(\".markdown-reading-view\"), root.closest(\".markdown-source-view\"), root.closest(\".view-content\"), root.closest(\".workspace-leaf-content\")].filter(Boolean).forEach(el => ro.observe(el)); }",
    "window.addEventListener(\"resize\", scheduleLayout, { passive: true });",
    "```", "",
  ].join("\n");
}

export function formatLearningWallMarkdown(settings) {
  return formatLexVoiceWallMarkdown("学习卡片瀑布墙", settings && settings.learningCardsFolder || DEFAULT_SETTINGS.learningCardsFolder, LEARNING_CARD_TAG, "没有找到学习卡片。完成学习类纪要后，可从信息提取面板保存学习卡片。");
}


export function formatConceptWallMarkdown(settings) {
  const root = settings && settings.learningCardsFolder || DEFAULT_SETTINGS.learningCardsFolder;
  return formatLexVoiceWallMarkdown("概念墙", root, CONCEPT_CARD_TAG, "没有找到概念卡片。会中用 #概念 标记或从学习纪要中提取概念后，会出现在这里。");
}


export function formatTodoWallMarkdown(settings) {
  return formatLexVoiceObjectWallMarkdown(settings, {
    title: "待办墙",
    initialFilter: "todo",
    showFilters: false,
    emptyText: "没有找到待办卡片。会议纪要中的明确行动项可在确认后沉淀为待办。"
  });
}


export function formatObjectWallMarkdown(settings) {
  return formatLexVoiceObjectWallMarkdown(settings, {
    title: "对象总览",
    initialFilter: "all",
    showFilters: true,
    emptyText: "还没有找到沉淀对象。完成纪要沉淀后，学习卡片、概念和待办会出现在这里。"
  });
}


/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
