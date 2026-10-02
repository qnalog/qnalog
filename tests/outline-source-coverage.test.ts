import { describe, expect, it } from "vitest";
import { createRealtimeOutlineSourceCoverage, getValidatedOutlineCommittedCount, rebaseRealtimeOutlineSourceCoverage, validateRealtimeOutlineSourceCoverage } from "../src/notes/outline-coverage";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import type { Segment } from "../src/shared/types";

function material(index: number, text = `Transcript ${index}`): Segment {
  const segment = attachTextTranscript({
    index,
    startOffsetMs: index * 1000,
    endOffsetMs: (index + 1) * 1000,
    audioStartOffsetMs: index * 1000,
    audioEndOffsetMs: (index + 1) * 1000,
    audioPath: `audio-${index}.webm`,
    audioName: `audio-${index}.webm`,
    text,
  }, `source-${index}`, "text-import");
  return segment;
}

describe("realtime outline source coverage", () => {
  it("does not promote a fresh 3/3 proof to an 11/11 whole-note proof", () => {
    const fresh = [material(0), material(1), material(2)];
    const wholeNote = Array.from({ length: 11 }, (_, index) => material(index));
    const proof = createRealtimeOutlineSourceCoverage("- Fresh topic", fresh, 3);

    expect(validateRealtimeOutlineSourceCoverage(proof, "- Fresh topic", fresh)).toBe(true);
    expect(validateRealtimeOutlineSourceCoverage(proof, "- Fresh topic", wholeNote)).toBe(false);
    expect(getValidatedOutlineCommittedCount(proof, "- Fresh topic", wholeNote)).toBe(0);
  });

  it("binds the proven ordered prefix to transcript ID, revision, text, local clocks, source and errors", () => {
    const segments = [material(0), material(1), material(2)];
    const proof = createRealtimeOutlineSourceCoverage("- Topic", segments, 2);
    expect(validateRealtimeOutlineSourceCoverage(proof, "- Topic", segments)).toBe(true);
    expect(validateRealtimeOutlineSourceCoverage(proof, "- Edited", segments)).toBe(false);

    const reordered = [segments[1], segments[0], segments[2]];
    expect(validateRealtimeOutlineSourceCoverage(proof, "- Topic", reordered)).toBe(false);
    expect(validateRealtimeOutlineSourceCoverage(proof, "- Topic", [segments[0], material(1, "revised text"), segments[2]])).toBe(false);

    const changedClock = segments.map(segment => ({ ...segment }));
    changedClock[0].audioEndOffsetMs = 999;
    expect(validateRealtimeOutlineSourceCoverage(proof, "- Topic", changedClock)).toBe(false);

    const changedSource = segments.map(segment => ({ ...segment }));
    changedSource[0].audioPath = "different.webm";
    expect(validateRealtimeOutlineSourceCoverage(proof, "- Topic", changedSource)).toBe(false);

    const changedRevision = segments.map(segment => ({ ...segment, transcript: segment.transcript ? {
      ...segment.transcript,
      currentRevision: segment.transcript.currentRevision + 1,
    } : undefined }));
    expect(validateRealtimeOutlineSourceCoverage(proof, "- Topic", changedRevision)).toBe(false);

    const changedNormalization = segments.map(segment => ({ ...segment, transcript: segment.transcript ? {
      ...segment.transcript,
      revisions: segment.transcript.revisions.map(revision => ({
        ...revision,
        normalizationRevision: revision.normalizationRevision + 1,
      })),
    } : undefined }));
    expect(validateRealtimeOutlineSourceCoverage(proof, "- Topic", changedNormalization)).toBe(false);
    const changedError = segments.map(segment => ({ ...segment }));
    changedError[0].error = "transcription failed";
    expect(validateRealtimeOutlineSourceCoverage(proof, "- Topic", changedError)).toBe(false);
  });

  it("extends a proven prefix when the same live session receives later segments", () => {
    const original = [material(0), material(1), material(2)];
    const proof = createRealtimeOutlineSourceCoverage("- Frozen prefix", original, 2);
    const appended = [...original, material(3)];
    const rebased = rebaseRealtimeOutlineSourceCoverage(proof, "- Frozen prefix", appended);
    expect(rebased?.totalSegmentCount).toBe(4);
    expect(getValidatedOutlineCommittedCount(rebased, "- Frozen prefix", appended)).toBe(2);

    const changedPrefix = [material(0, "edited committed row"), ...appended.slice(1)];
    expect(rebaseRealtimeOutlineSourceCoverage(proof, "- Frozen prefix", changedPrefix)).toBeNull();
  });

  it("ignores only merged-note index and global offset changes", () => {
    const segments = [material(0), material(1)];
    const proof = createRealtimeOutlineSourceCoverage("- Topic", segments, 2);
    const normalized = segments.map((segment, index) => ({
      ...segment,
      index: index + 20,
      startOffsetMs: segment.startOffsetMs + 60000,
      endOffsetMs: segment.endOffsetMs + 60000,
    }));
    expect(validateRealtimeOutlineSourceCoverage(proof, "- Topic", normalized)).toBe(true);
  });
});
