/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- service retains the recording pipeline's dynamic session data */
import * as obsidian from "obsidian";
import type { PluginSettings, QueueRecoveryEntrySummary, QueueTask, QueueTaskLifecycle, RecordingSession, TranscribeQueueTaskPayload } from "../shared/types";
import type { LiveAsrPipeline } from "../shared/live-asr-pipeline";
import type { LiveAsrCircuitState } from "./live-segment-policy";
import { LIVE_ASR_TASK_STATUS, classifyLiveAsrBacklog, createLiveAsrCircuitState, isLiveAsrCircuitOpen, recordLiveAsrFailure, recordLiveAsrSuccess, summarizeLiveAsrJobs } from "./live-segment-policy";
import { resolveTranscribeProvider, makeRecordingIssue } from "./transcribe";
import { isAsrTransportError, isTransientAsrError, extFromMime } from "../shared/util-audio";
import { getErrorMessage, genId, pad, escapeRegExp } from "../shared/util-common";
import { diagnosticError } from "../shared/util-key-diag";
import { initialAudioChannelRuntimeMode, normalizeAudioChannelMode } from "../audio/channel-speakers";
import { AUDIO_EXT } from "../shared/catalog-import";
import { SEGMENT_CACHE_RETENTION_MS } from "../shared/limits";
import { getRealtimeOutlineAnchorTime } from "../notes/outline-text";
import { normalizeRealtimeOutlineState } from "../notes/realtime-outline";
import { getSessionMasterAudioName } from "../notes/audio-refs";
import { ensureVaultFolder, findAvailableVaultPath } from "../shared/util-vault";
import { findSessionNoteBlock } from "../notes/note-document";
import { NS_AUDIO_PREFIX } from "../shared/namespace";
import { t } from "../shared/i18n";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { DiagnosticsService } from "../diagnostics/diagnostics-service";

export interface LiveAsrPipelineHost {
  getSettings(): Pick<PluginSettings, "audioFolder" | "segmentCacheFolder" | "keepSegmentAudioFiles" | "consolidatedLayout" | "audioChannelMode" | "activeTranscribeProvider" | "transcribeProviders" | "transcribeEndpoint" | "transcribeApiKey" | "transcribeModel" | "transcribeLanguage">;
  vault: {
    adapter: {
      exists(path: string): Promise<boolean>;
      mkdir(path: string): Promise<void>;
      writeBinary(path: string, data: ArrayBuffer): Promise<void>;
      remove(path: string): Promise<void>;
      list(path: string): Promise<{ files: string[]; folders: string[] }>;
      stat(path: string): Promise<{ mtime?: number } | null>;
    };
    getAbstractFileByPath(path: string): obsidian.TAbstractFile | null;
    createBinary(path: string, data: ArrayBuffer): Promise<obsidian.TFile>;
    createFolder(path: string): Promise<obsidian.TFolder>;
    read(file: obsidian.TFile): Promise<string>;
    modify(file: obsidian.TFile, content: string): Promise<void>;
  };
  fileManager: { trashFile(file: obsidian.TFile): Promise<void> };
  diagnostics: DiagnosticsService;
  queueTasks(): readonly QueueTask[];
  queueRecoveryEntries(): readonly QueueRecoveryEntrySummary[];
  addQueueTask(task: TranscribeQueueTaskPayload & Partial<QueueTaskLifecycle>): Promise<QueueTask>;
  updateQueueTask(id: string, patch: Partial<QueueTask>): Promise<void>;
  removeQueueTask(id: string): Promise<void>;
  removeLiveTranscriptBlock(mdPath: string, sessionId: string): Promise<void>;
  getRecorderBufferSummary(): { masterChunkCount: number; masterChunkBytes: number; currentSegmentChunkCount: number; currentSegmentChunkBytes: number };
  syncImportBusyFromSessionProgress(session: RecordingSession): void;
  requestOutlineRefresh(): void;
  requestBubbleUpdate(): void;
}

export class LiveAsrPipelineService implements LiveAsrPipeline {
  private host: LiveAsrPipelineHost;
  private asrServiceCircuitKey: string | null = null;
  private asrServiceCircuitState: LiveAsrCircuitState | null = null;
  private recordingIssue: unknown = null;

