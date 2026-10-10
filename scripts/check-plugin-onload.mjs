// 装配检查：在模拟的 Obsidian 宿主里加载 main.js，跑一遍 onload / onunload。
//
// 为什么要有这条：域服务全部由插件在 onload 里手工装配，漏装一个不会有任何编译期或静态检查报错——
// 只有运行时调用到才会抛错，或者更糟：调用方用 try/catch 兜住，功能静默失效。
// 实际发生过一次：loadAll 里的设置迁移依赖 migration 与 diagnostics 两个服务，
// 而它们当时在 loadAll 之后才装配，迁移被静默跳过（catch 里只打一行警告）。
// 因此固化成脚本：CI 每次 push 跑，本地也可随时跑。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const usage = "[plugin-onload] Usage: node scripts/check-plugin-onload.mjs [--bundle <path>]";
function parseBundleArgument(args) {
  if (args.length === 0) return fileURLToPath(new URL("../main.js", import.meta.url));
  if (args.length !== 2 || args[0] !== "--bundle" || !args[1]) {
    process.stderr.write(`${usage}\n`);
    process.exit(1);
  }
  return path.resolve(process.cwd(), args[1]);
}

let code;
const bundlePath = parseBundleArgument(process.argv.slice(2));
try {
  code = readFileSync(bundlePath, "utf8");
} catch (error) {
  process.stderr.write(`[plugin-onload] ${error.message}\n`);
  process.exit(1);
}

// onload 里应当装配好的域服务字段。新增域服务时在这里补一行。
const DOMAIN_FIELDS = [
  "diagnostics", "delivery", "noteWriter", "tasks", "queueRetry", "versions", "people",
  "profiles", "vocabulary", "cleanup", "outline", "meetingWorkbench", "audioLinks", "noteIndex",
  "topics", "inbox", "knowledgeExtraction", "recorder", "recording", "queue", "bubble", "semanticCanvas", "sessionStore", "continuations",
];
const PORT_HOST_FIELDS = {
  noteWriter: true,
  asrPipeline: true,
  continuations: true,
  outline: true,
  queue: true,
  versions: true,
  recorder: true,
  recording: true,
};

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
// Modal 的标准方法：插件在 onload 的布局就绪回调里会打开首次配置向导，
// 装配检查因此需要 open/close 存在（断言内容不变，只是补全 API 面）。
class ObsidianBase {
  modalEl = makeEl();
  contentEl = makeEl();
  open() {}
  close() {}
  setTitle() { return this; }
}
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
  async loadData() { return this.storedData ?? null; }
  async saveData(payload) { this.savedCount = (this.savedCount || 0) + 1; this.lastSaved = payload; return undefined; }
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

const secrets = new Map();

