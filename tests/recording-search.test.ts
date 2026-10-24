import { describe, expect, it } from "vitest";
import {
  RECORDING_SEARCH_MAX_RESULTS,
  RECORDING_SEARCH_SNIPPET_MAX_CHARS,
  buildRecordingSearchIndex,
  parseRecordingSearchQuery,
  searchRecording,
  type RecordingSearchResult,
} from "../src/notes/recording-search";
import { parseSessionKnowledgeResponse, type SessionKnowledge } from "../src/briefing/session-knowledge";
import { attachTextTranscript, attachTranscriptResult, getCurrentTranscript, getTranscriptSourceRevision } from "../src/transcript/session-transcript";
import type { AsrTranscriptUnit } from "../src/asr/transcript-result";
import type { Segment } from "../src/shared/types";

const AUDIO = "QnALog/Audio/session-a.webm";

function unit(text: string, startMs: number | null, timing: AsrTranscriptUnit["timing"], speaker: string | null = "Speaker 1"): AsrTranscriptUnit {
  return {
    rawText: text, normalizedText: text, speakerId: speaker ? `spk-${speaker.length}` : null, speakerName: speaker,
    startMs, endMs: startMs === null ? null : startMs + 1500, timing,
  };
}

/** A recorded segment whose clip is the whole session audio, so ledger times are audio-local. */
function recorded(units: AsrTranscriptUnit[], index = 0, extra: Partial<Segment> = {}): Segment {
  const text = units.map((item) => item.rawText).join(" ");
  return attachTranscriptResult({
    index, startOffsetMs: 0, endOffsetMs: 600_000, text, audioPath: AUDIO, audioName: "session-a.webm", ...extra,
  }, "session-a", { text, rawText: null, providerId: "test-asr", units }, "asr");
}

function find(segments: Segment[], query: string, knowledge: SessionKnowledge | null = null) {
  return searchRecording(buildRecordingSearchIndex(segments, knowledge), query);
}

function hitTexts(result: RecordingSearchResult): string[] {
  return result.hits.map((hit) => result.snippet.slice(hit.start, hit.end));
}

const meeting = recorded([
  unit("我们下周三发布试点版本。", 12_400, "provider", "张华"),
  unit("好的，没问题。", 30_000, "provider", "李明"),
  unit("We will SHIP the Pilot on Friday.", 45_000, "provider", "Alice"),
  unit("下周把 API 文档发给 Alice。", 61_000, "provider", "张华"),
  unit("预算还剩十一万，增长百分之十五。", 75_000, "provider", "李明"),
  unit("会议 11 点开始，Q3 目标：增长、稳定！", 3_725_000, "provider", "张华"),
]);