  constructor(host: LiveAsrPipelineHost) {
    this.host = host;
    this.asrServiceCircuitState = createLiveAsrCircuitState();
  }
  initializeSession(session: RecordingSession): void {
    session.segmentPersistQueue = Promise.resolve();
    session.liveAsrJobs = new Map();
    session.asrCircuitState = createLiveAsrCircuitState();
    session.asrBacklogLevel = "normal";
    session.asrDeferredMode = false;
    session.hasDeferredAsrJobs = false;
    session.activeSegmentJobs = 0;
  }
  beginSessionSegmentWork(session: RecordingSession): void {
    session.activeSegmentJobs = (Number(session.activeSegmentJobs) || 0) + 1;
  }
  finishSessionSegmentWork(session: RecordingSession, jobId?: string, reason = "completed"): void {
    if (jobId) this.getLiveAsrJobs(session).delete(jobId);
    session.activeSegmentJobs = Math.max(0, (Number(session.activeSegmentJobs) || 1) - 1);
    this.updateLiveAsrBacklogPolicy(session, reason);
  }
  markSessionAsrJobsDeferred(session: RecordingSession): void {
    session.hasDeferredAsrJobs = true;
  }
  getQueueTask(id: string): QueueTask | undefined {
    return this.host.queueTasks().find((task) => task && task.id === id);
  }

  getRecordingIssue() {
    return this.recordingIssue || null;
  }

  getSegmentCacheFolder() {
    return obsidian.normalizePath(this.host.getSettings().segmentCacheFolder || DEFAULT_SETTINGS.segmentCacheFolder);
  }

  async ensureSegmentCacheFolder() {
    const folderPath = this.getSegmentCacheFolder();
    const adapter = this.host.vault.adapter;
    const parts = folderPath.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
    return folderPath;
  }

  isSegmentCachePath(path) {
    const norm = obsidian.normalizePath(path || "");
    const folder = this.getSegmentCacheFolder();
    return !!norm && (norm === folder || norm.startsWith(folder + "/"));
  }

  isQueuedTranscribeAudioReferenced(path, excludeTaskId = undefined) {
    const norm = obsidian.normalizePath(String(path || ""));
    const tasks = this.host.queueTasks();
    const retainedReferences = this.host.queueRecoveryEntries().some(entry =>
      entry.audioPaths.some(audioPath => obsidian.normalizePath(audioPath) === norm),
    );
    return retainedReferences || tasks.some(t => t && t.type === "transcribe"
      && t.id !== excludeTaskId
      && obsidian.normalizePath(String(t.audioPath || "")) === norm);
  }

  async maybeDeleteSegmentCacheFile(path, excludeTaskId = undefined, force = false) {
    if (!force && this.host.getSettings().keepSegmentAudioFiles === true) return;
    if (!this.isSegmentCachePath(path)) return;
    if (this.isQueuedTranscribeAudioReferenced(path, excludeTaskId)) return;
    const file = this.host.vault.getAbstractFileByPath(obsidian.normalizePath(path));
    if (file instanceof obsidian.TFile) {
      try { await this.host.fileManager.trashFile(file); }
      catch (e) { console.error("[QnALog] segment cache cleanup failed", path, e); }
      return;
    }
    // 点目录缓存可能不进入 TFile 索引；它属于可再生临时文件，直接通过 adapter 删除。
    try {
      const adapter = this.host.vault.adapter;
      const norm = obsidian.normalizePath(path);
      if (adapter && await adapter.exists(norm)) await adapter.remove(norm);
    } catch (e) {
      console.error("[QnALog] segment cache adapter cleanup failed", path, e);
    }
  }

  async cleanupSuccessfulSegmentAudio(session) {
    if (!session || this.host.getSettings().keepSegmentAudioFiles === true) return;
    if (this.host.getSettings().consolidatedLayout === false) return;
    if (!getSessionMasterAudioName(session)) return;
    for (const s of session.segments || []) {
      if (!s || s.error) continue;
      await this.maybeDeleteSegmentCacheFile(s.segmentAudioPath || s.audioPath);
    }
  }

