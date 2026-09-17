/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：录音采集：双录音器切片、电平表、流与声道协商

import type QnALogPlugin from "../main";
import { isMobileRuntime } from "../shared/util-platform";

import { isChatInputAudioProvider, makeRecordingIssue, resolveTranscribeProvider } from "../asr/transcribe";

import { assertAudioCaptureSupported, extFromMime, pickMimeType } from "../shared/util-audio";

import { diagnosticError } from "../shared/util-key-diag";

import { MAX_SPEAKER_CHANNELS, buildMicrophoneAudioConstraints, configureMicrophoneTrackChannels, normalizeAudioChannelMode, speakerLabelForChannel } from "./channel-speakers";

import { resolveRuntimeAudioInputMode } from "../notes/recording-issues";
import type { RecorderSegmentPayload } from "../shared/types";

/** 录音过程中出现的问题（设备被回收、服务不可用等）。 */
type RecordingIssue = {
  kind: string;
  at: number;
  message?: string;
  stoppedAtMs?: number | null;
  reason?: string;
};

/** 单路电平表：持有 AudioContext、分析器与逐帧数据。 */
type AudioLevelMeter = {
  kind: string;
  icon: string;
  label: string;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  splitter: ChannelSplitterNode | null;
  analyser: AnalyserNode;
  timeData: Uint8Array<ArrayBuffer>;
  freqData: Uint8Array<ArrayBuffer>;
  level: number;
  bars: number[];
  _resumeAttempts: number;
};

