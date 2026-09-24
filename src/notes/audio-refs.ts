/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：音频引用、时间锚与时长计算

import * as obsidian from "obsidian";
import { hashRealtimeOutlineText } from "../outline-text";

import { parseElapsedMsToken, parseDurationLabel } from "../shared/util-text";

import { DEFAULT_SETTINGS } from "../shared/defaults";

import { AUDIO_EXT } from "../shared/catalog-import";

import { formatElapsed, normalizeAudioLinkTarget, safeDecodeUriText } from "../shared/util-common";

export function getAudioTimeLink(audioName, ms) {
  const name = String(audioName || "").trim();
  if (!name) return "";
  return `[[${name}|${formatElapsed(ms || 0)}]]`;
}

export function getSegmentAudioLinkOffsetMs(segment) {
  const local = Number(segment && segment.audioStartOffsetMs);
  if (Number.isFinite(local) && local >= 0) return local;
  return Math.max(0, Number(segment && segment.startOffsetMs) || 0);
}

export function getAudioSegmentListItem(segment, index) {
  if (!segment || !segment.audioName) return "";
  const n = Number.isFinite(segment.index) ? segment.index + 1 : index + 1;
  const start = formatElapsed(segment.startOffsetMs || 0);
  const end = formatElapsed(segment.endOffsetMs || 0);
  const link = getAudioTimeLink(segment.audioName, getSegmentAudioLinkOffsetMs(segment));
  return [
    `#### 段落 ${n}（${start}–${end}）`,
    "",
    `![[${segment.audioName}]]`,
    "",
    `回听：${link}`,
  ].join("\n");
}

export function getSessionMasterAudioName(session) {
  const name = String(session && session.masterAudioName ? session.masterAudioName : "").trim();
  if (name) return name;
  const path = String(session && session.masterAudioPath ? session.masterAudioPath : "").trim();
  return path ? (path.split("/").pop() || path) : "";
}

export function getAudioLinkCandidates(linkPath) {
  const target = normalizeAudioLinkTarget(linkPath);
  const out = [];
  const add = (value) => {
    const v = obsidian.normalizePath(String(value || "").trim());
    if (v && !out.includes(v)) out.push(v);
  };
  add(target);
  add(safeDecodeUriText(target));
  const name = (target.split("/").pop() || target).trim();
  add(name);
  add(safeDecodeUriText(name));
  return out;
}

export function getAudioExtFromLinkPath(linkPath) {
  const target = normalizeAudioLinkTarget(linkPath);
  const base = target.split("/").pop() || target;
  const ext = (base.split(".").pop() || "").toLowerCase();
  return AUDIO_EXT.has(ext) ? ext : "";
}

export function getAudioLinkTarget(linkPath) {
  return normalizeAudioLinkTarget(linkPath);
}

export function extractAudioSegmentOffsets(markdown) {
  const map = new Map();
  const text = String(markdown || "");
  const headingRe = /^###\s+段落\s+\d+\s*\(([^)\n]+?)[–-]([^)\n]+?)\)([^\n]*)$/gm;
  let match;
  while ((match = headingRe.exec(text))) {
    const startOffsetMs = parseElapsedMsToken(match[1]);
    const bodyStart = match.index + match[0].length;
    const nextHeading = text.slice(bodyStart).search(/^###\s+段落\s+\d+/m);
    const bodyEnd = nextHeading >= 0 ? bodyStart + nextHeading : text.length;
    const block = text.slice(bodyStart, bodyEnd);
    const embed = block.match(/!\[\[([^\]]+)\]\]/);
    if (!embed) continue;
    const target = getAudioLinkTarget(embed[1]);
    const name = (target.split("/").pop() || target).trim();
    if (target) map.set(obsidian.normalizePath(target), startOffsetMs);
    if (name) map.set(name, startOffsetMs);
  }
  return map;
}

// ============================================================
// 虚拟声卡识别 · 跨平台 audioinput 设备检测
// ============================================================