  async cleanupExpiredSegmentCacheFiles(maxAgeMs = SEGMENT_CACHE_RETENTION_MS) {
    if (this.host.getSettings().keepSegmentAudioFiles === true) return { deleted: 0, skipped: 0, failed: 0 };
    const folderPath = this.getSegmentCacheFolder();
    const folder = this.host.vault.getAbstractFileByPath(folderPath);
    const cutoff = Date.now() - Math.max(60 * 60 * 1000, Number(maxAgeMs) || SEGMENT_CACHE_RETENTION_MS);
    const files = [];
    if (folder instanceof obsidian.TFolder) {
      const walk = (node) => {
        if (node instanceof obsidian.TFile) {
          files.push({ path: node.path, mtime: Number(node.stat && node.stat.mtime) || 0 });
          return;
        }
        if (node instanceof obsidian.TFolder) {
          for (const child of node.children || []) walk(child);
        }
      };
      walk(folder);
    } else {
      // 默认缓存位于 .cache；点目录不会始终进入 Vault 文件索引，改用 adapter 递归盘点。
      const adapter = this.host.vault.adapter;
      if (!adapter || !(await adapter.exists(folderPath))) return { deleted: 0, skipped: 0, failed: 0 };
      const walkAdapter = async (dir) => {
        const listing = await adapter.list(dir);
        for (const filePath of listing.files || []) {
          const stat = await adapter.stat(filePath);
          files.push({ path: filePath, mtime: Number(stat && stat.mtime) || 0 });
        }
        for (const childDir of listing.folders || []) await walkAdapter(childDir);
      };
      await walkAdapter(folderPath);
    }
    let deleted = 0, skipped = 0, failed = 0;
    for (const file of files) {
      const path = obsidian.normalizePath(file.path || "");
      const ext = String(path.split(".").pop() || "").toLowerCase();
      if (!this.isSegmentCachePath(path) || (ext && !AUDIO_EXT.has(ext))) { skipped++; continue; }
      const mtime = Number(file.mtime) || 0;
      if (mtime > cutoff) { skipped++; continue; }
      if (this.isQueuedTranscribeAudioReferenced(path)) { skipped++; continue; }
      try {
        await this.maybeDeleteSegmentCacheFile(path);
        deleted++;
      } catch (e) {
        failed++;
        console.error("[QnALog] expired segment cache cleanup failed", path, e);
      }
    }
    if (deleted || failed) {
      await this.host.diagnostics.logDiagnostic("info", "segment_cache.cleanup", t("Cleaned up expired transcription segments"), { folderPath, deleted, skipped, failed });
    }
    return { deleted, skipped, failed };
  }
  getLiveAsrJobs(session) {
    if (!session) return new Map();
    if (!(session.liveAsrJobs instanceof Map)) session.liveAsrJobs = new Map();
    return session.liveAsrJobs;
  }
  getLiveAsrBacklogSummary(session) {
    return summarizeLiveAsrJobs(this.getLiveAsrJobs(session).values());
  }

  updateLiveAsrBacklogPolicy(session, reason = "update") {
    if (!session) return null;
    const summary = this.getLiveAsrBacklogSummary(session);
    const nextLevel = classifyLiveAsrBacklog(summary);
    const previousLevel = session.asrBacklogLevel || "normal";
    session.asrBacklogLevel = nextLevel;
    if (nextLevel === "critical") {
      session.asrDeferredMode = true;
      session.hasDeferredAsrJobs = true;
    }
    if (nextLevel !== previousLevel) {
      const recorderBuffer = this.host.getRecorderBufferSummary();
      void this.host.diagnostics.logDiagnostic(nextLevel === "normal" ? "info" : "warn", "asr.live_backlog_changed", t("Live transcription backlog state changed"), {
        reason,
        previousLevel,
        nextLevel,
        ...summary,
        ...recorderBuffer,
      });
      if (nextLevel === "warning" && !session._asrBacklogWarningNotified) {
        session._asrBacklogWarningNotified = true;
        new obsidian.Notice(t("Transcription is temporarily slower than recording; audio segments have been safely written to cache and QnALog will keep processing."), 8000);
      }
      if (nextLevel === "critical" && !session._asrBacklogCriticalNotified) {
        session._asrBacklogCriticalNotified = true;
        new obsidian.Notice(t("There is a large transcription backlog; later segments have been moved to a background queue. Recording will not be interrupted."), 10000);
      }
    }
    return summary;
  }

