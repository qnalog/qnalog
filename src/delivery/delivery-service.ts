/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// @ts-nocheck
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：交付物生成：HTML 报告、整页 PDF、.eml 邮件草稿

import * as obsidian from "obsidian";
import { recolorReportHtml } from "../outline-text";
import { getDesktopModule } from "../shared/desktop-runtime";
import { pickReportAccentColor } from "../ui/modals";
import { sanitizeReportFileStem, generateHtmlReportFromMarkdown, generateStyledReportFromMarkdown } from "../report/render";
import { readFileFrontmatter } from "../shared/util-note";
import { normalizePersonLookupText, loadPeopleDirectory } from "../people";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { LexVoiceSettings } from "../shared/types";
import { escapeHtmlText } from "../shared/util-markdown";
import { canOmitServiceApiKey } from "../shared/util-llm-endpoint";
import { EMAIL_DRAFT_ATTACHMENT_FOLDER, EMAIL_DRAFT_FOLDER, arrayBufferToBase64, buildEmailDraftContent, buildMeetingEmailBody, extractMeetingAttendeeNames, guessEmailAttachmentMime, normalizeEmailAddressList } from "../notes/note-markdown";
import { detectRecentNoteMode } from "../recent/recent-notes";
import { ensureVaultFolder, findAvailableVaultPath } from "../shared/util-vault";

