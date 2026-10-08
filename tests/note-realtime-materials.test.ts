import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ Notice: class Notice {}, normalizePath: (path: string) => path }));
import { buildRealtimeOutlineDetails } from "../src/notes/note-session-materials";
import { createRealtimeOutlineSourceCoverage } from "../src/notes/outline-coverage";
import { readCurrentOutlineBlock } from "../src/notes/outline-storage";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import type { Segment } from "../src/shared/types";
import { getActiveUiLanguage, matchUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { labelText } from "../src/shared/note-labels";

function withLanguage<T>(language: string, run: () => T): T {
  const previous = getActiveUiLanguage();
  setActiveUiLanguage(matchUiLanguage(language)!);
  try { return run(); }
  finally { setActiveUiLanguage(previous); }
}

function segments(): Segment[] {
  return [0, 1].map((index) => attachTextTranscript({
    index,
    startOffsetMs: index * 1_000,
    endOffsetMs: (index + 1) * 1_000,
    text: `Transcript source ${index}`,
  }, "realtime-materials-source", "text-import"));
}

const outline = "- [[recording.webm|00:00]] Topic $& $` $' $$";

function proofFor(text = outline, sourceSegments = segments(), committed = 1) {
  return createRealtimeOutlineSourceCoverage(text, sourceSegments, committed);
}

describe("realtime outline details materials", () => {
  it("returns empty for absent outlines without reading other session material", () => {
    for (const value of [null, undefined, "", " \r\n\t "]) {
      expect(buildRealtimeOutlineDetails({ realtimeOutline: value })).toBe("");
    }
    const session = {
      realtimeOutline: "  ",
      get realtimeOutlineCoverage() { throw new Error("coverage read"); },
      get realtimeOutlineSourceCoverage() { throw new Error("proof read"); },
      get segments() { throw new Error("segments read"); },
      get realtimeOutlineCoverageScope() { throw new Error("scope read"); },
    };
    expect(buildRealtimeOutlineDetails(session)).toBe("");
  });

  it("trims only outline edges and reads the generated block in both languages", () => {
    const sourceSegments = segments();
    const proof = proofFor(outline, sourceSegments);
    for (const language of ["en", "zh"]) {
      const rendered = withLanguage(language, () => buildRealtimeOutlineDetails({
        realtimeOutline: ` \r\n${outline}\r\n `,
        realtimeOutlineCoverage: { totalSegmentCount: 2 },
        realtimeOutlineCoverageScope: "current-recording",
        realtimeOutlineSourceCoverage: proof,
        segments: sourceSegments,
      }));
      const parsed = readCurrentOutlineBlock(rendered);
      expect(parsed?.outline).toBe(outline);
      expect(parsed?.sourceCoverage).toEqual(proof);
      expect(rendered).toContain("$& $` $' $$");
      expect(rendered).toContain("1/2");
    }
  });

  it("retains complete proof metadata without an incomplete notice", () => {
    const sourceSegments = segments();
    const proof = proofFor(outline, sourceSegments, 2);
    const rendered = buildRealtimeOutlineDetails({
      realtimeOutline: outline,
      realtimeOutlineCoverage: { totalSegmentCount: 2 },
      realtimeOutlineSourceCoverage: proof,
      segments: sourceSegments,
    });
    expect(rendered).not.toContain("1/2");
    expect(readCurrentOutlineBlock(rendered)?.sourceCoverage).toEqual(proof);
  });

  it("omits stale proofs while retaining the displayed total count", () => {
    const sourceSegments = segments();
    const staleProof = proofFor(outline, sourceSegments);
    const rendered = buildRealtimeOutlineDetails({
      realtimeOutline: `${outline} changed`,
      realtimeOutlineCoverage: { totalSegmentCount: 2 },
      realtimeOutlineSourceCoverage: staleProof,
      segments: sourceSegments,
    });
    expect(rendered).toContain("0/2");
    expect(readCurrentOutlineBlock(rendered)?.sourceCoverage).toBeNull();
  });

  it("preserves Number conversion and serializes additional proof fields", () => {
    const sourceSegments = segments();
    const proof = { ...proofFor(outline, sourceSegments, 2), retained: { marker: "extra" } };
    const rendered = buildRealtimeOutlineDetails({
      realtimeOutline: outline,
      realtimeOutlineCoverage: { totalSegmentCount: "1" },
      realtimeOutlineSourceCoverage: proof,
      segments: sourceSegments,
    });
    expect(rendered).not.toContain("1/1");
    expect(rendered).toContain(JSON.stringify(proof));
  });
  it("uses the coverage total and scope independently of the segment array", () => {
    const sourceSegments = segments();
    const proof = proofFor(outline, sourceSegments, 1);
    const rendered = buildRealtimeOutlineDetails({
      realtimeOutline: outline,
      realtimeOutlineCoverage: { totalSegmentCount: 2 },
      realtimeOutlineCoverageScope: "whole-note",
      realtimeOutlineSourceCoverage: proof,
      segments: sourceSegments,
    });
    expect(rendered).toContain(labelText("outlineCoverageWholeNote", 1, 2));
    expect(readCurrentOutlineBlock(rendered)?.sourceCoverage).toEqual(proof);
    expect(rendered).toContain(JSON.stringify(proof));
  });

  it("retains the original Number conversion for coverage totals", () => {
    for (const [total, expected] of [
      [undefined, ""],
      [0, ""],
      [-2, ""],
      ["not a number", ""],
      ["2", labelText("outlineCoverageCurrentRecording", 0, 2)],
    ] as const) {
      const rendered = buildRealtimeOutlineDetails({
        realtimeOutline: outline,
        realtimeOutlineCoverage: total === undefined ? {} : { totalSegmentCount: total },
        segments: [],
      });
      if (expected) expect(rendered).toContain(expected);
      else expect(rendered).not.toContain("0/");
    }
  });

  it("omits proof when outline, source text, segment count, or revision differs", () => {
    const originalSegments = segments();
    const proof = proofFor(outline, originalSegments);
    const changedSource = [
      attachTextTranscript({
        index: 0, startOffsetMs: 0, endOffsetMs: 1_000, text: "Changed source transcript",
      }, "realtime-materials-source", "text-import"),
      originalSegments[1],
    ];
    const changedRevision = [
      attachTextTranscript({
        index: 0, startOffsetMs: 0, endOffsetMs: 1_000, text: "Revised transcript",
      }, "realtime-materials-source", "edited-transcript"),
      originalSegments[1],
    ];
    const cases = [
      { realtimeOutline: `${outline} changed`, segments: originalSegments },
      { realtimeOutline: outline, segments: changedSource },
      { realtimeOutline: outline, segments: [...originalSegments, originalSegments[1]] },
      { realtimeOutline: outline, segments: changedRevision },
    ];
    for (const item of cases) {
      const rendered = buildRealtimeOutlineDetails({
        ...item,
        realtimeOutlineCoverage: { totalSegmentCount: 2 },
        realtimeOutlineSourceCoverage: proof,
      });
      expect(readCurrentOutlineBlock(rendered)?.sourceCoverage).toBeNull();
      expect(rendered).toContain("0/2");
    }
  });
});