// 已移除 pickVirtualCableId / pickRealMicrophoneId：
// 新哲学是"插件不替用户猜设备"——acquireStream 直接透传用户在设置里选的设备（没选则系统默认/明确提示），
// 不再用名字启发式自动挑选。名字启发式（isVirtualCableLabel）仅保留给 UI 软提示，不参与任何选择。

export function getSegmentsHash(segments) {
  const text = (segments || []).map((seg) => [
    Number(seg && seg.startOffsetMs) || 0,
    Number(seg && seg.endOffsetMs) || 0,
    String(seg && seg.text || "").trim(),
  ].join("|")).join("\n");
  return hashRealtimeOutlineText(text);
}

export function isSameVaultPath(a, b) {
  return !!a && !!b && obsidian.normalizePath(a) === obsidian.normalizePath(b);
}

/** 读取音频时长的毫秒数；无法解码或加载失败时返回 0。 */
export function getAudioDurationMs(blob: Blob): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  try {
    const url = URL.createObjectURL(blob);
    // Obsidian 在运行时把 createEl 挂在 Window 上（弹出窗口里要用它创建元素），但 obsidian.d.ts 只声明了
    // 模块级的同名函数，因此这里补一个局部类型。createEl 的返回类型由标签名决定，这里显式写 audio。
    const audio = (activeWindow as Window & {
      createEl: <K extends keyof HTMLElementTagNameMap>(tag: K) => HTMLElementTagNameMap[K];
    }).createEl("audio");
    audio.preload = "metadata";
    const cleanup = () => { try { URL.revokeObjectURL(url); } catch { /* intentionally empty */ } };
    audio.addEventListener("loadedmetadata", () => {
      // 头部无 Duration 的录音（MediaRecorder 边录边写、录音开始时总长未知，不回填该字段）
      // 在这里读到的是 Infinity，按有限值直读会得到 0；改走 probeAudioDurationMs 扫描回填，
      // 探测失败仍返回 0，与旧行为一致。
      void probeAudioDurationMs(audio).then((ms) => { cleanup(); resolve(ms); });
    });
    audio.addEventListener("error", () => { cleanup(); resolve(0); });
    audio.src = url;
  } catch { resolve(0); }
  return promise;
}

/**
 * 读出音频元素已知的总时长（毫秒），供导入计时与回放界面使用。
 *
 * MediaRecorder 录出的 WebM 头部没有 Duration 字段（录音开始时总长未知，录完不回填；
 * ffprobe 对这批文件同样报 duration=N/A），Chromium 因此把 audio.duration 报成 Infinity，
 * 直读会得到 0，播放器的总时长、进度条比例和点击跳转随之全部失效。把播放头推到超出文件
 * 末尾的位置（1e101 秒）会强制解码器扫描到文件结尾并回填真实总长（触发 durationchange，
 * 已在 Chromium 实测：Infinity → 5.396 秒），探测结束后播放头放回原位，失败时也放回原位——
 * 否则停在 1e101，按播放会直接结束。已是有限时长的文件直接返回现值、不动播放头；
 * 超时或元素报错返回 0，与探测前的读数一致，调用方按「读不到时长」处理。
 */
export function probeAudioDurationMs(audio: HTMLAudioElement, timeoutMs = 4000): Promise<number> {
  const readMs = () => {
    const d = audio.duration;
    return Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : 0;
  };
  const immediate = readMs();
  if (immediate > 0) return Promise.resolve(immediate);
  const { promise, resolve } = Promise.withResolvers<number>();
  const resumeTo = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  let settled = false;
  let timer = 0;
  const finish = () => {
    if (settled) return;
    settled = true;
    audio.removeEventListener("durationchange", onDurationChange);
    audio.removeEventListener("error", onError);
    window.clearTimeout(timer);
    const ms = readMs();
    // 播放头被推到了超远位置，必须放回原位——否则停在 1e101，按播放会直接结束。
    try { audio.currentTime = resumeTo; } catch { /* intentionally empty */ }
    resolve(ms);
  };
  const onDurationChange = () => { if (readMs() > 0) finish(); };
  const onError = () => finish();
  timer = window.setTimeout(finish, timeoutMs);
  audio.addEventListener("durationchange", onDurationChange);
  audio.addEventListener("error", onError);
  // 把播放头推到超出文件末尾的位置，强制解码器扫描到文件尾并回填真实总长（触发 durationchange）。
  try { audio.currentTime = 1e101; } catch { finish(); }
  return promise;
}