  prepareLiveSegmentDescriptor(session, seg) {
    const continuationOffsetMs = Math.max(0, Number(session && session.continuationOffsetMs) || 0);
    const baseSegmentCount = Array.isArray(session && session.continuationBaseSegments) ? session.continuationBaseSegments.length : 0;
    const rawLocalIndex = Number(seg && seg.index);
    const localIndex = Number.isFinite(rawLocalIndex)
      ? Math.max(0, Math.floor(rawLocalIndex))
      : Math.max(0, Number(session && session._nextLiveSegmentIndex) || 0);
    session._nextLiveSegmentIndex = Math.max(Number(session._nextLiveSegmentIndex) || 0, localIndex + 1);
    const segmentIndex = baseSegmentCount + localIndex;
    const segNumber = segmentIndex + 1;
    const startOffsetMs = Math.max(0, Number(seg && seg.startOffsetMs) || 0);
    const endOffsetMs = Math.max(startOffsetMs, Number(seg && seg.endOffsetMs) || 0);
    const displayStartOffsetMs = startOffsetMs + continuationOffsetMs;
    const displayEndOffsetMs = endOffsetMs + continuationOffsetMs;
    const blobType = String(seg && seg.blob && seg.blob.type || "");
    const ext = String(seg && seg.ext || extFromMime(blobType) || "webm");
    const segmentAudioName = `${NS_AUDIO_PREFIX}-${session.sessionStamp}-seg${pad(segNumber)}.${ext}`;
    const segmentAudioPath = obsidian.normalizePath(`${this.getSegmentCacheFolder()}/${segmentAudioName}`);
    return {
      jobId: `${session.id}:${segmentIndex}`,
      queueTaskId: genId(),
      segmentIndex,
      segNumber,
      startOffsetMs,
      endOffsetMs,
      displayStartOffsetMs,
      displayEndOffsetMs,
      durationMs: Math.max(0, displayEndOffsetMs - displayStartOffsetMs),
      segmentAudioName,
      segmentAudioPath,
      ext,
      blobType,
      blobSize: Math.max(0, Number(seg && seg.blob && seg.blob.size) || 0),
      isFinal: !!(seg && seg.isFinal),
      source: (seg && seg.source) || session.captureMode || "mic",
      sourceUrl: String((seg && seg.sourceUrl) || (session && session.sourceMeta && session.sourceMeta.url) || ""),
      sourceTitle: String((seg && seg.sourceTitle) || (session && session.sourceMeta && session.sourceMeta.title) || ""),
      sourcePlatform: String((seg && seg.sourcePlatform) || (session && session.sourceMeta && session.sourceMeta.platform) || ""),
    };
  }

  buildLiveSegmentQueueTask(session, descriptor, patch = {}): TranscribeQueueTaskPayload & Partial<QueueTaskLifecycle> {
    const task: TranscribeQueueTaskPayload & Partial<QueueTaskLifecycle> = {
      id: descriptor.queueTaskId || genId(),
      type: "transcribe" as const,
      status: LIVE_ASR_TASK_STATUS,
      retries: 0,
      sessionId: session.id,
      mdPath: session.mdPath,
      audioPath: descriptor.segmentAudioPath,
      audioName: descriptor.segmentAudioName,
      segmentIndex: descriptor.segmentIndex,
      sourceAudioPath: session.masterAudioPath || "",
      sourceAudioName: session.masterAudioName || "",
      masterAudioPath: session.masterAudioPath || "",
      masterAudioName: session.masterAudioName || "",
      startOffsetMs: descriptor.displayStartOffsetMs,
      endOffsetMs: descriptor.displayEndOffsetMs,
      audioStartOffsetMs: descriptor.startOffsetMs,
      audioEndOffsetMs: descriptor.endOffsetMs,
      mode: session.mode,
      isFinal: !!descriptor.isFinal,
      liveSegment: true,
      source: descriptor.source || "",
      sourceUrl: descriptor.sourceUrl || "",
      sourceTitle: descriptor.sourceTitle || "",
      sourcePlatform: descriptor.sourcePlatform || "",
      captureMode: session.captureMode || "",
      audioChannelMode: normalizeAudioChannelMode(session.audioChannelMode || this.host.getSettings().audioChannelMode),
      audioChannelCount: session.captureMode === "mic" ? Math.max(1, Number(session.audioChannelCount) || 1) : 1,
      audioChannelRuntimeMode: session.audioChannelRuntimeMode || initialAudioChannelRuntimeMode(
        session.audioChannelMode || this.host.getSettings().audioChannelMode,
        session.audioChannelCount,
      ),
      lastError: "",
    };
    return Object.assign(task, patch || {});
  }

