import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class TFile {},
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
}));

import { attachTextTranscript, attachTranscriptResult, getTranscriptSourceRevision } from "../src/transcript/session-transcript";
import { bindTranscriptSegmentToAudio } from "../src/transcript/audio-binding";
import { readTranscriptBlocks, replaceTranscriptBlock, serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
import { readSourceIntegrity, type SourceIntegrity } from "../src/transcript/source-integrity";
import { commitContinuationFlow } from "../src/notes/continuation-commit-flow";
import { syncTranscriptAudioSource } from "../src/notes/session-finalize-sources";
import type { RecordingSession, Segment } from "../src/shared/types";

const INTEGRITY: SourceIntegrity = {
  algo: "sha256",
  sha256: "a".repeat(64),
  bytes: 1234,
  at: "2026-10-23T10:00:00.000Z",
};

function asrSegment(sourceId = "session-1", audioPath = "QnALog/.cache/segments/seg-1.webm"): Segment {
  return attachTranscriptResult({
    index: 0,
    startOffsetMs: 0,
    endOffsetMs: 4000,
    audioStartOffsetMs: 0,
    audioEndOffsetMs: 4000,
    segmentAudioPath: audioPath,
    segmentAudioName: audioPath.split("/").pop(),
    text: "Hello there.",
  }, sourceId, {
    text: "Hello there.",
    rawText: "Hello there.",
    providerId: "test",
    units: [{ rawText: "Hello there.", normalizedText: "Hello there.", speakerId: null, speakerName: null, startMs: 0, endMs: 1000, timing: "provider" }],
  } as never, "asr");
}

function noteWith(segment: Segment): string {
  return `# Note\n\n${serializeTranscriptBlock(segment, "### Segment 1", String(segment.text || ""))}\n`;
}

describe("readSourceIntegrity", () => {
  it("accepts a well-formed record and returns a copy", () => {
    const value = readSourceIntegrity({ ...INTEGRITY, extra: 1 });
    expect(value).toEqual(INTEGRITY);
  });

  it.each([
    ["null", null],
    ["array", []],
    ["wrong algo", { ...INTEGRITY, algo: "md5" }],
    ["short digest", { ...INTEGRITY, sha256: "abc" }],
    ["upper-case digest", { ...INTEGRITY, sha256: "A".repeat(64) }],
    ["negative bytes", { ...INTEGRITY, bytes: -1 }],
    ["fractional bytes", { ...INTEGRITY, bytes: 1.5 }],
    ["string bytes", { ...INTEGRITY, bytes: "1234" }],
    ["bad date", { ...INTEGRITY, at: "not a date" }],
  ])("rejects %s", (_label, value) => {
    expect(readSourceIntegrity(value)).toBeNull();
  });
});

describe("transcript ledger sourceIntegrity field", () => {
  it("reads an old ledger without the field and rewrites it unchanged", () => {
    const segment = asrSegment();
    const markdown = noteWith(segment);
    const [block] = readTranscriptBlocks(markdown);
    expect(block.segment.transcript).not.toHaveProperty("sourceIntegrity");
    const rewritten = replaceTranscriptBlock(markdown, block, block.segment, block.visibleBlock);
    const [reread] = readTranscriptBlocks(rewritten);
    expect(reread.segment.transcript).toEqual(block.segment.transcript);
    expect(reread.segment.transcript).not.toHaveProperty("sourceIntegrity");
    // The hidden ledger payload is byte-identical; only the visible layout is normalized by the rewrite.
    const payloadOf = (text: string) => text.match(/data-qnalog-transcript-data="([^"]+)"/)?.[1];
    expect(payloadOf(rewritten)).toBe(payloadOf(markdown));
  });

  it("ignores a malformed sourceIntegrity value without rejecting the record", () => {
    const segment = asrSegment();
    const malformed = { ...segment, transcript: { ...segment.transcript!, sourceIntegrity: { algo: "sha256", sha256: "zz", bytes: "x" } } } as unknown as Segment;
    const markdown = noteWith(malformed);
    const blocks = readTranscriptBlocks(markdown);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].segment.transcript).not.toHaveProperty("sourceIntegrity");
    expect(blocks[0].segment.transcript?.revisions).toEqual(segment.transcript?.revisions);
  });

  it("round-trips a valid sourceIntegrity value", () => {
    const segment = asrSegment();
    const withIntegrity = { ...segment, transcript: { ...segment.transcript!, sourceIntegrity: INTEGRITY } };
    const [block] = readTranscriptBlocks(noteWith(withIntegrity));
    expect(block.segment.transcript?.sourceIntegrity).toEqual(INTEGRITY);
  });

  it("does not change the transcript source revision", () => {
    const segment = asrSegment();
    const withIntegrity = { ...segment, transcript: { ...segment.transcript!, sourceIntegrity: INTEGRITY } };
    expect(getTranscriptSourceRevision([withIntegrity])).toBe(getTranscriptSourceRevision([segment]));
  });
});

