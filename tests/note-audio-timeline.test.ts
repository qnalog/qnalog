import { describe, expect, it } from "vitest";
import type { Segment } from "../src/shared/types";
import { buildNoteAudioTimeline, mapAudioTimeToNote, mapNoteTimeToAudio } from "../src/notes/note-audio-timeline";

function segment(index: number, source: string, noteStart: number, noteEnd: number, localStart: number, localEnd: number): Segment {
  return {
    index, text: "transcript", startOffsetMs: noteStart, endOffsetMs: noteEnd,
    audioPath: `recordings/${source}.webm`, audioName: `${source}.webm`,
    audioStartOffsetMs: localStart, audioEndOffsetMs: localEnd,
  };
}

const fiveSources = buildNoteAudioTimeline([
  segment(0, "one", 0, 30000, 0, 30000),
  segment(1, "two", 30000, 60000, 0, 30000),
  segment(2, "three", 60000, 90000, 0, 30000),
  segment(3, "four", 90000, 148418, 0, 58418),
  segment(4, "five", 148418, 218094, 0, 69676),
]);

describe("note audio timeline", () => {
  it("maps all five sources in both directions, including the latest recording anchors", () => {
    expect(fiveSources).toHaveLength(5);
    expect(mapNoteTimeToAudio(fiveSources, 148418)).toEqual({
      sourcePath: "recordings/five.webm", sourceName: "five.webm", localMs: 0,
    });
    expect(mapNoteTimeToAudio(fiveSources, 158418)?.localMs).toBe(10000);
    expect(mapAudioTimeToNote(fiveSources, "recordings/five.webm", 0)).toBe(148418);
    expect(mapAudioTimeToNote(fiveSources, "recordings/five.webm", 10000)).toBe(158418);
    for (const interval of fiveSources) {
      const global = interval.noteStartMs + 1234;
      expect(mapAudioTimeToNote(fiveSources, interval.sourcePath, 1234)).toBe(global);
    }
  });

  it("uses half-open boundaries and clamps only the exact full-note endpoint", () => {
    expect(mapNoteTimeToAudio(fiveSources, 30000)?.sourcePath).toBe("recordings/two.webm");
    expect(mapNoteTimeToAudio(fiveSources, 218093)?.localMs).toBe(69675);
    expect(mapNoteTimeToAudio(fiveSources, 218094)).toEqual({
      sourcePath: "recordings/five.webm", sourceName: "five.webm", localMs: 69676,
    });
    expect(mapNoteTimeToAudio(fiveSources, 218095)).toBeNull();
    expect(mapAudioTimeToNote(fiveSources, "recordings/one.webm", 30000)).toBeNull();
  });

  it("does not merge same-source intervals across gaps and reports repeated local time as ambiguous", () => {
    const timeline = buildNoteAudioTimeline([
      segment(0, "repeat", 0, 10000, 0, 10000),
      segment(1, "repeat", 20000, 30000, 0, 10000),
    ]);
    expect(timeline).toHaveLength(2);
    expect(mapAudioTimeToNote(timeline, "recordings/repeat.webm", 5000)).toBeNull();
    expect(mapNoteTimeToAudio(timeline, 25000)?.localMs).toBe(5000);
  });

  it("leaves intervals with incomplete source clocks indeterminate", () => {
    const incomplete: Segment = {
      index: 0, text: "incomplete", startOffsetMs: 0, endOffsetMs: 10000,
      audioPath: "recordings/unknown.webm",
    };
    expect(buildNoteAudioTimeline([incomplete])).toEqual([]);
    expect(mapAudioTimeToNote(fiveSources, "recordings/missing.webm", 0)).toBeNull();
    expect(mapNoteTimeToAudio(fiveSources, Number.NaN)).toBeNull();
  });
});