  async registerLiveSegmentQueueTask(session, descriptor) {
    const task = await this.host.addQueueTask(this.buildLiveSegmentQueueTask(session, descriptor));
    descriptor.queueTaskId = task.id;
    return task;
  }

  async keepLiveSegmentQueueTaskForRetry(session, descriptor, error) {
    const message = getErrorMessage(error);
    const task = await this.host.addQueueTask(this.buildLiveSegmentQueueTask(session, descriptor, {
      status: "pending",
      sourceAudioPath: session.masterAudioPath || "",
      sourceAudioName: session.masterAudioName || "",
      masterAudioPath: session.masterAudioPath || "",
      masterAudioName: session.masterAudioName || "",
      deferredReason: error && error.deferReason || "",
      lastError: message,
    }));
    descriptor.queueTaskId = task.id;
    return task;
  }

  async markLiveSegmentQueueTaskRunning(descriptor) {
    const taskId = descriptor && descriptor.queueTaskId;
    if (!taskId) return;
    const task = this.host.queueTasks().find((item) => item && item.id === taskId);
    if (!task || task.status !== LIVE_ASR_TASK_STATUS) return;
    await this.host.updateQueueTask(taskId, { status: "running", lastError: "" });
  }

  async removeLiveSegmentQueueTask(descriptor) {
    const taskId = descriptor && descriptor.queueTaskId;
    if (!taskId || !this.host.queueTasks().some((task) => task && task.id === taskId)) return;
    await this.host.removeQueueTask(taskId);
  }