export class RecorderService {
  declare plugin: QnALogPlugin;
  /**
   * 以下字段在构造函数里赋值。TypeScript 不推断「仅在构造函数中赋值」的属性，
   * 未声明时其它模块读 `recorder.state` 会报「属性不存在」，因此显式声明跨模块读取的那几个。
   */
  /** 录音器状态；由 start/pause/resume/stop 切换。 */
  declare state: "idle" | "recording" | "paused";
  /** 下一次切片的累计录音时长（毫秒）；未开始计时时为 Infinity。 */
  declare nextCutAtElapsed: number;
  /** 当前段落的音频分片。 */
  declare chunks: Blob[];
  /** 整场录音的音频分片（主录音器）。 */
  declare masterChunks: Blob[];
  /** 有声音的计时次数，供「整场几乎没声音」提示使用。 */
  declare _voicedTicks: number;
  /** 静音的计时次数。 */
  declare _silentTicks: number;
  // 其余实例字段同样只在构造函数或方法里赋值；TypeScript 不推断这类属性（§8），逐个显式声明。
  /** 浏览器录音器（分段录制）。 */
  declare recorder: MediaRecorder | null;
  /** 主录音器：整场录音，用于回听与重切。 */
  declare masterRecorder: MediaRecorder | null;
  /** 麦克风输入流。 */
  declare stream: MediaStream | null;
  /** 当前段落的音频类型（如 audio/webm）。 */
  declare mime: string;
  /** 整场录音的音频类型。 */
  declare masterMime: string;
  /** 录音开始的绝对时间（毫秒）。 */
  declare sessionStartedAt: number;
  /** 当前段落的起始偏移。 */
  declare segmentStartOffsetMs: number;
  /** 累计暂停时长（毫秒）。 */
  declare pausedFor: number;
  /** 本次暂停的开始时间；恢复后清空。 */
  declare pausedAt: number;
  /** 已产出的段落序号。 */
  declare segmentIndex: number;
  /** 定时切片的间隔（毫秒）；0 表示不自动切。 */
  declare segmentDurationMs: number;
  /** 用户手动标记的切点（相对录音开始的毫秒）。 */
  declare quickCutMarksMs: number[];
  /** 是否正在切片（用于避免重入）。 */
  declare cutting: boolean;
  /** 段落回调；由 recording-service 传入。 */
  declare onSegment: ((payload: RecorderSegmentPayload) => void | Promise<void>) | null;
  /** 电平状态订阅者。 */
  declare listeners: Set<(info: unknown) => void>;
  /** 计时器句柄，用于产出电平与切片判断。 */
  declare ticker: number | null;
  /** 各输入通道的电平表实例。 */
  declare levelMeters: AudioLevelMeter[];
  /** 当前电平最大值（0–1）。 */
  declare audioLevel: number;
  /** 当前录音问题（设备/服务），无问题时为空。 */
  declare issue: RecordingIssue | null;
  /** 是否正在停止；停止过程中忽略流中断等回调。 */
  declare stopping: boolean;
  /** 流中断监听的清理函数。 */
  declare streamInterruptionCleanup: (() => void) | null;
  /** 音频输入方式：麦克风 / 混合 / 仅电脑音频。 */
  declare captureMode: string;
  /** 麦克风通道数。 */
  declare inputChannelCount: number;
  /** 设备支持的最大通道数。 */
  declare inputChannelMaxCount: number;
  /** 输入设备名称，用于状态栏显示。 */
  declare inputChannelLabel: string;
  /** 通道处理模式（auto / mono / multichannel）。 */
  declare inputChannelMode: string;
  /** 麦克风输入流引用（供电平表使用）。 */
  declare micStreamRef: MediaStream | null;
  /** 电脑音频输入流引用。 */
  declare sysStreamRef: MediaStream | null;
  /** 虚拟声卡输入流引用。 */
  declare virtStreamRef: MediaStream | null;
  /** 电平表使用的 AudioContext。 */
  declare audioContext: AudioContext | null;
  constructor(plugin) {
    this.plugin = plugin;
    this.recorder = null;
    this.masterRecorder = null;
    this.stream = null;
    this.chunks = [];
    this.masterChunks = [];
    this.mime = "";
    this.masterMime = "";
    this.sessionStartedAt = 0;
    this.segmentStartOffsetMs = 0;
    this.pausedFor = 0;
    this.pausedAt = 0;
    this.state = "idle";
    this.segmentIndex = 0;
    this.segmentDurationMs = 0;
    this.quickCutMarksMs = [];
    this.nextCutAtElapsed = Infinity;
    this.cutting = false;
    this.onSegment = null;
    this.listeners = new Set();
    this.ticker = null;
    this.levelMeters = [];
    this.audioLevel = 0;
    this.issue = null;
    this.stopping = false;
    this.streamInterruptionCleanup = null;
    this.captureMode = "mic";
    this.inputChannelCount = 1;
    this.inputChannelMaxCount = 1;
    this.inputChannelLabel = "";
    this.inputChannelMode = "auto";
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { const info = this.getInfo(); for (const fn of this.listeners) fn(info); }
  getInfo() {
    let elapsed = 0;
    if (this.state === "recording") elapsed = Date.now() - this.sessionStartedAt - this.pausedFor;
    else if (this.state === "paused") elapsed = this.pausedAt - this.sessionStartedAt - this.pausedFor;
    return {
      state: this.state,
      elapsed,
      segmentIndex: this.segmentIndex,
      audioLevel: this.audioLevel || 0,
      sourceLevels: this.getSourceLevels(),
      channelCount: this.inputChannelCount || 1,
      channelMaxCount: this.inputChannelMaxCount || 1,
      channelLabel: this.inputChannelLabel || "",
      channelMode: this.inputChannelMode || "auto",
      issue: this.issue || null,
    };
  }
  async start(options) {
    if (this.state !== "idle") return;
    assertAudioCaptureSupported();
    const captureMode = resolveRuntimeAudioInputMode((options && options.captureMode) || "mic");
    this.stream = await this.acquireStream(captureMode);
    if (!this.stream) throw new Error("未取得可用的麦克风录音流。请检查系统麦克风权限。");
    this.issue = null;
    this.stopping = false;
    this.attachStreamInterruptionHandlers(this.stream);
    // 选走 input_audio 协议的服务（MiMo、百炼 Qwen3-ASR Flash）时录 Opus：
    // 这两条路都可能需要在本地解码音频（MiMo 必须转 WAV；百炼超过 5 分钟或 base64 超 10MB 时转码切块），
    // 而 Electron 解不了 AAC、解得了 Opus。webm/opus 同时也在百炼的原生格式列表里，直发路径不受影响。
    let preferOpus = false;
    try { preferOpus = isChatInputAudioProvider(resolveTranscribeProvider(this.plugin)); } catch { /* intentionally empty */ }
    this.mime = pickMimeType(preferOpus);
    this.segmentIndex = 0;
    this.segmentStartOffsetMs = 0;
    this.pausedFor = 0;
    this.onSegment = (options && options.onSegment) || null;
    this.segmentDurationMs = (options && options.segmentDurationMs) || 0;
    this.quickCutMarksMs = this.segmentDurationMs > 0 && Array.isArray(options && options.quickCutMarksMs)
      ? options.quickCutMarksMs.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
      : [];
    this.nextCutAtElapsed = this.getNextCutAtElapsed(0);
    this.cutting = false;
    this.sessionStartedAt = Date.now();
    this.state = "recording";
    // 静音统计计数器：每场录音开始时清零（续录也走 start()，故不会跨场污染）。
    this._voicedTicks = 0;
    this._silentTicks = 0;
    this.startLevelMeter(this.stream);
    this.startMasterRecorder();
    this.startNewRecorder();
    if (options && typeof options.onStreamReady === "function") {
      try { await options.onStreamReady(this.stream, this.getChannelInfo()); }
      catch (e) { console.error("[QnALog] onStreamReady failed", e); }
    }
    this.ticker = window.setInterval(() => this.tick(), 160);
    this.emit();
  }
  attachStreamInterruptionHandlers(stream) {
    if (this.streamInterruptionCleanup) {
      try { this.streamInterruptionCleanup(); } catch { /* intentionally empty */ }
      this.streamInterruptionCleanup = null;
    }
    const tracks = stream && typeof stream.getTracks === "function" ? stream.getTracks() : [];
    const cleanups = [];
    const onEnded = () => this.handleStreamInterrupted("ended");
    const onMute = () => {
      window.setTimeout(() => {
        if (this.stopping || this.state === "idle") return;
        const liveTracks = this.stream && typeof this.stream.getAudioTracks === "function" ? this.stream.getAudioTracks() : [];
        if (liveTracks.length && liveTracks.every((track) => track.readyState === "ended")) this.handleStreamInterrupted("muted");
      }, 600);
    };
    for (const track of tracks) {
      try { track.addEventListener("ended", onEnded); cleanups.push(() => track.removeEventListener("ended", onEnded)); } catch { /* intentionally empty */ }
      try { track.addEventListener("mute", onMute); cleanups.push(() => track.removeEventListener("mute", onMute)); } catch { /* intentionally empty */ }
    }
    this.streamInterruptionCleanup = () => cleanups.forEach((fn) => { try { fn(); } catch { /* intentionally empty */ } });
  }
  handleStreamInterrupted(reason) {
    if (this.stopping || this.state === "idle" || (this.issue && this.issue.kind === "microphone")) return;
    const stoppedAtMs = this.getInfo().elapsed;
    this.issue = makeRecordingIssue("microphone", {
      reason,
      stoppedAtMs,
      message: "系统在录音过程中收回了麦克风权限。",
    });
    this.state = "paused";
    this.pausedAt = Date.now();
    try {
      if (this.plugin && this.plugin.recording && typeof this.plugin.recording.setRecordingIssue === "function") {
        this.plugin.recording.setRecordingIssue("microphone", this.issue);
      }
    } catch { /* intentionally empty */ }
    this.emit();
  }
  getStreamLabel(stream, fallback) {
    const track = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
    return (track && track.label) || fallback;
  }
  getChannelInfo() {
    return {
      channelCount: this.inputChannelCount || 1,
      maxChannelCount: this.inputChannelMaxCount || 1,
      label: this.inputChannelLabel || "",
      mode: this.captureMode || "mic",
      channelMode: this.inputChannelMode || "auto",
    };
  }
  createLevelMeter(kind, icon, label, stream, channelIndex = null, channelCount = 1) {
    const Ctx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx || !stream) {
      console.warn(`[QnALog][meter] ${kind} 创建失败：no AudioContext / no stream`, { hasCtx: !!Ctx, hasStream: !!stream });
      return null;
    }
    let ctx;
    try { ctx = new Ctx(); }
    catch (e) {
      console.error(`[QnALog][meter] ${kind} new AudioContext 失败`, e);
      return null;
    }
    let source;
    try { source = ctx.createMediaStreamSource(stream); }
    catch (e) {
      console.error(`[QnALog][meter] ${kind} createMediaStreamSource 失败`, e, {
        tracks: stream.getAudioTracks().map(t => ({ label: t.label, enabled: t.enabled, muted: t.muted, readyState: t.readyState })),
      });
      try { ctx.close(); } catch { /* intentionally empty */ }
      return null;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.56;
    let splitter = null;
    if (Number.isFinite(channelIndex) && channelIndex >= 0 && channelCount > 1) {
      try {
        source.channelCountMode = "explicit";
        source.channelCount = channelCount;
      } catch { /* browser keeps its negotiated channel layout */ }
      splitter = ctx.createChannelSplitter(channelCount);
      source.connect(splitter);
      splitter.connect(analyser, channelIndex);
    } else {
      source.connect(analyser);
    }
    if (ctx.state === "suspended" && ctx.resume) {
      ctx.resume().catch((e) => console.warn(`[QnALog][meter] ${kind} AudioContext resume 失败`, e));
    }
    return {
      kind,
      icon,
      label,
      context: ctx,
      source,
      splitter,
      analyser,
      timeData: new Uint8Array(analyser.fftSize),
      freqData: new Uint8Array(analyser.frequencyBinCount),
      level: 0,
      bars: new Array(12).fill(0),
      _resumeAttempts: 0,
    };
  }
  startLevelMeter(stream) {
    this.stopLevelMeter();
    try {
      const meters = [];
      if (this.micStreamRef) {
        const label = this.getStreamLabel(this.micStreamRef, "麦克风");
        const channelCount = this.captureMode === "mic"
          ? Math.min(MAX_SPEAKER_CHANNELS, Math.max(1, Number(this.inputChannelCount) || 1))
          : 1;
        if (channelCount > 1) {
          for (let channel = 0; channel < channelCount; channel++) {
            const meter = this.createLevelMeter(
              `speaker-${channel + 1}`,
              "●",
              `CH${channel + 1} · ${speakerLabelForChannel(channel + 1)}`,
              this.micStreamRef,
              channel,
              channelCount,
            );
            if (meter) meters.push(meter);
          }
        } else {
          const meter = this.createLevelMeter("mic", "●", label, this.micStreamRef);
          if (meter) meters.push(meter);
        }
      }
      if (this.virtStreamRef) {
        const label = this.getStreamLabel(this.virtStreamRef, "电脑音频输入");
        const meter = this.createLevelMeter("computer", "●", label, this.virtStreamRef);
        if (meter) meters.push(meter);
      }
      if (!meters.length && stream) {
        const label = this.getStreamLabel(stream, "输入");
        const meter = this.createLevelMeter("input", "●", label, stream);
        if (meter) meters.push(meter);
      }
      this.levelMeters = meters;
      this.updateAudioLevel();
    } catch (e) {
      console.error("[QnALog] level meter failed", e);
      this.stopLevelMeter();
    }
  }
  stopLevelMeter() {
    for (const meter of this.levelMeters || []) {
      try { if (meter.source) meter.source.disconnect(); } catch { /* intentionally empty */ }
      try { if (meter.splitter) meter.splitter.disconnect(); } catch { /* intentionally empty */ }
      try { if (meter.analyser) meter.analyser.disconnect(); } catch { /* intentionally empty */ }
      try { if (meter.context) void meter.context.close(); } catch { /* intentionally empty */ }
    }
    this.levelMeters = [];
    this.audioLevel = 0;
  }
  updateAudioLevel() {
    if (!this.levelMeters || !this.levelMeters.length || this.state !== "recording") {
      if (this.state !== "recording") this.audioLevel = 0;
      return this.audioLevel || 0;
    }
    let maxLevel = 0;
    for (const meter of this.levelMeters) {
      try {
        // 自愈：AudioContext 如果被浏览器挂起（autoplay 限制 / 长时间无交互），
        // 分析器读不到数据，电平条会假装"有输入"但每个频段全 0。这里每若干帧重试 resume。
        if (meter.context && meter.context.state === "suspended" && meter.context.resume) {
          meter._resumeAttempts = (meter._resumeAttempts || 0) + 1;
          if (meter._resumeAttempts <= 30 || meter._resumeAttempts % 60 === 0) {
            meter.context.resume().catch(() => { /* retry on the next meter tick */ });
          }
        }
        meter.analyser.getByteTimeDomainData(meter.timeData);
        meter.analyser.getByteFrequencyData(meter.freqData);
        let sum = 0;
        for (let i = 0; i < meter.timeData.length; i++) {
          const centered = (meter.timeData[i] - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / meter.timeData.length);
        const normalized = Math.max(0, Math.min(1, rms * 12));
        meter.level = (meter.level * 0.54) + (normalized * 0.46);

        const nextBars = [];
        const usableBins = Math.max(12, Math.min(meter.freqData.length, 180));
        const bandSize = Math.max(1, Math.floor(usableBins / 12));
        for (let b = 0; b < 12; b++) {
          let total = 0;
          let count = 0;
          const start = b * bandSize;
          const end = Math.min(usableBins, start + bandSize);
          for (let i = start; i < end; i++) {
            total += meter.freqData[i] || 0;
            count++;
          }
          const raw = count ? (total / count) / 255 : 0;
          const boosted = Math.max(raw, meter.level * (0.42 + (b % 4) * 0.05));
          const prev = meter.bars[b] || 0;
          nextBars[b] = (prev * 0.58) + (Math.min(1, boosted * 1.7) * 0.42);
        }
        meter.bars = nextBars;
        maxLevel = Math.max(maxLevel, meter.level);
      } catch {
        meter.level = 0;
        meter.bars = new Array(12).fill(0);
      }
    }
    this.audioLevel = maxLevel;
    // 静音统计（供"整场几乎没声音"的兜底提示）。
    // 排除 AudioContext 仍 suspended 的假 0 帧（此时分析器读不到数据，电平天然为 0，不能当静音算）。
    if (this.state === "recording") {
      const anySuspended = (this.levelMeters || []).some((m) => m && m.context && m.context.state === "suspended");
      if (!anySuspended) {
        if (maxLevel >= 0.012) this._voicedTicks = (this._voicedTicks || 0) + 1;
        else this._silentTicks = (this._silentTicks || 0) + 1;
      }
    }
    return this.audioLevel || 0;
  }
  getSourceLevels() {
    const meters = this.levelMeters || [];
    return meters.map((meter) => ({
      kind: meter.kind,
      icon: meter.icon,
      label: meter.label,
      level: meter.level || 0,
      bars: Array.isArray(meter.bars) ? meter.bars.slice(0, 12) : new Array(12).fill(0),
    }));
  }
  startNewRecorder() {
    const opts = this.mime ? { mimeType: this.mime } : undefined;
    this.recorder = new MediaRecorder(this.stream, opts);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.chunks.push(e.data); };
    this.recorder.onerror = (e) => { console.error("[QnALog] recorder error", e); };
    this.recorder.start(1000);
  }
  startMasterRecorder() {
    const opts = this.mime ? { mimeType: this.mime } : undefined;
    this.masterRecorder = null;
    this.masterChunks = [];
    this.masterMime = this.mime || "";
    try {
      this.masterRecorder = new MediaRecorder(this.stream, opts);
      this.masterRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.masterChunks.push(e.data); };
      this.masterRecorder.onerror = (e) => { console.error("[QnALog] master recorder error", e); };
      this.masterRecorder.start(1000);
    } catch (e) {
      console.error("[QnALog] master recorder start failed", e);
      this.masterRecorder = null;
      this.masterChunks = [];
    }
  }
  async stopMasterRecorder(fallbackBlob, fallbackMime) {
    const rec = this.masterRecorder;
    const chunks = this.masterChunks || [];
    const mime = (rec && (rec.mimeType || this.masterMime)) || this.masterMime || fallbackMime || "";
    if (!rec) {
      return fallbackBlob && this.segmentIndex === 0 ? { blob: fallbackBlob, mime: fallbackBlob.type || mime } : null;
    }
    const blob = await this._awaitRecorderStop(rec, () => new Blob(chunks, { type: mime }), null) as Blob | null;
    this.masterRecorder = null;
    this.masterChunks = [];
    this.masterMime = "";
    if (blob && blob.size > 0) return { blob, mime: blob.type || mime };
    return fallbackBlob && this.segmentIndex === 0 ? { blob: fallbackBlob, mime: fallbackBlob.type || fallbackMime || mime } : null;
  }
  async acquireStream(mode) {
    mode = resolveRuntimeAudioInputMode(mode);
    this.captureMode = mode;
    const configuredChannelMode = normalizeAudioChannelMode(this.plugin.settings.audioChannelMode);
    this.inputChannelMode = mode === "mic" ? configuredChannelMode : "mono";
    this.inputChannelCount = 1;
    this.inputChannelMaxCount = 1;
    this.inputChannelLabel = "";
    // 3 种音频输入：
    //   mic                 — 仅麦克风（默认）
    //   virtualCable        — 仅电脑音频（一个被识别为虚拟设备的 audioinput）
    //   mix-virtual         — 麦克风 + 电脑音频（会议/视频推荐）
    const wantMic    = mode === "mic" || mode === "mix-virtual";
    const wantVirt   = mode === "virtualCable" || mode === "mix-virtual";

    let micStream = null, virtStream = null;

    if (wantMic) {
      const mobile = isMobileRuntime();
      const requestedChannelMode = !mobile && mode === "mic" ? configuredChannelMode : "mono";
      const audioConstraints = buildMicrophoneAudioConstraints({
        deviceId: this.plugin.settings.selectedMicrophoneDevice || "",
        channelMode: requestedChannelMode,
        mobile,
        targetChannels: MAX_SPEAKER_CHANNELS,
      });
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        if (mode === "mic") {
          const track = micStream.getAudioTracks()[0];
          const channelInfo = await configureMicrophoneTrackChannels(
            track,
            requestedChannelMode,
            MAX_SPEAKER_CHANNELS,
          );
          this.inputChannelCount = channelInfo.channelCount;
          this.inputChannelMaxCount = channelInfo.maxChannelCount;
          this.inputChannelLabel = channelInfo.label;
        }
      } catch (e) {
        const name = (e && e.name) || "";
        // 用户显式选的麦克风打不开（拔了 / 设备 ID 变了 / 被占用）→ 明确提示去重选，绝不偷偷换成别的设备。
        if (audioConstraints.deviceId && /Overconstrained|NotFound|NotReadable/i.test(name)) {
          throw new Error(`所选麦克风当前不可用（${name}）。请到「设置 → 常规 → 音频输入」重新选择麦克风，或清空选择以使用系统默认麦克风。`);
        }
        throw e;
      }
    }

