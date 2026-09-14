// 装配检查：在模拟的 Obsidian 宿主里加载 main.js，跑一遍 onload / onunload。
//
// 为什么要有这条：域服务全部由插件在 onload 里手工装配，漏装一个不会有任何编译期或静态检查报错——
// 只有运行时调用到才会抛错，或者更糟：调用方用 try/catch 兜住，功能静默失效。
// 实际发生过一次：loadAll 里的设置迁移依赖 migration 与 diagnostics 两个服务，
// 而它们当时在 loadAll 之后才装配，迁移被静默跳过（catch 里只打一行警告）。
// 因此固化成脚本：CI 每次 push 跑，本地也可随时跑。
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../main.js", import.meta.url), "utf8");

// onload 里应当装配好的域服务字段。新增域服务时在这里补一行。
const DOMAIN_FIELDS = [
  "diagnostics", "delivery", "recruit", "noteWriter", "tasks", "queueRetry", "versions", "people",
  "profiles", "vocabulary", "migrations", "outline", "meetingWorkbench", "audioLinks", "noteIndex",
  "library", "shell", "recording", "sessionFinalize", "imports", "externalInbox", "repolish",
  "inbox", "knowledgeExtraction", "recorder", "queue", "bubble",
];

const noop = () => undefined;

function makeEl() {
  const el = {
    addClass: noop, removeClass: noop, toggleClass: noop, addClasses: noop, removeClasses: noop,
    setAttribute: noop, setAttr: noop, removeAttribute: noop, getAttribute: () => null,
    setText: noop, empty: noop, remove: noop, show: noop, hide: noop,
    setCssStyles: noop, setCssProps: noop, appendChild: noop, removeChild: noop,
    addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [], querySelector: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    style: {}, classList: { add: noop, remove: noop, toggle: noop }, children: [], textContent: "",
    offsetWidth: 0, offsetHeight: 0, clientWidth: 0, clientHeight: 0, isConnected: true, parentElement: null,
  };
  el.createEl = () => makeEl();
  el.createDiv = () => makeEl();
  el.createSpan = () => makeEl();
  return el;
}

const notices = [];
class ObsidianBase {}
class TFile extends ObsidianBase {
  constructor(path = "") {
    super();
    this.path = path;
    this.name = path;
    this.basename = path.replace(/\.[^.]+$/, "");
    this.extension = path.includes(".") ? path.split(".").pop() : "";
    this.parent = { path: "" };
  }
}
class TFolder extends ObsidianBase {
  constructor(path = "") { super(); this.path = path; this.children = []; }
}
class PluginBase extends ObsidianBase {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest;
    this.commands = [];
    this.views = [];
    this.settingTabs = [];
    this.intervals = [];
    this.registered = [];
  }
  async loadData() { return null; }
  async saveData() { return undefined; }
  register(cleanup) { this.registered.push(cleanup); }
  registerEvent() {}
  registerInterval(id) { this.intervals.push(id); return id; }
  addCommand(command) { this.commands.push(command); }
  addRibbonIcon() { return makeEl(); }
  addStatusBarItem() { return makeEl(); }
  addSettingTab(tab) { this.settingTabs.push(tab); }
  registerView(type) { this.views.push(type); }
  registerMarkdownPostProcessor() {}
  registerMarkdownCodeBlockProcessor() {}
  addChild() {}
  onLayoutReady(fn) { fn(); }
}

const app = {
  vault: {
    configDir: ".obsidian",
    adapter: { exists: async () => false, read: async () => "{}", write: async () => undefined, readBinary: async () => new ArrayBuffer(0) },
    getAbstractFileByPath: () => null,
    getFiles: () => [],
    getMarkdownFiles: () => [],
    createFolder: async () => new TFolder(),
    create: async (path) => new TFile(path),
    read: async () => "",
    cachedRead: async () => "",
    modify: async () => undefined,
    delete: async () => undefined,
    on: () => ({}),
  },
  workspace: {
    on: () => ({}),
    onLayoutReady: (fn) => fn(),
    getActiveFile: () => null,
    getLeavesOfType: () => [],
    getLeaf: () => ({ openFile: async () => undefined, view: null }),
    iterateAllLeaves: noop,
  },
  metadataCache: { getFirstLinkpathDest: () => null, on: () => ({}) },
  fileManager: { renameFile: async () => undefined },
  internalPlugins: { getPluginById: () => null, plugins: {} },
};

