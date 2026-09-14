/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// @ts-nocheck
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：招聘场景：主页区块渲染、项目统计重算、候选人笔记落位、面试提纲后台生成

import * as obsidian from "obsidian";
import { sanitizeProjectFolderName } from "../outline-text";
import { lexvoiceConfirm } from "../ui/helpers";
import { listJDProjects } from "../recruit/jd-projects";
import { isRecruitFeatureUnlocked, getRecruitInterviewOutline, getRecruitJdPreview, normalizeRecruitContext, parseJdProject, ensureRecruitAggregateBase, createRecruitProject, renderRecruitHomepageTemplate, listRecruitCandidateNotes } from "../recruit";
import { recommendationTone } from "../recruit/bases-view";
import { normalizePersonLookupText } from "../people";
import type { LexVoiceSettings } from "../shared/types";
import { renderRecordingInterviewBriefBlock } from "../notes/detail-blocks";
import { ensureVaultFolder } from "../shared/util-vault";

/** RecruitService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface RecruitHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  getAvailableMarkdownPath(targetPath: string, currentPath: string): string | null;
  /** 笔记正文写入服务：面试提纲块插到分段逐字稿标记之前。 */
  noteWriter: { insertBeforeSegmentsStart(path: string, content: string, sessionId: string): Promise<void> };
  /** 视图外壳服务：打开招聘上下文弹窗。 */
  shell: { openRecruitContextInline(): Promise<void> };
  registerMarkdownCodeBlockProcessor(language: string, handler: (source: string, el: HTMLElement, ctx: obsidian.MarkdownPostProcessorContext) => void): void;
  saveSettings(): Promise<void>;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: LexVoiceSettings;
}

export class RecruitService {
  declare host: RecruitHost;
  declare _recruitRecalcDebouncers;

  constructor(host) {
    this.host = host;
    this._recruitRecalcDebouncers = null;
  }

  /** 卸载时取消所有待触发的重算定时器；插件仍在生成中的回调不再执行。 */
  dispose() {
    try { if (this._recruitRecalcDebouncers) { this._recruitRecalcDebouncers.forEach(d => { try { if (d.cancel) d.cancel(); } catch { /* intentionally empty */ } }); this._recruitRecalcDebouncers.clear(); } } catch { /* intentionally empty */ }
  }