describe("find in recording: matching", () => {
  it("finds a Chinese phrase and returns the time, precision, speaker, snippet and audio target", () => {
    const outcome = find([meeting], "试点");
    expect(outcome.total).toBe(1);
    const [result] = outcome.results;
    expect(result).toMatchObject({
      timeLabel: "00:12",
      startMs: 12_400,
      precision: "provider",
      speaker: "张华",
      matchedIn: "text",
      snippet: "我们下周三发布试点版本。",
      target: { linkPath: AUDIO, label: "00:12", localMs: 12_400 },
    });
    expect(hitTexts(result)).toEqual(["试点"]);
  });

  it("ignores case in English and requires every term in the same utterance", () => {
    const both = find([meeting], "pilot FRIDAY");
    expect(both.results.map((result) => result.snippet)).toEqual(["We will SHIP the Pilot on Friday."]);
    expect(hitTexts(both.results[0])).toEqual(["Pilot", "Friday"]);
    expect(find([meeting], "pilot monday").total).toBe(0);
    // 「试点」 and 「Friday」 are in different utterances.
    expect(find([meeting], "试点 friday").total).toBe(0);
  });

  it("matches mixed Chinese and English queries across the spaces of the transcript", () => {
    const joined = find([meeting], "api文档");
    expect(joined.results.map((result) => result.timeLabel)).toEqual(["01:01"]);
    expect(hitTexts(joined.results[0])).toEqual(["API 文档"]);
    expect(find([meeting], "Alice 文档").results.map((result) => result.timeLabel)).toEqual(["01:01"]);
  });

  it("matches Chinese numerals and Arabic digits in both directions", () => {
    const eleven = find([meeting], "11");
    expect(eleven.results.map((result) => result.timeLabel)).toEqual(["01:15", "1:02:05"]);
    // 十一万 reads as 110000, which contains 11; the whole numeral run is highlighted.
    expect(hitTexts(eleven.results[0])).toEqual(["十一万"]);
    expect(hitTexts(eleven.results[1])).toEqual(["11"]);
    expect(find([meeting], "十一点").results.map((result) => result.timeLabel)).toEqual(["1:02:05"]);
    for (const query of ["15", "15%", "百分之十五", "十五"]) {
      const outcome = find([meeting], query);
      expect(outcome.results.map((result) => result.timeLabel), query).toEqual(["01:15"]);
    }
    expect(hitTexts(find([meeting], "15%").results[0])).toEqual(["百分之十五"]);
  });

  it("ignores punctuation and whitespace differences", () => {
    expect(find([meeting], "目标增长").results.map((result) => result.timeLabel)).toEqual(["1:02:05"]);
    expect(find([meeting], "q3，目标").results.map((result) => result.timeLabel)).toEqual(["1:02:05"]);
    expect(find([meeting], "好的没问题").results.map((result) => result.speaker)).toEqual(["李明"]);
    expect(find([meeting], "ship   the pilot").total).toBe(1);
  });

  it("matches the speaker display name and marks where the hit was", () => {
    const byName = find([meeting], "张华");
    expect(byName.results.map((result) => result.timeLabel)).toEqual(["00:12", "01:01", "1:02:05"]);
    expect(byName.results.every((result) => result.matchedIn === "speaker" && result.hits.length === 0)).toBe(true);
    const nameAndWord = find([meeting], "张华 试点");
    expect(nameAndWord.results).toHaveLength(1);
    expect(nameAndWord.results[0].matchedIn).toBe("both");
    expect(hitTexts(nameAndWord.results[0])).toEqual(["试点"]);
    // "Alice" is both a speaker and a word in 张华's utterance.
    expect(find([meeting], "alice").results.map((result) => [result.speaker, result.matchedIn])).toEqual([
      ["Alice", "speaker"],
      ["张华", "text"],
    ]);
  });

  it("returns nothing for an empty query or a query of punctuation only", () => {
    for (const query of ["", "   ", "，。！", "　"]) {
      const outcome = find([meeting], query);
      expect(outcome, JSON.stringify(query)).toEqual({ terms: [], results: [], total: 0, more: 0 });
    }
    expect(parseRecordingSearchQuery("  Pilot  pilot ")).toEqual(["pilot"]);
  });
});

