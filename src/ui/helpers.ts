/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。
import * as obsidian from "obsidian";
import { t } from '../shared/i18n';
import { getDesktopModule } from "../shared/desktop-runtime";
export {
  QNALOG_UPDATE_REPO_URL,
  QNALOG_UPDATE_BRANCH,
  QNALOG_UPDATE_PLUGIN_DIR,
  QNALOG_UPDATE_RAW_BASE_URL,
  parseGithubRepoUrl,
  trimSlashes,
  resolveUpdateRawBase,
  resolveUpdateRawBases,
  pluginBasePath,
} from "../update-source";
import { VIRTUAL_CABLE_PATTERNS } from '../shared/catalog-import';
import { normalizeKnowledgeExtractionHistory } from '../shared/util-knowledge';
import { NS_SEGMENTS_START_RE, NS_SESSION_RE } from "../shared/namespace";

export const SUPPORTED_AUDIO_INPUT_MODES = new Set(["mic", "mix-virtual", "virtualCable"]);

export function stripFrontmatterSimple(text) {
  return String(text || "").replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function stripArchivedDetailsBlocks(text) {
  let s = String(text || "");
  // \u53CD\u590D\u6D88\u6700\u5185\u5C42 details\uFF0C\u907F\u514D\u5D4C\u5957\uFF08"\u4E0A\u4E00\u7248\u7EAA\u8981" \u91CC\u5D4C\u53E6\u4E00\u4E2A "\u4E0A\u4E00\u7248\u7EAA\u8981"\uFF09\u6F0F\u5265
  for (let i = 0; i < 16; i++) {
    const next = s.replace(/<details\b[^>]*>(?:(?!<details\b)[\s\S])*?<\/details>/gi, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

export function normalizeRecentNoteMeaningfulText(text) {
  return String(text || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/^#\s+.*$/gm, "")
    .replace(/^>\s*\[![^\]]+\].*$/gm, "")
    .replace(/^\s*(开始|时间|时长|模式|分段|模型|状态)[:：].*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function noteHasSuccessfulLlmBriefing(content) {
  const fullText = String(content || "");
  // 关键：先剥掉历史归档 <details>，只看当前可见正文。
  // 否则"重新整理"成功后，旧版本里的失败标记会让本函数永远 false → 警告永远不消。
  const text = stripArchivedDetailsBlocks(fullText);

  // 新格式（v3 之后）：## ✨ 当前纪要（…）
  const currentMatch = text.match(/(?:^|\n)##\s+(?:✨\s*)?当前纪要[^\n]*\n+([\s\S]*?)(?:\n---|\n##\s|$)/);
  if (currentMatch) {
    const body = currentMatch[1] || "";
    const meaningful = normalizeRecentNoteMeaningfulText(body);
    if (meaningful.length > 60 && !/合并润色失败|AI 整理失败|_\[无输出\]_|_\[转写失败/.test(body)) return true;
  }

  const rawMatch = /\n##\s+(?:📁\s*)?原始材料/.exec(text);
  if (rawMatch) {
    const beforeRaw = stripFrontmatterSimple(text.slice(0, rawMatch.index));
    const meaningful = normalizeRecentNoteMeaningfulText(beforeRaw);
    if (meaningful.length > 60 && !/合并润色失败|AI 整理失败|_\[无输出\]_/.test(beforeRaw)) return true;
  }

  const mergeMatch = text.match(/(?:^|\n)##\s+(?:✨\s*)?整合版[^\n]*\n+([\s\S]*?)(?:\n---|\n##\s|$)/);
  if (mergeMatch) {
    const body = mergeMatch[1] || "";
    const meaningful = normalizeRecentNoteMeaningfulText(body);
    if (meaningful.length > 40 && !/合并润色失败|AI 整理失败|_\[无输出\]_/.test(body)) return true;
  }

  // frontmatter 兜底：状态已整理 且 *当前可见正文里* 没有失败标记
  return /(?:^|\n)(?:status:\s*(?:published|done|completed)|状态:\s*已整理)\s*$/im.test(fullText)
    && !/合并润色失败（已加入重试队列）|AI 整理失败/.test(text);
}

export function noteHasUsableRawTranscriptDespiteFailures(content) {
  const cleaned = String(content || "")
    .replace(/_\[转写失败(?:（已进入重试队列）)?：[^\]]*\]_/g, "")
    .replace(/_\[(?:等待后台转写，音频已保留|此段尚未完成转写，音频已保留)\]_/g, "")
    .replace(/_\[合并润色失败（已加入重试队列）：[^\]]*\]_/g, "")
    .replace(/_\[AI 整理失败：[^\]]*\]_/g, "")
    .replace(/_\[(?:此段暂无有效转写|此段无内容|无输出)\]_/g, "");
  const meaningful = normalizeRecentNoteMeaningfulText(stripFrontmatterSimple(cleaned));
  return meaningful.length > 160 && (NS_SEGMENTS_START_RE.test(content) || /^###\s+段落\s+\d+/m.test(content));
}

export function getRecentNoteProcessingState(content) {
  const fullText = String(content || "");
  if (noteHasSuccessfulLlmBriefing(fullText)) return null;
  // 关键：失败标记的匹配同样要先剥掉 <details> 历史归档，
  // 避免旧版本里的 "_[合并润色失败...]_" 永久把当前纪要标成警告态。
  const visibleText = stripArchivedDetailsBlocks(fullText);
  if (/合并润色失败|AI 整理失败|转写失败|已进入重试队列|等待后台转写|尚未完成转写|转写重试|Transcription failed|transcribe failed/i.test(visibleText)) {
    const hasMergeFailure = /合并润色失败|AI 整理失败/i.test(visibleText);
    if (noteHasUsableRawTranscriptDespiteFailures(visibleText)) {
      return {
        kind: "raw",
        label: hasMergeFailure ? "整理失败" : t("To organize"),
        title: hasMergeFailure
          ? t("AI organization failed; the original transcript can still be re-organized to generate the final notes")
          : t("Some segments in the original transcription failed, but no retryable tasks remain; right-click to reorganize and generate the final summary"),
      };
    }
    return {
      kind: "failed",
      label: t("Transcription failed"),
      title: t("This minutes note still contains transcription or cleanup failure markers"),
    };
  }
  if (NS_SEGMENTS_START_RE.test(visibleText) || /^###\s+段落\s+\d+/m.test(visibleText)) {
    return {
      kind: "raw",
      label: t("To organize"),
      title: t("This minutes note is currently mostly raw segment transcriptions and has no LLM-cleaned version yet"),
    };
  }
  return null;
}

export function getImportMarkerState(content) {
  const text = String(content || "");
  return {
    hasSession: NS_SESSION_RE.test(text),
    hasSegments: NS_SEGMENTS_START_RE.test(text) || /^###\s+段落\s+\d+/m.test(text),
    hasGeneratedBlock: /##\s+(?:✨\s*)?(?:当前纪要|整合版)/.test(text) || /##\s+(?:📁\s*)?原始材料/.test(text),
    hasImportBlock: /<details>\s*<summary>\s*导入文本信息/i.test(text),
  };
}

export function qnalogConfirm(app, title, body, ctaText = t("Confirm")) {
  return new Promise((resolve) => {
    const modal = new obsidian.Modal(app);
    let decided = false;
    const decide = (val) => { if (!decided) { decided = true; resolve(val); } modal.close(); };
    modal.onOpen = () => {
      const { contentEl } = modal;
      contentEl.empty();
      contentEl.createEl("h3", { text: title });
      contentEl.createEl("p", { text: body });
      const actions = contentEl.createDiv({ cls: "modal-button-container" });
      const cancel = actions.createEl("button", { text: t("Cancel"), attr: { type: "button" } });
      const ok = actions.createEl("button", { text: ctaText, cls: "mod-warning", attr: { type: "button" } });
      cancel.onclick = () => decide(false);
      ok.onclick = () => decide(true);
    };
    modal.onClose = () => { if (!decided) { decided = true; resolve(false); } };
    modal.open();
  });
}

export function qnalogPromptText(app, title, placeholder, initialValue) {
  return new Promise((resolve) => {
    const modal = new obsidian.Modal(app);
    let settled = false;
    const done = (value) => { if (settled) return; settled = true; resolve(value); modal.close(); };
    modal.onOpen = () => {
      const { contentEl } = modal;
      contentEl.empty();
      contentEl.createEl("h3", { text: title || t("Input") });
      const input = contentEl.createEl("input", { attr: { type: "text", placeholder: placeholder || "" } });
      input.setCssStyles({ width: "100%", marginBottom: "12px" });
      if (initialValue) input.value = String(initialValue);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); done(input.value); }
        else if (e.key === "Escape") { e.preventDefault(); done(null); }
      });
      const actions = contentEl.createDiv({ cls: "qnalog-modal-actions" });
      const cancel = actions.createEl("button", { text: t("Cancel") });
      cancel.onclick = () => done(null);
      const ok = actions.createEl("button", { text: t("OK"), cls: "mod-cta" });
      ok.onclick = () => done(input.value);
      window.setTimeout(() => input.focus(), 30);
    };
    modal.onClose = () => { if (!settled) { settled = true; resolve(null); } };
    modal.open();
  });
}

export function openPickListModal(app, title, items, onPick) {
  const modal = new obsidian.Modal(app);
  modal.onOpen = () => {
    const { contentEl } = modal;
    contentEl.empty();
    contentEl.createEl("h3", { text: title });
    const search = contentEl.createEl("input", { cls: "qnalog-pick-search", attr: { type: "text", placeholder: t("AI answer") } });
    const listEl = contentEl.createDiv({ cls: "qnalog-pick-list" });
    const render = (filter) => {
      listEl.empty();
      const f = String(filter || "").toLowerCase();
      const shown = items.filter(x => !f || x.toLowerCase().includes(f)).slice(0, 300);
      if (!shown.length) { listEl.createDiv({ cls: "qnalog-pick-empty", text: t("No matches") }); return; }
      for (const id of shown) {
        const row = listEl.createEl("button", { cls: "qnalog-pick-item", text: id, attr: { type: "button" } });
        row.onclick = () => { modal.close(); onPick(id); };
      }
    };
    render("");
    search.addEventListener("input", () => render(search.value));
    window.setTimeout(() => search.focus(), 30);
  };
  modal.open();
}

export function openExternalUrl(url) {
  // 桌面端优先走 Electron shell.openExternal —— 强制用系统默认浏览器，
  // 避免在 Obsidian 内嵌 webview 打开外部链接。
  try {
    const electron = getDesktopModule<{
      shell?: { openExternal?: (target: string) => void };
    }>("electron");
    if (electron && electron.shell && typeof electron.shell.openExternal === "function") {
      electron.shell.openExternal(url);
      return;
    }
  } catch { /* intentionally empty */ }
  try { window.open(url, "_blank"); } catch (e) { console.warn("[QnALog] open url failed", e); }
}

/**
 * 读取音频设备。
 *
 * 默认**只列设备，不申请权限**：`enumerateDevices()` 不需要授权就能返回设备
 * 与 `deviceId`，只有设备名（label）需要授权。因此「能不能用」这类判断不该
 * 顺带弹一次授权框——只看状态却弹出麦克风授权请求，用户会以为插件在录音。
 *
 * 只有用户主动点下的动作（「检测」「自动配置」）才传 `requestPermission: true`：
 * 那时弹出授权是用户预期的。
 *
 * `permissionRequired` 的判据是「输入设备的名称读不到」，这比「刚才探测失败」
 * 更贴近它真正要表达的事实：设备列表可能拿到了、但名字是空的。
 */
export async function enumerateAudioDevices(options?: { requestPermission?: boolean }) {
  const requestPermission = !!(options && options.requestPermission);
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    return { all: [], mics: [], virtualCables: [], outputs: [], permissionRequired: true };
  }
  if (requestPermission) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch {
      // 授权被拒或没有可用设备。下面照样列设备：拿得到多少就显示多少，
      // 不因为一次探测失败就把设备列表整个丢掉。
    }
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = [], virtualCables = [], outputs = [];
  for (const d of devices) {
    if (d.kind === "audioinput") {
      if (isVirtualCableLabel(d.label)) virtualCables.push(d);
      else mics.push(d);
    } else if (d.kind === "audiooutput") {
      outputs.push(d);
    }
  }
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const permissionRequired = inputs.length > 0 && inputs.every((d) => !d.label);
  return { all: devices, mics, virtualCables, outputs, permissionRequired };
}

export function isVirtualCableLabel(label) {
  if (!label) return false;
  return VIRTUAL_CABLE_PATTERNS.some((p) => p.test(label));
}

export async function trashVaultFileRef(app, file) {
  if (app.vault && typeof app.vault.trash === "function") {
    await app.vault.trash(file, true);
  } else {
    await app.fileManager.trashFile(file);
  }
}

export function normalizeAudioInputMode(mode) {
  if (mode === "mix") return "mix-virtual";
  if (mode === "system") return "virtualCable";
  return SUPPORTED_AUDIO_INPUT_MODES.has(mode) ? mode : "mic";
}

export function audioInputModeLabel(mode) {
  const labels = {
    mic: t("Microphone only"),
    "mix-virtual": t("Microphone + computer audio"),
    virtualCable: t("Computer audio only"),
  };
  return labels[normalizeAudioInputMode(mode)] || labels.mic;
}

export function classifyImportTextFileForModal(file, content) {
  const text = String(content || "");
  const marker = getImportMarkerState(text);
  const hasSignal = marker.hasSession || marker.hasSegments || marker.hasGeneratedBlock || marker.hasImportBlock;
  if (!hasSignal) {
    return {
      category: "external",
      badge: file && String(file.extension || "").toLowerCase() === "txt" ? "TXT" : t("External transcript"),
      reason: t("Plain text"),
      statusTitle: t("Not a Q&A Log transcript; can be organized directly as a dictation draft"),
    };
  }

  const processingState = getRecentNoteProcessingState(text);
  const successful = noteHasSuccessfulLlmBriefing(text);
  if (successful && !processingState) {
    return {
      category: "qnalog-normal",
      badge: t("Organized"),
      reason: t("Can merge / switch template"),
      statusTitle: "Q&A Log 已整理纪要，可用于多篇合并、换模板重整或转成其他模式",
    };
  }

  const label = processingState && processingState.label
    ? processingState.label
    : (marker.hasSegments ? "待整理" : t("Fragment draft"));
  return {
    category: "qnalog-repair",
    badge: label,
    reason: processingState && processingState.title ? processingState.title : t("Detected Q&A Log markers, but no stable organized body text"),
    statusTitle: processingState && processingState.title ? processingState.title : t("Suitable for re-cleaning or recovering failed transcriptions"),
  };
}

export function makeImportTextCheckboxId(path, index) {
  const source = String(path || "");
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `qnalog-import-text-${Math.max(0, Number(index) || 0)}-${(hash >>> 0).toString(36)}`;
}

export function countKnowledgeExtractionHistory(settings, kind) {
  const history = normalizeKnowledgeExtractionHistory(settings && settings.knowledgeExtractionHistory);
  return Object.keys((history && history[kind]) || {}).length;
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */

/** 设备对象的形状。enumerateDevices() 在 @ts-nocheck 区域里被读成动态类型，这里显式声明。 */
export interface AudioDeviceLike {
  kind?: string;
  deviceId?: string;
  label?: string;
}

/**
 * 把音频输入设备分类，供「麦克风」与「电脑音频」两个下拉共用同一套判据。
 *
 * 只负责如实归类，**不做任何自动选择**：判错一只设备会让录音录到错误的声音，
 * 而用户从界面上看不出来。选哪一只始终由用户决定。
 *
 * `dongles` 是除系统默认项以外的全部输入设备（含虚拟声卡，不隐藏）：
 * 用户的虚拟声卡名字可能不在关键词表里，隐藏他反而没法选。
 * `selectedInput` 是当前显式选定那一只（可能为空）。
 */
export function classifyAudioInputDevices(devices: AudioDeviceLike[] | null | undefined, selectedId = "") {
  const inputs = (devices || []).filter((d) => !!d && d.kind === "audioinput");
  const selected = String(selectedId || "");
  return {
    selectedInput: selected ? inputs.find((d) => d.deviceId === selected) || null : null,
    // 系统默认那一项（deviceId 为 "default" 或空）由下拉里的空值选项代表，不重复列出。
    dongles: inputs.filter((d) => !isSystemDefaultDeviceId(d.deviceId)),
  };
}

/**
 * 电脑音频下拉该列出哪些设备。
 *
 * 电脑音频要的是虚拟声卡输入，所以正常情况下只列虚拟声卡，不把普通麦克风铺进来。
 * 但一个虚拟声卡都认不出时**退回列出全部输入设备**：关键词只是启发式，
 * 用户的虚拟声卡名字不在表里时若照旧只列虚拟声卡，列表就空了，他反而没得选。
 * 宁可多列几只让他自己认，也不要给他一个空列表。
 */
export function pickComputerAudioDevices(devices: AudioDeviceLike[] | null | undefined) {
  const { dongles } = classifyAudioInputDevices(devices);
  const virtualCables = dongles.filter((d) => isVirtualCableLabel(d.label));
  return { listed: virtualCables.length ? virtualCables : dongles, virtualCables };
}

/** 浏览器约定：deviceId 为 "default" 或空串表示系统默认输入设备。 */
function isSystemDefaultDeviceId(deviceId?: string) {
  const id = String(deviceId || "");
  return id === "default" || id === "";
}

/**
 * 设备名读不到时，该给用户什么提示。
 *
 * `enumerateDevices()` 在未授权时仍会返回设备与 deviceId，只有 label 是空的；
 * 因此「名字为空」不等于「没有设备」。两者处理完全不同：
 * 前者让用户授权或仍可按下拉顺序选，后者才是真的没接设备。
 */
export function describeAudioDeviceAvailability(devices: AudioDeviceLike[] | null | undefined) {
  const inputs = (devices || []).filter((d) => !!d && d.kind === "audioinput");
  if (!inputs.length) return { state: "none", count: 0 };
  const named = inputs.some((d) => !!d.label);
  return { state: named ? "named" : "unnamed", count: inputs.length };
}
