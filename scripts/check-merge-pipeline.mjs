// 会话收尾 → 合并整理 的运行检查：在模拟宿主里加载 main.js，用桩 LLM 真跑一遍这条链路。
//
// 为什么要有这条：域服务与流水线都带 @ts-nocheck，静态检查只看得住「引用名对不对」，
// 看不出「参数传的是不是插件对象」。真机上就出过这条：
//   域服务把自身 this 传给 mergeAndPolish，流水线读 plugin.settings.briefingStructureLevel
//   → TypeError: Cannot read properties of undefined → llm.merge_failed，纪要无法整理。
// 那处缺陷通过了 tsc、ESLint、既有契约测试与静态门禁，只有真的执行一次才能发现。
// 因此固化成脚本：CI 每次 push 跑，本地也可随时跑。
import { readFileSync } from "node:fs";
import vm from "node:vm";
// Obsidian 提供 parseYaml / stringifyYaml；模拟宿主用它俩做等价实现，
// 否则流水线写出的 frontmatter 会被序列化成空串（harness 缺实现，不是产品缺陷）。
import { dump as yamlDump, load as yamlLoad } from "js-yaml";

const code = readFileSync(new URL("../main.js", import.meta.url), "utf8");
const noop = () => undefined;

function makeEl() {
  const el = {
    addClass: noop, removeClass: noop, toggleClass: noop, addClasses: noop, removeClasses: noop,
    setAttribute: noop, setAttr: noop, removeAttribute: noop, getAttribute: () => null,
    setText: noop, empty: noop, remove: noop, show: noop, hide: noop, setCssStyles: noop, setCssProps: noop,
    appendChild: noop, removeChild: noop, addEventListener: noop, removeEventListener: noop,
    querySelectorAll: () => [], querySelector: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    style: {}, classList: { add: noop, remove: noop, toggle: noop }, children: [], textContent: "",
    offsetWidth: 0, offsetHeight: 0, clientWidth: 0, clientHeight: 0, isConnected: true, parentElement: null,
  };
  el.createEl = () => makeEl();
  el.createDiv = () => makeEl();
  el.createSpan = () => makeEl();
  return el;
}

class TFile {
  constructor(path) {
    this.path = path; this.name = path; this.basename = path.replace(/\.[^.]+$/, "");
    this.extension = "md"; this.parent = { path: "" }; this.stat = { mtime: Date.now(), size: 10 };
  }
}
class TFolder { constructor(path) { this.path = path; this.children = []; } }

const NOTE_PATH = "2026-09-14 1133.md";
const NOTE_BODY = [
  "---", "mode: monologue", "time: 2026-09-14 11:33", "状态: 待整理", "---", "",
  "# 2026-09-14 11:33 · 个人笔记", "",
  "<!-- qnalog-segments-start:s1 -->",
  "### 段落 1 (00:00–00:05)", "今天的会议讨论了上线范围。", "",
  "### 段落 2 (00:05–00:10)", "确定先做内部灰度。",
  "<!-- qnalog-segments-end:s1 -->", "",
].join("\n");

const files = new Map();
const noteFile = new TFile(NOTE_PATH);
noteFile._content = NOTE_BODY;
files.set(NOTE_PATH, noteFile);

const app = {
  vault: {
    configDir: ".obsidian",
    adapter: {
      exists: async () => false, read: async () => "{}", write: async () => undefined,
      readBinary: async () => new ArrayBuffer(0), mkdir: async () => undefined, rename: async () => undefined,
      remove: async () => undefined, stat: async () => ({ mtime: Date.now(), size: 0 }),
      list: async () => ({ files: [], folders: [] }),
    },
    getAbstractFileByPath: (p) => files.get(String(p).replace(/^\/+/, "")) || null,
    getFiles: () => [...files.values()],
    getMarkdownFiles: () => [...files.values()],
    createFolder: async () => new TFolder(),
    create: async (p, c) => { const f = new TFile(p); f._content = c; files.set(p, f); return f; },
    read: async (f) => f._content || "",
    cachedRead: async (f) => f._content || "",
    modify: async (f, c) => { f._content = c; },
    delete: async () => undefined,
    on: () => ({}),
  },
  workspace: {
    on: () => ({}), onLayoutReady: (fn) => fn(), getActiveFile: () => null,
    getLeavesOfType: () => [], getLeaf: () => ({ openFile: async () => undefined, view: null }),
    iterateAllLeaves: noop,
  },
  metadataCache: { getFirstLinkpathDest: () => null, on: () => ({}) },
  fileManager: { renameFile: async () => undefined },
  internalPlugins: { getPluginById: () => null, plugins: {} },
};

