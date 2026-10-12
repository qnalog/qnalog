import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRootArg = process.argv.find((arg) => arg.startsWith("--repo-root="))?.slice("--repo-root=".length);
const repoRoot = resolve(repoRootArg || process.cwd());
const browserCandidates = [
  process.env.CHROMIUM_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter((value) => value && existsSync(value));
if (!browserCandidates.length) throw new Error("Chromium is required for topic dialog layout checks; set CHROMIUM_BIN.");

const tempBase = process.platform === "darwin" ? "/private/tmp" : tmpdir();
const temp = await mkdtemp(join(tempBase, "qnalog-topic-dialog-layout-"));
const browserData = join(temp, "browser-data");
const bundle = join(temp, "topic-dialog.js");
const html = join(temp, "index.html");
let browser;
let socket;

try {
  const entry = join(repoRoot, "tests/browser/topic-dialog-layout-entry.ts");
  const shim = join(repoRoot, "tests/browser/topic-dialog-layout-shim.ts");
  const stylesheet = await readFile(join(repoRoot, "styles.css"), "utf8");
  await build({
    entryPoints: [entry], bundle: true, platform: "browser", format: "iife", outfile: bundle,
    alias: { obsidian: shim }, logLevel: "silent",
    plugins: [{ name: "topic-panel-helper-shim", setup(buildApi) {
      buildApi.onResolve({ filter: /helpers$/ }, (args) => args.importer.endsWith("/topics-panel.ts") || args.importer.endsWith("/topic-dialog-layout-entry.ts")
        ? { path: join(repoRoot, "tests/browser/topic-helper-shim.ts") } : undefined);
    } }],
  });
  await writeFile(html, `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: light; --background-primary:#fff; --background-secondary:#f1f3f5; --background-modifier-border:#d7dbe0; --text-normal:#25282c; --text-muted:#656b73; --text-faint:#8b9098; --text-accent:#6750a4; --interactive-accent:#6750a4; --interactive-accent-hover:#58428e; --text-warning:#a96900; --modal-background:#fff; --font-ui-small:12px; --font-ui-smaller:11px; --font-ui-medium:15px; --background-modifier-hover:#eceef1; --radius-s:4px; --radius-m:8px; }
    .theme-dark { color-scheme:dark; --background-primary:#191a1c; --background-secondary:#24262a; --background-modifier-border:#3a3d42; --text-normal:#e7e9ec; --text-muted:#b1b5bc; --text-faint:#858b94; --text-accent:#b4a1fa; --interactive-accent:#a88df4; --interactive-accent-hover:#c0adff; --text-warning:#e2b75f; --modal-background:#1d1e20; }
    body { min-height:100vh; margin:0; background:var(--background-primary); color:var(--text-normal); font:14px/1.4 system-ui,sans-serif; }
    .modal-container { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; }
    .modal { position:relative; box-sizing:border-box; width:560px; max-width:min(720px, 92vw); max-height:100vh; overflow-x:auto; }
    @media (max-width: 480px) { .modal { max-width:95vw; } }
    .modal-header-button { position:absolute; top:8px; right:8px; z-index:2; }
    .modal-content { padding:20px; background:var(--modal-background); }
    button,input { font:inherit; }
    ${stylesheet.replace(/<\/style/gi, "<\\/style")}
  </style></head><body><script src="${pathToFileURL(bundle).href}"></script></body></html>`);

  await mkdir(browserData, { recursive: true });
  browser = spawn(browserCandidates[0], [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--disable-dev-shm-usage",
    "--allow-file-access-from-files",
    "--remote-debugging-port=0", `--user-data-dir=${browserData}`, pathToFileURL(html).href,
  ], { stdio: "ignore" });
  const activePortFile = join(browserData, "DevToolsActivePort");
  let debuggingPort = "";
  for (let attempt = 0; attempt < 100 && !debuggingPort; attempt++) {
    try { debuggingPort = (await readFile(activePortFile, "utf8")).split(/\r?\n/)[0]; }
    catch { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); }
  }
  if (!debuggingPort) throw new Error("Chromium did not start its debugging endpoint.");
  const targetUrl = new URL(`http://127.0.0.1:${debuggingPort}/json/new`);
  targetUrl.searchParams.set("url", "about:blank");
  const targetResponse = await fetch(targetUrl, { method: "PUT" });
  if (!targetResponse.ok) throw new Error(`Chromium target creation failed: ${targetResponse.status}`);
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      if (message.method === "Runtime.exceptionThrown") console.error(`[topic-dialog-layout] browser exception: ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const cdp = (method, params = {}) => new Promise((resolveResult, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: resolveResult, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description || ""}`);
    return result.result.value;
  };
  // Horizontal geometry of an open topic dialog. Text edges use Range rects so glyphs that overflow a clipped box still count.
  const horizontalFacts = (kind) => `(() => {
    const modal = document.querySelector('.modal');
    const content = document.querySelector('.modal-content.qnalog-topics-${kind}');
    const edge = modal.getBoundingClientRect();
    const rightOf = (element) => {
      return element.getBoundingClientRect().right;
    };
    const textEdges = [...content.querySelectorAll('h2, h3, label, input[type="text"], .qnalog-topics-candidate-title, .qnalog-topics-candidate-summary, .qnalog-topics-preview-text, .qnalog-topics-reason, .qnalog-topics-membership, .qnalog-topics-missing, .qnalog-topics-preview-meta > *, .qnalog-topics-notice, .qnalog-topics-cost-warning, .qnalog-topics-estimate')]
      .map((element) => ({ text: (element.textContent || element.value || '').slice(0, 24), right: rightOf(element), rectRight: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
    const buttons = [...modal.querySelectorAll('button')].map((button) => { const rect = button.getBoundingClientRect(); return { text: button.textContent, left: rect.left, right: rect.right }; });
    return { modal: { left: edge.left, right: edge.right, scrollWidth: modal.scrollWidth, clientWidth: modal.clientWidth }, content: { scrollWidth: content.scrollWidth, clientWidth: content.clientWidth }, textEdges, buttons };
  })()`;
  const assertHorizontal = (facts, label) => {
    assert(facts.textEdges.length > 0 && facts.buttons.length > 0, `${label}: no content measured`);
    assert(facts.modal.scrollWidth <= facts.modal.clientWidth, `${label}: .modal has horizontal overflow (${facts.modal.scrollWidth}/${facts.modal.clientWidth})`);
    assert(facts.content.scrollWidth <= facts.content.clientWidth, `${label}: .modal-content has horizontal overflow (${facts.content.scrollWidth}/${facts.content.clientWidth})`);
    for (const button of facts.buttons) assert(button.left >= facts.modal.left - 0.5 && button.right <= facts.modal.right + 0.5, `${label}: button "${button.text}" is outside the dialog (${Math.round(button.left)}-${Math.round(button.right)} vs ${Math.round(facts.modal.left)}-${Math.round(facts.modal.right)})`);
    for (const item of facts.textEdges) assert(item.right <= facts.modal.right + 0.5, `${label}: text is clipped at the dialog edge: "${item.text}" (${Math.round(item.right)} > ${Math.round(facts.modal.right)}, rect ${Math.round(item.rectRight)}, width ${Math.round(item.width)}, scroll ${item.scrollWidth}/${item.clientWidth})`);
  };
  // Closes the open dialog as a user would (× button, Escape, or the Cancel button) and returns how many port.cancel calls that caused.
  const closeDialog = async (how, kind) => {
    const cancelsBefore = await evaluate("window.cancelledTopics.length");
    const action = how === "x" ? "document.querySelector('.modal-header-button').click()"
      : how === "esc" ? "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))"
        : `[...document.querySelectorAll('.modal-content.qnalog-topics-${kind} button')].find((button) => button.textContent === 'Cancel').click()`;
    await evaluate(action);
    assert.equal(await evaluate("document.querySelectorAll('.modal').length"), 0, `${kind} dialog did not close by ${how}`);
    return (await evaluate("window.cancelledTopics.length")) - cancelsBefore;
  };
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  const pageLoaded = new Promise((resolveLoad) => socket.addEventListener("message", function loaded(event) {
    if (JSON.parse(event.data).method !== "Page.loadEventFired") return;
    socket.removeEventListener("message", loaded);
    resolveLoad();
  }));
  await cdp("Page.navigate", { url: pathToFileURL(html).href });
  await Promise.race([pageLoaded, new Promise((resolveWait) => setTimeout(resolveWait, 5000))]);
  let entryReady = false;
  for (let attempt = 0; attempt < 60 && !entryReady; attempt++) {
    entryReady = await evaluate("typeof window.renderTopicCreate === 'function'").catch(() => false);
    if (!entryReady) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!entryReady) throw new Error(`Topic modal browser entry did not load: ${JSON.stringify(await evaluate("({href: location.href, scripts: [...document.scripts].map((item) => item.src), ready: document.readyState})"))}`);

  const waitUntil = async (expression) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`timed out waiting for ${expression}`);
  };
  for (const width of [320, 360, 390, 540, 720, 768, 1440]) for (const theme of ["light", "dark"]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 827, deviceScaleFactor: 1, mobile: false });
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await evaluate(`document.body.className = ${JSON.stringify(theme === "dark" ? "theme-dark" : "theme-light")}; window.renderTopicCreate()`);
    const create = await evaluate(`(() => {
      const content=document.querySelector('.modal-content.qnalog-topics-create'); const scroll=content?.querySelector('.qnalog-topics-scroll'); const footer=content?.querySelector('.qnalog-topics-modal-footer');
      const summaries=[...(content?.querySelectorAll('.qnalog-topics-candidate-summary') || [])].map((item) => item.textContent || '');
      const headings=[...(content?.querySelectorAll('.qnalog-topics-preview-heading') || [])]; const first=content?.querySelector('.qnalog-topics-candidate');
      return {title:content?.closest('.modal')?.querySelector('.modal-title')?.textContent, actionHeading:content?.querySelector('.qnalog-topics-dialog-heading')?.textContent, height:content?.clientHeight, scrollHeight:scroll?.scrollHeight, scrollClientHeight:scroll?.clientHeight, footerBottom:footer?.getBoundingClientRect().bottom, viewport:innerHeight, scrollWidth:content?.scrollWidth, clientWidth:content?.clientWidth, bodyScrollWidth:document.body.scrollWidth, summaries, headingTags:headings.map((item)=>item.tagName), candidateOutline:first?getComputedStyle(first).outlineStyle:null};
    })()`);
    assert(create.height > 0, `create dialog missing at ${width}px/${theme}`);
    assert.equal(create.title, "QnALog · Topics", `create title bar must be localized at ${width}px/${theme}`);
    assert.equal(create.actionHeading, "Create topic", `create action heading must be present at ${width}px/${theme}`);
    assert(create.scrollHeight > create.scrollClientHeight, `candidate list did not scroll at ${width}px/${theme}`);
    assert(create.footerBottom <= create.viewport, `create footer below viewport at ${width}px/${theme}`);
    assert(create.scrollWidth <= create.clientWidth && create.bodyScrollWidth <= width, `create dialog has horizontal overflow at ${width}px/${theme}`);
    assert(create.summaries.some((summary) => summary.includes("底层数据结构的优化")) && create.summaries.every((summary) => !/[*_`]/.test(summary)), `candidate excerpt contains Markdown markers at ${width}px/${theme}`);
    assert(create.headingTags.length > 0 && create.headingTags.every((tag) => tag === "DIV"), `candidate headings must not use h3/h4 at ${width}px/${theme}`);
    assert.equal(create.candidateOutline, "none", `candidate rows must not keep an outline without keyboard focus at ${width}px/${theme}`);
    assertHorizontal(await evaluate(horizontalFacts("create")), `create dialog at ${width}px/${theme}`);
    for (const how of ["x", "esc", "cancel"]) {
      if (how !== "x") await evaluate("window.renderTopicCreate()");
      assert.equal(await closeDialog(how, "create"), 0, `create dialog closed by ${how} must not cancel a preview at ${width}px/${theme}`);
    }

    await evaluate("window.renderTopicsPanel()");
    await waitUntil("document.querySelectorAll('#topics-panel-root .qnalog-outline-recent-row').length === 8");
    const rowMetrics = await evaluate(`(() => {
      const metricsOf = (row) => {
        const style = (element) => getComputedStyle(element);
        const chip = row.querySelector('.qnalog-outline-recent-chip').getBoundingClientRect();
        return { padding: style(row).padding, rowHeight: row.getBoundingClientRect().height, chipWidth: chip.width, chipHeight: chip.height,
          nameFont: style(row.querySelector('.qnalog-outline-recent-name')).fontSize, metaFont: style(row.querySelector('.qnalog-outline-recent-meta')).fontSize };
      };
      const panel = document.querySelector('#topics-panel-root .qnalog-topics-panel');
      const minutesHost = document.createElement('div');
      minutesHost.id = 'minutes-metrics';
      minutesHost.style.width = '300px';
      minutesHost.innerHTML = '<div class="qnalog-outline-recent-row"><div class="qnalog-outline-recent-chip">m</div><div class="qnalog-outline-recent-body"><div class="qnalog-outline-recent-title-line"><div class="qnalog-outline-recent-name">2026-10-04 1543 · 个人笔记</div></div><div class="qnalog-outline-recent-meta">2026-10-04 15:43 · 个人笔记 · 00:38</div><div class="qnalog-outline-recent-actions"></div></div></div>';
      document.body.append(minutesHost);
      const minutesRow = minutesHost.querySelector('.qnalog-outline-recent-row');
      const topic = metricsOf(panel.querySelector('.qnalog-outline-recent-row'));
      const minutes = metricsOf(minutesRow);
      minutesHost.remove();
      return { topic, minutes, overflow: panel.scrollWidth > panel.clientWidth, bodyOverflow: document.body.scrollWidth > ${width} };
    })()`);
    assert.equal(rowMetrics.overflow, false, `topic panel has horizontal overflow at ${width}px/${theme}`);
    assert.equal(rowMetrics.bodyOverflow, false, `topic panel widens the page at ${width}px/${theme}`);
    assert.equal(rowMetrics.topic.padding, rowMetrics.minutes.padding, `topic row padding must match the minutes row at ${width}px/${theme}`);
    assert.equal(rowMetrics.topic.nameFont, rowMetrics.minutes.nameFont, `topic title font must match the minutes title at ${width}px/${theme}`);
    assert.equal(rowMetrics.topic.metaFont, rowMetrics.minutes.metaFont, `topic meta font must match the minutes meta at ${width}px/${theme}`);
    for (const key of ["rowHeight", "chipWidth", "chipHeight"]) {
      assert(Math.abs(rowMetrics.topic[key] - rowMetrics.minutes[key]) <= 1, `topic row ${key} ${rowMetrics.topic[key]} differs from minutes ${rowMetrics.minutes[key]} at ${width}px/${theme}`);
    }
    await evaluate("document.querySelector('#topics-panel-root').remove()");

    await evaluate("window.renderTopicPreview()");
    const preview = await evaluate(`(() => {
      const content=document.querySelector('.modal-content.qnalog-topics-preview'); const scroll=content?.querySelector('.qnalog-topics-scroll'); const footer=content?.querySelector('.qnalog-topics-modal-footer'); const row=content?.querySelector('.qnalog-topics-preview-item'); const text=row?.querySelector('.qnalog-topics-preview-text'); const source=row?.querySelector('.qnalog-topics-source-link'); const checkbox=content?.querySelector('input[type=checkbox]'); const rows=[...content.querySelectorAll('.qnalog-topics-preview-item')];
      const style=row?getComputedStyle(row):null; const headings=[...content.querySelectorAll('.qnalog-topics-preview-heading')];
      const stanceBlocks=[...(row?.querySelectorAll('.qnalog-topics-preview-stance') || [])]; const stanceTops=stanceBlocks.map((item)=>item.getBoundingClientRect().top);
      const conflictTitle=row?.querySelector('.qnalog-topics-preview-conflict-heading .qnalog-topics-preview-text');
      const metaRows=[...(row?.querySelectorAll('.qnalog-topics-preview-meta') || [])]; const sourceBounds=[...row.querySelectorAll('.qnalog-topics-source-link')].map((item)=>({right:item.getBoundingClientRect().right, metaRight:item.closest('.qnalog-topics-preview-meta').getBoundingClientRect().right}));
      return {title:content?.closest('.modal')?.querySelector('.modal-title')?.textContent, actionHeading:content?.querySelector('.qnalog-topics-dialog-heading')?.textContent, metaJustify:getComputedStyle(row?.querySelector('.qnalog-topics-preview-meta')).justifyContent, sourceRadius:parseFloat(getComputedStyle(source).borderRadius), checkboxWidth:checkbox?.getBoundingClientRect().width, checkboxHeight:checkbox?.getBoundingClientRect().height, itemPadding:parseFloat(getComputedStyle(row).paddingTop), rowGap:rows.length > 1 ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom : null, height:content?.clientHeight, footerBottom:footer?.getBoundingClientRect().bottom, viewport:innerHeight, scrollWidth:content?.scrollWidth, clientWidth:content?.clientWidth, scrollAreaWidth:scroll?.scrollWidth, scrollAreaClientWidth:scroll?.clientWidth, textWidth:text?.getBoundingClientRect().width, contentWidth:content?.clientWidth, source:row?.querySelector('.qnalog-topics-source-link')?.textContent, badgeWhiteSpace:getComputedStyle(row?.querySelector('.qnalog-topics-unverified')).whiteSpace, headingTags:headings.map((heading)=>heading.tagName), rowOutline:style?.outlineStyle, rowTopBorder:style?.borderTopStyle, buttonCount:content?.querySelectorAll('button').length, bodyScrollWidth:document.body.scrollWidth, conflictTitleWidth:conflictTitle?.getBoundingClientRect().width, stanceTops, stanceCount:stanceBlocks.length, operationCodeVisible:/(?:add_|revise_|resolve_)[a-z_]+/.test(content?.textContent || ''), sourceBounds};
    })()`);
    assert(preview.height > 0, `preview dialog missing at ${width}px/${theme}`);
    assert.equal(preview.title, "QnALog · Topics", `preview title bar must be localized at ${width}px/${theme}`);
    assert.equal(preview.actionHeading, "Preview topic changes", `preview action heading must be present at ${width}px/${theme}`);
    assert.equal(preview.metaJustify, "flex-end", `preview metadata must be right aligned at ${width}px/${theme}`);
    assert(preview.sourceRadius <= 6, `source label radius exceeds 6px at ${width}px/${theme}`);
    assert(preview.itemPadding >= 10 && (preview.rowGap === null || preview.rowGap >= 10), `preview item spacing is too tight at ${width}px/${theme}`);
    assert(preview.checkboxWidth >= 14 && preview.checkboxHeight >= 14, `preview checkbox is too small at ${width}px/${theme}`);
    assert(preview.textWidth >= preview.contentWidth * 0.6, `preview text is too narrow (${preview.textWidth}/${preview.contentWidth}) at ${width}px/${theme}`);
    assert(preview.footerBottom <= preview.viewport, `preview footer below viewport at ${width}px/${theme}`);
    const overflowing = preview.scrollAreaWidth > preview.scrollAreaClientWidth ? await evaluate(`(() => { const root=document.querySelector('.qnalog-topics-scroll'); const edge=root.getBoundingClientRect().right; return [...root.querySelectorAll('*')].map((el)=>({tag:el.tagName,cls:el.className?.toString(),text:(el.textContent||'').slice(0,50),width:Math.round(el.getBoundingClientRect().width),right:Math.round(el.getBoundingClientRect().right),scroll:el.scrollWidth,client:el.clientWidth})).filter((item)=>item.right>edge+1||item.scroll>item.client+1).slice(0,12); })()`):[];
    assert(preview.scrollWidth <= preview.clientWidth && preview.scrollAreaWidth <= preview.scrollAreaClientWidth && preview.bodyScrollWidth <= width, `preview dialog has horizontal overflow at ${width}px/${theme}: content ${preview.scrollWidth}/${preview.clientWidth}, scroll ${preview.scrollAreaWidth}/${preview.scrollAreaClientWidth}, body ${preview.bodyScrollWidth}/${width}, ${JSON.stringify(overflowing)}`);
    assert.equal(preview.source, "问答日志-数据结构优化", `source should display title only at ${width}px/${theme}`);
    assert.equal(preview.badgeWhiteSpace, "nowrap", `unverified badge can wrap vertically at ${width}px/${theme}`);
    assert(preview.headingTags.length > 0 && preview.headingTags.every((tag) => tag === "DIV"), `preview headings must not use h3/h4 at ${width}px/${theme}`);
    assert.equal(preview.rowOutline, "none", `preview rows must not keep an outline without keyboard focus at ${width}px/${theme}`);
    assert.equal(preview.rowTopBorder, "none", `preview rows must not keep a border around the whole item at ${width}px/${theme}`);
    assert(preview.buttonCount > 0, `preview actions must stay inside the dialog at ${width}px/${theme}`);
    assert(preview.conflictTitleWidth >= preview.contentWidth * 0.6, `disagreement heading is too narrow at ${width}px/${theme}`);
    assert.equal(preview.stanceCount, 2, `disagreement fixture must show two stances at ${width}px/${theme}`);
    assert(preview.stanceTops[0] < preview.stanceTops[1], `disagreement stances must stack vertically at ${width}px/${theme}`);
    assert.equal(preview.operationCodeVisible, false, `raw operation code is visible at ${width}px/${theme}`);
    for (const bounds of preview.sourceBounds) assert(bounds.right <= bounds.metaRight + 0.5, `source label overlaps its metadata row at ${width}px/${theme}`);
    assertHorizontal(await evaluate(horizontalFacts("preview")), `preview dialog at ${width}px/${theme}`);
    console.log(`[topic-dialog-layout] ${width}px ${theme}: body ${preview.textWidth}/${preview.contentWidth}px; footer ${Math.round(preview.footerBottom)}/${preview.viewport}px; no horizontal overflow`);
    for (const how of ["x", "esc", "cancel"]) {
      if (how !== "x") await evaluate("window.renderTopicPreview()");
      assert.equal(await closeDialog(how, "preview"), 1, `preview dialog closed by ${how} must cancel the preview exactly once at ${width}px/${theme}`);
    }
  }
  for (const width of [360, 540, 720]) for (const theme of ["light", "dark"]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 827, deviceScaleFactor: 1, mobile: false });
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await evaluate(`document.body.className = ${JSON.stringify(theme === "dark" ? "theme-dark" : "theme-light")}; window.renderTopicScan()`);
    await waitUntil("document.querySelectorAll('.modal-content.qnalog-topics-create .qnalog-topics-candidate').length === 5");
    const scan = await evaluate(`(() => {
      const content=document.querySelector('.modal-content.qnalog-topics-create'); const title=content?.closest('.modal')?.querySelector('.modal-title')?.textContent;
      const action=content?.querySelector('.qnalog-topics-dialog-heading')?.textContent;
      const headings=[...content.querySelectorAll('.qnalog-topics-candidate-group > .qnalog-topics-preview-heading')];
      const textRows=[...content.querySelectorAll('.qnalog-topics-candidate-title, .qnalog-topics-candidate-summary, .qnalog-topics-candidate-meta')];
      const widths=textRows.map((item)=>item.getBoundingClientRect().width);
      const labels=[...content.querySelectorAll('.qnalog-topics-candidate-meta')].map((item)=>item.textContent || '').join(' ');
      return {title, action, rows:content.querySelectorAll('.qnalog-topics-candidate').length, headings:headings.map((item)=>item.tagName), minTextWidth:Math.min(...widths), labels, scrollWidth:content.scrollWidth, clientWidth:content.clientWidth, bodyScrollWidth:document.body.scrollWidth};
    })()`);
    assert.equal(scan.title, "QnALog · Topics", `scan title bar at ${width}px/${theme}`);
    assert.equal(scan.action, "Scan for notes to integrate", `scan action heading at ${width}px/${theme}`);
    assert.equal(scan.rows, 5, `scan candidate count at ${width}px/${theme}`);
    assert(scan.headings.length > 0 && scan.headings.every((tag) => tag === "DIV"), `scan group titles must be styled divs at ${width}px/${theme}`);
    assert(scan.minTextWidth >= 48, `scan candidate text is too narrow and may stack vertically at ${width}px/${theme}`);
    assert(scan.labels.includes("Q&ALog") && scan.labels.includes("VeryLongProjectTagLabelForLayout"), `scan metadata labels are missing at ${width}px/${theme}`);
    assert(scan.scrollWidth <= scan.clientWidth && scan.bodyScrollWidth <= width, `scan dialog has horizontal overflow at ${width}px/${theme}`);
    const generating = await evaluate(`(() => { document.querySelector('.modal-content.qnalog-topics-create .mod-cta').click(); const content=document.querySelector('.modal-content.qnalog-topics-create'); return {title:content?.closest('.modal')?.querySelector('.modal-title')?.textContent, action:content?.querySelector('.qnalog-topics-dialog-heading')?.textContent, generating:content?.classList.contains('is-generating'), candidates:content?.querySelectorAll('.qnalog-topics-candidate').length, height:content?.getBoundingClientRect().height}; })()`);
    assert.equal(generating.title, "QnALog · Topics", `scan generation title bar at ${width}px/${theme}`);
    assert.equal(generating.action, "Generating preview", `scan generation action heading at ${width}px/${theme}`);
    assert.equal(generating.generating, true, `scan generation style state at ${width}px/${theme}`);
    assert.equal(generating.candidates, 0, `scan candidates remain visible during generation at ${width}px/${theme}`);
    assert(generating.height < 300, `scan generation dialog is not compact at ${width}px/${theme}`);
    if (width === 360 && theme === "light") {
      await evaluate("window.topicPreviewDriver.fail('fixture failure')");
      await waitUntil("document.querySelector('.modal-content.qnalog-topics-create .qnalog-topics-dialog-heading')?.textContent === 'Generation failed'");
      const failed = await evaluate(`(() => { const content=document.querySelector('.modal-content.qnalog-topics-create'); return {retry:[...content.querySelectorAll('button')].some((button)=>button.textContent==='Retry'),back:[...content.querySelectorAll('button')].some((button)=>button.textContent==='Back to candidates'),candidateCount:content.querySelectorAll('.qnalog-topics-candidate').length}; })()`);
      assert.equal(failed.retry, true, "scan preview failure must offer retry");
      assert.equal(failed.back, true, "scan preview failure must offer return to candidates");
      assert.equal(failed.candidateCount, 0, "scan candidate rows must stay hidden in the failure state");
      await evaluate("[...document.querySelectorAll('.modal-content.qnalog-topics-create button')].find((button)=>button.textContent==='Retry').click()");
      await waitUntil("document.querySelector('.modal-content.qnalog-topics-create.is-generating')");
    }
    assert.equal(await closeDialog("cancel", "create"), 1, `scan cancel did not close cleanly at ${width}px/${theme}`);
    console.log(`[topic-dialog-layout] scan ${width}px ${theme}: five candidates, tags stay horizontal, generation list hidden`);
    for (const kind of ["Delete topic", "Merge topics", "Generic confirmation"]) {
      await evaluate(`window.renderTopicConfirm(${JSON.stringify(kind)})`);
      const confirmation = await evaluate(`(() => { const modal=document.querySelector('.modal'); const content=modal?.querySelector('.modal-content'); const buttons=[...modal.querySelectorAll('button')].map((button)=>({text:button.textContent,cls:button.className,left:button.getBoundingClientRect().left,right:button.getBoundingClientRect().right})); const edge=modal?.getBoundingClientRect(); return {title:modal?.querySelector('.modal-title')?.textContent, heading:content?.firstElementChild?.textContent, headingTag:content?.firstElementChild?.tagName, width:edge?.width, left:edge?.left,right:edge?.right,scrollWidth:modal?.scrollWidth,clientWidth:modal?.clientWidth,buttons}; })()`);
      const expectedTitle = kind === "Generic confirmation" ? "" : "QnALog · Topics";
      assert.equal(confirmation.title, expectedTitle, `${kind} title bar at ${width}px/${theme}`);
      assert.equal(confirmation.heading, kind === "Generic confirmation" ? "Clear queue" : kind, `${kind} action heading at ${width}px/${theme}`);
      assert.equal(confirmation.headingTag, kind === "Generic confirmation" ? "H3" : "DIV", `${kind} heading style at ${width}px/${theme}`);
      assert(confirmation.scrollWidth <= confirmation.clientWidth, `${kind} confirmation has horizontal overflow at ${width}px/${theme}`);
      for (const button of confirmation.buttons) assert(button.left >= confirmation.left - 0.5 && button.right <= confirmation.right + 0.5, `${kind} button ${button.text} overflows at ${width}px/${theme}`);
      if (kind === "Delete topic") assert(confirmation.buttons.some((button) => button.text === "Delete" && button.cls.includes("mod-warning")), `delete confirmation lost its warning button style at ${width}px/${theme}`);
      await evaluate("document.querySelector('.modal-header-button').click()");
    }
  }
  // Whole-row toggling and list stability: 60 candidates, scrolled to the middle, real mouse and keyboard input.
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 827, deviceScaleFactor: 1, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await evaluate("document.body.className = 'theme-light'; window.renderTopicCreate()");
  const mouse = async (expression, { button = "left" } = {}) => {
    const point = await evaluate(`(() => { const el = ${expression}; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, clickCount: 1 });
  };
  const rowAt = (index) => `document.querySelectorAll('.qnalog-topics-candidate')[${index}]`;
  const checkedAt = (index) => evaluate(`document.querySelectorAll('.qnalog-topics-candidate input')[${index}].checked`);
  const scrollTop = () => evaluate("document.querySelector('.qnalog-topics-scroll').scrollTop");
  assert.equal(await evaluate("document.querySelectorAll('.qnalog-topics-candidate').length"), 60, "fixture should render 60 candidates");
  await evaluate(`${rowAt(25)}.scrollIntoView({ block: "center" })`);
  await evaluate("window.__rowsBefore = [...document.querySelectorAll('.qnalog-topics-candidate')]");
  const middle = await scrollTop();
  assert(middle > 0, "candidate list must be scrollable for the stability check");

  const beforeTitle = await checkedAt(25);
  await mouse(`${rowAt(25)}.querySelector('.qnalog-topics-candidate-title')`);
  assert.notEqual(await checkedAt(25), beforeTitle, "a click on the title must toggle the row");
  assert.equal(await evaluate("window.__rowsBefore[25] === document.querySelectorAll('.qnalog-topics-candidate')[25]"), true, "toggling must not rebuild the row");
  assert.equal(await scrollTop(), middle, "toggling must not change the list scroll position");

  await mouse(`${rowAt(25)}.querySelector('input')`);
  assert.equal(await checkedAt(25), beforeTitle, "a click on the checkbox must toggle the row exactly once");
  assert.equal(await scrollTop(), middle, "checkbox toggle must not change the list scroll position");

  const showMoreVisible = await evaluate(`!!${rowAt(25)}.querySelector('.qnalog-topics-candidate-details > button')`);
  assert(showMoreVisible, "fixture rows must offer a Show more control");
  await mouse(`${rowAt(25)}.querySelector('.qnalog-topics-candidate-details > button')`);
  assert.equal(await checkedAt(25), beforeTitle, "the Show more control must not toggle the row");

  await evaluate(`${rowAt(26)}.querySelector('.qnalog-topics-candidate-title').scrollIntoView({ block: "center" })`);
  const dragStart = await evaluate(`(() => { const r = document.querySelectorAll('.qnalog-topics-candidate-title')[26].getBoundingClientRect(); return { x: r.left + 2, y: r.top + r.height / 2, endX: r.right - 2 }; })()`);
  const beforeDrag = await checkedAt(26);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragStart.x, y: dragStart.y });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: dragStart.x, y: dragStart.y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragStart.endX, y: dragStart.y, button: "left", buttons: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragStart.endX, y: dragStart.y, button: "left", clickCount: 1 });
  assert.notEqual(await evaluate("String(window.getSelection())"), "", "the drag should select text");
  assert.equal(await checkedAt(26), beforeDrag, "drag-selecting text must not toggle the row");
  await evaluate("window.getSelection().removeAllRanges()");

  const spaceBefore = await checkedAt(27);
  await evaluate("document.querySelectorAll('.qnalog-topics-candidate input')[27].focus()");
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", text: " ", windowsVirtualKeyCode: 32 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  assert.equal(await checkedAt(27), !spaceBefore, "Space must toggle the focused row exactly once");

  assert.equal(await evaluate("document.querySelectorAll('.qnalog-topics-candidate')[0].getAttribute('aria-disabled')"), "true", "the starting note row must be aria-disabled");
  const disabledBefore = await checkedAt(0);
  await mouse(`${rowAt(0)}.querySelector('.qnalog-topics-candidate-title')`);
  assert.equal(await checkedAt(0), disabledBefore, "the starting note row must not toggle");
  console.log(`[topic-dialog-layout] 60-candidate list: title, checkbox, drag and keyboard toggles behave; row nodes and scroll stable`);
  await evaluate("document.querySelector('.modal-header-button').click()");
  // Preview generation: progress, elapsed time, cancel, failure with retry, and timer cleanup.
  const waitFor = async (expression) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`timed out waiting for ${expression}`);
  };
  const driver = (call) => evaluate(`window.topicPreviewDriver.${call}`);
  const clickFirst = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const checkedCount = () => evaluate("document.querySelectorAll('.qnalog-topics-candidate input:checked').length");
  await evaluate(`window.__liveIntervals = new Set(); window.__nativeSetInterval = window.setInterval; window.__nativeClearInterval = window.clearInterval;
    window.setInterval = (...args) => { const id = window.__nativeSetInterval(...args); window.__liveIntervals.add(id); return id; };
    window.clearInterval = (id) => { window.__liveIntervals.delete(id); window.__nativeClearInterval(id); };`);
  await evaluate("window.renderTopicCreate()");
  await waitFor("document.querySelectorAll('.qnalog-topics-candidate').length === 60");
  const selectedBeforeGeneration = await checkedCount();
  await clickFirst(".modal-content.qnalog-topics-create .mod-cta");
  await waitFor("!!document.querySelector('.qnalog-topics-generating')");
  assert.equal(await evaluate("document.querySelector('.qnalog-topics-generating').getAttribute('aria-busy')"), "true", "generating view must set aria-busy");
  assert.equal(await evaluate("document.querySelectorAll('.qnalog-topics-candidate').length"), 0, "generating view must hide the candidate list");
  assert.equal(await evaluate("document.querySelector('.qnalog-topics-progress').classList.contains('is-indeterminate')"), true, "unknown batch count must show the indeterminate bar");
  await driver("progress(0, 3)");
  await waitFor("document.querySelector('.qnalog-topics-progress').getAttribute('aria-valuemax') === '3'");
  assert.equal(await evaluate("document.querySelector('.qnalog-topics-progress').getAttribute('aria-valuenow')"), "0", "planned batches must give a determinate bar");
  await driver("progress(2, 3)");
  await waitFor("document.querySelector('.qnalog-topics-progress').getAttribute('aria-valuenow') === '2'");
  assert.match(await evaluate("document.querySelector('.qnalog-topics-progress-text').textContent"), /2\/3/, "batch text must show completed/total");
  const generationMetrics = await evaluate(`(() => { const content=document.querySelector('.modal-content.qnalog-topics-create'); const modal=content?.closest('.modal'); const title=modal?.querySelector('.modal-title')?.textContent; const heading=content?.querySelector('.qnalog-topics-dialog-heading')?.textContent; return {title, heading, modalHeight:modal?.getBoundingClientRect().height, contentHeight:content?.getBoundingClientRect().height}; })()`);
  assert.equal(generationMetrics.title, "QnALog · Topics", "generation title bar must be present");
  assert.equal(generationMetrics.heading, "Generating preview", "generation action heading must be present");
  assert(generationMetrics.modalHeight <= generationMetrics.contentHeight + 120, `generation dialog has excess height (${generationMetrics.modalHeight}/${generationMetrics.contentHeight})`);
  const fillRatio = await evaluate("(() => { const bar = document.querySelector('.qnalog-topics-progress').getBoundingClientRect().width; return document.querySelector('.qnalog-topics-progress-fill').getBoundingClientRect().width / bar; })()");
  assert(Math.abs(fillRatio - 2 / 3) < 0.02, `bar fill must follow completed batches (ratio ${fillRatio})`);
  const elapsedFirst = await evaluate("document.querySelector('.qnalog-topics-progress-elapsed').textContent");
  await new Promise((resolveWait) => setTimeout(resolveWait, 2200));
  assert.notEqual(await evaluate("document.querySelector('.qnalog-topics-progress-elapsed').textContent"), elapsedFirst, "elapsed time must keep updating");
  assert.equal(await evaluate("window.__liveIntervals.size"), 1, "one tick timer runs while generating");
  await clickFirst(".modal-content.qnalog-topics-create .qnalog-topics-modal-actions button");
  await waitFor("document.querySelectorAll('.qnalog-topics-candidate').length === 60");
  assert.equal(await checkedCount(), selectedBeforeGeneration, "cancel must keep the selection");
  assert.equal(await driver("pending()"), false, "cancel must abort the pending request");
  assert.equal(await evaluate("window.__liveIntervals.size"), 0, "cancel must clear the elapsed timer");

  await clickFirst(".modal-content.qnalog-topics-create .mod-cta");
  await waitFor("!!document.querySelector('.qnalog-topics-generating')");
  await waitFor("window.topicPreviewDriver.pending()");
  await driver("fail('boom')");
  await waitFor("!!document.querySelector('.qnalog-topics-retry')");
  const failureText = await evaluate("document.querySelector('.modal-content.qnalog-topics-create').textContent");
  assert.match(failureText, /The topic page could not be generated/, "failure view must show the localized error");
  assert.doesNotMatch(failureText, /boom/, "failure view must not show the raw exception");
  assert.equal(await evaluate("window.__liveIntervals.size"), 0, "failure must clear the elapsed timer");
  await clickFirst(".qnalog-topics-retry");
  await waitFor("!!document.querySelector('.qnalog-topics-generating')");
  await waitFor("window.topicPreviewDriver.pending()");
  await driver("finish()");
  await waitFor("!!document.querySelector('.modal-content.qnalog-topics-preview')");
  assert.equal(await evaluate("window.__liveIntervals.size"), 0, "opening the preview must clear the elapsed timer");
  await evaluate("document.querySelector('.modal-header-button').click()");
  await evaluate("window.setInterval = window.__nativeSetInterval; window.clearInterval = window.__nativeClearInterval");
  console.log("[topic-dialog-layout] preview generation: determinate bar, elapsed timer, cancel keeps selection, failure and retry, timers cleared");
  // Active-row highlight follows the clicked row and never rebuilds the list (topics panel and a minutes-style list).
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 827, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.body.className = 'theme-light'; window.renderTopicsPanel()");
  await waitFor("document.querySelectorAll('#topics-panel-root .qnalog-outline-recent-row').length === 8");
  const highlighted = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((row, index) => row.classList.contains('is-active') ? index : -1).filter((index) => index >= 0)`);
  await evaluate(`(() => { const root = document.querySelector('#topics-panel-root'); root.style.maxHeight = '260px'; root.style.overflowY = 'auto'; window.__topicNodes = [...document.querySelectorAll('#topics-panel-root .qnalog-outline-recent-row')]; })()`);
  await evaluate("document.querySelector('#topics-panel-root').scrollTop = 200");
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  const topicScroll = await evaluate("document.querySelector('#topics-panel-root').scrollTop");
  assert(topicScroll > 0, "topics list must scroll for the highlight check");
  const clickInList = async (listSelector, rowIndex) => {
    await evaluate(`document.querySelectorAll('${listSelector} .qnalog-outline-recent-row')[${rowIndex}].scrollIntoView({ block: 'nearest' })`);
    const before = await evaluate(`document.querySelector('${listSelector}').scrollTop`);
    await mouse(`document.querySelectorAll('${listSelector} .qnalog-outline-recent-row')[${rowIndex}]`);
    return before;
  };
  let listScroll = await clickInList('#topics-panel-root', 2);
  assert.deepEqual(await highlighted("#topics-panel-root .qnalog-outline-recent-row"), [2], "clicking topic 2 highlights only topic 2");
  listScroll = await clickInList('#topics-panel-root', 5);
  assert.deepEqual(await highlighted("#topics-panel-root .qnalog-outline-recent-row"), [5], "clicking topic 5 moves the highlight off topic 2");
  assert.equal(await evaluate("document.querySelector('#topics-panel-root').scrollTop"), listScroll, "highlight changes must not move the topic list");
  listScroll = await clickInList('#topics-panel-root', 5);
  assert.deepEqual(await highlighted("#topics-panel-root .qnalog-outline-recent-row"), [5], "clicking the same topic again keeps one highlight");
  assert.equal(await evaluate("[...document.querySelectorAll('#topics-panel-root .qnalog-outline-recent-row')].every((row, index) => row === window.__topicNodes[index])"), true, "highlight changes must not rebuild topic rows");
  await evaluate("window.syncActiveRow(document.querySelector('#topics-panel-root'), [])");
  assert.deepEqual(await highlighted("#topics-panel-root .qnalog-outline-recent-row"), [], "a path that matches no row clears the highlight");
  await evaluate("document.querySelector('#topics-panel-root').remove()");

  await evaluate(`(() => {
    const list = document.createElement('div'); list.id = 'minutes-fixture';
    list.style.maxHeight = '300px'; list.style.overflowY = 'auto';
    for (let index = 0; index < 60; index++) {
      const row = document.createElement('div'); row.className = 'qnalog-outline-recent-row'; row.dataset.path = 'QnALog/转写纪要/' + index + '.md'; row.style.height = '34px';
      row.addEventListener('click', () => window.syncActiveRow(list, [row.dataset.path]));
      list.append(row);
    }
    document.body.append(list);
    window.__minutesNodes = [...list.children];
  })()`);
  await evaluate("document.querySelector('#minutes-fixture').scrollTop = 400");
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  const minutesScroll = await evaluate("document.querySelector('#minutes-fixture').scrollTop");
  assert.equal(minutesScroll, 400, "the 60-row list must reach the middle");
  await clickInList('#minutes-fixture', 20);
  const minutesScrollBefore = await clickInList('#minutes-fixture', 40);
  assert.deepEqual(await highlighted("#minutes-fixture .qnalog-outline-recent-row"), [40], "clicking row 40 after row 20 leaves only row 40 highlighted");
  assert.equal(await evaluate("[...document.querySelectorAll('#minutes-fixture .qnalog-outline-recent-row')].every((row, index) => row === window.__minutesNodes[index])"), true, "minutes rows must keep their nodes");
  assert.equal(await evaluate("document.querySelector('#minutes-fixture').scrollTop"), minutesScrollBefore, "the minutes list must keep its scroll position");
  console.log("[topic-dialog-layout] active row follows the clicked row in the topics panel and a 60-row minutes-style list; nodes and scroll unchanged");
  await evaluate("document.querySelector('#minutes-fixture').remove()");

  const idlePairFacts = async (width, theme, display) => evaluate(`(() => {
    document.body.className = ${JSON.stringify(theme)};
    let root = document.querySelector('#idle-pair-fixture');
    if (!root) {
      root = document.createElement('div');
      root.id = 'idle-pair-fixture';
      root.className = 'qnalog-outline is-idle-view';
      const more = document.createElement('div'); more.className = 'qnalog-outline-more is-expanded';
      const body = document.createElement('div'); body.className = 'qnalog-outline-more-body';
      const pair = document.createElement('div'); pair.className = 'qnalog-outline-control-pair';
      for (const label of ['偏好', '思考']) {
        const cell = document.createElement('div'); cell.className = 'qnalog-outline-pair-cell'; cell.textContent = label; pair.append(cell);
      }
      body.append(pair); more.append(body); root.append(more); document.body.append(root);
    }
    root.style.width = ${JSON.stringify(`${width}px`)};
    const pair = root.querySelector('.qnalog-outline-control-pair');
    pair.style.display = ${JSON.stringify(display)};
    const cells = [...root.querySelectorAll('.qnalog-outline-pair-cell')].map((cell) => {
      const rect = cell.getBoundingClientRect(); return { left: rect.left, width: rect.width, right: rect.right };
    });
    return { cells, gap: cells[1].left - cells[0].right, totalWidth: cells[1].right - cells[0].left };
  })()`);
  for (const theme of ['theme-light', 'theme-dark']) {
    for (const width of [280, 360, 480]) {
      const contents = await idlePairFacts(width, theme, 'contents');
      const grid = await idlePairFacts(width, theme, 'grid');
      assert.equal(contents.cells.length, 2, `${theme} ${width}px contents: expected two cells`);
      assert.equal(grid.cells.length, 2, `${theme} ${width}px grid: expected two cells`);
      assert(Math.abs(grid.cells[0].left - contents.cells[0].left) <= 1, `${theme} ${width}px: left cell shifted from display:contents baseline`);
      assert(Math.abs(grid.cells[0].width - contents.cells[0].width) <= 1, `${theme} ${width}px: left cell width differs from display:contents baseline`);
      assert(Math.abs(grid.cells[1].left - contents.cells[1].left) <= 1, `${theme} ${width}px: right cell shifted from display:contents baseline`);
      assert(Math.abs(grid.cells[1].width - contents.cells[1].width) <= 1, `${theme} ${width}px: right cell width differs from display:contents baseline`);
      assert(grid.gap >= 6, `${theme} ${width}px: idle preference/thinking cells have less than 6px between them`);
      assert(Math.abs(grid.totalWidth - contents.totalWidth) <= 1, `${theme} ${width}px: total pair width differs from display:contents baseline`);
      console.log(`[topic-dialog-layout] idle pair ${theme} ${width}px: 6px gap; cell geometry matches display:contents within 1px`);
    }
  }
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    const exited = new Promise((resolveExit) => browser.once("exit", resolveExit));
    browser.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 1200))]);
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