describe("find in recording: time and precision", () => {
  it("labels each precision kind from the ledger", () => {
    const providerSegment = recorded([unit("provider 时间", 5_000, "provider")], 0);
    const spanSegment = recorded([unit("audio-span 时间", 8_000, "audio-span")], 1);
    // A unit without its own time, from a segment cut from the session audio: the ledger keeps the segment start.
    const segmentTimed = recorded([unit("segment 时间", null, "unknown")], 2, {
      startOffsetMs: 60_000, endOffsetMs: 120_000, audioStartOffsetMs: 60_000, audioEndOffsetMs: 120_000,
      segmentAudioPath: "QnALog/Cache/clip-2.webm",
    });
    // No audio file at all: the time is unknown and the row has no target.
    const unknown = recorded([unit("unknown 时间", null, "unknown")], 3, { audioPath: "", audioName: "", startOffsetMs: 200_000 });
    const outcome = find([providerSegment, spanSegment, segmentTimed, unknown], "时间");
    expect(outcome.results.map((result) => [result.snippet, result.precision, result.timeLabel])).toEqual([
      ["provider 时间", "provider", "00:05"],
      ["audio-span 时间", "audio-span", "00:08"],
      ["segment 时间", "segment", "01:00"],
      ["unknown 时间", "unknown", ""],
    ]);
    expect(outcome.results[2].target).toEqual({ linkPath: AUDIO, label: "01:00", localMs: 60_000 });
    expect(outcome.results[3].target).toBeNull();
    expect(outcome.results[3].startMs).toBeNull();
  });

  it("uses the segment's audio start for ledger utterances without an audio reference", () => {
    const legacyLedger = attachTextTranscript({
      index: 0, startOffsetMs: 300_000, endOffsetMs: 360_000, audioStartOffsetMs: 300_000,
      text: "旧账本里的预算讨论。", audioPath: AUDIO, audioName: "session-a.webm",
    }, "session-a", "legacy-transcript");
    expect(getCurrentTranscript(legacyLedger.transcript!).utterances[0].audioRef).toBeNull();
    const [result] = find([legacyLedger], "预算").results;
    expect(result).toMatchObject({ precision: "segment", timeLabel: "05:00", target: { linkPath: AUDIO, label: "05:00", localMs: 300_000 } });
  });

  it("searches segment text at the segment start when the note has no utterance ledger", () => {
    const later: Segment = {
      index: 1, startOffsetMs: 90_000, endOffsetMs: 150_000, text: "**张华：** 旧笔记里的预算讨论，十一月上线。",
      audioPath: "QnALog/Audio/old.m4a", audioName: "old.m4a",
    };
    const earlier: Segment = { index: 0, startOffsetMs: 0, endOffsetMs: 90_000, text: "开场：先看预算。", audioPath: "QnALog/Audio/old.m4a", audioName: "old.m4a" };
    const textOnly: Segment = { index: 2, startOffsetMs: 0, endOffsetMs: 0, text: "导入文本里的预算。", sourcePath: "Imports/notes.txt", sourceName: "notes.txt" };
    const outcome = find([later, earlier, textOnly], "预算");
    expect(outcome.results.map((result) => [result.id, result.precision, result.timeLabel, result.speaker])).toEqual([
      ["segment:0", "segment", "00:00", ""],
      ["segment:2", "unknown", "", ""],
      ["segment:1", "segment", "01:30", ""],
    ]);
    expect(outcome.results[2].target).toEqual({ linkPath: "QnALog/Audio/old.m4a", label: "01:30", localMs: 90_000 });
    expect(find([later], "11月").results.map((result) => result.id)).toEqual(["segment:1"]);
  });

  it("returns results in time order across segments", () => {
    const second = recorded([unit("第二段的预算", 400_000, "provider")], 1, { startOffsetMs: 400_000, endOffsetMs: 500_000 });
    const first = recorded([unit("第一段的预算", 20_000, "provider"), unit("第一段末尾的预算", 300_000, "provider")], 0);
    expect(find([second, first], "预算").results.map((result) => result.snippet)).toEqual(["第一段的预算", "第一段末尾的预算", "第二段的预算"]);
  });

  it("caps the results at 200 and reports the rest as a count", () => {
    const units = Array.from({ length: 250 }, (_, index) => unit(`第 ${index + 1} 次提到预算`, index * 1000, "provider"));
    const outcome = find([recorded(units)], "预算");
    expect(RECORDING_SEARCH_MAX_RESULTS).toBe(200);
    expect(outcome.results).toHaveLength(200);
    expect(outcome.total).toBe(250);
    expect(outcome.more).toBe(50);
    const starts = outcome.results.map((result) => result.startMs ?? -1);
    expect(starts).toEqual([...starts].sort((left, right) => left - right));
    expect(outcome.results[199].snippet).toBe("第 200 次提到预算");
  });
});