// 桩 LLM：合并整理与后续索引都走这里。
const LLM_REPLY = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "## 议题\n\n上线范围已确定，先做内部灰度。\n\n## 结论\n\n内部灰度后按反馈扩大。" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
});
const llmCalls = [];

const obsidian = {
  apiVersion: "1.13.7",
  Plugin: class {
    constructor(a, m) {
      this.app = a; this.manifest = m;
      this.commands = []; this.views = []; this.tabs = []; this.intervals = []; this.registered = [];
    }
    async loadData() { return null; }
    async saveData() {}
    register(cleanup) { this.registered.push(cleanup); }
    registerEvent() {}
    registerInterval(id) { this.intervals.push(id); return id; }
    addCommand(c) { this.commands.push(c); }
    addRibbonIcon() { return makeEl(); }
    addStatusBarItem() { return makeEl(); }
    addSettingTab(t) { this.tabs.push(t); }
    registerView(v) { this.views.push(v); }
    registerMarkdownPostProcessor() {}
    registerMarkdownCodeBlockProcessor() {}
    addChild() {}
  },
  TFile, TFolder,
  ItemView: class { constructor() { this.containerEl = makeEl(); } }, MarkdownView: class {},
  Modal: class { open() {} close() {} }, Component: class {}, Menu: class {}, TextComponent: class {},
  Setting: class {}, PluginSettingTab: class {}, BasesView: class {},
  SuggestModal: class {}, FuzzySuggestModal: class {}, AbstractInputSuggest: class {},
  Platform: { isMacOS: true, isWin: false, isLinux: false, isIosApp: false, isAndroidApp: false, isDesktop: true, isMobile: false },
  getLanguage: () => "zh",
  MarkdownRenderer: { render: async () => undefined },
  Notice: class {},
  debounce: (fn) => { const wrapped = (...a) => fn(...a); wrapped.cancel = noop; return wrapped; },
  normalizePath: (v) => String(v || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, ""),
  parseYaml: (text) => { try { return yamlLoad(text) || {}; } catch { return {}; } },
  stringifyYaml: (value) => yamlDump(value || {}, { lineWidth: -1 }),
  parseLinktext: (l) => ({ path: l, subpath: "" }), getLinkpath: (l) => l, htmlToMarkdown: (h) => String(h),
  prepareFuzzySearch: () => () => null, sanitizeHTMLToDom: () => makeEl(),
  requestUrl: async () => {
    llmCalls.push("requestUrl");
    return { status: 200, text: LLM_REPLY, json: JSON.parse(LLM_REPLY), headers: {}, arrayBuffer: new ArrayBuffer(0) };
  },
  setIcon: noop, setTooltip: noop,
  moment: Object.assign(() => ({ format: () => "2026-09-14" }), { locale: () => "zh-cn" }),
};

