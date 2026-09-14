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
  "diagnostics", "delivery", "noteWriter", "tasks", "queueRetry", "versions", "people",
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
  // 记录子元素与文本：渲染结果可以被断言（例如筛选条上必须出现时间范围按钮）。
  const record = (child, options) => {
    el.children.push(child);
    if (options && typeof options === "object") {
      if (typeof options.text === "string") child.textContent = options.text;
      if (typeof options.cls === "string") child.className = options.cls;
    }
    return child;
  };
  el.createEl = (tag, options) => record(makeEl(), options);
  el.createDiv = (options) => record(makeEl(), options);
  el.createSpan = (options) => record(makeEl(), options);
  return el;
}

/** 收集某个元素树下所有已创建子元素的 className 与文本，供断言。 */
function collectRenderedText(root) {
  const out = [];
  const walk = (el) => {
    for (const child of el.children || []) {
      out.push({ cls: String(child.className || ""), text: String(child.textContent || "") });
      walk(child);
    }
  };
  walk(root);
  return out;
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
  registerView(type, factory) { this.views.push({ type, factory }); }
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
  // 每个域服务的宿主必须是插件实例：装配成别的对象（包括服务自身）时，
  // 服务里读 host.settings / host.app 会读到 undefined，且多数被 try/catch 吞成静默失效。
  for (const field of DOMAIN_FIELDS) {
    const service = plugin[field];
    if (!service || typeof service !== "object") continue;
    if (!("host" in service)) continue;
    if (service.host !== plugin) {
      failures.push(`this.${field}.host 不是插件实例（装配错了宿主对象）`);
    }
  }

  // 用户可见的装配面没有整体丢失（命令、视图、设置页、状态栏定时器）
  // 招聘/晋升评审场景已移除，命令数比此前少 5 个（刷新招聘统计×2、重建总览看板、重建招聘主页、招聘/晋升内联编辑）。
  expect(plugin.commands.length >= 25, `注册的命令数异常：${plugin.commands.length}`);
  expect(plugin.views.length >= 2, `注册的视图数异常：${plugin.views.length}`);
  expect(plugin.settingTabs.length >= 1, "没有注册设置页");
  expect(plugin.intervals.length >= 1, "没有注册状态栏维护定时器");

  // 设置迁移必须真的跑过：迁移服务在 loadAll 之前装配，否则会被静默跳过
  expect(typeof plugin.migrations.migrateDefaultLibraryLayout === "function", "迁移服务未就绪，loadAll 的迁移会被跳过");

  // 侧边栏「纪要」列表：默认不能带隐藏筛选。
  // 列表按 recentFilters 过滤，但筛选条只渲染分组与模板两个按钮——
  // 一旦初始值不是声明的默认值（曾为 time: "week"），用户就只会看到被截短的一周列表，
  // 却看不到、也改不了那个筛选（真机现象：10 篇只显示 2 篇）。
  const outlineEntry = plugin.views.find((v) => v.type === "lexvoice-outline-view");
  expect(outlineEntry, "没有注册实时纪要面板视图");
  if (outlineEntry) {
    try {
      const view = outlineEntry.factory({ app, containerEl: makeEl(), view: null });
      const initial = view.getRecentFilters();
      const defaults = view.getDefaultRecentFilters();
      expect(initial.time === defaults.time && initial.mode === defaults.mode,
        `纪要列表打开时带了非默认筛选：初始 ${JSON.stringify(initial)}，默认 ${JSON.stringify(defaults)}`);

      // 纪要列表的文件范围必须只落在配置的纪要目录内。
      // 反例（改设置结构时踩过）：getRecentNoteRoots 读了已删除的设置键，取到 undefined →
      // 空前缀被当成"匹配一切"，列表静默变成整个知识库的 Markdown。
      const mdFolder = plugin.settings.mdFolder || "LexVoice/转写纪要";
      expect(view.isRecentNotePath(`${mdFolder}/2026-09-14 1133 · 个人笔记.md`),
        "纪要目录内的笔记被判为不在范围里");
      expect(!view.isRecentNotePath("AFFiNE Export/Notes/Unfiled/2025-09-05.md"),
        "纪要目录之外的笔记被判为在范围里（根目录过滤失效，列表会覆盖全库）");

      const bar = makeEl();
      view.renderRecentFilterBar(bar, []);
      const rendered = collectRenderedText(bar);
      const timeLabel = view.getRecentFilterLabel("time", initial.time, []);
      const cls = (item) => item.cls.split(/\s+/);
      const hasChip = (label) => rendered.some((item) => cls(item).includes("lexvoice-outline-recent-filter-chip") && item.text === label);
      expect(hasChip(timeLabel), `筛选条上没有时间范围按钮（列表按它过滤，必须可见）：缺「${timeLabel}」`);
      expect(hasChip("全部模板"), "筛选条上没有模板筛选按钮");
      expect(rendered.some((item) => cls(item).includes("lexvoice-outline-recent-group-chip")), "筛选条上没有分组按钮");
    } catch (error) {
      failures.push(`纪要面板渲染检查抛错：${(error && error.message) || error}`);
    }
  }

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
