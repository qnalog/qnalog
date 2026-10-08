// 会话收尾 → 合并整理 的运行检查：在模拟宿主里加载 main.js，用桩 LLM 真跑一遍这条链路。
//
// 为什么要有这条：域服务与流水线都带 @ts-nocheck，静态检查只看得住「引用名对不对」，
// 看不出「参数传的是不是插件对象」。真机上就出过这条：
//   域服务把自身 this 传给 mergeAndPolish，流水线读 plugin.settings.briefingStructureLevel
//   → TypeError: Cannot read properties of undefined → llm.merge_failed，纪要无法整理。
// 那处缺陷通过了 tsc、ESLint、既有契约测试与静态门禁，只有真的执行一次才能发现。
// 因此固化成脚本：CI 每次 push 跑，本地也可随时跑。
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
// Obsidian 提供 parseYaml / stringifyYaml；模拟宿主用它俩做等价实现，
// 否则流水线写出的 frontmatter 会被序列化成空串（harness 缺实现，不是产品缺陷）。
import { dump as yamlDump, load as yamlLoad } from "js-yaml";

const code = readFileSync(new URL("../main.js", import.meta.url), "utf8");
const appendLayout = process.argv.includes("--append-layout");
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
  "---", "qnalog_mode: monologue", "qnalog_time: 2026-09-14T11:33:00", "qnalog_status: draft", "---", "",
  "# 2026-09-14 11:33 · 个人笔记", "",
  "<details><summary>原始音频</summary>![[qnalog-20260914-113300.webm]]</details>", "",
  "<details><summary>分段原始转写</summary>",
  "<!-- qnalog-segments-start:s1 -->",
  serializeTranscriptSegment(transcriptSegment(0, "今天的会议讨论了上线范围。", 0, 5000)),
  serializeTranscriptSegment(transcriptSegment(1, "确定先做内部灰度。", 5000, 10000)),
  "<!-- qnalog-segments-end:s1 -->",
  "</details>",
  "<!-- qnalog-session:s1 -->",
].join("\n");

function transcriptSegment(index, text, startOffsetMs, endOffsetMs, sourceId = "s1") {
  const id = `seg:${sourceId}:${index}`;
  const utteranceId = `${id}:r1:u1`;
  return {
    index, startOffsetMs, endOffsetMs, audioStartOffsetMs: 0, audioEndOffsetMs: endOffsetMs - startOffsetMs, text,
    audioName: `qnalog-${sourceId}-${index}.webm`,
    audioPath: `QnALog/Audio/qnalog-${sourceId}-${index}.webm`,
    transcript: {
      schemaVersion: 2,
      id,
      sourceId,
      sourcePath: null,
      sourceName: null,
      currentRevision: 1,
      revisions: [{
        revision: 1,
        normalizationRevision: 1,
        source: "text-import",
        providerId: null,
        rawText: text,
        displayText: text,
        utterances: [{
          id: utteranceId,
          parentSegmentId: id,
          rawText: text,
          normalizedText: text,
          speakerId: null,
          speakerName: null,
          startMs: null,
          endMs: null,
          timing: "unknown",
          audioRef: null,
          source: "text-import",
        }],
        corrections: [],
      }],
    },
  };
}
function serializeTranscriptSegment(segment) {
  const { transcript, ...storedSegment } = segment;
  return [
    `<!-- qnalog-transcript-start:${transcript.id} -->`,
    `### Segment ${segment.index + 1}`,
    `<!-- qnalog-transcript-text-start:${transcript.id} -->`,
    segment.text,
    `<!-- qnalog-transcript-text-end:${transcript.id} -->`,
    `<!-- qnalog-transcript-data ${JSON.stringify({ schemaVersion: 2, segment: storedSegment, transcript })} -->`,
    `<!-- qnalog-transcript-end:${transcript.id} -->`,
  ].join("\n");
}

const files = new Map();
const frontmatterByPath = new Map();
const openedFiles = [];
const noteFile = new TFile(NOTE_PATH);
noteFile._content = NOTE_BODY;
files.set(NOTE_PATH, noteFile);

const secrets = new Map();
const adapterData = new Map();

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
    adapter: {
      exists: async (path) => adapterData.has(path) || files.has(path),
      read: async (path) => adapterData.get(path) ?? files.get(path)?._content ?? "{}",
      write: async (path, content) => { adapterData.set(path, String(content)); },
      readBinary: async () => new ArrayBuffer(0),
      mkdir: async () => undefined,
      rename: async (from, to) => {
        if (adapterData.has(from)) { adapterData.set(to, adapterData.get(from)); adapterData.delete(from); }
      },
      remove: async (path) => { adapterData.delete(path); },
      stat: async () => ({ mtime: Date.now(), size: 0 }),
      list: async () => ({ files: [], folders: [] }),
    },
    getAbstractFileByPath: (p) => files.get(String(p).replace(/^\/+/, "")) || null,
    getFiles: () => [...files.values()],
    getMarkdownFiles: () => [...files.values()],
    createFolder: async () => new TFolder(),
    create: async (p, c) => { const f = new TFile(p); f._content = c; files.set(p, f); return f; },
    read: async (f) => {
      if (gateContinuationStageRead && f.path === continuationStagePath) {
        gateContinuationStageRead = false;
        continuationStageReadReached();
        await continuationStageReadGate.promise;
      }
      return f._content || "";
    },
    cachedRead: async (f) => f._content || "",
    modify: async (f, c) => {
      if (failContinuationCommit && String(c).includes("qnalog-continuation-committed:s2")) {
        failContinuationCommit = false;
        throw new Error("simulated target write failure");
      }
      f._content = c;
    },
    delete: async () => undefined,
    on: () => ({}),
  },
  workspace: {
    on: () => ({}), onLayoutReady: (fn) => fn(), getActiveFile: () => null,
    getLeavesOfType: () => [], getLeaf: () => ({ openFile: async (file) => { openedFiles.push(file); }, view: null }),
    iterateAllLeaves: noop,
  },
  metadataCache: {
    getFirstLinkpathDest: () => null,
    getFileCache: (file) => frontmatterByPath.has(file.path) ? { frontmatter: frontmatterByPath.get(file.path) } : null,
    on: () => ({}),
  },
  fileManager: {
    renameFile: async (file, path) => {
      files.delete(file.path);
      file.path = path;
      file.name = path.slice(path.lastIndexOf("/") + 1);
      file.basename = file.name.replace(/\.[^.]+$/, "");
      files.set(path, file);
    },
    trashFile: async (file) => { files.delete(file.path); },
  },
  internalPlugins: { getPluginById: () => null, plugins: {} },
};

let failContinuationCommit = false;
let gateNextLlmRequest = false;
let releaseGatedLlmRequest = null;
let gateContinuationStageRead = false;
let continuationStagePath = "";
let continuationStageReadReached = () => undefined;
let continuationStageReadGate = null;
let continuationStageReadObserved = false;

