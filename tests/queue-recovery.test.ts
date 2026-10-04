import { describe, expect, it } from "vitest";
import { restoreQueue } from "../src/queue/queue-recovery";

const options = (ids: string[] = ["generated"]) => {
  let next = 0;
  return { createId: () => ids[next++] ?? `generated-${next}`, nowIso: () => "2024-01-01T00:00:00.000Z", getMaxRetries: () => 3 };
};
const merge = (patch: Record<string, unknown> = {}) => ({ type: "merge", sessionId: "s", mdPath: "note.md", mode: "custom", segments: [{ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "source text" }], ...patch });

describe("restoreQueue", () => {
  it("classifies each invalid row and retains its original value and safe references", () => {
    const saved: unknown[] = [null, false, "text", [], {}, { type: "future-task", audioPath: "keep.wav" },
      { type: "transcribe", sessionId: "s", mdPath: "n.md", audioPath: "a.wav", segmentIndex: "bad" },
      merge({ dependsOnSessionIds: [" "] })];
    const before = structuredClone(saved);
    const result = restoreQueue(saved, options());
    expect(result.tasks).toEqual([]);
    expect(result.retained.map((entry) => entry.summary.issue)).toEqual([
      "invalid-entry", "invalid-entry", "invalid-entry", "invalid-entry", "invalid-entry", "unsupported-type", "invalid-field", "invalid-field",
    ]);
    expect(result.retained.map((entry) => entry.raw)).toEqual(before);
    expect(result.retained[5].summary.audioPaths).toContain("keep.wav");
    expect(result.retained[6].summary.audioPaths).toContain("a.wav");
  });

  it("preserves inputs, drops only invalid continuation proof, and recovers valid tasks", () => {
    const continuation = { targetPath: "target.md", targetSourceId: "source", recordedAt: "2024-01-01", realtimeOutline: 42, priorOutlineHash: false, realtimeOutlineSegmentCount: -1, realtimeOutlineSourceCoverage: { version: 9 } };
    const saved = [merge({ id: "m", continuation }), { type: "generate-prompt", mode: "custom", status: "future-status", retries: "2" }];
    const before = structuredClone(saved);
    const result = restoreQueue(saved, options());
    expect(result.retained).toEqual([]);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({ id: "m", type: "merge", segments: [{ text: "source text" }], continuation: { targetPath: "target.md" } });
    expect(result.tasks[0].continuation).not.toHaveProperty("realtimeOutline");
    expect(result.tasks[1]).toMatchObject({ status: "pending", retries: 2 });
    expect(saved).toEqual(before);
  });

  it("retains all duplicate IDs and generates IDs avoiding stored collisions", () => {
    const saved = [{ id: "same", type: "generate-prompt", mode: "x" }, { id: "same", type: "future" }, { type: "generate-prompt", mode: "y" }];
    const result = restoreQueue(saved, options(["same", "available"]));
    expect(result.retained.map((row) => row.summary.issue)).toEqual(["duplicate-id", "duplicate-id"]);
    expect(result.tasks[0].id).toBe("available");
  });

  it("enforces continuation and ordinary merge segment requirements", () => {
    const result = restoreQueue([merge({ segments: [] }), merge({ segments: [], continuation: { targetPath: "t", targetSourceId: "s", recordedAt: "2024-01-01" } }), merge({ continuationDisposition: "unexpected" })], options());
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].type).toBe("merge");
    expect(result.retained.map((row) => row.summary.issue)).toEqual(["invalid-field", "invalid-disposition"]);
  });
  it("rejects null optional lifecycle values and infinite retry conversions", () => {
    const result = restoreQueue([
      { type: "generate-prompt", mode: "x", lastError: null },
      { type: "generate-prompt", mode: "x", attempt: null },
      { type: "generate-prompt", mode: "x", retries: "Infinity" },
      { type: "generate-prompt", mode: "x", retries: Infinity },
    ], options());
    expect(result.tasks).toEqual([]);
    expect(result.retained.map((row) => row.summary.field)).toEqual(["lastError", "attempt", "retries", "retries"]);
  });
  it("restores each executable payload while preserving extensions and legacy lifecycle defaults", () => {
    const transcribe = {
      type: "transcribe",
      sessionId: "session-a",
      mdPath: "note.md",
      audioPath: "audio.wav",
      segmentIndex: 0,
      retries: "2",
      createdAt: null,
      updatedAt: null,
      nextRetryAt: "not-a-date",
      extension: { source: "kept" },
    };
    const result = restoreQueue([
      transcribe,
      { id: "generated", type: "generate-prompt", mode: "custom", status: "future-status" },
      merge({ id: "merge", segments: [], continuation: { targetPath: "target.md", targetSourceId: "source", recordedAt: "2024-01-01" } }),
    ], options(["generated", "available"]));
    expect(result.retained).toEqual([]);
    expect(result.tasks[0]).toMatchObject({
      id: "available", status: "pending", retries: 2,
      createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
      nextRetryAt: "not-a-date", extension: { source: "kept" },
    });
    expect(result.tasks.map((task) => task.type)).toEqual(["transcribe", "generate-prompt", "merge"]);
    expect(transcribe.createdAt).toBeNull();
    expect(transcribe.updatedAt).toBeNull();
  });

  it("retains invalid optional fields and malformed segment members instead of filtering material", () => {
    const badSegment = { index: 0, startOffsetMs: 0, endOffsetMs: 100, text: "source", audioPath: "keep.wav", speakerIds: [false] };
    const result = restoreQueue([
      { type: "generate-prompt", mode: "custom", mdPath: null },
      { type: "transcribe", sessionId: "s", mdPath: "n.md", audioPath: "a.wav", segmentIndex: 0, isFinal: "yes" },
      merge({ segments: [badSegment] }),
      { type: "merge", sessionId: "s", mdPath: "n.md", mode: "m", segments: {} },
      { type: "transcribe", sessionId: "s", mdPath: "n.md", audioPath: "a.wav", segmentIndex: 0, dependsOnSessionIds: ["s", 3] },
    ], options());
    expect(result.tasks).toEqual([]);
    expect(result.retained.map((row) => row.summary.field)).toEqual(["mdPath", "isFinal", "segments.0", "segments", "dependsOnSessionIds"]);
    expect(result.retained[2].summary.audioPaths).toContain("keep.wav");
    expect(result.retained[2].raw).toEqual(merge({ segments: [badSegment] }));
  });
});
