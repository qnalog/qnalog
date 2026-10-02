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
    read: async (f) => f._content || "",
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
    getLeavesOfType: () => [], getLeaf: () => ({ openFile: async () => undefined, view: null }),
    iterateAllLeaves: noop,
  },
  metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => null, on: () => ({}) },
  fileManager: {
    renameFile: async () => undefined,
    trashFile: async (file) => { files.delete(file.path); },
  },
  internalPlugins: { getPluginById: () => null, plugins: {} },
};

let failContinuationCommit = false;
let gateNextLlmRequest = false;
let releaseGatedLlmRequest = null;

// 桩 LLM：从实际请求中的来源标题读取允许的证据 ID，只返回一个分部回复。
const llmCalls = [];
function requestPrompt(request) {
  try {
    const body = JSON.parse(request?.body || "{}");
    return (body.messages || []).map((message) => String(message.content || "")).join("\n");
  } catch { return ""; }
}
function makeLlmReply(request) {
  const prompt = requestPrompt(request);
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
        content: `## 议题\n\n上线范围已确定，先做内部灰度。\n\n## 结论\n\n内部灰度后按反馈扩大。\n\n<!-- qnalog-session-knowledge ${protocol} -->`,
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
      plugin.settings.enableRealtimeOutline = true;
      continuationPreparation.continuation.realtimeOutline = appendedLiveOutline;
      for (const segment of addedSegments) {
        continuationPreparation.stageFile._content += `\n${serializeTranscriptSegment(segment)}\n`;
      }
      const task = await plugin.queue.add({
        id: continuationPreparation.taskId,
        type: "merge",
        sessionId: continuationId,
        mdPath: continuationPreparation.stageFile.path,
        temporarySourcePath: continuationPreparation.stageFile.path,
        mode: continuationPreparation.mode,
        segments: addedSegments,
        continuation: continuationPreparation.continuation,
        sessionMeta: { startedAt: continuationTime, duration: "00:12" },
        status: "pending",
        retries: 0,
        dependsOnSessionIds: [],
      });
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
  return 0;
}

const failed = await main();
process.exitCode = failed;
process.stdout.write("", () => process.exit(failed));