describe("bindTranscriptSegmentToAudio with integrity", () => {
  const masterPath = "QnALog/Audio/qnalog-20261023-100000.webm";
  const masterName = "qnalog-20261023-100000.webm";

  it("writes the integrity record when binding to the master recording", () => {
    const bound = bindTranscriptSegmentToAudio(asrSegment(), masterPath, masterName, INTEGRITY);
    expect(bound.transcript?.sourcePath).toBe(masterPath);
    expect(bound.transcript?.sourceIntegrity).toEqual(INTEGRITY);
  });

  it("adds the record to an already-bound segment without bumping normalizationRevision", () => {
    const bound = bindTranscriptSegmentToAudio(asrSegment(), masterPath, masterName);
    expect(bound.transcript).not.toHaveProperty("sourceIntegrity");
    const again = bindTranscriptSegmentToAudio(bound, masterPath, masterName, INTEGRITY);
    expect(again).not.toBe(bound);
    expect(again.transcript?.sourceIntegrity).toEqual(INTEGRITY);
    expect(again.transcript?.revisions).toBe(bound.transcript?.revisions);
    expect(getTranscriptSourceRevision([again])).toBe(getTranscriptSourceRevision([bound]));
  });

  it("returns the same segment when nothing changed", () => {
    const bound = bindTranscriptSegmentToAudio(asrSegment(), masterPath, masterName, INTEGRITY);
    expect(bindTranscriptSegmentToAudio(bound, masterPath, masterName, INTEGRITY)).toBe(bound);
    expect(bindTranscriptSegmentToAudio(bound, masterPath, masterName)).toBe(bound);
  });

  it("drops a record that described a different path", () => {
    const bound = bindTranscriptSegmentToAudio(asrSegment(), masterPath, masterName, INTEGRITY);
    const moved = bindTranscriptSegmentToAudio(bound, "QnALog/Audio/other.webm", "other.webm");
    expect(moved.transcript).not.toHaveProperty("sourceIntegrity");
  });
});

describe("attach functions keep the integrity record", () => {
  const audioPath = "QnALog/Import/clip.wav";

  it("attachTranscriptResult stores an explicit record, including for failed transcription", () => {
    const failed = attachTranscriptResult({ index: 0, startOffsetMs: 0, endOffsetMs: 1, audioPath, audioName: "clip.wav", text: "" }, "import-1", null, "asr", INTEGRITY);
    expect(failed.transcript?.sourceIntegrity).toEqual(INTEGRITY);
  });

  it("a retried transcription for the same path keeps the earlier record", () => {
    const failed = attachTranscriptResult({ index: 0, startOffsetMs: 0, endOffsetMs: 1, audioPath, audioName: "clip.wav", text: "" }, "import-1", null, "asr", INTEGRITY);
    const retried = attachTranscriptResult({ ...failed, text: "Done." }, "import-1", {
      text: "Done.", rawText: "Done.", providerId: "test",
      units: [{ rawText: "Done.", normalizedText: "Done.", speakerId: null, speakerName: null, startMs: null, endMs: null, timing: "unknown" }],
    } as never, "asr");
    expect(retried.transcript?.currentRevision).toBe(1);
    expect(retried.transcript?.sourceIntegrity).toEqual(INTEGRITY);
    const edited = attachTextTranscript({ ...retried, text: "Done, edited." }, "import-1", "edited-transcript");
    expect(edited.transcript?.sourceIntegrity).toEqual(INTEGRITY);
  });

  it("does not add the field when no record exists", () => {
    const plain = attachTranscriptResult({ index: 0, startOffsetMs: 0, endOffsetMs: 1, audioPath, audioName: "clip.wav", text: "" }, "import-1", null, "asr");
    expect(plain.transcript).not.toHaveProperty("sourceIntegrity");
  });
});