// 桩 LLM：从实际请求中的来源标题读取允许的证据 ID，只返回一个分部回复。
const llmCalls = [];
let literalMergeSmokeBody = "";
function requestPrompt(request) {
  try {
    const body = JSON.parse(request?.body || "{}");
    return (body.messages || []).map((message) => String(message.content || "")).join("\n");
  } catch { return ""; }
}
function makeLlmReply(request) {
  const prompt = requestPrompt(request);
  if (prompt.includes("You name files and extract short topic tags from meeting notes.")
    || prompt.includes("你是文件命名助手，擅长从中文内容中提取简洁的主题标签。")) {
    return JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Writer topic" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
    });
  }
  if (prompt.includes("<qnalog-outline>")) {
    return JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: [
            "<qnalog-memory>连续录音按内容顺序补全主题。</qnalog-memory>",
            "<qnalog-outline>",
            "- [[qnalog-s1-0.webm|00:00]] 首次录音范围主题",
            "  - 讨论发布范围",
            "- [[qnalog-s1-1.webm|00:00]] 首次录音决定主题",
            "  - 确认内部灰度",
            "- [[qnalog-s2-0.webm|00:00]] 续录灰度反馈主题",
            "- [[qnalog-s2-1.webm|00:00]] 续录回滚责任主题",
            "- [[qnalog-s2-2.webm|00:00]] 续录检查清单主题",
            "</qnalog-outline>",
          ].join("\n"),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
    });
  }
  const evidenceIds = [...new Set(Array.from(prompt.matchAll(/^===UTTERANCE ("(?:[^"\\]|\\.)*")/gm), (match) => JSON.parse(match[1])))];
  const evidence = evidenceIds.slice(0, 1);
  const protocol = JSON.stringify({
    schemaVersion: 2,
    topics: [{ key: "release", title: "灰度发布", summary: "先进行内部灰度", evidence }],
    decisions: [{ text: "先做内部灰度", topics: ["release"], evidence }],
    actions: [], questions: [],
  });
  return JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: `## 议题\n\n上线范围已确定，先做内部灰度。\n\n## 结论\n\n内部灰度后按反馈扩大。${literalMergeSmokeBody}\n\n<!-- qnalog-session-knowledge ${protocol} -->`,
      },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
  });
}

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
  addIcon() {},
  TFile, TFolder,
  ItemView: class { constructor() { this.containerEl = makeEl(); } }, MarkdownView: class {},
  Modal: class { modalEl = makeEl(); contentEl = makeEl(); open() {} close() {} }, Component: class {}, Menu: class {}, TextComponent: class {},
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
  requestUrl: async (request) => {
    llmCalls.push(request);
    if (gateNextLlmRequest) {
      gateNextLlmRequest = false;
      await new Promise((resolve) => { releaseGatedLlmRequest = resolve; });
    }
    const text = makeLlmReply(request);
    return { status: 200, text, json: JSON.parse(text), headers: {}, arrayBuffer: new ArrayBuffer(0) };
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
  const fixedNow = Date.parse("2026-09-14T12:00:00.000Z");
  let randomSeed = 0;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => (++randomSeed % 1_000_000) / 1_000_000;
  const sandbox = {
    module: { exports: {} }, exports: {},
    require: (id) => { if (id === "obsidian") return obsidian; throw new Error(`加载了不可用的模块：${id}`); },
    console, Date: FixedDate, setTimeout, clearTimeout, setInterval, clearInterval,
    Math: deterministicMath,
    crypto: {
      getRandomValues: (bytes) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index + 1;
        return bytes;
      },
    },
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
let smokeDigest = "";
let rawSegmentMaterialsDigest = "";

async function main() {
  const realDateNow = Date.now;
  Date.now = () => Date.parse("2026-09-14T12:00:00.000Z");
  const sandbox = makeSandbox();
  const realError = console.error;
  console.error = (...args) => { errorLog.push(args.map(String).join(" ")); };
  try {
    vm.runInNewContext(code, sandbox, { filename: "main.js", timeout: 10000 });
    const PluginClass = sandbox.module.exports?.default || sandbox.module.exports;
    const plugin = new PluginClass(app, { id: "qnalog", version: "1.0.0", dir: ".obsidian/plugins/qnalog", name: "QnALog", minAppVersion: "1.0.0" });
    await plugin.onload();
    plugin.settings.llmEndpoint = "http://localhost:55990/v1";
    plugin.settings.llmModel = "stub-model";
    plugin.settings.llmApiKey = "stub-key";
    plugin.settings.enableRealtimeOutline = false;
    plugin.settings.consolidatedLayout = !appendLayout;
    plugin.settings.briefingStructureLevel = "balanced";
    plugin.settings.sedimentAutoExtract = false;

    const session = {
      id: "s1", mode: "monologue", mdPath: NOTE_PATH,
      startedAt: Date.now() - 600_000, workProgress: {}, segmentMeta: [],
      segments: [
        transcriptSegment(0, "今天的会议讨论了上线范围。", 0, 5000),
        transcriptSegment(1, "确定先做内部灰度。", 5000, 10000),
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
    if (appendLayout) {
      const integratedStart = content.search(/^## .*整合版/m);
      if (integratedStart < 0 || !/议题[\s\S]*结论/.test(content.slice(integratedStart))) {
        failures.push("追加布局的整合版段落没有保留成稿正文");
      }
    } else if (!/议题[\s\S]*结论/.test(beforeRaw)) {
      failures.push("笔记正文里没有写入整合后的内容（原始材料之前）");
    }
    if (!/分段原始转写/.test(content)) failures.push("笔记里没有保留原始转写");
    if (!/<!--\s*qnalog-session:s1\s*-->/.test(content)) failures.push("笔记里没有保留会话标记");
    if (!/^---\r?\n[\s\S]*?\r?\n---/.test(content)) failures.push("笔记没有 frontmatter");
    if (!/^qnalog_time:\s*\S/m.test(content)) failures.push("frontmatter 里没有 qnalog_time 字段（重新整理入口会因缺少时间属性不可用）");
    const knowledgeMatch = content.match(/<!--\s*qnalog-session-knowledge\s+([\s\S]*?)\s*-->/);
    let savedKnowledge = null;
    if (!knowledgeMatch) failures.push("纪要没有保存结构化知识快照");
    else {
      try {
        savedKnowledge = JSON.parse(knowledgeMatch[1]);
        if (savedKnowledge.schemaVersion !== 2 || savedKnowledge.status !== "complete" || savedKnowledge.decisions?.length !== 1) {
          failures.push("纪要知识快照没有按 schema v2 完整保存");
        }
        if (!savedKnowledge.decisions?.[0]?.evidence?.[0]?.startsWith("seg:s1:")) {
          failures.push("纪要决定没有引用转写账本中的 utterance ID");
        }
      } catch { failures.push("纪要知识快照不是有效 JSON"); }
    }
    const sourceUtteranceIds = new Set();
    for (const match of content.matchAll(/<!--\s*qnalog-transcript-data\s+([\s\S]*?)\s*-->/g)) {
      try {
        const data = JSON.parse(match[1]);
        const current = data.transcript.revisions.find((revision) => revision.revision === data.transcript.currentRevision);
        for (const unit of current?.utterances || []) sourceUtteranceIds.add(unit.id);
      } catch { failures.push("转写来源块的元数据不是有效 JSON"); }
    }
    const citedIds = [
      ...(savedKnowledge?.topics || []).flatMap((item) => item.evidence || []),
      ...(savedKnowledge?.decisions || []).flatMap((item) => item.evidence || []),
      ...(savedKnowledge?.actions || []).flatMap((item) => item.evidence || []),
      ...(savedKnowledge?.questions || []).flatMap((item) => item.evidence || []),
    ];
    if (!citedIds.length || citedIds.some((id) => !sourceUtteranceIds.has(id))) {
      failures.push("知识快照证据未全部指向笔记中持久化的 utterance");
    }
    const indexMatch = content.match(/<!--\s*qnalog-note-index\s*-->\s*<details>[\s\S]*?```json\s*([\s\S]*?)\s*```\s*<\/details>/);
    if (!indexMatch) failures.push("收尾后没有生成 note-index 块");
    else {
      try {
        const index = JSON.parse(indexMatch[1]);
        if (index.schemaVersion !== 2 || index.knowledge?.status !== "complete") {
          failures.push("note-index 没有保存知识快照摘要");
        }
      } catch { failures.push("note-index 数据不是有效 JSON"); }
    }
    const protocolRequests = llmCalls.filter((request) => requestPrompt(request).includes("机器证据协议"));
    if (!protocolRequests.length || protocolRequests.length > 2 || protocolRequests.some((request) => !requestPrompt(request).includes("===UTTERANCE"))) {
      failures.push(`结构化知识必须随既有分部整理回复返回，不得另发提取请求；实际协议调用 ${protocolRequests.length} 次`);
    }
    if ((content.match(/qnalog-transcript-start:/g) || []).length !== 2) failures.push("成品笔记没有保留两个转写来源块");
    // 只认 H1（# + 空格）：正文里 `---` 分隔线后的 `## 章节` 也以 # 开头，不是头部空行。
    if (/^---\r?\n[ \t]*\r?\n#\s/m.test(content)) failures.push("frontmatter 与 H1 之间有多余空行（新格式：单换行紧贴标题）");
    const continuationId = "s2";
    const continuationTime = "2026-09-14T11:43:00.000Z";
    const originalLiveOutline = "- [[qnalog-s1-0.webm|00:00]] 首次录音已保存主题";
    const addedSegments = [
      transcriptSegment(0, "追加录音确认按反馈扩大灰度。", 0, 4000, continuationId),
      transcriptSegment(1, "追加录音补充回滚阈值与负责人。", 4000, 8000, continuationId),
      transcriptSegment(2, "追加录音补充发布检查清单。", 8000, 12000, continuationId),
    ];
    const appendedLiveOutline = [
      originalLiveOutline,
      "- [[qnalog-s2-0.webm|00:00]] QNALOG_CONTINUATION_OUTLINE_PERSISTENCE_1",
      "- [[qnalog-s2-1.webm|00:00]] QNALOG_CONTINUATION_OUTLINE_PERSISTENCE_2",
      "- [[qnalog-s2-2.webm|00:00]] QNALOG_CONTINUATION_OUTLINE_PERSISTENCE_3",
    ].join("\n");
    noteFile._content += [
      "",
      "<details>",
      "<summary>录音中实时大纲（草稿）</summary>",
      "",
      "> 基于录音过程中已完成的分段自动生成，正文纪要以最终整理为准。时间标记可用于快速回听对应片段。",
      "",
      originalLiveOutline,
      "</details>",
      "",
    ].join("\n");
    let continuationPreparation;
    try {
      continuationPreparation = await plugin.continuations.prepare(noteFile, continuationId, "20260914-114300", continuationTime);
      plugin.settings.enableRealtimeOutline = false;
      for (const segment of addedSegments) {
        continuationPreparation.stageFile._content += `\n${serializeTranscriptSegment(segment)}\n`;
      }
      const continuationSession = {
        id: continuationId,
        mode: continuationPreparation.mode,
        mdPath: continuationPreparation.stageFile.path,
        startedAt: continuationTime,
        segments: addedSegments,
        workProgress: {},
        segmentMeta: [],
        finalized: false,
        finalizing: false,
        finalizePromise: null,
        continuationTaskId: continuationPreparation.taskId,
        continuation: continuationPreparation.continuation,
        continuationSourcePath: noteFile.path,
        realtimeOutline: appendedLiveOutline,
      };
      plugin.sessionStore.begin(continuationSession);
      plugin.continuations.trackSession(continuationSession, noteFile);
      const targetBeforeFinalize = noteFile._content;
      continuationStagePath = continuationPreparation.stageFile.path;
      const stageReadGate = Promise.withResolvers();
      const stageReadReached = Promise.withResolvers();
      continuationStageReadGate = stageReadGate;
      continuationStageReadReached = () => { continuationStageReadObserved = true; stageReadReached.resolve(); };
      gateContinuationStageRead = true;
      const firstFinalize = plugin.sessionFinalize.finalizeSession(continuationSession);
      const stageReadDeadline = performance.now() + 5000;
      while (!continuationStageReadObserved && performance.now() < stageReadDeadline) {
        await Promise.race([stageReadReached.promise, new Promise((resolve) => setTimeout(resolve, 0))]);
      }
      if (!continuationStageReadObserved) throw new Error("continuation finalizer did not reach the stage read gate within 5 seconds");
      const secondFinalize = plugin.sessionFinalize.finalizeSession(continuationSession);
      if (continuationSession.finalized || !continuationSession.finalizePromise
        || noteFile._content !== targetBeforeFinalize
        || !plugin.queue.tasks.some((candidate) => candidate.id === continuationPreparation.taskId)) {
        failures.push("continuation finalization changed state or target before staged material was read");
      }
      stageReadGate.resolve();
      await Promise.all([firstFinalize, secondFinalize]);
      gateContinuationStageRead = false;
      continuationStageReadGate = null;
      plugin.settings.enableRealtimeOutline = true;
      const task = plugin.queue.tasks.find((candidate) => candidate.id === continuationPreparation.taskId);
      if (!continuationSession.finalized || continuationSession.finalizationError || continuationSession.finalizePromise !== null
        || plugin.continuations.isSessionTracked(continuationId)
        || !files.has(continuationPreparation.stageFile.path)
        || plugin.sessionStore.get() !== null
        || !task || task.status !== "pending"
        || task.mdPath !== continuationPreparation.stageFile.path
        || task.temporarySourcePath !== continuationPreparation.stageFile.path
        || JSON.stringify(task.segments) !== JSON.stringify(addedSegments)
        || task.continuation?.realtimeOutline !== appendedLiveOutline) {
        failures.push(`finalizeSession did not hand off the prepared continuation task: ${JSON.stringify({ finalized: continuationSession.finalized, finalizationError: continuationSession.finalizationError, activeSession: plugin.sessionStore.get(), task })}`);
      }
      if (noteFile._content !== targetBeforeFinalize) failures.push("continuation finalization changed its target note before queue processing");
      if (!task) throw new Error("continuation finalize handoff did not create the prepared queue task");
      gateNextLlmRequest = true;
      failContinuationCommit = true;
      const continuationRun = plugin.queue.processOne(task);
      const gateDeadline = performance.now() + 5000;
      while (!releaseGatedLlmRequest && performance.now() < gateDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (!releaseGatedLlmRequest) throw new Error("continuation model request did not reach the gate");
      const activeId = plugin.tasks.queueTaskActivityId(task);
      const duringModel = plugin.tasks.getTaskActivities({ includeDone: true, includeCancelled: true })
        .find((activity) => activity.id === activeId);
      if (!duringModel || duringModel.status !== "running" || duringModel.stage === "write-note") {
        failures.push(`continuation did not retain its live model activity while the request was pending: ${JSON.stringify(duringModel)}`);
      }
      releaseGatedLlmRequest();
      releaseGatedLlmRequest = null;
      let firstAttemptError = null;
      try { await continuationRun; } catch (error) { firstAttemptError = error; }
      if (!firstAttemptError || !String(firstAttemptError.message || firstAttemptError).includes("simulated target write failure")) {
        failures.push("simulated continuation write failure did not reach the queue retry path");
      }
      const failedTask = plugin.queue.tasks.find((candidate) => candidate.id === task.id);
      const failedActivity = plugin.tasks.getTaskActivities({ includeDone: true, includeCancelled: true })
        .find((activity) => activity.id === activeId);
      if (!failedTask || failedTask.status !== "failed" || !failedActivity || failedActivity.status !== "failed"
        || failedActivity.completedAt <= 0 || !String(failedActivity.error || "").includes("simulated target write failure")) {
        failures.push(`continuation failure state was not retained for recovery: ${JSON.stringify({ failedTask, failedActivity })}`);
      }
      if ((noteFile._content || "").includes("qnalog-continuation-committed:s2")) {
        failures.push("failed continuation write marked the target as committed");
      }
      if (failedTask) {
        failedTask.retries = 1;
        await plugin.queue.processOne(failedTask);
      }
      const appended = noteFile._content || "";
      const outlineBlocks = [...appended.matchAll(/<details>\s*<summary>录音中实时大纲（草稿）<\/summary>[\s\S]*?<\/details>/g)];
      const continuationOutline = outlineBlocks.at(-1)?.[0] || "";
      for (const topic of ["首次录音范围主题", "首次录音决定主题", "续录灰度反馈主题", "续录回滚责任主题", "续录检查清单主题"]) {
        if (!continuationOutline.includes(topic)) failures.push(`续录实时大纲未覆盖完整录音材料：${topic}`);
      }
      for (const phrase of ["追加录音确认按反馈扩大灰度。", "追加录音补充回滚阈值与负责人。", "追加录音补充发布检查清单。"]) {
        if (!appended.includes(phrase)) failures.push(`续录逐字稿没有并入目标笔记：${phrase}`);
      }
      if ((appended.match(/<!-- qnalog-continuation-committed:s2 -->/g) || []).length !== 1) failures.push("目标笔记没有恰好一个续录提交标记");
      if ((appended.match(/qnalog-transcript-start:/g) || []).length !== 5) failures.push("续录提交后目标笔记没有保留五段逐字稿");
      const ledgerSegments = [...appended.matchAll(/<!--\s*qnalog-transcript-data\s+([\s\S]*?)\s*-->/g)]
        .map((match) => JSON.parse(match[1]).segment);
      if (JSON.stringify(ledgerSegments.map((segment) => segment.index)) !== JSON.stringify([0, 1, 2, 3, 4])) {
        failures.push(`续录账本分段编号不连续：${JSON.stringify(ledgerSegments.map((segment) => segment.index))}`);
      }
      const coverageBlocks = [...appended.matchAll(/<!--\s*qnalog-realtime-outline-source-coverage\s*:\s*([\s\S]*?)\s*-->/g)];
      try {
        const coverage = JSON.parse(coverageBlocks.at(-1)?.[1] || "null");
        if (coverage?.committedSegmentCount !== 5 || coverage?.totalSegmentCount !== 5) {
          failures.push(`续录大纲覆盖范围不是五段完整账本：${JSON.stringify(coverage)}; markers=${coverageBlocks.length}; outline=${continuationOutline.slice(-800)}; task=${JSON.stringify(failedTask?.continuation)}`);
        }
      } catch { failures.push("续录大纲来源覆盖证明不是有效 JSON"); }
      if (files.has(continuationPreparation.stageFile.path)) failures.push("续录成功后暂存文件没有清理");
      const transcriptData = (text) => [...text.matchAll(/<!--\s*qnalog-transcript-data\s+([\s\S]*?)\s*-->/g)].map((match) => match[1]);
      const mediaReferences = (text) => text.match(/!?\[\[[^\]]+\]\]/g) || [];
      const sameMediaReferences = (left, right) =>
        JSON.stringify([...mediaReferences(left)].sort()) === JSON.stringify([...mediaReferences(right)].sort());
      const initialRecords = transcriptData(appended);
      const audioFixture = initialRecords.map((record) => JSON.parse(record))
        .find((record) => typeof record.segment?.audioPath === "string" && record.segment.audioPath);
      if (!audioFixture) throw new Error("source ledger has no audio target fixture");
      const withAudioFixture = appended.replace(
        /(<summary>原始音频[^<]*<\/summary>)/,
        `$1![[${audioFixture.segment.audioPath}]]`,
      );
      if (withAudioFixture === appended) throw new Error("raw audio fixture insertion point is missing");
      await app.vault.modify(noteFile, `${withAudioFixture}\n\nOriginal snapshot smoke body.`);
      const postContinuation = noteFile._content || "";
      const sourceRecords = transcriptData(postContinuation);
      const sourceReferences = mediaReferences(postContinuation);
      if (!sourceReferences.includes(`![[${audioFixture.segment.audioPath}]]`)) {
        throw new Error("audio target fixture is not present in source note");
      }
      const parseOuterYaml = (text) => {
        const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!match) throw new Error("source note has no parseable outer frontmatter");
        const value = yamlLoad(match[1]);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("source note outer frontmatter is not a YAML object");
        }
        return value;
      };
      const sourceYaml = parseOuterYaml(postContinuation);
      if (!sourceYaml.qnalog_time || !sourceYaml.qnalog_mode) {
        throw new Error("source note outer content properties are missing");
      }
      try {
        const originalPath = await plugin.versions.ensureOriginalVersionForSource(noteFile);
        if (!originalPath || !(await app.vault.adapter.exists(originalPath))) {
          throw new Error("original snapshot was not saved");
        }
        const originalSnapshot = await app.vault.adapter.read(originalPath);
        if (!originalSnapshot.includes("qnalog_time:") || !originalSnapshot.includes("Original snapshot smoke body.")
          || !/议题[\s\S]*结论/.test(originalSnapshot)) {
          throw new Error("original snapshot did not retain source content properties and body");
        }
        const originalManifestPath = `${originalPath.slice(0, originalPath.lastIndexOf("/"))}/manifest.json`;
        const manifestBeforeSave = JSON.parse(await app.vault.adapter.read(originalManifestPath));
        const activeVersionBeforeSave = manifestBeforeSave.activeVersionId ?? null;
        const savedVersion = await plugin.versions.saveVersion(noteFile, postContinuation, [], {
          kind: "minutes",
          label: "Outer document smoke",
          mode: "synthesis",
          body: "---\nqnalog_time: 2026-09-14T11:43:00\nqnalog_mode: synthesis\n---\n# Smoke minutes\n\nVersioned minutes body.",
          activate: false,
        });
        const manifestAfterSave = JSON.parse(await app.vault.adapter.read(originalManifestPath));
        if ((manifestAfterSave.activeVersionId ?? null) !== activeVersionBeforeSave) {
          throw new Error("saving inactive minutes changed the active version ID");
        }
        const cachePath = `${savedVersion.folder}/${savedVersion.meta.fileName}`;
        const cachedContent = await app.vault.adapter.read(cachePath);
        if (!cachedContent.includes("Versioned minutes body.") || !cachedContent.includes("qnalog_mode: synthesis")) {
          throw new Error("saved version cache did not retain its body and content properties");
        }
        await plugin.versions.switchVersion(cachePath, NOTE_PATH);
        const switched = noteFile._content || "";
        if (!switched.includes("Versioned minutes body.")) failures.push("切换版本后母本没有显示缓存正文");
        if ((switched.match(/qnalog-active-version-start/g) || []).length !== 1) failures.push("切换版本后活动版本块数量不是一");
        if ((switched.match(/qnalog-active-version-end/g) || []).length !== 1) failures.push("切换版本后活动版本结束标记数量不是一");
        const outerYaml = parseOuterYaml(switched);
        if (outerYaml.qnalog_mode !== "synthesis" || !outerYaml.qnalog_time) {
          failures.push("切换版本未更新母本内容属性");
        }
        const bookkeepingKeys = ["qnalog_type", "type", "variant_kind", "variant_label", "variant_mode", "variant_style", "qnalog_source_path", "source_path", "source_id", "qnalog_contains_raw", "contains_raw", "contains_frontmatter", "created", "payload_format", "version_id", "source_segments_hash"];
        if (bookkeepingKeys.some((key) => Object.prototype.hasOwnProperty.call(outerYaml, key))) {
          failures.push("版本记账字段泄漏到母本 frontmatter");
        }
        if (JSON.stringify(transcriptData(switched)) !== JSON.stringify(sourceRecords)) {
          failures.push("切换版本改变了母本转写来源账本");
        }
        if (!sameMediaReferences(switched, postContinuation)) {
          failures.push("切换版本改变了母本来源或媒体引用");
        }
        const activeManifest = JSON.parse(await app.vault.adapter.read(`${savedVersion.folder}/manifest.json`));
        if (activeManifest.activeVersionId !== savedVersion.meta.id) failures.push("切换版本后清单活动 ID 不匹配");

        await plugin.versions.switchVersion(originalPath, NOTE_PATH);
        const restored = noteFile._content || "";
        const restoredYaml = parseOuterYaml(restored);
        const restoredActiveBlock = restored.match(/<!-- qnalog-active-version-start -->([\s\S]*?)<!-- qnalog-active-version-end -->/)?.[1] || "";
        if (!restored.includes("Original snapshot smoke body.") || !/议题[\s\S]*结论/.test(restored)
          || restoredActiveBlock.includes("Versioned minutes body.")) {
          failures.push("恢复原稿未还原固定正文、模型正文或原稿活动块");
        }
        if (JSON.stringify(restoredYaml) !== JSON.stringify(sourceYaml)) {
          failures.push("恢复原稿快照改变了母本内容属性");
        }
        if (!restored.includes("qnalog-transcript-start:")) {
          failures.push("恢复原稿快照后原始转写缺失");
        }
        if (JSON.stringify(transcriptData(restored)) !== JSON.stringify(sourceRecords)) {
          failures.push("恢复原稿快照改变了母本转写来源账本");
        }
        if (!sameMediaReferences(restored, postContinuation)) {
          failures.push("恢复原稿快照改变了母本来源或媒体引用");
        }
        const restoredManifest = JSON.parse(await app.vault.adapter.read(`${savedVersion.folder}/manifest.json`));
        const originalFileName = originalPath.slice(originalPath.lastIndexOf("/") + 1);
        const originalMeta = restoredManifest.versions.find((record) => record.fileName === originalFileName && record.kind === "source-original");
        if (!originalMeta || restoredManifest.activeVersionId !== originalMeta.id) failures.push("恢复原稿后清单活动 ID 不匹配");
      } catch (error) {
        failures.push(`版本缓存切换与原稿恢复失败：${(error && error.message) || error}`);
      }
    } catch (error) {
      failures.push(`续录收尾到目标笔记合并失败：${(error && error.message) || error}`);
    }
    try {
      const disposablePath = "qnalog-session-cleanup-smoke.md";
      const block = "## Disposable\n<!-- qnalog-session:smoke-session -->\n<!-- qnalog-segments-start:smoke-session -->\n<!-- qnalog-segments-end:smoke-session -->";
      const full = `KEEP-A\n\n${block}\n\nKEEP-B\n`;
      const expected = "KEEP-A\n\nKEEP-B\n";
      const makeTemporaryNote = (content) => {
        const file = new TFile(disposablePath);
        file._content = content;
        files.set(disposablePath, file);
        return file;
      };
      const noteSession = () => ({ id: "smoke-session", mdPath: disposablePath });
      const segmentStorePath = "qnalog-segment-store-smoke.md";
      const segmentStoreInput = [
        "# First",
        "<!-- qnalog-session:s1 -->",
        "<!-- qnalog-segments-start:s1 -->",
        "FIRST BODY",
        "<!-- qnalog-segments-end:s1 -->",
        "",
        "## Second",
        "<!-- qnalog-session:s2 -->",
        "<!-- qnalog-segments-start:s2 -->",
        "SECOND BODY",
        "<!-- qnalog-segments-end:s2 -->",
        "AFTER",
      ].join("\n");
      const startText = "提纲\n$& $` $' $$";
      const endText = "转写 $& $` $' $$";
      await plugin.noteWriter.appendToNote(segmentStorePath, segmentStoreInput);
      await plugin.noteWriter.insertBeforeSegmentsStart(segmentStorePath, startText, "s1");
      await plugin.noteWriter.insertBeforeSegmentsEnd(segmentStorePath, endText, "s2");
      const segmentFile = files.get(segmentStorePath);
      const expectedSegments = [
        "# First",
        "<!-- qnalog-session:s1 -->",
        startText,
        "<!-- qnalog-segments-start:s1 -->",
        "FIRST BODY",
        "<!-- qnalog-segments-end:s1 -->",
        "",
        "## Second",
        "<!-- qnalog-session:s2 -->",
        "<!-- qnalog-segments-start:s2 -->",
        "SECOND BODY",
        endText,
        "<!-- qnalog-segments-end:s2 -->",
        "AFTER",
      ].join("\n");
      if (!segmentFile || segmentFile._content !== expectedSegments) {
        failures.push("分段存储插入没有按指定会话边界保留字面文本与其它正文");
      }
      await plugin.noteWriter.removeEmptySessionBlock({ id: "s2", mdPath: segmentStorePath });
      const expectedAfterSegmentCleanup = [
        "# First",
        "<!-- qnalog-session:s1 -->",
        `${startText}`,
        "<!-- qnalog-segments-start:s1 -->",
        "FIRST BODY",
        "<!-- qnalog-segments-end:s1 -->",
        "",
        "AFTER",
      ].join("\n");
      if (!files.has(segmentStorePath) || files.get(segmentStorePath)._content !== expectedAfterSegmentCleanup) {
        failures.push("分段存储清理会话时未保留其它会话与周围正文");
      }
      files.delete(segmentStorePath);

      const fallbackPath = "qnalog-segment-store-fallback-smoke.md";
      await plugin.noteWriter.insertBeforeSegmentsEnd(fallbackPath, startText, "missing");
      await plugin.noteWriter.appendToNote(fallbackPath, endText);
      if (files.get(fallbackPath)?._content !== `${startText}\n${endText}`) {
        failures.push("分段存储缺少目标标记时未创建并追加到目标笔记");
      }
      files.delete(fallbackPath);


      makeTemporaryNote(full);
      await plugin.noteWriter.removeEmptySessionBlock(noteSession());
      if (!files.has(disposablePath) || files.get(disposablePath)._content !== expected) {
        failures.push("NoteWriter 空会话清理未精确保留区块前后正文");
      }
      files.delete(disposablePath);

      makeTemporaryNote(full);
      await plugin.asrPipeline.discardShortRecordingNote(noteSession());
      if (!files.has(disposablePath) || files.get(disposablePath)._content !== expected) {
        failures.push("短录音空会话清理未精确保留区块前后正文");
      }
      files.delete(disposablePath);

      makeTemporaryNote(block);
      await plugin.noteWriter.removeEmptySessionBlock(noteSession());
      if (!files.has(disposablePath) || files.get(disposablePath)._content !== "") {
        failures.push("NoteWriter 清除唯一会话区块时未保留空文件");
      }
      files.delete(disposablePath);

      makeTemporaryNote(block);
      await plugin.asrPipeline.discardShortRecordingNote(noteSession());
      if (files.has(disposablePath)) failures.push("短录音清除唯一会话区块时未移除文件");
      files.delete(disposablePath);

      const incomplete = full.replace("qnalog-segments-end:smoke-session", "qnalog-segments-end:other");
      makeTemporaryNote(incomplete);
      await plugin.noteWriter.removeEmptySessionBlock(noteSession());
      if (!files.has(disposablePath) || files.get(disposablePath)._content !== incomplete) {
        failures.push("NoteWriter 对缺失匹配结束标记的文件执行了修改");
      }
      files.delete(disposablePath);

      makeTemporaryNote(incomplete);
      const encoder = { stopped: false, stop() { this.stopped = true; } };
      const streamingClient = { closed: false, _safeClose() { this.closed = true; } };
      const liveSession = Object.assign(noteSession(), { pcmEncoder: encoder, streamingClient });
      await plugin.asrPipeline.discardShortRecordingNote(liveSession);
      if (!files.has(disposablePath) || files.get(disposablePath)._content !== incomplete
        || !encoder.stopped || !streamingClient.closed
        || liveSession.pcmEncoder !== null || liveSession.streamingClient !== null) {
        failures.push("短录音清理未保留缺失匹配标记的文件或关闭流式资源");
      }
      files.delete(disposablePath);
    } catch (error) {
      failures.push(`空会话清理冒烟失败：${(error && error.message) || error}`);
      files.delete("qnalog-session-cleanup-smoke.md");
    }
    let settingsBeforeWriterSmoke = null;
    let momentBeforeWriterSmoke = null;
    try {
      settingsBeforeWriterSmoke = {
        mdFolder: plugin.settings.mdFolder,
        polishMode: plugin.settings.polishMode,
        autoRenameWithTitle: plugin.settings.autoRenameWithTitle,
        noteFileNameFormatNew: plugin.settings.noteFileNameFormatNew,
      };
      momentBeforeWriterSmoke = sandbox.moment;
      const openedBeforeWriterSmoke = openedFiles.length;
      const sourceAPath = "QnALog/WriterSmoke/2026-09-14 1100.md";
      const sourceBPath = "QnALog/WriterSmoke/2026-09-14 1101.md";
      const makeSource = (path, sourceId, text, time) => {
        const segment = transcriptSegment(0, text, 0, 1000, sourceId);
        const content = [
          "---", "qnalog_mode: monologue", `qnalog_time: ${time}`, "---", "",
          `# ${path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "")}`, "",
          `<!-- qnalog-segments-start:${sourceId} -->`,
          serializeTranscriptSegment(segment),
          `<!-- qnalog-segments-end:${sourceId} -->`,
        ].join("\n");
        const file = new TFile(path);
        file._content = content;
        files.set(path, file);
        frontmatterByPath.set(path, { qnalog_mode: "monologue", qnalog_time: time });
        return { file, content };
      };
      const sourceA = makeSource(sourceAPath, "writer-source-a", "Writer source A transcript remains intact.", "2026-09-14T11:00:00.000Z");
      const sourceB = makeSource(sourceBPath, "writer-source-b", "Writer source B transcript remains intact.", "2026-09-14T11:01:00.000Z");
      plugin.settings.mdFolder = "QnALog/WriterSmoke";
      plugin.settings.polishMode = "monologue";
      plugin.settings.autoRenameWithTitle = false;
      const writerMoment = (input) => {
        const parsed = input instanceof Date
          ? input
          : typeof input === "string" && /^\d{4}-\d{2}-\d{2} \d{4}$/.test(input)
            ? new Date(`${input.slice(0, 10)}T${input.slice(11, 13)}:${input.slice(13, 15)}:00.000Z`)
            : input ? new Date(input) : new Date("2026-09-14T12:00:00.000Z");
        const valid = Number.isFinite(parsed.getTime());
        return {
          isValid: () => valid,
          year: () => parsed.getUTCFullYear(),
          day: () => parsed.getUTCDay(),
          valueOf: () => parsed.getTime(),
          format: (pattern) => pattern === "YYYY-MM-DD"
            ? parsed.toISOString().slice(0, 10)
            : pattern === "YYYY-MM-DD HHmm"
              ? `${parsed.toISOString().slice(0, 10)} ${parsed.toISOString().slice(11, 16).replace(":", "")}`
              : pattern === "HH:mm"
                ? parsed.toISOString().slice(11, 16)
                : pattern === "DD"
                  ? parsed.toISOString().slice(8, 10)
                  : "Sep",
        };
      };
      sandbox.moment = writerMoment;
      const previousSource = plugin.noteWriter.findPreviousRecentNoteFile(sourceB.file);
      sandbox.moment = momentBeforeWriterSmoke;
      if (previousSource !== sourceA.file) failures.push("真实 recent 查询没有把 source A 识别为 source B 的上一篇纪要");
      await plugin.noteWriter.mergeMarkdownFilesAsNew([sourceA.file, sourceB.file]);
      const merged = [...files.values()].find((file) =>
        file.path.startsWith("QnALog/WriterSmoke/")
        && file.path !== sourceAPath && file.path !== sourceBPath
        && String(file._content || "").includes("上线范围已确定"));
      if (!merged) throw new Error("合并场景没有生成包含模型正文的成稿");
      if (!merged._content.includes("writer-source-a") || !merged._content.includes("writer-source-b")
        || !merged._content.includes("Writer source A transcript remains intact.")
        || !merged._content.includes("Writer source B transcript remains intact.")) {
        failures.push("合并成稿没有保留两篇来源账本及其可见转写");
      }
      if (!merged._content.includes("qnalog-merge") || !merged._content.includes("qnalog-merge-end")
        || !merged._content.includes("qnalog-note-index")) {
        failures.push("合并成稿缺少来源元数据或真实索引");
      }
      if (sourceA.file._content !== sourceA.content || sourceB.file._content !== sourceB.content) {
        failures.push("合并操作修改了来源笔记");
      }
      if (openedFiles.length !== openedBeforeWriterSmoke + 1 || openedFiles.at(-1) !== merged) {
        failures.push("合并操作没有打开实际生成的成稿");
      }
      plugin.settings.autoRenameWithTitle = true;
      const originalMergedPath = merged.path;
      const originalMergedBody = merged._content;
      const renamed = await plugin.noteWriter.renameMarkdownWithGeneratedTitle(merged, originalMergedBody, "monologue");
      if (renamed !== merged || !merged.path.includes("Writer topic") || files.has(originalMergedPath)
        || merged._content !== originalMergedBody) {
        failures.push("模型生成标题后没有按当前文件状态完成同文件改名并保留正文");
      }
      const originalEditorText = "The complete editor document must remain unchanged.";
      let selectedResult = "";
      const editor = {
        getSelection: () => "selected passage to polish",
        getValue: () => originalEditorText,
        replaceSelection: (value) => { selectedResult = value; },
        setValue: () => { failures.push("选区整理错误地替换了整篇编辑器文本"); },
      };
      await plugin.noteWriter.polishEditor(editor);
      if (!selectedResult.includes("上线范围已确定") || originalEditorText !== editor.getValue()) {
        failures.push("编辑器整理未仅把模型结果写入原选区");
      }
      if (sourceA.file._content !== sourceA.content || sourceB.file._content !== sourceB.content) {
        failures.push("Writer smoke 后来源笔记内容发生变化");
      }
    } catch (error) {
      failures.push(`NoteWriter 能力边界冒烟失败：${(error && error.message) || error}`);
    } finally {
      if (settingsBeforeWriterSmoke) Object.assign(plugin.settings, settingsBeforeWriterSmoke);
      if (momentBeforeWriterSmoke) sandbox.moment = momentBeforeWriterSmoke;
      frontmatterByPath.delete("QnALog/WriterSmoke/2026-09-14 1100.md");
      frontmatterByPath.delete("QnALog/WriterSmoke/2026-09-14 1101.md");
    }
    let recorderBeforeLifecycleSmoke = null;
    let momentBeforeLifecycleSmoke = null;
    let lifecycleSettingsBefore = null;
    let lifecycleFilesBefore = null;
    let lifecycleAdapterDataBefore = null;
    let lifecycleFrontmatterBefore = null;
    let lifecycleSession = null;
    let lifecycleIssueBefore = null;
    let lifecycleIssueInjected = false;
    let lifecycleStopGate = null;
    let lifecycleStopReached = null;
    let lifecycleStopPromise = null;
    try {
      recorderBeforeLifecycleSmoke = plugin.recorder;
      momentBeforeLifecycleSmoke = sandbox.moment;
      lifecycleSettingsBefore = {
        audioFolder: plugin.settings.audioFolder,
        mdFolder: plugin.settings.mdFolder,
        noteFileNameFormatNew: plugin.settings.noteFileNameFormatNew,
        autoOpenOutlineOnRecord: plugin.settings.autoOpenOutlineOnRecord,
        filterShortRecordings: plugin.settings.filterShortRecordings,
        captureMode: plugin.settings.captureMode,
        activeTranscribeProvider: plugin.settings.activeTranscribeProvider,
        enableInterimOutput: plugin.settings.enableInterimOutput,
      };
      lifecycleFilesBefore = [...files].map(([path, file]) => [path, file, file._content]);
      lifecycleAdapterDataBefore = new Map(adapterData);
      lifecycleFrontmatterBefore = new Map(frontmatterByPath);
      lifecycleIssueBefore = plugin.recording.getRecordingIssue();
      const requestCountBefore = llmCalls.length;
      const taskIdsBefore = plugin.queue.tasks.map((task) => task.id);
      const cacheFolder = plugin.settings.segmentCacheFolder;
      const cachePathsBefore = [...files.keys()].filter((path) => path.startsWith(`${cacheFolder}/`)).sort();
      const targetBodyBefore = noteFile._content;
      plugin.settings.audioFolder = "QnALog/RecordingSmoke/Audio";
      plugin.settings.mdFolder = "QnALog/RecordingSmoke";
      plugin.settings.noteFileNameFormatNew = "YYYY-MM-DD HHmm";
      plugin.settings.autoOpenOutlineOnRecord = false;
      plugin.settings.filterShortRecordings = true;
      plugin.settings.captureMode = "mic";
      plugin.settings.activeTranscribeProvider = "siliconflow";
      plugin.settings.enableInterimOutput = false;
      sandbox.moment = () => ({
        format: (pattern) => pattern === "YYYYMMDD-HHmmss"
          ? "20260914-120000"
          : pattern === "YYYY-MM-DD HH:mm"
            ? "2026-09-14 12:00"
            : "2026-09-14 1200",
        toDate: () => new Date("2026-09-14T12:00:00.000Z"),
      });
      lifecycleStopGate = Promise.withResolvers();
      lifecycleStopReached = Promise.withResolvers();
      const smokeRecorder = {
        state: "idle",
        chunks: [],
        masterChunks: [],
        options: null,
        getInfo() { return { state: this.state, elapsed: 0, issue: null }; },
        releaseStream() {},
        async start(options) {
          this.options = options;
          this.state = "recording";
          if (options.onStreamReady) {
            await options.onStreamReady({}, {
              channelCount: 1, maxChannelCount: 1, label: "Smoke microphone",
              mode: "mic", channelMode: "mono",
            });
          }
        },
        async stop() {
          lifecycleStopReached.resolve();
          await lifecycleStopGate.promise;
          await this.options.onSegment({
            blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
            index: 0,
            startOffsetMs: 0,
            endOffsetMs: 2000,
            isFinal: true,
            ext: "webm",
          });
          this.state = "idle";
        },
      };
      plugin.recorder = smokeRecorder;
      await plugin.recording.startRecording();
      lifecycleSession = plugin.sessionStore.get();
      const placeholderPath = lifecycleSession?.mdPath;
      const placeholder = placeholderPath ? files.get(placeholderPath)?._content || "" : "";
      if (!placeholderPath?.startsWith("QnALog/RecordingSmoke/")
        || !placeholder.includes(`<!-- qnalog-session:${lifecycleSession?.id} -->`)
        || !placeholder.includes(`<!-- qnalog-segments-start:${lifecycleSession?.id} -->`)
        || !placeholder.includes(`<!-- qnalog-segments-end:${lifecycleSession?.id} -->`)
        || !lifecycleSession
        || !plugin.continuations.isSessionTracked(lifecycleSession.id)) {
        throw new Error("recording start did not create and track the expected placeholder session");
      }
      plugin.asrPipeline.setRecordingIssue("service", {
        source: "recording-lifecycle-smoke",
        message: "Lifecycle smoke issue",
      });
      lifecycleIssueInjected = true;
      let stopCompleted = false;
      lifecycleStopPromise = plugin.recording.stopRecording().then(() => { stopCompleted = true; });
      await lifecycleStopReached.promise;
      const issueWhileStopping = plugin.recording.getRecordingIssue();
      if (stopCompleted || issueWhileStopping?.source !== "recording-lifecycle-smoke") {
        throw new Error("stop did not wait for final-segment processing while retaining the recording issue");
      }
      lifecycleStopGate.resolve();
      await lifecycleStopPromise;
      if (files.has(placeholderPath)
        || plugin.sessionStore.get() !== null
        || plugin.continuations.isSessionTracked(lifecycleSession.id)
        || plugin.recording.getRecordingIssue() !== null) {
        throw new Error("short-recording finalization did not discard the placeholder and release session state");
      }
      if (llmCalls.length !== requestCountBefore
        || JSON.stringify(plugin.queue.tasks.map((task) => task.id)) !== JSON.stringify(taskIdsBefore)
        || JSON.stringify([...files.keys()].filter((path) => path.startsWith(`${cacheFolder}/`)).sort()) !== JSON.stringify(cachePathsBefore)
        || noteFile._content !== targetBodyBefore) {
        throw new Error("short recording created requests, tasks, cache files, or modified the existing note");
      }
      console.log("[recording-lifecycle] OK: start created placeholder; final discard removed it and released session tracking");
    } catch (error) {
      failures.push(`录音启停生命周期冒烟失败：${(error && error.message) || error}`);
    } finally {
      if (lifecycleStopGate) lifecycleStopGate.resolve();
      if (lifecycleStopPromise) await lifecycleStopPromise.catch(() => undefined);
      if (lifecycleSession) {
        plugin.continuations.releaseSession(lifecycleSession.id);
        plugin.sessionStore.end(lifecycleSession);
      }
      if (lifecycleIssueInjected) {
        if (lifecycleIssueBefore && typeof lifecycleIssueBefore === "object" && typeof lifecycleIssueBefore.kind === "string") {
          plugin.asrPipeline.setRecordingIssue(lifecycleIssueBefore.kind, lifecycleIssueBefore);
        } else {
          plugin.asrPipeline.clearRecordingIssue();
        }
      }
      if (recorderBeforeLifecycleSmoke) plugin.recorder = recorderBeforeLifecycleSmoke;
      if (momentBeforeLifecycleSmoke) sandbox.moment = momentBeforeLifecycleSmoke;
      if (lifecycleSettingsBefore) Object.assign(plugin.settings, lifecycleSettingsBefore);
      if (lifecycleFilesBefore) {
        files.clear();
        for (const [path, file, content] of lifecycleFilesBefore) {
          file._content = content;
          files.set(path, file);
        }
      }
      if (lifecycleAdapterDataBefore) {
        adapterData.clear();
        for (const [path, content] of lifecycleAdapterDataBefore) adapterData.set(path, content);
      }
      if (lifecycleFrontmatterBefore) {
        frontmatterByPath.clear();
        for (const [path, metadata] of lifecycleFrontmatterBefore) frontmatterByPath.set(path, metadata);
      }
    }
    let outlineSmokeFile = null;
    const outlineSmokePath = "qnalog-outline-store-smoke.md";
    const adapter = app.vault.adapter;
    const savedAdapterDescriptors = {
      exists: Object.getOwnPropertyDescriptor(adapter, "exists"),
      mkdir: Object.getOwnPropertyDescriptor(adapter, "mkdir"),
      process: Object.getOwnPropertyDescriptor(app.vault, "process"),
    };
    const savedOutlineFile = files.get(outlineSmokePath);
    const savedOutlineContent = savedOutlineFile?._content;
    const outlineAdapterDataBefore = new Map(adapterData);
    const outlineFolders = new Set();
    let outlineSmokePassed = false;
    try {
      const archivedDetails = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- Archived smoke outline\n</details>";
      const currentDetails = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- Current smoke outline\n</details>";
      const replacementDetails = "<details>\n<summary>Live outline while recording (draft)</summary>\n\n- Replaced smoke outline\n</details>";
      const transcript = serializeTranscriptSegment(transcriptSegment(
        0, "Outline smoke transcript must remain.", 0, 1000, "outline-smoke",
      ));
      const original = [
        "---\nqnalog_mode: meeting\n---",
        "# Outline smoke",
        "KEEP-A",
        archivedDetails,
        currentDetails,
        transcript,
        "KEEP-B",
      ].join("\n\n");
      const expectedWritten = original.replace(currentDetails, replacementDetails);
      outlineSmokeFile = new TFile(outlineSmokePath);
      outlineSmokeFile.name = outlineSmokePath;
      outlineSmokeFile.basename = outlineSmokePath.replace(/\.md$/, "");
      outlineSmokeFile._content = original;
      files.set(outlineSmokePath, outlineSmokeFile);

      const previousExists = adapter.exists;
      const previousMkdir = adapter.mkdir;
      adapter.exists = async function (path) {
        return outlineFolders.has(path) || await previousExists.call(this, path);
      };
      adapter.mkdir = async function (path) {
        outlineFolders.add(path);
        return previousMkdir.call(this, path);
      };
      let outlineProcessCount = 0;
      app.vault.process = async function (file, transform) {
        outlineProcessCount += 1;
        const current = outlineProcessCount === 2
          ? `${file._content}\n\nConcurrent outline smoke edit.`
          : file._content;
        if (outlineProcessCount === 2) file._content = current;
        const next = transform(current);
        if (next !== current) file._content = next;
        return next;
      };

      const written = await plugin.noteWriter.replaceRealtimeOutline(outlineSmokeFile, original, replacementDetails);
      if (written.status !== "written"
        || !written.backupPath?.startsWith(".obsidian/qnalog-outline-backups/")
        || adapterData.get(written.backupPath) !== original
        || outlineSmokeFile._content !== expectedWritten) {
        throw new Error("exact outline replacement or original-byte backup did not match");
      }

      outlineSmokeFile._content = original;
      const stale = await plugin.noteWriter.replaceRealtimeOutline(outlineSmokeFile, original, replacementDetails);
      const expectedConcurrent = `${original}\n\nConcurrent outline smoke edit.`;
      if (stale.status !== "stale"
        || !stale.backupPath
        || adapterData.get(stale.backupPath) !== original
        || outlineSmokeFile._content !== expectedConcurrent) {
        throw new Error("stale outline replacement did not preserve the concurrent edit and exact backup");
      }
      outlineSmokePassed = true;
    } catch (error) {
      failures.push(`大纲存储冒烟失败：${(error && error.message) || error}`);
    } finally {
      if (savedAdapterDescriptors.exists) Object.defineProperty(adapter, "exists", savedAdapterDescriptors.exists);
      else delete adapter.exists;
      if (savedAdapterDescriptors.mkdir) Object.defineProperty(adapter, "mkdir", savedAdapterDescriptors.mkdir);
      else delete adapter.mkdir;
      if (savedAdapterDescriptors.process) Object.defineProperty(app.vault, "process", savedAdapterDescriptors.process);
      else delete app.vault.process;
      adapterData.clear();
      for (const [path, content] of outlineAdapterDataBefore) adapterData.set(path, content);
      if (savedOutlineFile) {
        savedOutlineFile._content = savedOutlineContent;
        files.set(outlineSmokePath, savedOutlineFile);
      } else {
        files.delete(outlineSmokePath);
      }
    }
    if (outlineSmokePassed) {
      console.log("[outline-note-store] OK: exact backup, last-outline replacement, and concurrent edit preservation");
    }
    let literalSmokeSettingsBefore = null;
    let literalSmokeFilesBefore = null;
    let literalSmokeAdapterBefore = null;
    let literalSmokeFrontmatterBefore = null;
    let literalSmokePassed = false;
    const literalOutlinePath = "QnALog/LiteralSmoke/continuation.md";
    const literalRetryPath = "QnALog/LiteralSmoke/retry.md";
    try {
      literalSmokeSettingsBefore = {
        consolidatedLayout: plugin.settings.consolidatedLayout,
        autoRenameWithTitle: plugin.settings.autoRenameWithTitle,
        llmModel: plugin.settings.llmModel,
      };
      literalSmokeFilesBefore = [literalOutlinePath, literalRetryPath].map((path) => [path, files.get(path), files.get(path)?._content]);
      literalSmokeAdapterBefore = new Map(adapterData);
      literalSmokeFrontmatterBefore = new Map(frontmatterByPath);
      const special = "$&\n$` 与反引号\n$'\n$$";
      const priorAudioNames = ["旧录音-$&-$`-$'-$$.m4a", "qnalog-prior-second.webm"];
      const source = transcriptSegment(0, "Literal smoke transcript ledger.", 0, 1000, "literal-continuation");
      source.audioStartOffsetMs = 18000;
      source.audioEndOffsetMs = 19000;
      const errorSegment = {
        ...transcriptSegment(2, "RAW ERROR MUST NOT DISPLAY", 1000, 2000, "literal-continuation"),
        audioStartOffsetMs: 0,
        queueTaskId: "literal-raw-retry",
        error: "temporary failure",
      };
      const legacySegment = {
        index: 7,
        startOffsetMs: 2000,
        endOffsetMs: 3000,
        text: "旧纯文本 $& $` $' $$",
        queueTaskId: "literal-legacy-task",
        isFinal: true,
      };
      const outlineFile = new TFile(literalOutlinePath);
      outlineFile._content = [
        "---\nqnalog_mode: meeting\n---",
        "# Previous note",
        serializeTranscriptSegment(source),
      ].join("\n\n");
      files.set(literalOutlinePath, outlineFile);
      const continuation = {
        id: "literal-continuation",
        sessionStamp: "literal-continuation",
        startedAt: "2026-09-14T11:59:00.000Z",
        mdPath: literalOutlinePath,
        mode: "meeting",
        finalized: true,
        segments: [source, errorSegment, legacySegment],
        continuationSourcePath: "QnALog/LiteralSmoke/previous.md",
        continuationSourceTitle: "旧纪要",
        continuationRecordedAt: "2026-09-17T03:56:35.000Z",
        continuationPriorRecordingInfo: `- 旧录音信息\n${special}`,
        continuationPriorOutline: `- 旧大纲\n  - ${special.replace(/\n/g, "\n  - ")}`,
        continuationPriorAudioNames: priorAudioNames,
        multiSourceAudio: true,
        realtimeOutline: "- 本场实时大纲",
      };
      const polished = "---\ntitle: literal smoke\n---\n\nLiteral rewrite body.";
      await plugin.noteWriter.rewriteConsolidated(continuation, polished);
      const firstRewrite = outlineFile._content;
      await plugin.noteWriter.rewriteConsolidated(continuation, polished);
      const secondRewrite = outlineFile._content;
      const rawStart = "<!-- qnalog-segments-start:literal-continuation -->";
      const rawEnd = "<!-- qnalog-segments-end:literal-continuation -->";
      const rawSectionStart = firstRewrite.indexOf(rawStart);
      const rawSectionEnd = firstRewrite.indexOf(rawEnd);
      const rawSection = rawSectionStart >= 0 && rawSectionEnd > rawSectionStart
        ? firstRewrite.slice(rawSectionStart, rawSectionEnd)
        : "";
      const errorTextStart = "<!-- qnalog-transcript-text-start:seg:literal-continuation:2 -->";
      const errorTextEnd = "<!-- qnalog-transcript-text-end:seg:literal-continuation:2 -->";
      const visibleErrorStart = firstRewrite.indexOf(errorTextStart);
      const visibleErrorEnd = firstRewrite.indexOf(errorTextEnd);
      const visibleError = visibleErrorStart >= 0 && visibleErrorEnd > visibleErrorStart
        ? firstRewrite.slice(visibleErrorStart + errorTextStart.length, visibleErrorEnd)
        : "";
      const legacyTask = "<!-- qnalog-transcribe-task:literal-legacy-task -->";
      const legacyText = "旧纯文本 $& $` $' $$";
      if (!/(?:### Segment 1|### 段落 1) \(00:00–00:01\) \[\[qnalog-literal-continuation-0\.webm\|00:18\]\]/.test(rawSection)
        || !/(?:### Segment 3|### 段落 3) \(00:01–00:02\) \[\[qnalog-literal-continuation-2\.webm\|00:00\]\]/.test(rawSection)
        || !rawSection.includes("<!-- qnalog-transcribe-task:literal-raw-retry -->")
        || rawSection.indexOf("<!-- qnalog-transcribe-task:literal-raw-retry -->") > rawSection.indexOf(errorTextStart)
        || visibleError.includes("RAW ERROR MUST NOT DISPLAY")
        || !rawSection.includes(legacyTask)
        || !rawSection.includes(legacyText)
        || !/(?:### Segment 8|### 段落 8) \(00:02–00:03\)/.test(rawSection)
        || !rawSection.endsWith(`${legacyText}\n\n`)) {
        throw new Error("raw segment headings, retry markers, or visible transcript text changed");
      }
      rawSegmentMaterialsDigest = createHash("sha256").update(rawSection).digest("hex");
      const secondRawStart = secondRewrite.indexOf(rawStart);
      const secondRawEnd = secondRewrite.indexOf(rawEnd);
      if (secondRawStart < 0 || secondRawEnd <= secondRawStart
        || secondRewrite.slice(secondRawStart, secondRawEnd) !== rawSection) {
        throw new Error("raw segment materials changed during repeated rewrite");
      }
      if (!firstRewrite.includes(`- 旧录音信息\n${special}`)
        || !firstRewrite.includes("- 追加录音：2026-09-14")
        || !firstRewrite.includes("- 本场实时大纲")
        || !firstRewrite.includes(special)
        || !firstRewrite.includes("Literal smoke transcript ledger.")
        || !priorAudioNames.every((name) => firstRewrite.includes(`![[${name}]]`) && firstRewrite.includes(`[[${name}|00:00]]`))
        || firstRewrite.indexOf(`![[${priorAudioNames[0]}]]`) > firstRewrite.indexOf(`![[${priorAudioNames[1]}]]`)
        || firstRewrite !== secondRewrite) {
        throw new Error("continuation materials or transcript changed during repeated rewrite");
      }

      const retryFile = new TFile(literalRetryPath);
      const retrySegment = transcriptSegment(0, "Retry smoke transcript ledger.", 0, 1000, "literal-retry");
      const failMark = "_[Merge failed (queued for retry): temporary]_";
      retryFile._content = [
        "---\nqnalog_mode: meeting\n---",
        "# Retry smoke note",
        "KEEP BEFORE",
        failMark,
        "KEEP AFTER",
        serializeTranscriptSegment(retrySegment),
      ].join("\n\n");
      files.set(literalRetryPath, retryFile);
      plugin.settings.consolidatedLayout = false;
      plugin.settings.autoRenameWithTitle = false;
      literalMergeSmokeBody = `\n\nRETRY LITERAL ${special}\nUnicode：保留原文`;
      await plugin.queueRetry.retryMergeTask({
        id: "literal-merge-retry",
        mdPath: literalRetryPath,
        mode: "meeting",
        source: "recording",
        createdAt: "2026-09-14T12:00:00.000Z",
        segments: [retrySegment],
        sessionMeta: { startedAt: "2026-09-14T12:00:00.000Z" },
      });
      const retryResult = retryFile._content;
      if (retryResult.includes(failMark)
        || !retryResult.includes(`RETRY LITERAL ${special}\nUnicode：保留原文`)
        || !retryResult.includes("KEEP BEFORE")
        || !retryResult.includes("KEEP AFTER")
        || !retryResult.includes("Retry smoke transcript ledger.")) {
        throw new Error("merge retry did not preserve model text, surrounding content, and transcript");
      }
      const polishLiteralBody = "模型正文\n$& $` $' $$";
      const polishFolded = [
        "<!--QNALOG_SEDIMENT_BEGIN-->",
        "<details>",
        "<summary>Fixture data</summary>",
        "",
        "```json",
        '{"people":[],"todos":[],"hotwords":{}}',
        "```",
        "",
        "</details>",
        "<!--QNALOG_SEDIMENT_END-->",
      ].join("\n");
      const polishLegacy = "<!--QNALOG_SEDIMENT_BEGIN\n{\"people\":[]}\nQNALOG_SEDIMENT_END-->";
      const polishFallback = "> [!warning] AI 整理未完成\n> 未获得可用的整理正文；原始转写仍保留在当前笔记中，可以稍后从处理进度中重试。";
      const polishCases = [
        { input: "", frontmatter: "", body: polishFallback, block: "" },
        { input: " \r\n\t ", frontmatter: "", body: polishFallback, block: "" },
        { input: "---\r\ntitle: only\r\n---\r\n\r\n", frontmatter: "---\ntitle: only\n---", body: polishFallback, block: "" },
        { input: "\uFEFF---\r\ntitle: literal\r\n---\r\n\r\n  " + polishLiteralBody + " \r\n\r\n" + polishFolded + "\n", frontmatter: "---\ntitle: literal\n---", body: polishLiteralBody, block: polishFolded },
        { input: polishFolded, frontmatter: "", body: polishFallback, block: polishFolded },
        { input: polishLiteralBody + "\n\n" + polishLegacy, frontmatter: "", body: polishLiteralBody, block: polishLegacy },
        { input: "prefix\n---\ntitle: not-leading\n---\nbody", frontmatter: "", body: "prefix\n---\ntitle: not-leading\n---\nbody", block: "" },
        { input: polishLiteralBody + "\n<!--QNALOG_SEDIMENT_BEGIN\nincomplete", frontmatter: "", body: polishLiteralBody + "\n<!--QNALOG_SEDIMENT_BEGIN\nincomplete", block: "" },
      ];
      const polishSession = {
        id: "literal-retry",
        sessionStamp: "literal-retry",
        startedAt: "2026-09-14T12:00:00.000Z",
        mdPath: literalRetryPath,
        mode: "meeting",
        source: "recording",
        segments: [retrySegment],
        finalized: true,
        multiSourceAudio: true,
      };
      const polishOriginal = [
        "---\ntitle: old\n---",
        "# Existing note",
        serializeTranscriptSegment(retrySegment),
      ].join("\n\n");
      const polishRewriteResults = [];
      const polishAppendResults = [];
      for (const entry of polishCases) {
        retryFile._content = polishOriginal;
        await plugin.noteWriter.rewriteConsolidated(polishSession, entry.input);
        const rewritten = retryFile._content;
        const rewriteFrontmatter = rewritten.match(/^---\n[\s\S]*?\n---/)?.[0] || "";
        const originalHeading = "\n\n---\n\n## ";
        if (rewriteFrontmatter !== entry.frontmatter
          || !rewritten.includes(entry.body)
          || rewritten.indexOf(entry.body) > rewritten.indexOf(originalHeading)
          || (entry.block && rewritten.split(entry.block).length - 1 !== 1)) {
          throw new Error("rewrite polish body, frontmatter, or sediment boundary changed");
        }
        if (entry === polishCases[3]) {
          await plugin.noteWriter.rewriteConsolidated(polishSession, entry.input);
          if (retryFile._content !== rewritten) throw new Error("repeated polish rewrite changed output");
        }
        polishRewriteResults.push(rewritten);

        retryFile._content = polishOriginal;
        await plugin.noteWriter.appendPolishBlock(polishSession, entry.input, null, false, "", polishOriginal);
        const appended = retryFile._content;
        const appendFrontmatter = appended.match(/^---\n[\s\S]*?\n---/)?.[0] || "";
        if (appendFrontmatter !== (entry.frontmatter || "---\ntitle: old\n---")
          || !appended.includes(entry.body)
          || appended.indexOf(entry.body) < appended.indexOf("\n## ")
          || (entry.block && appended.split(entry.block).length - 1 !== 1)) {
          throw new Error("append polish body, frontmatter, or sediment boundary changed");
        }
        polishAppendResults.push(appended);
      }
      retryFile._content = polishOriginal;
      await plugin.noteWriter.appendPolishBlock(polishSession, polishCases[3].input, new Error("temporary failure"), false, "", polishOriginal);
      const failedPolishAppend = retryFile._content;
      if (!failedPolishAppend.startsWith("---\ntitle: old\n---")
        || !failedPolishAppend.includes("temporary failure")
        || failedPolishAppend.includes(polishLiteralBody)
        || failedPolishAppend.split(polishFolded).length - 1 !== 1) {
        throw new Error("failed append changed old frontmatter or lost fallback, transcript, or sediment");
      }
      polishAppendResults.push(failedPolishAppend);
      const polishMaterialsDigest = createHash("sha256")
        .update(JSON.stringify([...polishRewriteResults, ...polishAppendResults]))
        .digest("hex");
      console.log(`[polish-materials] rewrite/append digest: ${polishMaterialsDigest}`);
      const textMaterialsPath = literalRetryPath;
      const textMaterialOriginal = "---\ntitle: old\n---\n\n# Existing note\n";
      const textMaterialModelOutput = "---\ntitle: new\n---\n\n模型正文 $& $` $' $$";
      const textMaterialModelBody = "模型正文 $& $` $' $$";
      const firstTextMaterial = transcriptSegment(4, "来源标签：不可作为原文", 0, 1000, "literal-text-materials");
      firstTextMaterial.sourceName = "来源一 $& $` $' $$";
      firstTextMaterial.sourcePath = "Notes/source-one.md";
      firstTextMaterial.rawText = "  原文一\r\n$& $` $' $$  ";
      firstTextMaterial.transcript.revisions[0].rawText = firstTextMaterial.rawText;
      firstTextMaterial.transcript.revisions[0].displayText = firstTextMaterial.rawText;
      firstTextMaterial.transcript.revisions[0].utterances[0].rawText = firstTextMaterial.rawText;
      firstTextMaterial.transcript.revisions[0].utterances[0].normalizedText = firstTextMaterial.rawText;
      const textMaterialSegments = [
        firstTextMaterial,
        {
          ...transcriptSegment(9, "第二份原文 $& $` $' $$", 1000, 2000, "literal-text-materials"),
          sourcePath: "Notes/source-two.md",
        },
        { ...transcriptSegment(12, "EMPTY RAW MUST NOT DISPLAY", 2000, 3000, "literal-text-materials"), rawText: "" },
        { ...transcriptSegment(20, "WHITESPACE RAW MUST NOT DISPLAY", 3000, 4000, "literal-text-materials"), sourceName: "空白来源", rawText: " \r\n\t " },
      ];
      for (const segment of textMaterialSegments.slice(1)) delete segment.transcript;
      const textMaterialSession = {
        id: "literal-text-materials",
        sessionStamp: "literal-text-materials",
        startedAt: "2026-09-14T12:00:00.000Z",
        mdPath: textMaterialsPath,
        mode: "meeting",
        source: "text-import",
        segments: textMaterialSegments,
        finalized: true,
      };
      const textMaterialHeadings = [
        "### 1. [[Notes/source-one.md|来源一 $& $` $' $$]]",
        "### 2. [[Notes/source-two.md|文本 2]]",
        "### 3. 文本 3",
        "### 4. 空白来源",
      ];
      const expectedTextMaterial = [
        "  原文一\r\n$& $` $' $$  ",
        "第二份原文 $& $` $' $$",
        "",
        " \r\n\t ",
      ];
      const readTextMaterialLedger = (markdown, id) => {
        const marker = `<!-- qnalog-transcript-data `;
        const startMarker = `<!-- qnalog-transcript-text-start:${id} -->`;
        const endMarker = `<!-- qnalog-transcript-text-end:${id} -->`;
        const blockEndMarker = `<!-- qnalog-transcript-end:${id} -->`;
        const start = markdown.indexOf(startMarker);
        const end = markdown.indexOf(endMarker, start);
        const blockEnd = markdown.indexOf(blockEndMarker, end);
        const dataAt = markdown.indexOf(marker, end);
        if (start < 0 || end < 0 || blockEnd < 0 || dataAt < end || dataAt >= blockEnd) {
          throw new Error(`missing text-import transcript block ${id}`);
        }
        const visible = markdown.slice(start + startMarker.length + 1, end).replace(/\n$/, "");
        const jsonStart = dataAt + marker.length;
        const jsonEnd = markdown.indexOf(" -->", jsonStart);
        const data = JSON.parse(markdown.slice(jsonStart, jsonEnd));
        const transcript = data.transcript;
        const revision = transcript.revisions.find((item) => item.revision === transcript.currentRevision);
        return { visible, transcript, rawText: revision?.rawText };
      };
      const checkTextMaterials = (markdown, allowFailure) => {
        const summaries = [
          "<summary>导入文本原文（4 个来源）</summary>",
          "<summary>Imported text (4 sources)</summary>",
        ];
        const summary = summaries.find((candidate) => markdown.includes(candidate));
        if (!summary
          || markdown.indexOf(textMaterialModelBody) >= markdown.indexOf(textMaterialHeadings[0])
          || !textMaterialHeadings.every((heading, index) => markdown.indexOf(heading) >= 0
            && (index === 0 || markdown.indexOf(textMaterialHeadings[index - 1]) < markdown.indexOf(heading)))) {
          throw new Error("text-import source summary or heading order changed");
        }
        const allIds = [4, 9, 12, 20].map((segmentIndex) => `seg:literal-text-materials:${segmentIndex}`);
        const detailsAt = markdown.lastIndexOf("<details>", markdown.indexOf(summary));
        const contentAt = allowFailure ? markdown.indexOf("temporary failure") : markdown.indexOf(textMaterialModelBody);
        if (detailsAt < 0 || contentAt < 0 || contentAt >= detailsAt) {
          throw new Error("text-import materials were placed before their success or failure content");
        }
        if (markdown.split("<!-- qnalog-transcript-data ").length - 1 !== 4) {
          throw new Error("text-import transcript-data marker count changed");
        }
        for (const id of allIds) {
          if (markdown.split(`<!-- qnalog-transcript-start:${id} -->`).length - 1 !== 1
            || markdown.split(`<!-- qnalog-transcript-end:${id} -->`).length - 1 !== 1
            || markdown.split(`<!-- qnalog-transcript-text-start:${id} -->`).length - 1 !== 1
            || markdown.split(`<!-- qnalog-transcript-text-end:${id} -->`).length - 1 !== 1) {
            throw new Error(`text-import transcript markers changed for ${id}`);
          }
        }
        for (const [index, segmentIndex] of [4, 9, 12, 20].entries()) {
          const id = `seg:literal-text-materials:${segmentIndex}`;
          const block = readTextMaterialLedger(markdown, id);
          const emptyText = summary === summaries[0] ? "_[此文本来源为空]_" : "_[This text source is empty]_";
          if (block.transcript.id !== id
            || block.transcript.sourceId !== "literal-text-materials"
            || block.transcript.currentRevision !== 1
            || block.rawText !== expectedTextMaterial[index]
            || block.visible !== (index === 2 ? emptyText : expectedTextMaterial[index])) {
            throw new Error(`text-import source ledger changed at index ${index + 1}`);
          }
        }
        if (!markdown.includes(textMaterialModelBody) && !allowFailure) {
          throw new Error("text-import success output lost model body");
        }
        if (allowFailure && (!markdown.startsWith("---\ntitle: old\n---")
          || (!markdown.includes("合并润色失败（已加入重试队列）：temporary failure")
            && !markdown.includes("Merge failed (queued for retry): temporary failure"))
          || markdown.includes(textMaterialModelBody))) {
          throw new Error("text-import failed append lost old frontmatter or queued failure placeholder");
        }
        if (markdown.includes("![[qnalog-literal-text-materials-")
          || markdown.includes("qnalog-transcribe-task:")
          || markdown.includes("qnalog-segments-start:literal-text-materials")) {
          throw new Error("text-import source details acquired recording-only material");
        }
      };
      const textMaterialRewriteResults = [];
      const textMaterialAppendResults = [];
      retryFile._content = textMaterialOriginal;
      await plugin.noteWriter.rewriteConsolidated(textMaterialSession, textMaterialModelOutput);
      const textMaterialRewrite = retryFile._content;
      checkTextMaterials(textMaterialRewrite, false);
      await plugin.noteWriter.rewriteConsolidated(textMaterialSession, textMaterialModelOutput);
      if (retryFile._content !== textMaterialRewrite) throw new Error("text-import rewrite was not byte-stable");
      textMaterialRewriteResults.push(textMaterialRewrite);
      retryFile._content = textMaterialOriginal;
      await plugin.noteWriter.appendPolishBlock(textMaterialSession, textMaterialModelOutput, null, false, "", textMaterialOriginal);
      const textMaterialAppend = retryFile._content;
      checkTextMaterials(textMaterialAppend, false);
      textMaterialAppendResults.push(textMaterialAppend);
      retryFile._content = textMaterialOriginal;
      await plugin.noteWriter.appendPolishBlock(textMaterialSession, textMaterialModelOutput, new Error("temporary failure"), false, "", textMaterialOriginal);
      const textMaterialFailedAppend = retryFile._content;
      checkTextMaterials(textMaterialFailedAppend, true);
      textMaterialAppendResults.push(textMaterialFailedAppend);
      const textImportMaterialsDigest = createHash("sha256")
        .update(JSON.stringify([...textMaterialRewriteResults, ...textMaterialAppendResults]))
        .digest("hex");
      console.log(`[text-import-materials] rewrite/append digest: ${textImportMaterialsDigest}`);
      const infoMomentBefore = sandbox.moment;
      const infoSourcesBefore = textMaterialSession.textImportSources;
      const infoSegmentsBefore = textMaterialSession.segments;
      const infoModelOutput = "---\ntitle: info\n---\n\nINFO BODY $& $` $' $$";
      const infoBody = "INFO BODY $& $` $' $$";
      const infoSources = [
        { name: "来源一 $& $` $' $$", path: "Notes/one.md", chars: 11 },
        { path: "Notes/two.md" },
        { name: "无路径来源 $& $` $' $$" },
        {},
      ];
      const infoFixtures = [
        {
          kind: "recording", session: polishSession, original: polishOriginal,
          expected: [
            "<details>", "<summary>录音信息</summary>", "", "- 时间：2026-09-14", "- 时长：00:01",
            "- 模式：工作纪要", "- 分段：1", "- 模型：stub-model", "", "</details>",
          ].join("\n"),
        },
        {
          kind: "sources", session: textMaterialSession, original: textMaterialOriginal, sourceFiles: infoSources,
          expected: [
            "<details>", "<summary>导入文本信息</summary>", "", "- 时间：2026-09-14", "- 模式：工作纪要",
            "- 来源文件：4", "- 模型：stub-model", "", "来源：",
            "- [[Notes/one.md|来源一 $& $` $' $$]]", "- [[Notes/two.md|two.md]]",
            "- 无路径来源 $& $` $' $$", "- 未命名文本", "", "</details>",
          ].join("\n"),
        },
        {
          kind: "no-sources", session: textMaterialSession, original: textMaterialOriginal, sourceFiles: undefined,
          expected: [
            "<details>", "<summary>导入文本信息</summary>", "", "- 时间：2026-09-14", "- 模式：工作纪要",
            "- 来源文件：4", "- 模型：stub-model", "", "</details>",
          ].join("\n"),
        },
        {
          kind: "empty", session: textMaterialSession, original: textMaterialOriginal, sourceFiles: [], segments: [],
          expected: [
            "<details>", "<summary>导入文本信息</summary>", "", "- 时间：2026-09-14", "- 模式：工作纪要",
            "- 来源文件：1", "- 模型：stub-model", "", "</details>",
          ].join("\n"),
        },
      ];
      const infoResults = [];
      const infoEnglish = sandbox.moment.locale() !== "zh-cn" && sandbox.moment.locale() !== "zh";
      const localizedInfoFixtures = infoEnglish ? infoFixtures.map((fixture) => ({
        ...fixture,
        expected: fixture.expected
          .replace("<summary>录音信息</summary>", "<summary>Recording info</summary>")
          .replace("<summary>导入文本信息</summary>", "<summary>Imported text info</summary>")
          .replace("- 时间：", "- Time: ").replace("- 时长：", "- Duration: ")
          .replace("- 模式：", "- Mode: ").replace("- 分段：", "- Segments: ")
          .replace("- 模型：", "- Model: ").replace("- 来源文件：", "- Source files: ")
          .replace("\n来源：\n", "\nSource: \n"),
      })) : infoFixtures;
      try {
        plugin.settings.llmModel = "stub-model";
        for (const fixture of localizedInfoFixtures) {
          if (fixture.sourceFiles !== undefined) textMaterialSession.textImportSources = fixture.sourceFiles;
          else if (fixture.kind === "no-sources") delete textMaterialSession.textImportSources;
          if (fixture.segments) textMaterialSession.segments = fixture.segments;
          const summary = fixture.expected.split("\n")[1];
          const run = async (layout, failed) => {
            retryFile._content = fixture.original;
            if (layout === "rewrite") await plugin.noteWriter.rewriteConsolidated(fixture.session, infoModelOutput);
            else await plugin.noteWriter.appendPolishBlock(
              fixture.session, infoModelOutput, failed ? new Error("info failure") : null, false, "", fixture.original,
            );
            const result = retryFile._content;
            const summaryAt = result.indexOf(summary);
            const detailsAt = result.lastIndexOf("<details>", summaryAt);
            const closeAt = result.indexOf("</details>", summaryAt);
            if (summaryAt < 0 || detailsAt < 0 || closeAt < summaryAt
              || result.split(summary).length - 1 !== 1
              || result.slice(detailsAt, closeAt + "</details>".length) !== fixture.expected) {
              throw new Error(`${fixture.kind} ${layout} info block differed from its explicit expected text`);
            }
            const contentAt = failed ? result.indexOf("info failure") : result.indexOf(infoBody);
            if (contentAt < 0 || contentAt >= detailsAt
              || (failed && (result.includes(infoBody) || !result.startsWith("---\ntitle: old\n---")))) {
              throw new Error(`${fixture.kind} ${layout} moved info materials before its success or failure content`);
            }
            if (fixture.kind === "recording"
              && readTextMaterialLedger(result, "seg:literal-retry:0").rawText !== "Retry smoke transcript ledger.") {
              throw new Error("recording info fixture lost its existing transcript ledger");
            }
            if (fixture.kind === "sources") {
              for (const id of ["seg:literal-text-materials:4", "seg:literal-text-materials:9", "seg:literal-text-materials:12", "seg:literal-text-materials:20"]) {
                if (result.split(`<!-- qnalog-transcript-start:${id} -->`).length - 1 !== 1
                  || !result.includes(`<!-- qnalog-transcript-data `)) {
                  throw new Error(`text-import info fixture lost transcript ledger ${id}`);
                }
              }
              if (!result.includes("原文一") || !result.includes("第二份原文")) {
                throw new Error("text-import info fixture changed source transcript text");
              }
            }
            return result;
          };
          const rewritten = await run("rewrite", false);
          if (await run("rewrite", false) !== rewritten) throw new Error(`${fixture.kind} rewrite was not byte-stable`);
          infoResults.push(rewritten);
          infoResults.push(await run("append", false));
          infoResults.push(await run("failed append", true));
        }
        const infoDigest = createHash("sha256").update(JSON.stringify(infoResults)).digest("hex");
        console.log(`[note-info-materials] rewrite/append digest: ${infoDigest}`);
        for (const session of [polishSession, textMaterialSession]) {
          retryFile._content = session === polishSession ? polishOriginal : textMaterialOriginal;
          const originalContent = retryFile._content;
          if (session === textMaterialSession) textMaterialSession.textImportSources = infoSources;
          sandbox.moment = undefined;
          await plugin.noteWriter.appendPolishBlock(session, infoModelOutput, null, false, "", originalContent);
          const missingMomentResult = retryFile._content;
          const missingSummary = session === polishSession ? "<summary>录音信息</summary>" : "<summary>导入文本信息</summary>";
          const missingInfoAt = missingMomentResult.indexOf(missingSummary);
          const missingInfo = missingMomentResult.slice(missingMomentResult.lastIndexOf("<details>", missingInfoAt));
          if (!missingInfo.includes("stub-model") || /(?:Time: |时间：)/.test(missingInfo)) {
            throw new Error("missing moment did not omit only the info timestamp");
          }
          sandbox.moment = () => ({ format: () => { throw new Error("info format failed"); } });
          retryFile._content = originalContent;
          let formatFailure;
          try {
            await plugin.noteWriter.appendPolishBlock(session, infoModelOutput, null, false, "", originalContent);
          } catch (error) { formatFailure = error; }
          if (formatFailure?.message !== "info format failed" || retryFile._content !== originalContent) {
            throw new Error("info timestamp formatting failure did not preserve the original note");
          }
        }
      } finally {
        sandbox.moment = infoMomentBefore;
        textMaterialSession.segments = infoSegmentsBefore;
        if (infoSourcesBefore === undefined) delete textMaterialSession.textImportSources;
        else textMaterialSession.textImportSources = infoSourcesBefore;
      }
      literalSmokePassed = true;
    } catch (error) {
      failures.push(`字面量材料保全冒烟失败：${(error && error.message) || error}`);
    } finally {
      literalMergeSmokeBody = "";
      if (literalSmokeSettingsBefore) Object.assign(plugin.settings, literalSmokeSettingsBefore);
      if (literalSmokeFilesBefore) {
        for (const [path, file, content] of literalSmokeFilesBefore) {
          if (file) {
            file._content = content;
            files.set(path, file);
          } else {
            files.delete(path);
          }
        }
      }
      if (literalSmokeAdapterBefore) {
        adapterData.clear();
        for (const [path, content] of literalSmokeAdapterBefore) adapterData.set(path, content);
      }
      if (literalSmokeFrontmatterBefore) {
        frontmatterByPath.clear();
        for (const [path, metadata] of literalSmokeFrontmatterBefore) frontmatterByPath.set(path, metadata);
      }
    }
    if (literalSmokePassed) {
      console.log("[literal-note-content] OK: continuation materials and merge retry preserve literal text and transcript");
    }
    for (const id of plugin.intervals) clearInterval(id);
  } finally {
    Date.now = realDateNow;
    console.error = realError;
  }

  const stray = errorLog.filter((line) => !/update check failed/.test(line));
  for (const line of stray) failures.push(`运行期报错：${line.split("\n")[0]}`);
  smokeDigest = createHash("sha256")
    .update(JSON.stringify({ note: noteFile._content || "", adapterData: [...adapterData].sort(([left], [right]) => left.localeCompare(right)) }))
    .digest("hex");

  if (failures.length) {
    console.error("[merge-pipeline] 检查失败：");
    for (const failure of failures) console.error("  " + failure);
    return 1;
  }
  console.log(`[merge-pipeline] OK: 会话收尾到合并整理跑通，模型调用 ${llmCalls.length} 次（知识随 ${llmCalls.filter((request) => requestPrompt(request).includes("机器证据协议")).length} 个既有请求返回），笔记保留正文、证据与原始转写`);
  console.log(`[merge-pipeline] ${appendLayout ? "append" : "rewrite"} digest: ${smokeDigest}`);
  if (rawSegmentMaterialsDigest) {
    console.log(`[raw-segment-materials] rewrite digest: ${rawSegmentMaterialsDigest}`);
  }
  return 0;
}

const failed = await main();
process.exitCode = failed;
process.stdout.write("", () => process.exit(failed));