const app = {
  secretStorage: {
    getSecret: (id) => secrets.has(id) ? secrets.get(id) : null,
    listSecrets: () => [...secrets.keys()],
    setSecret: (id, secret) => {
      if (id.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("invalid SecretStorage id");
      secrets.set(id, secret);
    },
  },
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
  addIcon() {},
  Platform: { isMacOS: true, isWin: false, isLinux: false, isIosApp: false, isAndroidApp: false, isDesktop: true, isMobile: false },
  // Obsidian 1.8.7+ 的公开 API：读取界面语言。插件据此决定界面文案语言。
  getLanguage: () => "zh",
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
    TextEncoder,
    TextDecoder,
    atob,
    crypto: {
      getRandomValues: (bytes) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index + 1;
        return bytes;
      },
    },
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

  const plugin = new PluginClass(app, { id: "qnalog", version: "1.0.0", dir: ".obsidian/plugins/qnalog", name: "QnALog", minAppVersion: "1.11.4" });
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
  // 插件宿主服务使用插件实例；明确的窄端口必须持有装配时指定的能力，而非整个插件。
  for (const field of DOMAIN_FIELDS) {
    const service = plugin[field];
    if (!service || typeof service !== "object") continue;
    if (!("host" in service)) continue;
    if (Object.hasOwn(PORT_HOST_FIELDS, field)) {
      if (service.host === plugin) failures.push(`this.${field}.host 应使用窄能力对象，不得接收完整插件实例`);
      if (field === "noteWriter") {
        const methods = [
          "getFileFrontmatter", "ensureFolder", "findAvailableMarkdownPath", "renameFile", "openFile",
          "confirm", "getRecentNotes", "generateTitleTag", "polishTranscript", "mergeAndPolish",
          "clearCommittedBriefingCheckpoint",
        ];
        if (service.host === plugin
          || service.host?.vault !== app.vault
          || service.host?.settings !== plugin.settings
          || service.host?.noteIndex !== plugin.noteIndex
          || methods.some((method) => typeof service.host?.[method] !== "function")) {
          failures.push("this.noteWriter.host 未绑定预期的知识库、动态设置、索引与具体能力");
        }
        continue;
      }
      if (field === "recorder") {
        const methods = [
          "getSettings", "prefersOpus", "resolveCaptureMode", "makeRecordingIssue",
          "setRecordingIssue", "clearRecordingIssue", "logDiagnostic",
        ];
        if (service.host === plugin
          || methods.some((method) => typeof service.host?.[method] !== "function")
          || service.host?.getSettings() !== plugin.settings) {
          failures.push("this.recorder.host 未绑定预期的动态设置与录音采集能力");
        }
        continue;
      }
      if (field === "recording") {
        if (service.host?.settings !== plugin.settings
          || service.host?.recorder !== plugin.recorder
          || service.host?.asrPipeline !== plugin.asrPipeline
          || service.host?.continuations !== plugin.continuations
          || typeof service.host?.ensureFolder !== "function"
          || typeof service.host?.getFileByPath !== "function") {
          failures.push("this.recording.host 未绑定预期的动态设置、录音器、ASR、续录与知识库能力");
        }
        continue;
      }
      if (field === "versions") {
        if (service.host?.vault !== app.vault
          || typeof service.host?.getSettings !== "function"
          || typeof service.host?.getFileFrontmatter !== "function"
          || typeof service.host?.refreshNoteIndexSafely !== "function"
          || typeof service.host?.openSourceFile !== "function"
          || service.host.getSettings() !== plugin.settings) {
          failures.push("this.versions.host 未绑定预期的知识库与动态设置、frontmatter、索引和工作区能力");
        }
        continue;
      }
      if (field === "queue") {
        if (typeof service.host?.getMaxRetries !== "function"
          || typeof service.host?.persistQueue !== "function"
          || service.host.getMaxRetries() !== plugin.settings.maxRetries) {
          failures.push("this.queue.host 未绑定预期的最大重试数与队列持久化能力");
        }
        continue;
      }
      if (field === "outline") {
        if (service.host === plugin
          || service.host?.noteWriter !== plugin.noteWriter
          || service.host?.continuations !== plugin.continuations
          || service.host?.settings !== plugin.settings
          || service.host?.diagnostics !== plugin.diagnostics) {
          failures.push("this.outline.host 未绑定预期的笔记写入、续录协调、设置与诊断能力");
        }
        continue;
      }
      if (typeof service.host?.getSettings !== "function"
          || service.host?.vault !== app.vault
          || service.host?.fileManager !== app.fileManager) {
        failures.push(`this.${field}.host 未绑定预期的设置、知识库与文件管理能力`);
      }
      continue;
    }
    if (service.host !== plugin) {
      failures.push(`this.${field}.host 不是插件实例（装配错了宿主对象）`);
    }
  }

  // 用户可见的装配面没有整体丢失（命令、视图、设置页、状态栏定时器）
  // 招聘/晋升评审场景已移除，命令数比此前少 5 个（刷新招聘统计×2、重建总览看板、重建招聘主页、招聘/晋升内联编辑）。
  // 学习卡片场景已移除，再少 3 个（打开学习卡片瀑布墙、打开概念墙、打开对象总览）。
  expect(plugin.commands.length >= 22, `注册的命令数异常：${plugin.commands.length}`);
  expect(plugin.views.length >= 2, `注册的视图数异常：${plugin.views.length}`);
  expect(plugin.settingTabs.length >= 1, "没有注册设置页");
  expect(plugin.intervals.length >= 1, "没有注册状态栏维护定时器");

  // 清理服务必须装配：命令与设置页都直接调它。
  expect(typeof plugin.cleanup.cleanupEmptyShortRecordings === "function", "清理服务未就绪");

  // 侧边栏「纪要」列表：默认不能带隐藏筛选。
  // 列表按 recentFilters 过滤，但筛选条只渲染分组与模板两个按钮——
  // 一旦初始值不是声明的默认值（曾为 time: "week"），用户就只会看到被截短的一周列表，
  // 却看不到、也改不了那个筛选（真机现象：10 篇只显示 2 篇）。
  const outlineEntry = plugin.views.find((v) => v.type === "qnalog-outline-view");
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
      const mdFolder = plugin.settings.mdFolder || "QnALog/转写纪要";
      expect(view.isRecentNotePath(`${mdFolder}/2026-09-14 1133 · 个人笔记.md`),
        "纪要目录内的笔记被判为不在范围里");
      expect(!view.isRecentNotePath("AFFiNE Export/Notes/Unfiled/2025-09-05.md"),
        "纪要目录之外的笔记被判为在范围里（根目录过滤失效，列表会覆盖全库）");

      const bar = makeEl();
      view.renderRecentFilterBar(bar, []);
      const rendered = collectRenderedText(bar);
      const timeLabel = view.getRecentFilterLabel("time", initial.time, []);
      const cls = (item) => item.cls.split(/\s+/);
      const hasChip = (label) => rendered.some((item) => cls(item).includes("qnalog-outline-recent-filter-chip") && item.text === label);
      expect(hasChip(timeLabel), `筛选条上没有时间范围按钮（列表按它过滤，必须可见）：缺「${timeLabel}」`);
      expect(hasChip("全部模板"), "筛选条上没有模板筛选按钮");
      expect(rendered.some((item) => cls(item).includes("qnalog-outline-recent-group-chip")), "筛选条上没有分组按钮");
    } catch (error) {
      failures.push(`纪要面板渲染检查抛错：${(error && error.message) || error}`);
    }
  }

  // 设置结构版本政策：正式用户的配置不能因结构变更被清空。
  // 用独立实例驱动真实的 loadAll——复用主实例会把它的域服务状态搅乱，
  // 导致后面的装配断言误报（实测过）。
  try {
    const probe = new PluginClass(app, { id: "qnalog", version: "1.0.0", dir: ".obsidian/plugins/qnalog", name: "QnALog", minAppVersion: "1.11.4" });
    await probe.onload();
    const settingsSource = readFileSync(new URL("../src/shared/settings-io.ts", import.meta.url), "utf8");
    const versionMatch = settingsSource.match(/SETTINGS_SCHEMA_VERSION\s*=\s*(\d+)/);
    const CURRENT = versionMatch ? Number(versionMatch[1]) : NaN;
    expect(Number.isFinite(CURRENT), "无法从设置源码读出 SETTINGS_SCHEMA_VERSION");
    const userData = {
      settings: {
        schemaVersion: CURRENT,
        storage: { recordingLibraryPath: "QnALog/录音", briefingNotePath: "QnALog/转写纪要" },
        speech: { providers: { siliconflow: { apiKey: "qnk1:JQsyOEIGXwVCCAQV" } } },
        composer: { apiKey: "qnk1:JQsyOEIGXwVCCAQV", model: "用户选的模型" },
      },
      backgroundJobs: { items: [{ id: "t1", mdPath: "QnALog/转写纪要/a.md" }] },
    };
    probe.storedData = userData;
    probe.savedCount = 0;
    await probe.loadAll();
    expect(probe.settings.transcribeProviders?.siliconflow?.apiKey === "test-api-key",
      `版本一致时用户的转写服务密钥丢失（SecretStorage 条目数 ${secrets.size}）`);
    expect(probe.settings.llmApiKey === "test-api-key", `版本一致时用户的 LLM 密钥丢失（SecretStorage 条目数 ${secrets.size}）`);
    expect(probe.settings.llmModel === "用户选的模型", "版本一致时用户选的模型丢失");
    // 注意：loadAll 只负责把队列读进 persistedQueue，queue.load() 在 onload 里另调一次。
    expect(probe.persistedQueue.length === 1, "版本一致时持久化队列被清空");
    probe.queue.load(probe.persistedQueue);
    expect(probe.queue.snapshot().length === 0, "无效队列稀疏行进入了可执行队列");
    expect(probe.queue.recoveryEntries().length === 1, "稀疏队列行未进入恢复保留区");
    await probe.saveAll();
    expect(JSON.stringify(probe.lastSaved.backgroundJobs.items) === JSON.stringify(userData.backgroundJobs.items),
      "保存后稀疏队列原行未保留");
    probe.queue.load(probe.lastSaved.backgroundJobs.items);
    expect(probe.queue.recoveryEntries().length === 1, "重载后稀疏队列原行丢失");
    expect(probe.lastSaved.settings.speech.providers.siliconflow.apiKey === "",
      "迁移后 data.json 仍包含转写 API Key");
    expect(probe.lastSaved.settings.composer.apiKey === "",
      "迁移后 data.json 仍包含 LLM API Key");
    expect([...secrets.values()].filter(value => value === "test-api-key").length === 2,
      "迁移后 SecretStorage 缺少转写或 LLM API Key");

    secrets.clear();
    // 版本更高（用户回退了插件）：必须一个字节都不写回
    probe.storedData = { settings: { schemaVersion: CURRENT + 1, security: { apiKeyStorageNamespace: probe.settings.apiKeyStorageNamespace }, composer: { apiKey: "future-key" } } };
    probe.savedCount = 0;
    await probe.loadAll();
    await probe.saveAll();
    expect(probe.savedCount === 0,
      `磁盘设置来自更高版本时仍写盘了 ${probe.savedCount} 次，会覆盖新版字段`);
    expect(probe.settingsSchemaState === "future", "更高版本未被标记为 future");
    expect(secrets.size === 0, "future 设置读取时写入了 SecretStorage");

    secrets.clear();
    // 无法识别来源：回到默认值，且必须写一次盘完成重建
    probe.storedData = { settings: { schemaVersion: 0, whatever: true } };
    probe.savedCount = 0;
    await probe.loadAll();
    expect(probe.settingsSchemaState === "foreign", "未识别来源的数据未被标记为 foreign");
    expect(probe.settings.audioFolder === "QnALog/录音", "foreign 时未回到默认设置");
    await probe.onunload();
  } catch (error) {
    failures.push(`设置结构版本政策检查失败：${(error && error.message) || error}`);
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