  // F7：注册一个招聘主页 code block 渲染器，外层包 try/catch 降级为「数据加载失败 + 重试」。
  mountHrBlock(lang, render) {
    this.host.registerMarkdownCodeBlockProcessor(lang, (source, el, ctx) => {
      if (!isRecruitFeatureUnlocked(this.host.settings)) { el.empty(); el.createDiv({ cls: "lexvoice-hr-empty", text: "招聘功能未启用" }); return; }
      const go = () => Promise.resolve(render.call(this, source, el, ctx)).catch(e => {
        console.error("[QnALog] " + lang + " 渲染失败", e);
        el.empty();
        const box = el.createDiv({ cls: "lexvoice-hr-block-error" });
        box.createSpan({ text: "数据加载失败。" });
        box.createEl("button", { text: "重试" }).onclick = () => go();
      });
      void go();
    });
  }
  renderHrActions(source, el) {
    el.empty();
    const bar = el.createDiv({ cls: "lexvoice-hr-actions" });
    bar.createEl("button", { cls: "mod-cta", text: "＋ 新建面试" }).onclick = () => { void this.host.shell.openRecruitContextInline(); };
    bar.createEl("button", { text: "＋ 新建招聘项目" }).onclick = () => this.openNewRecruitProjectDialog();
  }
  renderHrLinks(source, el) {
    el.empty();
    const root = obsidian.normalizePath(this.host.settings.recruitJdFolderPath || "JD");
    const scrollToHeading = (label) => {
      const view = el.closest(".markdown-preview-view");
      if (!view) return;
      const headings = Array.from(view.querySelectorAll("h2, h3"));
      const target = headings.find(h => String(h.textContent || "").trim().includes(label));
      if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    const openProjectBase = async () => {
      try {
        await ensureRecruitAggregateBase(this.host.app, root);
        await this.host.app.workspace.openLinkText(obsidian.normalizePath(`${root}/招聘项目.base`), "", false);
      } catch (e) {
        console.error("[QnALog] open recruit base failed", e);
        new obsidian.Notice("打开招聘项目看板失败");
      }
    };
    const groups = [
      {
        title: "AGENDA",
        items: [
          { label: "新建面试", action: () => void this.host.shell.openRecruitContextInline() },
          { label: "新建项目", action: () => this.openNewRecruitProjectDialog() },
        ],
      },
      {
        title: "PROJECTS",
        items: [
          { label: "招聘项目", action: () => void openProjectBase() },
          { label: "在招项目", action: () => scrollToHeading("PROJECT TRACKING") },
        ],
      },
      {
        title: "PEOPLE",
        items: [
          { label: "候选人池", action: () => scrollToHeading("CANDIDATE POOL") },
          { label: "本周面试", action: () => scrollToHeading("THIS WEEK") },
        ],
      },
      {
        title: "QUERIES",
        items: [
          { label: "最近纪要", action: () => scrollToHeading("RECENT INTERVIEWS") },
          { label: "工作流", action: () => scrollToHeading("WORKFLOW") },
        ],
      },
    ];
    const grid = el.createDiv({ cls: "lexvoice-hr-links" });
    for (const group of groups) {
      const section = grid.createDiv({ cls: "lexvoice-hr-link-group" });
      section.createDiv({ cls: "lexvoice-hr-link-title", text: group.title });
      for (const item of group.items) {
        const btn = section.createEl("button", { cls: "lexvoice-hr-link-button", text: item.label });
        btn.onclick = (event) => {
          event.preventDefault();
          item.action();
        };
      }
    }
  }
  renderHrStats(source, el) {
    el.empty();
    const projects = listJDProjects(this.host.app, this.host.settings.recruitJdFolderPath);
    const notes = listRecruitCandidateNotes(this.host.app);
    let weekStart = 0;
    try { weekStart = window.moment ? window.moment().startOf("isoWeek").valueOf() : 0; } catch { weekStart = 0; }
    const weekNotes = notes.filter(n => n.time >= weekStart);
    const weekCands = new Set(weekNotes.map(n => n.候选人).filter(Boolean));
    const allCands = new Set(notes.map(n => n.候选人).filter(Boolean));
    const cards = [
      { label: "在招项目", value: projects.filter(p => p.status === "招聘中").length },
      { label: "候选人池", value: allCands.size },
      { label: "本周面试", value: weekNotes.length },
      { label: "本周新增候选人", value: weekCands.size },
    ];
    const grid = el.createDiv({ cls: "lexvoice-hr-stats" });
    for (const c of cards) {
      const card = grid.createDiv({ cls: "lexvoice-hr-stat-card" });
      card.createDiv({ cls: "lexvoice-hr-stat-value", text: String(c.value) });
      card.createDiv({ cls: "lexvoice-hr-stat-label", text: c.label });
    }
  }
  renderHrCandidates(source, el) {
    el.empty();
    let count = 30;
    const m = String(source || "").match(/count\s*[:=]\s*(\d+)/i);
    if (m) count = Math.max(1, parseInt(m[1], 10) || 30);
    const groups = new Map();
    for (const n of listRecruitCandidateNotes(this.host.app)) {
      const name = String(n.候选人 || "").trim();
      if (!name) continue;
      const key = normalizePersonLookupText(name) || name;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          候选人: name,
          联系方式: n.联系方式 || "",
          项目: n.项目 || "",
          最新轮次: n.轮次 || "",
          录用建议: n.录用建议 || "",
          一句话评价: n.一句话评价 || "",
          time: n.time || 0,
          path: n.path,
          count: 1,
        });
      } else {
        existing.count += 1;
        if (!existing.联系方式 && n.联系方式) existing.联系方式 = n.联系方式;
        if ((n.time || 0) > (existing.time || 0)) {
          existing.项目 = n.项目 || existing.项目;
          existing.最新轮次 = n.轮次 || existing.最新轮次;
          existing.录用建议 = n.录用建议 || existing.录用建议;
          existing.一句话评价 = n.一句话评价 || existing.一句话评价;
          existing.time = n.time || 0;
          existing.path = n.path;
        }
      }
    }
    const rows = Array.from(groups.values())
      .sort((a, b) => (b.time || 0) - (a.time || 0))
      .slice(0, count);
    if (!rows.length) { el.createDiv({ cls: "lexvoice-hr-empty", text: "暂无候选人评估纪要" }); return; }
    const table = el.createEl("table", { cls: "lexvoice-hr-table lexvoice-hr-candidate-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const h of ["候选人", "项目", "面试次数", "最近轮次", "最新结论", "一句话评价"]) head.createEl("th", { text: h });
    const tbody = table.createEl("tbody");
    for (const n of rows) {
      const tr = tbody.createEl("tr");
      const nameCell = tr.createEl("td");
      nameCell.createEl("strong", { text: n.候选人 || "—" });
      if (n.联系方式) nameCell.createDiv({ cls: "lexvoice-hr-subtext", text: n.联系方式 });
      tr.createEl("td", { text: n.项目 || "—" });
      tr.createEl("td", { text: String(n.count || 1) });
      tr.createEl("td", { text: n.最新轮次 || "—" });
      const recCell = tr.createEl("td");
      if (n.录用建议) {
        recCell.createSpan({ cls: "lexvoice-hr-rec", text: n.录用建议 }).setAttribute("data-tone", recommendationTone(n.录用建议));
      } else { recCell.setText("—"); }
      tr.createEl("td", { text: n.一句话评价 || "—" });
      tr.addClass("lexvoice-hr-row");
      tr.onclick = () => { void this.host.app.workspace.openLinkText(n.path, "", false); };
    }
  }
  renderHrRecent(source, el) {
    el.empty();
    let days = 7;
    const m = String(source || "").match(/days\s*[:=]\s*(\d+)/i);
    if (m) days = Math.max(1, parseInt(m[1], 10) || 7);
    let cutoff = 0;
    try { cutoff = window.moment ? window.moment().subtract(days, "days").valueOf() : 0; } catch { cutoff = 0; }
    const notes = listRecruitCandidateNotes(this.host.app).filter(n => n.time >= cutoff);
    if (!notes.length) { el.createDiv({ cls: "lexvoice-hr-empty", text: `近 ${days} 天暂无面试纪要` }); return; }
    const table = el.createEl("table", { cls: "lexvoice-hr-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const h of ["候选人", "项目", "轮次", "一句话评价", "录用建议"]) head.createEl("th", { text: h });
    const tbody = table.createEl("tbody");
    for (const n of notes) {
      const tr = tbody.createEl("tr");
      tr.createEl("td", { text: n.候选人 || "—" });
      tr.createEl("td", { text: n.项目 || "—" });
      tr.createEl("td", { text: n.轮次 || "—" });
      tr.createEl("td", { text: n.一句话评价 || "—" });
      const td = tr.createEl("td");
      if (n.录用建议) {
        td.createSpan({ cls: "lexvoice-hr-rec", text: n.录用建议 }).setAttribute("data-tone", recommendationTone(n.录用建议));
      } else { td.setText("—"); }
      tr.addClass("lexvoice-hr-row");
      tr.onclick = () => { void this.host.app.workspace.openLinkText(n.path, "", false); };
    }
  }
  renderHrLatest(source, el) {
    el.empty();
    let count = 10;
    const m = String(source || "").match(/count\s*[:=]\s*(\d+)/i);
    if (m) count = Math.max(1, parseInt(m[1], 10) || 10);
    const notes = listRecruitCandidateNotes(this.host.app).slice(0, count);
    if (!notes.length) { el.createDiv({ cls: "lexvoice-hr-empty", text: "暂无纪要" }); return; }
    const list = el.createEl("ul", { cls: "lexvoice-hr-latest" });
    for (const n of notes) {
      const li = list.createEl("li");
      const label = `${n.候选人 || "候选人"}${n.轮次 ? " · " + n.轮次 : ""}${n.项目 ? "（" + n.项目 + "）" : ""}`;
      const a = li.createEl("a", { text: label, href: "#" });
      a.onclick = (e) => { e.preventDefault(); void this.host.app.workspace.openLinkText(n.path, "", false); };
    }
  }
  // F4.3：扫某项目文件夹内候选人纪要，算 已面试数/候选人数/推荐数/倾向不推荐数/最新动态，原子写回 JD frontmatter。
  // 防自激：本方法只写 JD 文件，而触发它的 vault 钩子已过滤掉 JD 文件本身（basename==文件夹名），故 JD 的 modify 永不触发重算。
  async recalcRecruitProject(folderPath, retry) {
    const folder = this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(folderPath || ""));
    if (!(folder instanceof obsidian.TFolder)) return false;
    const jdFile = (folder.children || []).find(f => f instanceof obsidian.TFile && f.extension === "md" && f.basename === folder.name);
    if (!(jdFile instanceof obsidian.TFile)) return false; // 不是招聘项目文件夹（无同名 JD）
    const sessions = new Set();   // 候选人|轮次 去重 = 面试场次
    const candidates = new Set();
    let rec = 0, notRec = 0;
    let latest = null, latestTime = -1;
    let staleCache = false;
    const parseTime = (fm, f) => {
      try {
        if (fm.time && window.moment) { const mm = window.moment(fm.time); if (mm && mm.isValid && mm.isValid()) return mm.valueOf(); }
        if (fm.time) { const d = Date.parse(fm.time); if (!Number.isNaN(d)) return d; }
      } catch { /* intentionally empty */ }
      return f && f.stat ? f.stat.mtime : 0;
    };
    for (const f of (folder.children || [])) {
      if (!(f instanceof obsidian.TFile) || f.extension !== "md" || f.path === jdFile.path) continue;
      const fm = (this.host.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
      // 缓存未就绪兜底：刚落盘/批量导入的候选人纪要（文件名形如 候选人-轮次-MMDD）此刻 fm 可能为空 → 标记稍后重算
      if (!Object.keys(fm).length && /-[^/]+-\d{3,4}(-\d+)?$/.test(f.basename)) { staleCache = true; continue; }
      if (fm.jd == null && fm.mode !== "recruit") continue;        // 非候选人纪要（无 jd 链接、非招聘）
      if (fm.类型 === "招聘项目") continue;                          // 防御：别把别的项目文件误计
      const cand = String(fm.候选人 || "").trim();
      const round = String(fm.轮次 || "").trim();
      if (cand) candidates.add(cand);
      sessions.add(`${cand}|${round}`);
      const rl = String(fm.录用建议 || "").trim();
      if (rl === "强烈推荐" || rl === "推荐") rec++;
      if (rl.startsWith("倾向不推荐") || rl === "不推荐") notRec++;
      const t = parseTime(fm, f);
      if (t > latestTime) { latestTime = t; latest = { cand, evalText: String(fm.一句话评价 || "").trim() }; }
    }
    // 缓存未就绪 → 稍后再重算一次（metadataCache 大概率已重建），避免统计长期偏小且无自纠正
    if (staleCache && !retry) { window.setTimeout(() => { this.recalcRecruitProject(folderPath, true).catch(() => { /* intentionally empty */ }); }, 2000); }
    const latestText = latest ? (latest.evalText ? `${latest.cand}：${latest.evalText}` : latest.cand) : "";
    try {
      await this.host.app.fileManager.processFrontMatter(jdFile, (fm) => {
        fm.已面试数 = sessions.size;
        fm.候选人数 = candidates.size;
        fm.推荐数 = rec;
        fm.倾向不推荐数 = notRec;
        fm.最新动态 = latestText;
      });
      return true;
    } catch (e) {
      console.error("[QnALog] processFrontMatter recalc failed", e);
      if (!retry) { window.setTimeout(() => { this.recalcRecruitProject(folderPath, true).catch(() => { /* intentionally empty */ }); }, 1500); }
      else new obsidian.Notice("项目统计更新失败，可用命令「刷新当前招聘项目统计」手动刷新");
      return false;
    }
  }
  // F4.3：防抖触发某招聘项目文件夹的统计重算（3s 合并，每文件夹一个 Debouncer）。
  scheduleRecruitRecalc(folderPath) {
    if (!folderPath) return;
    if (!this._recruitRecalcDebouncers) this._recruitRecalcDebouncers = new Map();
    let d = this._recruitRecalcDebouncers.get(folderPath);
    if (!d) {
      d = obsidian.debounce(() => {
        this.recalcRecruitProject(folderPath).catch(e => console.error("[QnALog] recruit recalc failed", e));
      }, 3000, false);
      this._recruitRecalcDebouncers.set(folderPath, d);
    }
    d();
  }
  // F4.2：把招聘评估纪要移到对应 JD 项目文件夹，命名 候选人-轮次-MMDD(-N)。用 fileManager.renameFile（同步更新反链）。
  async resolveRecruitProjectContext(rc) {
    const ctx = normalizeRecruitContext(rc || {});
    const getJdFile = (path) => {
      const file = this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(path || ""));
      return file instanceof obsidian.TFile ? file : null;
    };
    const applyProject = async (base, jdFilePath, fallbackPosition) => {
      const next = normalizeRecruitContext(Object.assign({}, base, { jdFile: jdFilePath }));
      if (!next.position && fallbackPosition) next.position = fallbackPosition;
      try {
        const parsed = await parseJdProject(this.host.app, jdFilePath);
        if (!next.jd && parsed["岗位描述"]) next.jd = parsed["岗位描述"];
        if (!next.seniority && parsed["岗位资历"]) next.seniority = parsed["岗位资历"];
        if (!next.generalOutline && parsed["统一提纲"]) next.generalOutline = parsed["统一提纲"];
        if ((!next.requiredQualities || !next.requiredQualities.length) && parsed["综合素质"]) {
          next.requiredQualities = parsed["综合素质"];
        }
      } catch {
        /* intentionally empty */
      }
      return next;
    };
    const norm = (value) => sanitizeProjectFolderName(String(value || ""))
      .toLowerCase()
      .replace(/[\s\-_/\\（）()·.]+/g, "");
    if (ctx.jdFile && getJdFile(ctx.jdFile)) return ctx;

    const candidates = [
      ctx.position,
      getRecruitJdPreview(ctx.jd),
    ].map(norm).filter(Boolean);
    const matchesCandidate = (value) => {
      const v = norm(value);
      return !!v && candidates.some(c => c === v || c.includes(v) || v.includes(c));
    };

    const saved = normalizeRecruitContext(this.host.settings.recruitContext || {});
    if (saved.jdFile && getJdFile(saved.jdFile)) {
      if (!candidates.length || matchesCandidate(saved.position) || matchesCandidate(getRecruitJdPreview(saved.jd))) {
        return await applyProject(Object.assign({}, saved, ctx), saved.jdFile, saved.position);
      }
    }

    if (candidates.length) {
      const projects = listJDProjects(this.host.app, this.host.settings.recruitJdFolderPath);
      const matched = (projects || []).find(project =>
        project && project.hasJd && project.jdFilePath &&
        (matchesCandidate(project.position) || matchesCandidate(project.name))
      );
      if (matched) return await applyProject(ctx, matched.jdFilePath, matched.position || matched.name);
    }

    return ctx;
  }
  async relocateRecruitNote(session, rc) {
    try {
      if (!rc || !rc.jdFile) return null;
      const jdFile = this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(rc.jdFile));
      if (!(jdFile instanceof obsidian.TFile) || !jdFile.parent) return null;
      const folder = jdFile.parent.path;
      const cand = (sanitizeProjectFolderName(rc.candidateName || "候选人") || "候选人").slice(0, 40);
      let mmdd = "";
      try { mmdd = window.moment ? window.moment().format("MMDD") : ""; } catch { /* intentionally empty */ }
      const cur = this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(session.mdPath));
      if (!(cur instanceof obsidian.TFile)) return null;
      // 轮次取笔记 frontmatter 实际值（与落盘一致），回退 rc.round，再回退 初面——保证文件名与 frontmatter 轮次 同源
      const noteFm = (this.host.app.metadataCache.getFileCache(cur) || {}).frontmatter || {};
      const round = String(noteFm.轮次 || rc.round || "初面").replace(/[\\/:*?"<>|]/g, "").trim() || "初面";
      const target = this.host.getAvailableMarkdownPath(obsidian.normalizePath(`${folder}/${cand}-${round}-${mmdd}.md`), cur.path);
      if (!target || obsidian.normalizePath(target) === obsidian.normalizePath(cur.path)) return cur;
      await this.host.app.fileManager.renameFile(cur, target);
      return this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(target)) || cur;
    } catch (e) {
      console.error("[QnALog] relocateRecruitNote failed", e);
      return null;
    }
  }
  // F7：生成/重建招聘主页（重建前若有差异用 lexvoiceConfirm 确认覆盖）。
  async rebuildRecruitHomepage() {
    try {
      const root = obsidian.normalizePath(this.host.settings.recruitJdFolderPath || "JD");
      const hp = String(this.host.settings.recruitHomepagePath || "").trim();
      const targetPath = obsidian.normalizePath(hp || `${root}/招聘主页.md`);
      const tpl = renderRecruitHomepageTemplate();
      const slash = targetPath.lastIndexOf("/");
      const dir = slash >= 0 ? targetPath.slice(0, slash) : "";
      if (dir && !(this.host.app.vault.getAbstractFileByPath(dir) instanceof obsidian.TFolder)) await ensureVaultFolder(this.host.app, dir);
      await ensureRecruitAggregateBase(this.host.app, root);    // 主页嵌入聚合 base，确保它存在
      const existing = this.host.app.vault.getAbstractFileByPath(targetPath);
      if (existing instanceof obsidian.TFile) {
        const cur = await this.host.app.vault.read(existing);
        if (cur.trim() !== tpl.trim()) {
          const ok = await lexvoiceConfirm(this.host.app, "覆盖招聘主页？", "目标已存在且与最新模板不一致，重建会覆盖你的手改。", "覆盖重建");
          if (!ok) { await this.host.app.workspace.getLeaf(false).openFile(existing); return; }
          await this.host.app.vault.modify(existing, tpl);
        }
        await this.host.app.workspace.getLeaf(false).openFile(existing);
      } else {
        await this.host.app.vault.create(targetPath, tpl);
        const f = this.host.app.vault.getAbstractFileByPath(targetPath);
        if (f instanceof obsidian.TFile) await this.host.app.workspace.getLeaf(false).openFile(f);
      }
      new obsidian.Notice("招聘主页已就绪");
    } catch (e) {
      console.error("[QnALog] rebuild recruit homepage failed", e);
      new obsidian.Notice(`重建招聘主页失败：${(e && e.message) || e}`);
    }
  }
  openNewRecruitProjectDialog() {
    const sub = new obsidian.Modal(this.host.app);
    sub.titleEl.setText("新建招聘项目");
    const mk = (label, val, ph) => {
      const row = sub.contentEl.createDiv({ cls: "lexvoice-recruit-meta-cell" });
      row.createEl("label", { text: label });
      const inp = row.createEl("input", { type: "text", cls: "lexvoice-recruit-input" });
      inp.value = val || ""; inp.placeholder = ph || "";
      return inp;
    };
    const nameInp = mk("职位名", "", "如：海外发行-社招负责人");
    const seqInp = mk("序列", "招聘", "如：招聘 / 产品 / 运营");
    const statusInp = mk("状态", "招聘中", "招聘中 / 已关闭 / 暂停");
    sub.contentEl.createEl("label", { text: "JD 正文（可选，可稍后在项目里补）" });
    const jdTa = sub.contentEl.createEl("textarea", { cls: "lexvoice-recruit-textarea" });
    jdTa.placeholder = "粘贴 JD 正文…";
    const actions = sub.contentEl.createDiv({ cls: "lexvoice-recruit-actions" });
    actions.createEl("button", { text: "取消" }).onclick = () => sub.close();
    actions.createEl("button", { text: "创建", cls: "mod-cta" }).onclick = async () => {
      const name = String(nameInp.value || "").trim();
      if (!name) { new obsidian.Notice("请填职位名"); return; }
      try {
        const res = await createRecruitProject(this.host.app, this.host.settings.recruitJdFolderPath, name, { 职位名: name, 序列: seqInp.value, 状态: statusInp.value }, jdTa.value);
        new obsidian.Notice(`已创建招聘项目：${res.name}`);
        sub.close();
        const f = this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(res.mdPath));
        if (f instanceof obsidian.TFile) await this.host.app.workspace.getLeaf(false).openFile(f);
      } catch (e) { new obsidian.Notice(`创建失败：${(e && e.message) || e}`); }
    };
    sub.open();
  }
  scheduleRecruitInterviewBriefBackground(session) {
    if (!session || session._interviewBriefBackgroundRunning) return;
    session._interviewBriefBackgroundRunning = true;
    new obsidian.Notice("已开始录音；面试提纲会在后台生成并补到笔记顶部。", 5000);
    void (async () => {
      try {
        const ctx = normalizeRecruitContext(session.recruitContext || {});
        if (!ctx.jd && !ctx.resume) return;
        const brief = await getRecruitInterviewOutline(this, ctx);
        const body = String(brief || "").trim();
        if (!body) return;

        session.interviewBrief = body;
        session.recruitContext = { ...(session.recruitContext || {}), interviewBrief: body };
        this.host.settings.recruitContext = { ...normalizeRecruitContext({ ...(this.host.settings.recruitContext || {}), interviewBrief: body }) };
        try { await this.host.saveSettings(); } catch (e) { console.warn("[QnALog] save recruit brief cache failed", e); }

        const block = renderRecordingInterviewBriefBlock(session.id, body).trimEnd();
        const write = async () => {
          const file = this.host.app.vault.getAbstractFileByPath(session.mdPath);
          if (file instanceof obsidian.TFile) {
            const cur = await this.host.app.vault.read(file);
            if (cur.includes(`<!-- lexvoice-interview-brief-start:${session.id} -->`)) return;
          }
          await this.host.noteWriter.insertBeforeSegmentsStart(session.mdPath, block, session.id);
        };
        session.writeQueue = (session.writeQueue || Promise.resolve()).then(write, write).catch((e) => {
          console.error("[QnALog] insert background interview brief failed", e);
        });
        try { await session.writeQueue; } catch { /* already swallowed above */ }
        new obsidian.Notice("面试提纲已生成并补到当前笔记顶部。", 5000);
      } catch (e) {
        console.error("[QnALog] create interview brief in background failed", e);
        new obsidian.Notice("面试提纲后台生成失败；录音不受影响。", 7000);
      } finally {
        if (session) session._interviewBriefBackgroundRunning = false;
      }
    })();
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