    if (wantVirt) {
      // 电脑音频没有合理默认，必须由用户显式选定；没选 → 明确提示去选，不猜。
      const virtId = this.plugin.settings.selectedVirtualDevice || "";
      if (!virtId) {
        if (micStream) micStream.getTracks().forEach((t) => t.stop());
        throw new Error("请先在「设置 → 常规 → 音频输入」选择电脑音频设备。\n\n录制电脑声音需要先配置虚拟声卡：\n• Windows：VB-Cable（vb-audio.com/Cable/）\n• macOS：BlackHole（existential.audio/blackhole/）\n• Linux：PulseAudio/PipeWire monitor source\n\n配置完成后，返回「音频输入」选择对应设备。");
      }
      try {
        virtStream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: virtId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (e) {
        // 电脑音频必须是指定的虚拟设备，退回默认会录错东西，故给清晰错误而非兜底默认。
        if (micStream) micStream.getTracks().forEach((t) => t.stop());
        const name = (e && e.name) || "";
        if (/Overconstrained|NotFound|NotReadable/i.test(name)) {
          throw new Error(`所选电脑音频设备当前不可用（${name}）。请到「设置 → 常规 → 音频输入」重新选择电脑音频输入。`);
        }
        throw e;
      }
    }

    this.micStreamRef = micStream;
    this.sysStreamRef = null;
    this.virtStreamRef = virtStream;

    const sources = [micStream, virtStream].filter(Boolean);
    if (sources.length > 1) {
      try {
        const ctx = new (window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)();
        const dest = ctx.createMediaStreamDestination();
        for (const source of sources) ctx.createMediaStreamSource(source).connect(dest);
        this.audioContext = ctx;
        return dest.stream;
      } catch (e) {
        // 混流上下文构造失败：把已打开的 mic/virt 流全部停掉，避免 track 泄漏后再抛错。
        try { if (this.audioContext) { void this.audioContext.close(); this.audioContext = null; } } catch { /* intentionally empty */ }
        for (const s of sources) { try { s.getTracks().forEach((t) => t.stop()); } catch { /* intentionally empty */ } }
        this.micStreamRef = null; this.virtStreamRef = null;
        throw e;
      }
    }
    return sources[0] || null;
  }
  releaseStream() {
    try { if (this.audioContext) { void this.audioContext.close(); } } catch { /* intentionally empty */ }
    this.audioContext = null;
    if (this.micStreamRef) this.micStreamRef.getTracks().forEach((t) => t.stop());
    if (this.sysStreamRef) this.sysStreamRef.getTracks().forEach((t) => t.stop());
    if (this.virtStreamRef) this.virtStreamRef.getTracks().forEach((t) => t.stop());
    this.micStreamRef = null;
    this.sysStreamRef = null;
    this.virtStreamRef = null;
    this.inputChannelCount = 1;
    this.inputChannelMaxCount = 1;
    this.inputChannelLabel = "";
    this.inputChannelMode = "auto";
  }
  tick() {
    this.updateAudioLevel();
    this.emit();
    if (this.state !== "recording" || this.cutting) return;
    const elapsed = this.getInfo().elapsed;
    if (elapsed >= this.nextCutAtElapsed) {
      this.cutSegment().catch((e) => console.error("[QnALog] cutSegment error", e));
    }
  }
  getNextCutAtElapsed(fromElapsed) {
    if (!this.segmentDurationMs || this.segmentDurationMs <= 0) return Infinity;
    const from = Math.max(0, Number(fromElapsed) || 0);
    const nextRegular = from + this.segmentDurationMs;
    const nextQuick = (this.quickCutMarksMs || []).find((mark) => mark > from + 500);
    return Math.min(nextQuick || Infinity, nextRegular);
  }
  // 等 MediaRecorder 的 onstop；但若 stop() 成功而 onstop 永不触发（track 已 ended——虚拟/远程设备
  // 掉线、系统收回麦克风等场景常见），4 秒后用已收集的 chunk 强制收尾，杜绝 stop()/cutSegment 永久挂起
  // 导致录音卡在"录音中…"、流/AudioContext 不释放、finalizeSession 永不触发。
  _awaitRecorderStop(rec, makeResult, fallback) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); };
      if (!rec) return finish(fallback);
      rec.onstop = () => finish(makeResult());
      try { rec.stop(); } catch { finish(fallback); }
      window.setTimeout(() => finish(makeResult()), 4000);
    });
  }
  async cutSegment() {
    if (this.cutting || this.state !== "recording") return;
    this.cutting = true;
    const chunksAtCut = this.chunks;
    const mimeAtCut = this.recorder.mimeType || this.mime;
    const endOffset = this.getInfo().elapsed;
    const startOffset = this.segmentStartOffsetMs;
    const index = this.segmentIndex;

    let blob = null;
    let cutError = null;
    try {
      await this._awaitRecorderStop(this.recorder, () => undefined, undefined);

      blob = new Blob(chunksAtCut, { type: mimeAtCut });
      this.segmentIndex++;
      this.segmentStartOffsetMs = endOffset;
      this.nextCutAtElapsed = this.getNextCutAtElapsed(endOffset);

      // 上面的 await 期间用户可能已停止录音（state 变回 idle），此时不应重启分段录音器。
      // 该守卫原本直读 this.state，但 TypeScript 会按前面的 `state !== "recording"` 守卫把它
      // 收窄成 "recording"，导致这里的比较被判为恒真；改从 getInfo() 读实时值，语义不变。
      if (this.getInfo().state !== "idle") this.startNewRecorder();
    } catch (e) {
      cutError = e;
      // 分段重启失败时不能继续显示成“正在录音”。暂停分段录音，但保留独立 masterRecorder，
      // 用户停止录音后仍可保存整场音频；本次已切出的 blob 也会在下方继续交给转写。
      this.state = "paused";
      this.pausedAt = Date.now();
      try { if (this.masterRecorder && this.masterRecorder.state === "recording") this.masterRecorder.pause(); } catch { /* intentionally empty */ }
      this.issue = makeRecordingIssue("service", {
        reason: "segment-restart-failed",
        stoppedAtMs: endOffset,
        message: "录音分段无法继续，已暂停。请停止录音以保存完整音频后重试。",
      });
      try { this.plugin.recording.setRecordingIssue("service", this.issue); } catch { /* intentionally empty */ }
      try {
        void this.plugin.diagnostics.logDiagnostic("error", "recording.segment_cut_failed", "录音分段切换失败，已暂停并保留完整录音", {
          index, startOffsetMs: startOffset, endOffsetMs: endOffset, error: diagnosticError(e),
        });
      } catch { /* intentionally empty */ }
    } finally {
      // 任何异常都必须释放切片锁；否则此后所有 tick 都会永久跳过分段。
      this.cutting = false;
    }

    if (blob && this.onSegment) {
      try { await this.onSegment({ blob, index, startOffsetMs: startOffset, endOffsetMs: endOffset, isFinal: false, ext: extFromMime(mimeAtCut) }); }
      catch (e) { console.error("[QnALog] onSegment error", e); }
    }
    this.emit();
    if (cutError) throw cutError;
  }
  pause() {
    if (this.state !== "recording") return;
    try { this.recorder.pause(); } catch { /* intentionally empty */ }
    try { if (this.masterRecorder && this.masterRecorder.state === "recording") this.masterRecorder.pause(); } catch { /* intentionally empty */ }
    this.pausedAt = Date.now();
    this.state = "paused";
    this.emit();
  }
  resume() {
    if (this.state !== "paused") return;
    let segmentReady = false;
    let masterReady = !this.masterRecorder || this.masterRecorder.state === "recording";
    try {
      if (this.recorder && this.recorder.state === "paused") {
        this.recorder.resume();
        segmentReady = true;
      } else if (!this.recorder || this.recorder.state === "inactive") {
        // 分段重启失败后 recorder 已经 inactive。继续录音时必须真正创建新 recorder，
        // 不能只把 UI 状态改回 recording。
        this.startNewRecorder();
        segmentReady = this.recorder && this.recorder.state === "recording";
      } else {
        segmentReady = this.recorder.state === "recording";
      }
    } catch (e) {
      console.error("[QnALog] segment recorder resume failed", e);
    }
    try {
      if (this.masterRecorder && this.masterRecorder.state === "paused") this.masterRecorder.resume();
      masterReady = !this.masterRecorder || this.masterRecorder.state === "recording";
    } catch (e) {
      console.error("[QnALog] master recorder resume failed", e);
      masterReady = false;
    }
    if (!segmentReady || !masterReady) {
      try { if (this.recorder && this.recorder.state === "recording") this.recorder.pause(); } catch { /* intentionally empty */ }
      this.issue = makeRecordingIssue("service", {
        reason: "recorder-resume-failed",
        stoppedAtMs: this.getInfo().elapsed,
        message: "录音器未能恢复，仍保持暂停。请停止录音以保存已有音频。",
      });
      try { this.plugin.recording.setRecordingIssue("service", this.issue); } catch { /* intentionally empty */ }
      this.emit();
      return;
    }
    this.pausedFor += Date.now() - this.pausedAt;
    this.issue = null;
    try { this.plugin.recording.clearRecordingIssue("service"); } catch { /* intentionally empty */ }
    this.state = "recording";
    this.emit();
  }
  async stop() {
    if (this.state === "idle") return null;
    this.stopping = true;
    const elapsedAtStop = this.getInfo().elapsed;
    const startOffset = this.segmentStartOffsetMs;
    const index = this.segmentIndex;
    const mime = this.recorder ? (this.recorder.mimeType || this.mime) : this.mime;
    const chunksAtStop = this.chunks;

    const finalBlob = await this._awaitRecorderStop(this.recorder, () => new Blob(chunksAtStop, { type: mime }), null);
    const master = await this.stopMasterRecorder(finalBlob, mime);

    this.stopLevelMeter();
    if (this.streamInterruptionCleanup) {
      try { this.streamInterruptionCleanup(); } catch { /* intentionally empty */ }
      this.streamInterruptionCleanup = null;
    }
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.releaseStream();
    this.stream = null; this.recorder = null; this.chunks = [];
    this.issue = null;
    this.state = "idle";
    this.stopping = false;
    if (this.ticker) { window.clearInterval(this.ticker); this.ticker = null; }
    this.segmentIndex++;
    this.emit();

    const masterOnly = !finalBlob && !!(master && master.blob) && index > 0;
    const finalAudioBlob = finalBlob || (!masterOnly && master && master.blob) || null;
    if (this.onSegment && (finalAudioBlob || masterOnly)) {
      try {
        await this.onSegment({
          blob: finalAudioBlob || new Blob([], { type: mime }),
          index,
          startOffsetMs: startOffset,
          endOffsetMs: elapsedAtStop,
          isFinal: true,
          masterOnly,
          ext: extFromMime((finalAudioBlob && finalAudioBlob.type) || mime),
          masterBlob: master && master.blob,
          masterMime: master && master.mime,
          masterExt: extFromMime((master && master.mime) || mime),
        });
      }
      catch (e) { console.error("[QnALog] onSegment(final) error", e); }
    }
    return { totalDurationMs: elapsedAtStop, segmentsEmitted: index + 1 };
  }
}

// 解析当前激活的转写 provider 配置（带向后兼容：旧版顶层字段兜底）

// 轻量确认弹窗：危险/不可逆/有成本的操作前二次确认。resolve(true) 仅当用户点了确认按钮。

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