// 确定性 ASR 错误：格式不被服务端接受 / 本机无法解码 / 超过体积上限 / 4xx 拒绝（密钥、余额、审核）——
// 重试同样必败，还会对大文件反复解码卡 UI、对服务端反复发必拒请求。队列对这类失败直接吃满重试退出自动重试。
// 旗标 nonRetryable 由抛错处设置（chatInputAudioPermanentError / HTTP 4xx 分支）；正则兜底匹配已落盘任务的 lastError。

export function getDurationMs(markdown) {
  const text = String(markdown || "");
  let maxMs = 0;
  let sawDuration = false;
  const segmentHeadingRe = /^###\s+段落\s+\d+\s*\(([^)\n]+?)[–-]([^)\n]+?)\)/gm;
  let match;
  while ((match = segmentHeadingRe.exec(text))) {
    sawDuration = true;
    maxMs = Math.max(maxMs, parseDurationLabel(match[2]));
  }
  if (sawDuration) return maxMs;

  const durationRe = /(?:时长|共)\s*[：:]?\s*(\d{1,3}:\d{2}(?::\d{2})?|\d+(?:\.\d+)?\s*(?:秒|分钟))/g;
  while ((match = durationRe.exec(text))) {
    const ms = parseDurationLabel(match[1]);
    if (ms > 0) {
      sawDuration = true;
      maxMs = Math.max(maxMs, ms);
    }
  }
  return sawDuration ? maxMs : 0;
}

export function getSegmentsDurationMs(segments) {
  let maxMs = 0;
  for (const seg of segments || []) {
    const end = Number(seg && seg.endOffsetMs) || 0;
    if (end > maxMs) maxMs = end;
  }
  return maxMs;
}

export function collectAudioRefs(markdown) {
  const refs = [];
  const seen = new Set();
  const re = /!\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = re.exec(String(markdown || "")))) {
    const ref = String(match[1] || "").split("|")[0].split("#")[0].trim();
    const fileName = ref.split("/").pop() || ref;
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    if (!ref || !AUDIO_EXT.has(ext)) continue;
    const key = obsidian.normalizePath(ref);
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
}

export function resolveAudioFileRef(app, settings, ref) {
  const normalizedRef = obsidian.normalizePath(String(ref || ""));
  const direct = app.vault.getAbstractFileByPath(normalizedRef);
  if (direct instanceof obsidian.TFile && AUDIO_EXT.has((direct.extension || "").toLowerCase())) return direct;

  const audioFolder = obsidian.normalizePath((settings && settings.audioFolder) || DEFAULT_SETTINGS.audioFolder);
  const fileName = normalizedRef.split("/").pop();
  if (!fileName) return null;
  const scoped = app.vault.getAbstractFileByPath(obsidian.normalizePath(`${audioFolder}/${fileName}`));
  if (scoped instanceof obsidian.TFile && AUDIO_EXT.has((scoped.extension || "").toLowerCase())) return scoped;

  const folder = app.vault.getAbstractFileByPath(audioFolder);
  if (!(folder instanceof obsidian.TFolder)) return null;
  const stack = folder.children.slice();
  while (stack.length) {
    const item = stack.pop();
    if (item instanceof obsidian.TFolder) {
      stack.push(...item.children);
    } else if (item instanceof obsidian.TFile && item.name === fileName && AUDIO_EXT.has((item.extension || "").toLowerCase())) {
      return item;
    }
  }
  return null;
}

export function getSessionLatestSegmentEndMs(session) {
  const segments = session && Array.isArray(session.segments) ? session.segments : [];
  let latest = 0;
  for (const s of segments) {
    const end = Number(s && (s.endOffsetMs ?? s.startOffsetMs)) || 0;
    if (end > latest) latest = end;
  }
  return latest;
}


/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
