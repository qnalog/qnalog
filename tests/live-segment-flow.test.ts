import { beforeEach, describe, expect, it, vi } from "vitest";

const { transcribeMock, channelsMock, loadVocabMock, notices } = vi.hoisted(() => ({
  transcribeMock: vi.fn(),
  channelsMock: vi.fn(),
  loadVocabMock: vi.fn(),
  notices: [] as Array<[string, number | undefined]>,
}));

vi.mock("obsidian", () => ({
  Notice: class { constructor(message: string, timeout?: number) { notices.push([String(message), timeout]); } },
  normalizePath: (value: string) => String(value || "").replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, ""),
}));
vi.mock("../src/asr/transcribe", () => ({ transcribeAudio: transcribeMock }));
vi.mock("../src/asr/channel-transcription", () => ({ transcribeAudioByChannels: channelsMock }));
vi.mock("../src/vocabulary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/vocabulary")>()),
  loadVocabularyGroups: loadVocabMock,
}));
vi.mock("../src/ui/modals", () => ({ SpeakerNameConfirmModal: class {} }));

import { SessionFinalizeService } from "../src/notes/session-finalize-service";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { t } from "../src/shared/i18n";
import { labelText } from "../src/shared/note-labels";
import { NS_AUDIO_PREFIX, nsMarker } from "../src/shared/namespace";
import { parseVocabularyGroups } from "../src/vocabulary";
import { normalizePath } from "obsidian";
import { getAudioTimeLink } from "../src/notes/audio-reference-text";

function makeHost() {
  const progress: unknown[] = [];
  const diagnostics: unknown[][] = [];
  const blocks: string[] = [];
  const host = {
    app: { vault: { adapter: { writeBinary: vi.fn(async () => undefined) } } },
    settings: { ...DEFAULT_SETTINGS },
    profiles: { getActiveTranscribeProfile: vi.fn(() => ({ id: "profile", model: "model", transcribeMode: "http" })) },
    asrPipeline: {
      saveMasterAudio: vi.fn(async () => undefined), setSessionWorkProgress: vi.fn((_s, p) => progress.push(p)),
      closeStreamingForDiscard: vi.fn(async () => undefined), getSegmentCacheFolder: vi.fn(() => "Cache/segs"),
      ensureSegmentCacheFolder: vi.fn(async () => undefined), markLiveSegmentQueueTaskRunning: vi.fn(async () => undefined),
      getLiveAsrJobs: vi.fn(() => new Map()), updateLiveAsrBacklogPolicy: vi.fn(), isAsrServiceCircuitOpen: vi.fn(() => false),
      recordLiveAsrAttemptFailure: vi.fn(), recordLiveAsrAttemptSuccess: vi.fn(), getLiveAsrBacklogSummary: vi.fn(() => ({ totalDurationMs: 7000 })),
      setRecordingIssue: vi.fn(), clearRecordingIssue: vi.fn(), markSessionAsrJobsDeferred: vi.fn(),
      keepLiveSegmentQueueTaskForRetry: vi.fn(async () => ({ id: "task-1" })), removeLiveSegmentQueueTask: vi.fn(async () => undefined),
    },
    readVaultAudioBlob: vi.fn(async () => null),
    meetingWorkbench: { removeLiveTranscriptBlock: vi.fn(async () => undefined) },
    diagnostics: { logDiagnostic: vi.fn(async (...args) => { diagnostics.push(args); }) },
    noteWriter: { insertBeforeSegmentsEnd: vi.fn(async (_path, block) => { blocks.push(block); }) },
    requestOutlineRefresh: vi.fn(), outline: { scheduleRealtimeOutline: vi.fn() },
  };
  return { host, progress, diagnostics, blocks, service: new SessionFinalizeService(host as never) };
}

