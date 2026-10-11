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
      buildApi.onResolve({ filter: /^\.\/helpers$/ }, (args) => args.importer.endsWith("/topics-panel.ts")
        ? { path: join(repoRoot, "tests/browser/topic-helper-shim.ts") } : undefined);
    } }],
  });
  await writeFile(html, `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: light; --background-primary:#fff; --background-secondary:#f1f3f5; --background-modifier-border:#d7dbe0; --text-normal:#25282c; --text-muted:#656b73; --text-faint:#8b9098; --text-accent:#6750a4; --interactive-accent:#6750a4; --interactive-accent-hover:#58428e; --text-warning:#a96900; --modal-background:#fff; --font-ui-small:12px; --font-ui-smaller:11px; --radius-s:4px; --radius-m:8px; }
    .theme-dark { color-scheme:dark; --background-primary:#191a1c; --background-secondary:#24262a; --background-modifier-border:#3a3d42; --text-normal:#e7e9ec; --text-muted:#b1b5bc; --text-faint:#858b94; --text-accent:#b4a1fa; --interactive-accent:#a88df4; --interactive-accent-hover:#c0adff; --text-warning:#e2b75f; --modal-background:#1d1e20; }
    body { min-height:100vh; margin:0; background:var(--background-primary); color:var(--text-normal); font:14px/1.4 system-ui,sans-serif; }
    .modal-container { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; }
    .modal { position:relative; max-width:100vw; max-height:100vh; }
    .modal-close-button { position:absolute; top:8px; right:8px; z-index:2; }
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

  for (const width of [320, 390, 768, 1440]) for (const theme of ["light", "dark"]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 827, deviceScaleFactor: 1, mobile: false });
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await evaluate(`document.body.className = ${JSON.stringify(theme === "dark" ? "theme-dark" : "theme-light")}; window.renderTopicCreate()`);
    const create = await evaluate(`(() => {
      const content=document.querySelector('.modal-content.qnalog-topics-create'); const scroll=content?.querySelector('.qnalog-topics-scroll'); const footer=content?.querySelector('.qnalog-topics-modal-footer');
      const summaries=[...(content?.querySelectorAll('.qnalog-topics-candidate-summary') || [])].map((item) => item.textContent || '');
      return {height:content?.clientHeight, scrollHeight:scroll?.scrollHeight, scrollClientHeight:scroll?.clientHeight, footerBottom:footer?.getBoundingClientRect().bottom, viewport:innerHeight, scrollWidth:content?.scrollWidth, clientWidth:content?.clientWidth, bodyScrollWidth:document.body.scrollWidth, summaries};
    })()`);
    assert(create.height > 0, `create dialog missing at ${width}px/${theme}`);
    assert(create.scrollHeight > create.scrollClientHeight, `candidate list did not scroll at ${width}px/${theme}`);
    assert(create.footerBottom <= create.viewport, `create footer below viewport at ${width}px/${theme}`);
    assert(create.scrollWidth <= create.clientWidth && create.bodyScrollWidth <= width, `create dialog has horizontal overflow at ${width}px/${theme}`);
    assert(create.summaries.some((summary) => summary.includes("底层数据结构的优化")) && create.summaries.every((summary) => !/[*_`]/.test(summary)), `candidate excerpt contains Markdown markers at ${width}px/${theme}`);
    await evaluate("document.querySelector('.modal-close-button').click()");
    assert.equal(await evaluate("document.querySelectorAll('.modal').length"), 0, `create dialog did not close at ${width}px/${theme}`);

    await evaluate("window.renderTopicsPanel()");
    const panel = await evaluate(`(() => { const panel=document.querySelector('#topics-panel-root .qnalog-topics-panel'); const row=panel?.querySelector('.qnalog-topics-row'); return {padding:getComputedStyle(panel).paddingInlineStart, rowLeft:row?.getBoundingClientRect().left, panelLeft:panel?.getBoundingClientRect().left, overflow:panel?.scrollWidth > panel?.clientWidth}; })()`);
    assert.equal(panel.padding, "16px", `topic panel horizontal inset differs from outline at ${width}px/${theme}`);
    assert.equal(panel.overflow, false, `topic panel has horizontal overflow at ${width}px/${theme}`);
    await evaluate("document.querySelector('#topics-panel-root').remove()");

    await evaluate("window.renderTopicPreview()");
    const preview = await evaluate(`(() => {
      const content=document.querySelector('.modal-content.qnalog-topics-preview'); const scroll=content?.querySelector('.qnalog-topics-scroll'); const footer=content?.querySelector('.qnalog-topics-modal-footer'); const row=content?.querySelector('.qnalog-topics-preview-item'); const text=row?.querySelector('.qnalog-topics-preview-text');
      return {height:content?.clientHeight, footerBottom:footer?.getBoundingClientRect().bottom, viewport:innerHeight, scrollWidth:content?.scrollWidth, clientWidth:content?.clientWidth, scrollAreaWidth:scroll?.scrollWidth, scrollAreaClientWidth:scroll?.clientWidth, textWidth:text?.getBoundingClientRect().width, contentWidth:content?.clientWidth, source:row?.querySelector('.qnalog-topics-source-link')?.textContent, badgeWhiteSpace:getComputedStyle(row?.querySelector('.qnalog-topics-unverified')).whiteSpace, bodyScrollWidth:document.body.scrollWidth};
    })()`);
    assert(preview.height > 0, `preview dialog missing at ${width}px/${theme}`);
    assert(preview.textWidth >= preview.contentWidth * 0.6, `preview text is too narrow (${preview.textWidth}/${preview.contentWidth}) at ${width}px/${theme}`);
    assert(preview.footerBottom <= preview.viewport, `preview footer below viewport at ${width}px/${theme}`);
    assert(preview.scrollWidth <= preview.clientWidth && preview.scrollAreaWidth <= preview.scrollAreaClientWidth && preview.bodyScrollWidth <= width, `preview dialog has horizontal overflow at ${width}px/${theme}`);
    assert.equal(preview.source, "问答日志-数据结构优化", `source should display title only at ${width}px/${theme}`);
    assert.equal(preview.badgeWhiteSpace, "nowrap", `unverified badge can wrap vertically at ${width}px/${theme}`);
    console.log(`[topic-dialog-layout] ${width}px ${theme}: body ${preview.textWidth}/${preview.contentWidth}px; footer ${Math.round(preview.footerBottom)}/${preview.viewport}px; no horizontal overflow`);
    await evaluate("document.querySelector('.modal-close-button').click()");
    assert.equal(await evaluate("document.querySelectorAll('.modal').length"), 0, `preview dialog did not close at ${width}px/${theme}`);
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