describe("finalize audio binding writes the record into the note", () => {
  it("rewrites the block with the session's master integrity record", async () => {
    const segment = asrSegment();
    let markdown = noteWith(segment);
    const file = { path: "QnALog/Minutes/a.md" };
    const obsidian = await import("obsidian");
    Object.setPrototypeOf(file, (obsidian.TFile as unknown as { prototype: object }).prototype);
    const session = {
      id: "session-1",
      mdPath: file.path,
      masterAudioPath: "QnALog/Audio/qnalog-20261023-100000.webm",
      masterAudioName: "qnalog-20261023-100000.webm",
      masterAudioIntegrity: INTEGRITY,
      segments: [segment],
    } as unknown as RecordingSession;
    await syncTranscriptAudioSource({
      getVault: () => ({
        getAbstractFileByPath: () => file,
        read: async () => markdown,
        modify: async (_file: unknown, next: string) => { markdown = next; },
        process: async (_file: unknown, update: (value: string) => string) => { markdown = update(markdown); return markdown; },
      }) as never,
      bindSegmentToAudio: (seg, path, name, integrity) => bindTranscriptSegmentToAudio(seg, path, name, integrity),
      logDiagnostic: async () => undefined,
    }, session);
    const [block] = readTranscriptBlocks(markdown);
    expect(block.segment.transcript?.sourceIntegrity).toEqual(INTEGRITY);
    expect(session.segments[0].transcript?.sourceIntegrity).toEqual(INTEGRITY);
  });
});

describe("finalize audio binding when only the integrity record changed", () => {
  const masterPath = "QnALog/Audio/qnalog-20261023-100000.webm";
  const masterName = "qnalog-20261023-100000.webm";

  async function runSync(markdown: string | Error, segment: Segment) {
    const obsidian = await import("obsidian");
    const file = Object.setPrototypeOf({ path: "QnALog/Minutes/a.md" }, (obsidian.TFile as unknown as { prototype: object }).prototype);
    const modify = vi.fn(async () => undefined);
    const logDiagnostic = vi.fn(async () => undefined);
    const session = {
      id: "session-1", mdPath: file.path, masterAudioPath: masterPath, masterAudioName: masterName,
      masterAudioIntegrity: INTEGRITY, segments: [segment],
    } as unknown as RecordingSession;
    await syncTranscriptAudioSource({
      getVault: () => ({
        getAbstractFileByPath: () => file,
        read: async () => { if (markdown instanceof Error) throw markdown; return markdown; },
        modify,
        process: async (_file: unknown, update: (value: string) => string) => update(markdown as string),
      }) as never,
      bindSegmentToAudio: (seg, path, name, integrity) => bindTranscriptSegmentToAudio(seg, path, name, integrity),
      logDiagnostic,
    }, session);
    return { session, modify, logDiagnostic };
  }

  it("does not fail finalization when the note has no block for the segment", async () => {
    const bound = bindTranscriptSegmentToAudio(asrSegment(), masterPath, masterName);
    const { session, modify } = await runSync("# Note without transcript blocks\n", bound);
    expect(modify).not.toHaveBeenCalled();
    expect(session.segments[0].transcript?.sourceIntegrity).toEqual(INTEGRITY);
  });

  it("does not fail finalization when the block was edited by the user", async () => {
    const bound = bindTranscriptSegmentToAudio(asrSegment(), masterPath, masterName);
    const markdown = noteWith(bound).replace("Hello there.\n", "Hello there, edited.\n");
    expect(readTranscriptBlocks(markdown)[0].drifted).toBe(true);
    const { modify } = await runSync(markdown, bound);
    expect(modify).not.toHaveBeenCalled();
  });

  it("logs and continues when the note cannot be read", async () => {
    const bound = bindTranscriptSegmentToAudio(asrSegment(), masterPath, masterName);
    const { logDiagnostic, session } = await runSync(new Error("read failed"), bound);
    expect(logDiagnostic).toHaveBeenCalledWith("warn", "audio.integrity_ledger_write_failed", expect.any(String), expect.objectContaining({ error: "read failed" }));
    expect(session.segments[0].transcript?.sourceIntegrity).toEqual(INTEGRITY);
  });

  it("still throws for a structural binding change whose block is missing", async () => {
    await expect(runSync("# Note without transcript blocks\n", asrSegment())).rejects.toThrow(/Expected one transcript block/);
  });
});

describe("continuation commit with integrity records", () => {
  it("accepts an incoming block whose only change is the integrity record", async () => {
    const masterPath = "QnALog/Audio/qnalog-20261023-110000.webm";
    const base = bindTranscriptSegmentToAudio(asrSegment("cont-1"), masterPath, "qnalog-20261023-110000.webm");
    const target = noteWith(base);
    const incoming = bindTranscriptSegmentToAudio(base, masterPath, "qnalog-20261023-110000.webm", INTEGRITY);
    const rewrite = vi.fn(async () => undefined);
    const session = { id: "cont-1", mdPath: "QnALog/Minutes/target.md", segments: [incoming] } as unknown as RecordingSession;
    await commitContinuationFlow({ readTarget: async () => target, rewrite }, session, "polished", []);
    expect(rewrite).toHaveBeenCalledOnce();
  });
});