/** DeliveryService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface DeliveryHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: LexVoiceSettings;
}

export class DeliveryService {
  declare host: DeliveryHost;
  constructor(host) {
    this.host = host;
  }

  // 报告生成共用：校验 LLM 配置 →（研讨模板）弹配色选择 → 调模型产 HTML → 按所选色相整体重着色。
  // 返回 { html } 或 null（未配置/用户取消）。HTML 报告与 PDF 报告共用，保证选色/改色逻辑只有一份。
  async produceReportHtmlForFile(file) {
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") return null;
    if (!this.host.settings.llmApiKey && !canOmitServiceApiKey(this.host.settings.llmEndpoint)) {
      new obsidian.Notice("请先在 API 页配置大模型服务；本地、局域网或 Tailscale 等私有网络服务可留空密钥。", 8000);
      return null;
    }
    if (!this.host.settings.llmEndpoint || !this.host.settings.llmModel) {
      new obsidian.Notice("请先配置大模型服务地址和模型标识。", 8000);
      return null;
    }
    // 研讨纪要：纯白弥散数据驱动模板（大模型只产 DATA JSON 注入固定模板），生成前先选配色；其余模式沿用通用 HTML 报告。
    const frontmatter = await readFileFrontmatter(this.host, file);
    const mode = detectRecentNoteMode(this.host, file, frontmatter);
    const styled = mode === "seminar";
    let accentHex = null;
    if (styled) {
      accentHex = await pickReportAccentColor(this.host.app);
      if (accentHex === null) return null;  // 用户取消
    }
    new obsidian.Notice("QnALog：正在生成报告…");
    const markdown = await this.host.app.vault.read(file);
    let html = styled
      ? await generateStyledReportFromMarkdown(this.host, mode, markdown)
      : await generateHtmlReportFromMarkdown(this.host, file.basename, markdown);
    if (styled && accentHex) html = recolorReportHtml(html, accentHex);
    return { html };
  }
  async generateHtmlReportForMarkdownFile(file) {
    try {
      const r = await this.produceReportHtmlForFile(file);
      if (!r) return;
      const folder = obsidian.normalizePath(this.host.settings.htmlReportFolder || DEFAULT_SETTINGS.htmlReportFolder);
      await ensureVaultFolder(this.host.app, folder);
      const target = findAvailableVaultPath(this.host.app, `${folder}/${sanitizeReportFileStem(file.basename)}-HTML报告.html`);
      if (!target) throw new Error("无法生成可用的 HTML 报告路径");
      const outFile = await this.host.app.vault.create(target, r.html);
      new obsidian.Notice(`QnALog：已生成 HTML 报告：${target}`, 8000);
      if (this.host.settings.autoOpenHtmlReportAfterGenerate !== false) {
        this.openVaultFileInSystem(outFile.path);
      }
    } catch (e) {
      console.error("[QnALog] generate html report failed", e);
      new obsidian.Notice(`HTML 报告生成失败：${(e && e.message) || e}`, 8000);
    }
  }
  async generatePdfReportForMarkdownFile(file) {
    try {
      const r = await this.produceReportHtmlForFile(file);
      if (!r) return;
      new obsidian.Notice("QnALog：正在渲染整页 PDF…");
      const folder = obsidian.normalizePath(this.host.settings.htmlReportFolder || DEFAULT_SETTINGS.htmlReportFolder);
      await ensureVaultFolder(this.host.app, folder);
      const target = findAvailableVaultPath(this.host.app, `${folder}/${sanitizeReportFileStem(file.basename)}-报告.pdf`);
      if (!target) throw new Error("无法生成可用的 PDF 路径");
      const pdfBuffer = await this.printHtmlToSinglePagePdfBuffer(r.html);
      const bytes = pdfBuffer instanceof Uint8Array ? pdfBuffer : new Uint8Array(pdfBuffer || []);
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const outFile = await this.host.app.vault.createBinary(target, arrayBuffer);
      new obsidian.Notice(`QnALog：已生成 PDF 报告：${target}`, 8000);
      if (this.host.settings.autoOpenHtmlReportAfterGenerate !== false) {
        this.openVaultFileInSystem(outFile.path);
      }
    } catch (e) {
      console.error("[QnALog] generate pdf report failed", e);
      new obsidian.Notice(`PDF 报告生成失败：${(e && e.message) || e}`, 8000);
    }
  }
  async printHtmlToPdfBuffer(html) {
    let BrowserWindow = null;
    try {
      const electron = getDesktopModule("electron");
      BrowserWindow = electron && (electron.BrowserWindow || (electron.remote && electron.remote.BrowserWindow));
    } catch { /* intentionally empty */ }
    if (!BrowserWindow) {
      try {
        const remote = getDesktopModule("@electron/remote");
        BrowserWindow = remote && remote.BrowserWindow;
      } catch { /* intentionally empty */ }
    }
    if (!BrowserWindow) throw new Error("当前 Obsidian 环境不支持自动生成 PDF");
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: "A4",
        margins: { marginType: "default" },
      });
      return pdf;
    } finally {
      try { win.destroy(); } catch { /* intentionally empty */ }
    }
  }
  // 整页不截断 PDF：隐藏窗口量内容真实尺寸 → 注入 @page 为整页全高 + preferCSSPageSize → 单页长 PDF（非 A4 分页，不截断）。
  async printHtmlToSinglePagePdfBuffer(html) {
    let BrowserWindow = null;
    try { const e = getDesktopModule("electron"); BrowserWindow = e && (e.BrowserWindow || (e.remote && e.remote.BrowserWindow)); } catch { /* intentionally empty */ }
    if (!BrowserWindow) { try { BrowserWindow = getDesktopModule("@electron/remote")?.BrowserWindow; } catch { /* intentionally empty */ } }
    if (!BrowserWindow) throw new Error("当前 Obsidian 环境不支持自动生成 PDF");
    const win = new BrowserWindow({ show: false, width: 1024, height: 1400, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    // 超时兜底：渲染进程崩溃/卡死时这些 await 可能永不 settle，不加超时会让用户卡在"正在渲染…"且无法取消。
    const withTimeout = (p, ms, label) => Promise.race([
      Promise.resolve(p),
      new Promise((_, rej) => window.setTimeout(() => rej(new Error(`${label}超时（${ms / 1000}s）`)), ms)),
    ]);
    try {
      await withTimeout(win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`), 30000, "PDF 页面加载");
      await new Promise(r => window.setTimeout(r, 200));  // 等字体/布局稳定，量高才准
      // 页宽量 .doc（内容定宽容器，纯白弥散模板为 960px）实际宽度，避免把溢出/留白算进页宽导致左右白边；无 .doc 退回文档滚动宽。
      const dims = await withTimeout(win.webContents.executeJavaScript(
        "(()=>{const d=document.documentElement,b=document.body,doc=document.querySelector('.doc');return{w:(doc&&doc.offsetWidth)||Math.max(b.scrollWidth,d.scrollWidth,640),h:Math.max(b.scrollHeight,d.scrollHeight,400)};})()"
      ), 10000, "PDF 内容测量");
      const wpx = Math.min(1600, Math.max(640, Math.ceil(Number(dims && dims.w) || 960)));
      const rawH = Math.max(400, Math.ceil(Number(dims && dims.h) || 1320) + 24);
      // 单页高度上限保护：PDF 单页约 200in≈19200px(96dpi)，超了会被裁，封顶 18000px 留余量。超长则提示用户，避免静默丢内容。
      const hpx = Math.min(18000, rawH);
      if (rawH > 18000) {
        try { new obsidian.Notice("报告较长，整页 PDF 已按单页高度上限裁切；要完整内容请改用 HTML 报告。", 9000); } catch { /* intentionally empty */ }
      }
      await withTimeout(win.webContents.executeJavaScript(
        "(()=>{const s=document.createElement('style');s.textContent='@page{size:" + wpx + "px " + hpx + "px;margin:0}';document.head.appendChild(s);return true;})()"
      ), 10000, "PDF 页面尺寸注入");
      const pdf = await withTimeout(win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { marginType: "none" } }), 45000, "PDF 渲染");
      return pdf;
    } finally {
      try { win.destroy(); } catch { /* intentionally empty */ }
    }
  }
  async renderMarkdownToEmailHtml(file, markdown) {
    let contentHtml = "";
    const renderComponent = new obsidian.Component();
    try {
      const el = activeWindow.createEl("article");
      if (obsidian.MarkdownRenderer && typeof obsidian.MarkdownRenderer.render === "function") {
        await obsidian.MarkdownRenderer.render(this.host.app, markdown, el, file.path, renderComponent);
      }
      contentHtml = el.innerHTML;
    } catch (e) {
      console.warn("[QnALog] markdown render for email pdf failed, fallback to plain markdown", e);
    } finally {
      renderComponent.unload();
    }
    if (!contentHtml) contentHtml = `<pre>${escapeHtmlText(markdown)}</pre>`;
    const title = escapeHtmlText(file && file.basename || "QnALog 会议纪要");
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
body { margin: 0; padding: 32px; color: #222; background: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; line-height: 1.65; }
article { max-width: 820px; margin: 0 auto; }
h1, h2, h3 { line-height: 1.25; }
pre { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
blockquote { margin: 12px 0; padding-left: 14px; border-left: 3px solid #ddd; color: #555; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #ddd; padding: 6px 8px; }
</style>
</head>
<body>
<article>${contentHtml}</article>
</body>
</html>`;
  }
  async createEmailDraftForMarkdownFile(file) {
    if (!(file instanceof obsidian.TFile) || file.extension !== "md") return;
    try {
      new obsidian.Notice("QnALog：正在生成邮件草稿…");
      const markdown = await this.host.app.vault.read(file);
      const { recipients, attendeeNames } = await this.resolveEmailRecipientsForMarkdownFile(file);
      const attachmentFiles = [file];
      let pdfFile = null;
      try {
        pdfFile = await this.ensureMarkdownPdfForEmail(file, markdown);
      } catch (e) {
        console.warn("[QnALog] create email pdf failed", e);
        new obsidian.Notice(`PDF 自动生成失败：${(e && e.message) || e}；邮件草稿仍会包含 MD 和已有导出文件。`, 9000);
      }
      if (pdfFile instanceof obsidian.TFile) attachmentFiles.push(pdfFile);
      for (const generated of this.getGeneratedEmailAttachmentFiles(file)) {
        const path = obsidian.normalizePath(generated.path || "");
        if (!attachmentFiles.some(f => obsidian.normalizePath(f.path || "") === path)) attachmentFiles.push(generated);
      }
      const attachments = [];
      for (const attachmentFile of attachmentFiles) {
        try {
          attachments.push(await this.makeEmailAttachment(attachmentFile));
        } catch (e) {
          console.warn("[QnALog] attach file failed", attachmentFile && attachmentFile.path, e);
        }
      }
      const subject = `会议纪要：${file.basename}`;
      const body = buildMeetingEmailBody({
        file,
        markdown,
        attendeeNames,
        attachmentsCount: attachments.length,
      });
      const eml = buildEmailDraftContent({ to: recipients, subject, body, attachments });
      const folder = obsidian.normalizePath(EMAIL_DRAFT_FOLDER);
      await ensureVaultFolder(this.host.app, folder);
      const target = findAvailableVaultPath(this.host.app, `${folder}/${sanitizeReportFileStem(file.basename)}-邮件草稿.eml`);
      if (!target) throw new Error("无法生成可用的邮件草稿路径");
      const draft = await this.host.app.vault.create(target, eml);
      const opened = this.openVaultFileInSystem(draft.path);
      const recipientHint = recipients.length ? `，已填入 ${recipients.length} 个收件人` : "，未匹配到邮箱";
      new obsidian.Notice(`QnALog：已生成邮件草稿${recipientHint}，附件 ${attachments.length} 个。${opened ? "" : "可在邮件草稿文件夹中打开。"}`, 10000);
    } catch (e) {
      console.error("[QnALog] create email draft failed", e);
      new obsidian.Notice(`邮件草稿生成失败：${(e && e.message) || e}`, 9000);
    }
  }
  async makeEmailAttachment(file) {
    const data = await this.host.app.vault.readBinary(file);
    return {
      name: file.name,
      mime: guessEmailAttachmentMime(file),
      base64: arrayBufferToBase64(data),
      path: file.path,
    };
  }
  async resolveEmailRecipientsForMarkdownFile(file) {
    const frontmatter = await readFileFrontmatter(this.host, file) || {};
    const attendeeNames = extractMeetingAttendeeNames(frontmatter);
    if (!attendeeNames.length) return { recipients: [], attendeeNames };
    const attendeeKeys = new Set(attendeeNames.map(normalizePersonLookupText).filter(Boolean));
    const people = await loadPeopleDirectory(this.host);
    const recipients = [];
    const seen = new Set();
    for (const person of people || []) {
      const terms = [person.name, ...(person.aliases || [])]
        .map(normalizePersonLookupText)
        .filter(Boolean);
      if (!terms.some(term => attendeeKeys.has(term))) continue;
      for (const email of normalizeEmailAddressList(person.email)) {
        if (seen.has(email)) continue;
        seen.add(email);
        recipients.push(email);
      }
    }
    return { recipients, attendeeNames };
  }
  getGeneratedEmailAttachmentFiles(file) {
    const stem = sanitizeReportFileStem(file && file.basename || "").toLowerCase();
    if (!stem) return [];
    const folders = [
      this.host.settings.htmlReportFolder || DEFAULT_SETTINGS.htmlReportFolder,
    ].map(p => obsidian.normalizePath(p || "")).filter(Boolean);
    const allowed = new Set(["html", "htm", "pdf"]);
    const out = [];
    const seen = new Set();
    for (const candidate of this.host.app.vault.getFiles()) {
      const path = obsidian.normalizePath(candidate.path || "");
      const ext = String(candidate.extension || "").toLowerCase();
      if (!allowed.has(ext)) continue;
      if (!folders.some(folder => path.startsWith(folder + "/"))) continue;
      const base = String(candidate.basename || "").toLowerCase();
      if (!base.startsWith(stem)) continue;
      if (file && obsidian.normalizePath(candidate.path) === obsidian.normalizePath(file.path)) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(candidate);
    }
    return out.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  }
  async ensureMarkdownPdfForEmail(file, markdown) {
    const folder = obsidian.normalizePath(EMAIL_DRAFT_ATTACHMENT_FOLDER);
    await ensureVaultFolder(this.host.app, folder);
    const target = findAvailableVaultPath(this.host.app, `${folder}/${sanitizeReportFileStem(file.basename)}-纪要PDF.pdf`);
    if (!target) throw new Error("无法生成可用的 PDF 路径");
    const html = await this.renderMarkdownToEmailHtml(file, markdown);
    const pdfBuffer = await this.printHtmlToPdfBuffer(html);
    const bytes = pdfBuffer instanceof Uint8Array ? pdfBuffer : new Uint8Array(pdfBuffer || []);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return await this.host.app.vault.createBinary(target, arrayBuffer);
  }

  openVaultFileInSystem(path) {
    try {
      const adapter = this.host.app.vault.adapter;
      const fullPath = adapter && typeof adapter.getFullPath === "function" ? adapter.getFullPath(path) : "";
      if (!fullPath) return false;
      const electron = getDesktopModule("electron");
      if (electron && electron.shell && typeof electron.shell.openPath === "function") {
        electron.shell.openPath(fullPath);
        return true;
      }
    } catch (e) {
      console.warn("[QnALog] open generated report failed", e);
    }
    return false;
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