function makeSandbox() {
  const document = {
    createElement: () => makeEl(), createDiv: () => makeEl(), createSpan: () => makeEl(),
    body: makeEl(), head: makeEl(), addEventListener: noop, removeEventListener: noop,
    querySelectorAll: () => [], querySelector: () => null,
  };
  const sandbox = {
    module: { exports: {} }, exports: {},
    require: (id) => { if (id === "obsidian") return obsidian; throw new Error(`加载了不可用的模块：${id}`); },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    document, navigator: { clipboard: { writeText: async () => undefined } },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: (id) => clearTimeout(id),
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2,
    moment: obsidian.moment,
    // vm 的新上下文只有 ECMAScript 内建；URL 等 Web 全局需要显式注入，
    // 否则 util-llm-endpoint 里的 new URL() 会抛错，被当成"地址格式无效"。
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal,
    structuredClone, Blob, atob, btoa, performance: { now: () => Date.now() },
    fetch: async () => { throw new Error("本检查不走 fetch，应经 obsidian.requestUrl"); },
  };
  sandbox.addEventListener = noop;
  sandbox.removeEventListener = noop;
  sandbox.window = sandbox;
  sandbox.activeWindow = sandbox;
  sandbox.activeDocument = document;
  sandbox.globalThis = sandbox;
  return sandbox;
}

const failures = [];
const errorLog = [];

async function main() {
  const sandbox = makeSandbox();
  const realError = console.error;
  console.error = (...args) => { errorLog.push(args.map(String).join(" ")); };
  try {
    vm.runInNewContext(code, sandbox, { filename: "main.js", timeout: 10000 });
    const PluginClass = sandbox.module.exports?.default || sandbox.module.exports;
    const plugin = new PluginClass(app, { id: "qnalog", version: "1.0.0", dir: ".obsidian/plugins/qnalog", name: "Q&A Log", minAppVersion: "1.0.0" });
    await plugin.onload();
    plugin.settings.llmEndpoint = "http://localhost:55990/v1";
    plugin.settings.llmModel = "stub-model";
    plugin.settings.llmApiKey = "stub-key";
    plugin.settings.consolidatedLayout = true;
    plugin.settings.briefingStructureLevel = "balanced";

    const session = {
      id: "s1", mode: "monologue", mdPath: NOTE_PATH,
      startedAt: Date.now() - 600_000, workProgress: {}, segmentMeta: [],
      segments: [
        { text: "今天的会议讨论了上线范围。", startMs: 0, endMs: 5000, index: 0 },
        { text: "确定先做内部灰度。", startMs: 5000, endMs: 10000, index: 1 },
      ],
    };
    try {
      await plugin.sessionFinalize.finalizeSession(session);
    } catch (error) {
      failures.push(`会话收尾抛错：${(error && error.message) || error}`);
    }

    const content = noteFile._content || "";
    if (!llmCalls.length) failures.push("流水线没有发起任何模型调用（可能停在配置校验或根本没走到整理）");
    const beforeRaw = content.split("## 原始材料")[0];
    if (!/议题[\s\S]*结论/.test(beforeRaw)) failures.push("笔记正文里没有写入整合后的内容（原始材料之前）");
    if (!/分段原始转写/.test(content)) failures.push("笔记里没有保留原始转写");
    if (!/<!--\s*qnalog-session:s1\s*-->/.test(content)) failures.push("笔记里没有保留会话标记");
    if (!/^---\r?\n[\s\S]*?\r?\n---/.test(content)) failures.push("笔记没有 frontmatter");
    if (!/^time:\s*\S/m.test(content)) failures.push("frontmatter 里没有 time 字段（重新整理入口会因缺少 time 不可用）");
    for (const id of plugin.intervals) clearInterval(id);
  } finally {
    console.error = realError;
  }

  const stray = errorLog.filter((line) => !/update check failed/.test(line));
  for (const line of stray) failures.push(`运行期报错：${line.split("\n")[0]}`);

  if (failures.length) {
    console.error("[merge-pipeline] 检查失败：");
    for (const failure of failures) console.error("  " + failure);
    return 1;
  }
  console.log(`[merge-pipeline] OK: 会话收尾到合并整理跑通，模型调用 ${llmCalls.length} 次，笔记保留正文与原始转写`);
  return 0;
}

const failed = await main();
process.exitCode = failed;
process.stdout.write("", () => process.exit(failed));