const obsidian = {
  apiVersion: "1.13.7",
  BasesView: ObsidianBase, Component: ObsidianBase, FuzzySuggestModal: ObsidianBase,
  ItemView: ObsidianBase, Menu: ObsidianBase, Modal: ObsidianBase, Setting: ObsidianBase,
  PluginSettingTab: ObsidianBase, TextComponent: ObsidianBase, SuggestModal: ObsidianBase,
  AbstractInputSuggest: ObsidianBase, MarkdownView: ObsidianBase,
  Plugin: PluginBase, TFile, TFolder,
  Platform: { isMacOS: true, isWin: false, isLinux: false, isIosApp: false, isAndroidApp: false, isDesktop: true, isMobile: false },
  MarkdownRenderer: { render: async () => undefined },
  Notice: function Notice(message) { notices.push(message); },
  debounce: (fn) => { const wrapped = (...args) => fn(...args); wrapped.cancel = noop; return wrapped; },
  normalizePath: (value) => String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, ""),
  parseYaml: () => ({}),
  stringifyYaml: () => "",
  parseLinktext: (link) => ({ path: link, subpath: "" }),
  getLinkpath: (link) => link,
  htmlToMarkdown: (html) => String(html),
  prepareFuzzySearch: () => () => null,
  sanitizeHTMLToDom: () => makeEl(),
  requestUrl: async () => ({ status: 200, text: "{}" }),
  setIcon: noop, setTooltip: noop,
  moment: Object.assign(() => ({ format: () => "2026-09-14", valueOf: () => Date.now() }), { locale: () => "zh-cn" }),
};

function makeSandbox() {
  const document = {
    createElement: () => makeEl(), createDiv: () => makeEl(), createSpan: () => makeEl(),
    body: makeEl(), head: makeEl(),
    addEventListener: noop, removeEventListener: noop,
    querySelectorAll: () => [], querySelector: () => null,
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require(id) {
      if (id === "obsidian") return obsidian;
      return require(id);
    },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document,
    navigator: { clipboard: { writeText: async () => undefined } },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2,
  };
  sandbox.addEventListener = noop;
  sandbox.removeEventListener = noop;
  sandbox.window = sandbox;
  sandbox.activeWindow = sandbox;
  sandbox.activeDocument = document;
  sandbox.globalThis = sandbox;
  return sandbox;
}

function report(failures) {
  console.error("[plugin-onload] 装配检查失败：");
  for (const failure of failures) console.error("  " + failure);
  return 1;
}

const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };

async function main() {
  const sandbox = makeSandbox();
  vm.runInNewContext(code, sandbox, { filename: "main.js", timeout: 10000 });
  const PluginClass = sandbox.module.exports?.default || sandbox.module.exports;
  expect(typeof PluginClass === "function", "main.js 没有导出插件类");

  const plugin = new PluginClass(app, { id: "qnalog", version: "1.0.0", dir: ".obsidian/plugins/qnalog", name: "QnALog", minAppVersion: "1.0.0" });
  try {
    await plugin.onload();
  } catch (error) {
    failures.push(`onload 抛错：${error && error.stack ? error.stack.split("\n").slice(0, 4).join(" | ") : error}`);
    report(failures);
    return 1;
  }

  for (const field of DOMAIN_FIELDS) {
    const value = plugin[field];
    if (!value) { failures.push(`域服务未装配：this.${field}`); continue; }
    if (typeof value !== "object") { failures.push(`this.${field} 不是服务实例`); continue; }
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(value)).filter((n) => n !== "constructor");
    if (!methods.length) failures.push(`this.${field} 没有任何方法，可能装配成了空对象`);
  }
  // 用户可见的装配面没有整体丢失（命令、视图、设置页、状态栏定时器）
  expect(plugin.commands.length >= 30, `注册的命令数异常：${plugin.commands.length}`);
  expect(plugin.views.length >= 2, `注册的视图数异常：${plugin.views.length}`);
  expect(plugin.settingTabs.length >= 1, "没有注册设置页");
  expect(plugin.intervals.length >= 1, "没有注册状态栏维护定时器");

  // 设置迁移必须真的跑过：迁移服务在 loadAll 之前装配，否则会被静默跳过
  expect(typeof plugin.migrations.migrateDefaultLibraryLayout === "function", "迁移服务未就绪，loadAll 的迁移会被跳过");

  try {
    await plugin.onunload();
  } catch (error) {
    failures.push(`onunload 抛错：${error && error.message}`);
  }
  // 清掉插件注册的定时器，否则 Node 事件循环不退出（真实宿主里由 Obsidian 负责）
  for (const id of plugin.intervals) clearInterval(id);

  if (failures.length) return report(failures);
  console.log(`[plugin-onload] OK: onload/onunload 跑通，${DOMAIN_FIELDS.length} 个域服务装配齐全，命令 ${plugin.commands.length} 个、视图 ${plugin.views.length} 个`);
  return 0;
}

const code_ = await main();
// 插件在 onload 里注册的定时器与宿主注入的 stdio 句柄会让 Node 不自然退出，输出完成后显式结束。
process.exitCode = code_;
process.stdout.write("", () => process.exit(code_));