  queueLiveSegmentPersistence(session, descriptor, blob) {
    const jobs = this.getLiveAsrJobs(session);
    jobs.set(descriptor.jobId, {
      id: descriptor.jobId,
      queuedAtMs: Date.now(),
      sizeBytes: descriptor.blobSize,
      durationMs: descriptor.durationMs,
      state: "spooling",
    });
    session.activeSegmentJobs = (Number(session.activeSegmentJobs) || 0) + 1;
    const summary = this.updateLiveAsrBacklogPolicy(session, "enqueue");
    void this.host.diagnostics.logDiagnostic("info", "asr.live_segment_enqueued", t("Recording segment entered the on-disk transcription queue"), {
      segmentIndex: descriptor.segmentIndex,
      durationMs: descriptor.durationMs,
      sizeBytes: descriptor.blobSize,
      pendingCount: summary && summary.count,
      pendingDurationMs: summary && summary.totalDurationMs,
      ...this.host.getRecorderBufferSummary(),
    });

    const previousPersist = session.segmentPersistQueue || Promise.resolve();
    const persistTask = Promise.resolve(previousPersist).catch(() => undefined).then(async () => {
      try {
        await this.ensureSegmentCacheFolder();
        const ab = await blob.arrayBuffer();
        await this.host.vault.adapter.writeBinary(descriptor.segmentAudioPath, ab);
      } catch (e) {
        const job = jobs.get(descriptor.jobId);
        if (job) job.state = "queued";
        this.updateLiveAsrBacklogPolicy(session, "persist-failed");
        await this.host.diagnostics.logDiagnostic("error", "asr.segment_cache_write_failed", t("Failed to write the recording segment to the cache; the segment is temporarily kept in memory as a fallback"), {
          segmentIndex: descriptor.segmentIndex,
          durationMs: descriptor.durationMs,
          sizeBytes: descriptor.blobSize,
          error: diagnosticError(e),
        });
        if (!session._segmentCacheWriteFailureNotified) {
          session._segmentCacheWriteFailureNotified = true;
          new obsidian.Notice(t("Failed to write the recording segment cache; this segment will be kept in memory temporarily and processing will continue. Please check the vault disk space."), 10000);
        }
        return { persisted: false, fallbackBlob: blob, error: e };
      }
      let queueTask = null;
      try {
        // 音频一旦安全落盘，就立即登记任务。即使 Obsidian 此后崩溃，重启时也能从路径恢复。
        queueTask = await this.registerLiveSegmentQueueTask(session, descriptor);
      } catch (e) {
        await this.host.diagnostics.logDiagnostic("error", "asr.segment_task_persist_failed", t("Recording segment was written to disk, but persistent task registration failed"), {
          segmentIndex: descriptor.segmentIndex,
          audioPath: descriptor.segmentAudioPath,
          error: diagnosticError(e),
        });
        if (!session._segmentTaskPersistFailureNotified) {
          session._segmentTaskPersistFailureNotified = true;
          new obsidian.Notice(t("The recording segment was saved, but registering the recovery task failed; transcription will continue for this session, so please do not force-quit Obsidian."), 10000);
        }
      }
      const job = jobs.get(descriptor.jobId);
      if (job) job.state = "queued";
      this.updateLiveAsrBacklogPolicy(session, "persisted");
      return { persisted: true, fallbackBlob: null, error: null, queueTaskId: queueTask && queueTask.id || "" };
    });
    session.segmentPersistQueue = persistTask.then(() => undefined, () => undefined);
    return persistTask;
  }
  async saveMasterAudio(session, seg) {
    if (!session || session.masterAudioPath || !seg || !seg.masterBlob) return;
    try {
      const ext = seg.masterExt || extFromMime(seg.masterMime || seg.masterBlob.type || "") || seg.ext || "webm";
      await ensureVaultFolder({ vault: this.host.vault }, this.host.getSettings().audioFolder);
      const target = findAvailableVaultPath({ vault: this.host.vault }, obsidian.normalizePath(`${this.host.getSettings().audioFolder}/${NS_AUDIO_PREFIX}-${session.sessionStamp}.${ext}`));
      if (!target) throw new Error(t("Could not build a path for the full recording file"));
      const ab = await seg.masterBlob.arrayBuffer();
      await this.host.vault.createBinary(target, ab);
      session.masterAudioPath = target;
      session.masterAudioName = target.split("/").pop() || target;
      const oldNames = new Set();
      for (const item of session.segments || []) {
        if (item.audioName) oldNames.add(item.audioName);
        if (item.segmentAudioName) oldNames.add(item.segmentAudioName);
        item.audioName = session.masterAudioName;
        item.audioPath = session.masterAudioPath;
      }
      if (session.realtimeOutline && oldNames.size) {
        let outline = String(session.realtimeOutline);
        for (const oldName of oldNames) {
          if (oldName && oldName !== session.masterAudioName) {
            outline = outline.replace(new RegExp("\\[\\[" + escapeRegExp(oldName) + "\\|", "g"), "[[" + session.masterAudioName + "|");
          }
        }
        session.realtimeOutline = outline;
      }
      if (session.realtimeOutlineState && oldNames.size) {
        const state = normalizeRealtimeOutlineState(session.realtimeOutlineState, session.realtimeOutline, session.realtimeOutlineMemory);
        for (const node of state.nodes || []) {
          let anchor = String(node.anchor || "");
          for (const oldName of oldNames) {
            if (oldName && oldName !== session.masterAudioName) {
              anchor = anchor.replace(new RegExp("\\[\\[" + escapeRegExp(oldName) + "\\|", "g"), "[[" + session.masterAudioName + "|");
            }
          }
          node.anchor = anchor;
          node.time = getRealtimeOutlineAnchorTime(anchor);
        }
        session.realtimeOutlineState = state;
      }
      if (session.realtimeOutlineMemory && oldNames.size) {
        let memory = String(session.realtimeOutlineMemory);
        for (const oldName of oldNames) {
          if (oldName && oldName !== session.masterAudioName) {
            memory = memory.replace(new RegExp("\\[\\[" + escapeRegExp(oldName) + "\\|", "g"), "[[" + session.masterAudioName + "|");
          }
        }
        session.realtimeOutlineMemory = memory;
      }
    } catch (e) {
      console.error("[QnALog] master audio write failed", e);
      new obsidian.Notice(`${t("Failed to write the full recording: ")}${(e && e.message) || e}`, 8000);
    }
  }
  startMasterAudioSave(session, seg) {
    if (!session || !seg || !seg.masterBlob) return Promise.resolve();
    const masterInput = {
      masterBlob: seg.masterBlob,
      masterMime: seg.masterMime,
      masterExt: seg.masterExt,
      ext: seg.ext,
    };
    return this.saveMasterAudio(session, masterInput).finally(() => { masterInput.masterBlob = null; });
  }