function makeSession(extra: Record<string, unknown> = {}) {
  return {
    id: "s1", sessionStamp: "20261009-100000", mdPath: "Notes/s.md", mode: "synthesis",
    startedAt: "2026-10-09T10:00:00.000Z", segments: [] as Array<Record<string, unknown>>,
    finalized: false, captureMode: "mic", ...extra,
  } as never;
}
function makeSegment(extra: Record<string, unknown> = {}) {
  return { startOffsetMs: 1000, endOffsetMs: 4000, ext: "webm", blob: new Blob(["audio"], { type: "audio/webm" }), ...extra } as never;
}

beforeEach(() => {
  vi.clearAllMocks(); notices.length = 0;
  loadVocabMock.mockResolvedValue(parseVocabularyGroups(""));
  transcribeMock.mockResolvedValue({ text: "recognized text", rawText: "recognized text", providerId: "provider", units: [] });
  channelsMock.mockResolvedValue({ text: "recognized text", rawText: "recognized text", providerId: "provider", units: [], actualChannelCount: 2, processedChannelCount: 2, usedMultichannel: true, separation: "separated", deduplicatedParts: 0, errors: [] });
});

describe("live segment consumer contract", () => {
  it("returns without touching the host for an absent session", async () => {
    const { service, host } = makeHost();
    await expect(service.processSegment(null as never, makeSegment())).resolves.toBeUndefined();
    expect(host.asrPipeline.setSessionWorkProgress).not.toHaveBeenCalled();
    expect(host.noteWriter.insertBeforeSegmentsEnd).not.toHaveBeenCalled();
  });

  it("saves master-only final audio and advances finalization without transcribing", async () => {
    const { service, host, progress } = makeHost();
    const session = makeSession({ segments: [{}] });
    const seg = makeSegment({ isFinal: true, masterOnly: true, masterAudioSavePromise: Promise.resolve() });
    await service.processSegment(session, seg);
    expect(host.asrPipeline.saveMasterAudio).not.toHaveBeenCalled();
    expect(progress).toContainEqual(expect.objectContaining({ stage: "transcribe-finalized", percent: null, label: t("Finalizing transcription") }));
    expect(host.diagnostics.logDiagnostic).toHaveBeenCalledWith("warn", "recording.master_only_finalize", expect.any(String), { mode: "synthesis", segmentCount: 1, endOffsetMs: 4000 });
    expect(host.requestOutlineRefresh).toHaveBeenCalledOnce();
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("discards short recordings after waiting for master audio", async () => {
    const { service, host } = makeHost();
    await service.processSegment(makeSession({ shortRecordingTier: "discard" }), makeSegment({ masterAudioSavePromise: Promise.resolve() }));
    expect(host.asrPipeline.closeStreamingForDiscard).toHaveBeenCalledOnce();
    expect(host.noteWriter.insertBeforeSegmentsEnd).not.toHaveBeenCalled();
    expect(host.asrPipeline.markLiveSegmentQueueTaskRunning).not.toHaveBeenCalled();
  });

  it("computes continuation numbering, offsets, audio links and persisted note content", async () => {
    const { service, host, blocks, progress } = makeHost();
    const session = makeSession({ continuationOffsetMs: 5000, continuationBaseSegments: [{}, {}], segments: [{}] });
    await service.processSegment(session, makeSegment({}));
    const record = session.segments[1];
    expect(record).toMatchObject({ index: 3, startOffsetMs: 6000, endOffsetMs: 9000, audioStartOffsetMs: 1000, audioEndOffsetMs: 4000, segmentAudioName: `${NS_AUDIO_PREFIX}-20261009-100000-seg04.webm`, segmentAudioPath: normalizePath("Cache/segs/" + `${NS_AUDIO_PREFIX}-20261009-100000-seg04.webm`) });
    expect(record.source).toBe("mic");
    expect(host.app.vault.adapter.writeBinary).toHaveBeenCalledOnce();
    expect(blocks[0]).toContain(labelText("segment", 4));
    expect(blocks[0]).toContain(getAudioTimeLink(record.audioName, 1000));
    expect(blocks[0]).toContain("recognized text");
    expect(progress.at(-1)).toMatchObject({ stage: "transcribed", label: t("Transcribed {0} segments").replace("{0}", "2") });
  });

  it("uses streaming text, vocabulary correction and source priority, then clears the client", async () => {
    const { service, host } = makeHost();
    loadVocabMock.mockResolvedValue(parseVocabularyGroups("## 易错写法\n- 错字 => 正字"));
    host.profiles.getActiveTranscribeProfile.mockReturnValue({ id: "profile", model: "model", transcribeMode: "streaming" } as never);
    const session = makeSession({ importTranscribeProviderId: "import-provider", streamingClient: { finish: vi.fn(), getFullText: () => "错字。第二句。" }, pcmEncoder: { stop: vi.fn() } });
    await service.processSegment(session, makeSegment({ source: "virtualCable" }));
    expect(session.segments[0]).toMatchObject({ text: "正字。第二句。", source: "virtualCable" });
    expect(session.segments[0].transcript.revisions.at(-1)).toMatchObject({ source: "streaming-transcript", providerId: "profile" });
    expect(session.streamingClient).toBeNull();
    expect(session.pcmEncoder).toBeNull();
    expect(host.meetingWorkbench.removeLiveTranscriptBlock).toHaveBeenCalledWith("Notes/s.md", "s1");
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("does not send a streaming provider to HTTP when its client is absent", async () => {
    const { service, host } = makeHost();
    host.profiles.getActiveTranscribeProfile.mockReturnValue({ id: "stream", transcribeMode: "streaming" } as never);
    const session = makeSession();
    await service.processSegment(session, makeSegment());
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(host.asrPipeline.keepLiveSegmentQueueTaskForRetry).not.toHaveBeenCalled();
    expect(session.segments[0].error).toBe(t("The streaming transcription connection could not be established. Check your API key and network, then record again."));
  });

  it("defers backlog work and preserves its retry task marker", async () => {
    const { service, host, blocks, progress } = makeHost();
    await service.processSegment(makeSession({ asrDeferredMode: true }), makeSegment());
    const record = host.noteWriter.insertBeforeSegmentsEnd.mock.calls[0][1];
    expect(host.asrPipeline.markSessionAsrJobsDeferred).toHaveBeenCalledOnce();
    expect(host.asrPipeline.keepLiveSegmentQueueTaskForRetry).toHaveBeenCalledOnce();
    expect(record).toContain(nsMarker("transcribe-task", "task-1"));
    expect(progress.at(-1)).toMatchObject({ stage: "transcribed", label: t("Cached {0} segments").replace("{0}", "1") });
    expect(host.asrPipeline.removeLiveSegmentQueueTask).not.toHaveBeenCalled();
    expect(host.asrPipeline.setRecordingIssue).not.toHaveBeenCalled();
    expect(blocks).toHaveLength(1);
  });

  it("records batch success and resolves MIME from the blob", async () => {
    const { service, host } = makeHost();
    const blob = new Blob(["audio"], { type: "audio/custom" });
    await service.processSegment(makeSession(), makeSegment({ blob }));
    expect(transcribeMock).toHaveBeenCalledWith(host, blob, "audio/custom");
    expect(host.asrPipeline.recordLiveAsrAttemptSuccess).toHaveBeenCalledOnce();
    expect(host.asrPipeline.clearRecordingIssue).toHaveBeenCalledWith("network");
    expect(host.asrPipeline.clearRecordingIssue).toHaveBeenCalledWith("service");
    expect(host.asrPipeline.removeLiveSegmentQueueTask).toHaveBeenCalledOnce();
  });

  it("keeps failed batch work queued and exposes the failure in the note and issue state", async () => {
    const { service, host, diagnostics } = makeHost();
    transcribeMock.mockRejectedValueOnce(new Error("boom"));
    await service.processSegment(makeSession(), makeSegment());
    expect(host.asrPipeline.recordLiveAsrAttemptFailure).toHaveBeenCalledOnce();
    expect(host.asrPipeline.keepLiveSegmentQueueTaskForRetry).toHaveBeenCalledOnce();
    expect(diagnostics.flat().join(" ")).toContain("asr.segment_failed");
    expect(host.asrPipeline.setRecordingIssue).toHaveBeenCalledWith("service", expect.objectContaining({ message: "boom" }));
    expect(notices.at(-1)?.[1]).toBe(7000);
  });

  it("treats long empty responses as retryable soft failures", async () => {
    const { service, host, diagnostics } = makeHost();
    transcribeMock.mockResolvedValueOnce({ text: "", rawText: "", providerId: "provider", units: [] });
    const session = makeSession();
    await service.processSegment(session, makeSegment({ endOffsetMs: 40_000 }));
    expect(host.asrPipeline.recordLiveAsrAttemptFailure).toHaveBeenCalledOnce();
    expect(host.asrPipeline.keepLiveSegmentQueueTaskForRetry).toHaveBeenCalledOnce();
    expect(diagnostics.flat().join(" ")).toContain("asr.segment_empty");
    expect(session.segments[0].error).toBe(t("Transcription returned an empty result (the service responded but returned no text)"));
  });

  it("reports short empty results once and writes the no-content label", async () => {
    const { service, host, blocks, diagnostics } = makeHost();
    transcribeMock.mockResolvedValue({ text: "", rawText: "", providerId: "provider", units: [] });
    const session = makeSession();
    await service.processSegment(session, makeSegment());
    await service.processSegment(session, makeSegment({ startOffsetMs: 5000, endOffsetMs: 8000 }));
    expect(session._emptyAsrNotified).toBe(true);
    expect(notices.filter(([message]) => message === t("No speech detected in this segment. Go to \"Settings → General → Audio input\" to test the selected device."))).toHaveLength(1);
    expect(diagnostics.flat().join(" ")).toContain("asr.empty_result");
    expect(blocks[0]).toContain(labelText("noContentSegment"));
  });

  it("uses the channel transcription path for multichannel microphone capture", async () => {
    const { service, host } = makeHost();
    host.settings.audioChannelMode = "multichannel" as never;
    const session = makeSession({ audioChannelCount: 2 });
    await service.processSegment(session, makeSegment());
    expect(channelsMock).toHaveBeenCalledWith(host, expect.any(Blob), "audio/webm", 4, { requireSeparatedChannels: false });
    expect(session.audioChannelCount).toBe(2);
    expect(session.channelSeparationMode).toBe("device-channels");
    expect(session._channelSpeakersNotified).toBe(true);
  });

  it("propagates note-write failure after recording the segment but before cleanup", async () => {
    const { service, host } = makeHost();
    const failure = new Error("note write failed");
    host.noteWriter.insertBeforeSegmentsEnd.mockRejectedValueOnce(failure);
    const session = makeSession();
    await expect(service.processSegment(session, makeSegment())).rejects.toBe(failure);
    expect(session.segments).toHaveLength(1);
    expect(host.asrPipeline.removeLiveSegmentQueueTask).not.toHaveBeenCalled();
    expect(host.asrPipeline.setSessionWorkProgress).toHaveBeenCalledTimes(1);
  });

  it("keeps the streaming failure placeholder without creating an HTTP retry", async () => {
    const { service, host, blocks, diagnostics } = makeHost();
    host.profiles.getActiveTranscribeProfile.mockReturnValue({ id: "stream", model: "m", transcribeMode: "streaming" } as never);
    const session = makeSession({ streamingFullText: "residual", streamingClient: { finish: vi.fn().mockRejectedValue(new Error("ws closed")), getFullText: () => "" } });
    await service.processSegment(session, makeSegment());
    expect(session.segments[0].error).toBe("ws closed");
    expect(blocks[0]).toContain("ws closed");
    expect(host.asrPipeline.keepLiveSegmentQueueTaskForRetry).not.toHaveBeenCalled();
    expect(host.asrPipeline.removeLiveSegmentQueueTask).toHaveBeenCalledOnce();
    expect(diagnostics.flat().join(" ")).toContain("asr.segment_failed");
  });
});

function sessionError(host: ReturnType<typeof makeHost>["host"]): string {
  const calls = host.noteWriter.insertBeforeSegmentsEnd.mock.calls;
  return calls.length ? String(calls.at(-1)?.[1]) : "";
}