describe("find in recording: corrected text from session knowledge", () => {
  function knowledgeWithProjection(segments: Segment[], utteranceId: string, normalizedText: string, speakerName: string): SessionKnowledge {
    const utterances = segments.flatMap((segment) => getCurrentTranscript(segment.transcript!).utterances);
    const sources = segments.map((segment) => {
      const current = getCurrentTranscript(segment.transcript!);
      return { segmentId: segment.transcript!.id, revision: current.revision, normalizationRevision: current.normalizationRevision };
    });
    const wire = { schemaVersion: 2, topics: [], decisions: [{ text: "Pilot", evidence: [utteranceId], topics: [] }], actions: [], questions: [] };
    return parseSessionKnowledgeResponse(`Body\n<!-- qnalog-session-knowledge ${JSON.stringify(wire)} -->`, {
      allowed: utterances, part: 1, sources, sourceRevision: getTranscriptSourceRevision(segments),
      projections: [{ utteranceId, normalizedText, speakerName }],
    }).knowledge;
  }

  it("searches the projected text and speaker while the knowledge matches the ledger", () => {
    const segment = recorded([unit("我们下周三发布式点版本。", 12_400, "provider", "Speaker 1")]);
    const id = getCurrentTranscript(segment.transcript!).utterances[0].id;
    const knowledge = knowledgeWithProjection([segment], id, "我们下周三发布试点版本。", "王芳");
    expect(find([segment], "试点", knowledge).results.map((result) => result.speaker)).toEqual(["王芳"]);
    expect(find([segment], "王芳", knowledge).total).toBe(1);
    expect(find([segment], "式点", knowledge).total).toBe(0);
    // Without the knowledge, or with knowledge from another ledger revision, the ledger text is searched.
    expect(find([segment], "式点").total).toBe(1);
    const changed = recorded([unit("我们下周三发布式点版本，再确认一次。", 12_400, "provider", "Speaker 1")]);
    expect(find([changed], "试点", knowledge).total).toBe(0);
    expect(find([changed], "式点", knowledge).total).toBe(1);
  });
});

describe("find in recording: snippet window", () => {
  const codePoints = (value: string) => Array.from(value).length;

  it("keeps short text whole", () => {
    const [result] = find([meeting], "稳定").results;
    expect(result.snippet).toBe("会议 11 点开始，Q3 目标：增长、稳定！");
    expect(hitTexts(result)).toEqual(["稳定"]);
  });

  it("cuts long text around the first hit without splitting a Latin word at the start", () => {
    const text = `${"甲".repeat(40)}Kubernetes${"丙".repeat(10)}集群${"乙".repeat(40)}`;
    const [result] = find([recorded([unit(text, 1000, "provider")])], "集群").results;
    expect(codePoints(result.snippet)).toBeLessThanOrEqual(RECORDING_SEARCH_SNIPPET_MAX_CHARS);
    expect(result.snippet.startsWith("…丙")).toBe(true);
    expect(result.snippet).not.toContain("ubernetes");
    expect(result.snippet.endsWith("乙…")).toBe(true);
    expect(hitTexts(result)).toEqual(["集群"]);
  });

  it("does not split a Latin word at the end", () => {
    const text = `集群${"丁".repeat(53)}deployment${"乙".repeat(20)}`;
    const [result] = find([recorded([unit(text, 1000, "provider")])], "集群").results;
    expect(result.snippet.startsWith("集群丁")).toBe(true);
    expect(result.snippet.endsWith("丁…")).toBe(true);
    expect(result.snippet).not.toContain("deploy");
    expect(hitTexts(result)).toEqual(["集群"]);
  });

  it("maps a hit that spans the CJK and Latin boundary and counts code points, not UTF-16 units", () => {
    const [mixed] = find([recorded([unit("我们用Kubernetes部署服务", 1000, "provider")])], "kubernetes部署").results;
    expect(hitTexts(mixed)).toEqual(["Kubernetes部署"]);

    const text = `${"𠮷".repeat(70)}目标`;
    const [wide] = find([recorded([unit(text, 1000, "provider")])], "目标").results;
    expect(codePoints(wide.snippet)).toBe(RECORDING_SEARCH_SNIPPET_MAX_CHARS);
    expect(wide.snippet.startsWith("…𠮷")).toBe(true);
    expect(hitTexts(wide)).toEqual(["目标"]);
  });

  it("starts at the beginning of the text when only the speaker matched", () => {
    const text = `${"甲".repeat(70)}`;
    const [result] = find([recorded([unit(text, 1000, "provider", "张华")])], "张华").results;
    expect(result.snippet.startsWith("甲")).toBe(true);
    expect(result.snippet.endsWith("…")).toBe(true);
    expect(codePoints(result.snippet)).toBe(RECORDING_SEARCH_SNIPPET_MAX_CHARS);
    expect(result.hits).toEqual([]);
  });
});