  getAsrServiceCircuitKey() {
    try {
      const provider = resolveTranscribeProvider({ settings: this.host.getSettings() });
      const endpoint = String(provider && provider.endpoint || "").trim();
      let host = endpoint;
      try { host = new URL(endpoint).host || endpoint; } catch { /* keep normalized raw endpoint */ }
      return [provider && provider.id || "", host, provider && provider.model || ""].join("|");
    } catch {
      return "unknown";
    }
  }

  getAsrServiceCircuitState() {
    const key = this.getAsrServiceCircuitKey();
    if (this.asrServiceCircuitKey !== key) {
      this.asrServiceCircuitKey = key;
      this.asrServiceCircuitState = createLiveAsrCircuitState();
    }
    if (!this.asrServiceCircuitState) this.asrServiceCircuitState = createLiveAsrCircuitState();
    return this.asrServiceCircuitState;
  }

  isAsrServiceCircuitOpen() {
    return isLiveAsrCircuitOpen(this.getAsrServiceCircuitState());
  }

  getAsrServiceRetryDelayMs() {
    const state = this.getAsrServiceCircuitState();
    const openDelayMs = Math.max(0, Number(state.openUntilMs) || 0) - Date.now() + 1000;
    if (openDelayMs > 1000) return openDelayMs;
    const failures = Math.max(0, Number(state.consecutiveFailures) || 0);
    if (failures > 0) return Math.min(2 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, failures - 1)));
    return 1500;
  }

  recordAsrServiceAttemptFailure(error) {
    if (!isAsrTransportError(error)) return this.getAsrServiceCircuitState();
    this.asrServiceCircuitState = recordLiveAsrFailure(
      this.getAsrServiceCircuitState(),
      getErrorMessage(error),
      true,
    );
    return this.asrServiceCircuitState;
  }

  recordAsrServiceAttemptSuccess() {
    const previousFailures = Math.max(0, Number(this.getAsrServiceCircuitState().consecutiveFailures) || 0);
    this.asrServiceCircuitState = recordLiveAsrSuccess();
    if (previousFailures > 0) {
      void this.host.diagnostics.logDiagnostic("info", "asr.service_circuit_recovered", t("Transcription service connection recovered"), { previousFailures });
    }
  }

  resetAsrServiceCircuitForManualRetry(source = "manual") {
    const previousFailures = Math.max(0, Number(this.getAsrServiceCircuitState().consecutiveFailures) || 0);
    this.asrServiceCircuitState = recordLiveAsrSuccess();
    if (previousFailures > 0) {
      void this.host.diagnostics.logDiagnostic("info", "asr.service_circuit_manual_probe", t("User-initiated transcription retry; one immediate probe allowed"), {
        source,
        previousFailures,
      });
    }
  }

  recordLiveAsrAttemptSuccess(session) {
    if (!session) return;
    const previousFailures = Math.max(0, Number(session.asrCircuitState && session.asrCircuitState.consecutiveFailures) || 0);
    session.asrCircuitState = recordLiveAsrSuccess();
    this.recordAsrServiceAttemptSuccess();
    if (previousFailures > 0) {
      void this.host.diagnostics.logDiagnostic("info", "asr.live_circuit_recovered", t("Live transcription service recovered"), { previousFailures });
    }
  }

  recordLiveAsrAttemptFailure(session, error, descriptor) {
    if (!session || !isTransientAsrError(error)) return;
    const beforeOpen = isLiveAsrCircuitOpen(session.asrCircuitState || createLiveAsrCircuitState());
    session.asrCircuitState = recordLiveAsrFailure(
      session.asrCircuitState || createLiveAsrCircuitState(),
      getErrorMessage(error),
      true,
    );
    if (isAsrTransportError(error)) this.recordAsrServiceAttemptFailure(error);
    const afterOpen = isLiveAsrCircuitOpen(session.asrCircuitState);
    if (!beforeOpen && afterOpen) {
      session.hasDeferredAsrJobs = true;
      void this.host.diagnostics.logDiagnostic("warn", "asr.live_circuit_opened", t("Consecutive transcription failures; live requests are temporarily circuit-broken"), {
        segmentIndex: descriptor && descriptor.segmentIndex,
        consecutiveFailures: session.asrCircuitState.consecutiveFailures,
        openUntilMs: session.asrCircuitState.openUntilMs,
        error: diagnosticError(error),
      });
      if (!session._asrCircuitOpenNotified) {
        session._asrCircuitOpenNotified = true;
        new obsidian.Notice(t("The transcription service failed repeatedly; later segments will be safely queued first and retried automatically later. Recording is not affected."), 10000);
      }
    }
  }

  /** 录音问题状态：set/clear/get 三个入口，读的是当前问题的快照。 */
  setRecordingIssue(kind, patch) {
    const current = this.recordingIssue && typeof this.recordingIssue === "object"
      ? this.recordingIssue as { kind?: string; at?: number; [key: string]: unknown }
      : {};
    const issuePatch = patch && typeof patch === "object"
      ? patch as { kind?: string; at?: number; [key: string]: unknown }
      : {};
    this.recordingIssue = makeRecordingIssue(kind || current.kind || "service", Object.assign({}, current, issuePatch, {
      kind: kind || current.kind || "service",
      at: issuePatch.at ? issuePatch.at : (current.at || Date.now()),
    }));
    try { this.host.requestOutlineRefresh(); } catch { /* intentionally empty */ }
    try { this.host.requestBubbleUpdate(); } catch { /* intentionally empty */ }
  }
  clearRecordingIssue(kind = undefined) {
    if (!this.recordingIssue || typeof this.recordingIssue !== "object") return;
    const issue = this.recordingIssue as { kind?: string };
    if (kind && issue.kind !== kind) return;
    this.recordingIssue = null;
    try { this.host.requestOutlineRefresh(); } catch { /* intentionally empty */ }
    try { this.host.requestBubbleUpdate(); } catch { /* intentionally empty */ }
  }
  async closeStreamingForDiscard(session) {
    if (!session) return;
    if (session.pcmEncoder) {
      try { session.pcmEncoder.stop(); } catch { /* intentionally empty */ }
      session.pcmEncoder = null;
    }
    if (session.streamingClient) {
      try {
        if (typeof session.streamingClient._safeClose === "function") session.streamingClient._safeClose();
        else if (typeof session.streamingClient.finish === "function") await session.streamingClient.finish();
      } catch (e) {
        console.warn("[QnALog] close streaming client for discard failed", e);
      }
      session.streamingClient = null;
    }
    try { await this.host.removeLiveTranscriptBlock(session.mdPath, session.id); } catch { /* intentionally empty */ }
  }

  /**
   * 删掉本次短录音在结尾创建的纪要（只保留它自己的段落块）。
   *
   * 两种短录音级别共用：时长 < 3 秒丢弃音频，3–10 秒保留音频。纪要文件只有这一段内容时
   * 移到废纸篓，否则只摘掉这一段（续录目标笔记本来就存在，不会走到这里）。
   */
  async discardShortRecordingNote(session) {
    await this.closeStreamingForDiscard(session);
    const file = this.host.vault.getAbstractFileByPath(session.mdPath);
    if (!(file instanceof obsidian.TFile)) return;
    const cur = await this.host.vault.read(file);
    const range = findSessionNoteBlock(cur, session.id);
    if (!range) return;
    const before = cur.slice(0, range.start).replace(/\n+$/, "\n");
    const after = cur.slice(range.end).replace(/^\n+/, "");
    const next = before + (after ? "\n" + after : "");
    if (!next.trim()) await this.host.fileManager.trashFile(file);
    else if (next !== cur) await this.host.vault.modify(file, next);
  }

  setSessionWorkProgress(session, patch) {
    if (!session) return;
    session.workProgress = Object.assign({}, session.workProgress || {}, patch || {}, {
      updatedAt: new Date().toISOString(),
    });
    this.host.syncImportBusyFromSessionProgress(session);
    try { this.host.requestOutlineRefresh(); } catch { /* intentionally empty */ }
  }

  clearSessionWorkProgress(session) {
    if (!session) return;
    delete session.workProgress;
    try { this.host.requestOutlineRefresh(); } catch { /* intentionally empty */ }
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of service dynamic-typing region */
