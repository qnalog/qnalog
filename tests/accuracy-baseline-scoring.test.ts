import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  editDistance,
  normalizeNumbers,
  scoreText,
  scoreTranscript,
  tokenize,
  type GroundTruth,
  type ReferenceUtterance,
} from "../scripts/accuracy-baseline/scoring";
import type { AsrTranscriptResult, AsrTranscriptTiming, AsrTranscriptUnit } from "../src/asr/transcript-result";

function utt(speaker: string, text: string, startMs: number, endMs: number): ReferenceUtterance {
  return { speaker, text, startMs, endMs };
}

function truthOf(utterances: ReferenceUtterance[]): GroundTruth {
  return { title: "t", language: "en", utterances };
}

function unit(
  text: string,
  speakerId: string | null,
  startMs: number | null,
  endMs: number | null,
  timing: AsrTranscriptTiming = "provider",
): AsrTranscriptUnit {
  return { rawText: text, normalizedText: text, speakerId, speakerName: null, startMs, endMs, timing };
}

function resultOf(units: AsrTranscriptUnit[], text?: string): AsrTranscriptResult {
  return { text: text ?? units.map((u) => u.normalizedText).join(" "), rawText: null, providerId: "test", units };
}

describe("accuracy baseline scoring", () => {
  const two = truthOf([utt("A", "hello world", 0, 1000), utt("B", "good morning", 1000, 3000)]);

  it("scores a perfect match as zero error", () => {
    const r = scoreTranscript(two, resultOf([unit("hello world", "A", 0, 1000), unit("good morning", "B", 1000, 3000)]));
    expect(r.speaker.wrongShare).toBe(0);
    expect(r.speaker.coverage).toBe(1);
    expect(r.speaker.referenceSpeakers).toBe(2);
    expect(r.speaker.hypothesisSpeakers).toBe(2);
    expect(r.offset).toEqual({ matchedUtterances: 2, medianMs: 0, p90Ms: 0 });
    expect(r.text.errorRate).toBe(0);
  });

  it("maps arbitrary hypothesis labels, including swapped ones, with zero error", () => {
    const r = scoreTranscript(two, resultOf([unit("hello world", "spk_1", 0, 1000), unit("good morning", "spk_0", 1000, 3000)]));
    expect(r.speaker.wrongShare).toBe(0);
    expect(r.speaker.mapping).toEqual({ spk_1: "A", spk_0: "B" });
  });

  it("reports the wrong share when one utterance gets the wrong speaker", () => {
    // A 0-1000, B 1000-2000, A 2000-3000. The third utterance is labelled y (B's label).
    // Best mapping x->A, y->B matches 1000 + 1000 ms; 1000 of 3000 labelled ms is wrong.
    const truth = truthOf([utt("A", "one", 0, 1000), utt("B", "two", 1000, 2000), utt("A", "three", 2000, 3000)]);
    const r = scoreTranscript(truth, resultOf([unit("one", "x", 0, 1000), unit("two", "y", 1000, 2000), unit("three", "y", 2000, 3000)]));
    expect(r.speaker.labelledOverlapMs).toBe(3000);
    expect(r.speaker.wrongOverlapMs).toBe(1000);
    expect(r.speaker.wrongShare).toBeCloseTo(1 / 3, 10);
  });

  it("counts reference time without a labelled unit as lower coverage, not as wrong", () => {
    const r = scoreTranscript(two, resultOf([unit("hello world", "A", 0, 1000), unit("good morning", null, 1000, 3000)]));
    expect(r.speaker.labelledOverlapMs).toBe(1000);
    expect(r.speaker.wrongShare).toBe(0);
    expect(r.speaker.coverage).toBeCloseTo(1000 / 3000, 10);
  });

  it("computes median and p90 start offsets (nearest rank)", () => {
    const truth = truthOf([
      utt("A", "alpha", 0, 1000),
      utt("A", "bravo", 2000, 3000),
      utt("A", "charlie", 4000, 5000),
      utt("A", "delta", 6000, 7000),
    ]);
    const r = scoreTranscript(
      truth,
      resultOf([unit("alpha", "A", 100, 1000), unit("bravo", "A", 2200, 3000), unit("charlie", "A", 3700, 5000), unit("delta", "A", 6400, 7000)]),
    );
    // Absolute offsets 100, 200, 300, 400: median 250, p90 = 4th value.
    expect(r.offset).toEqual({ matchedUtterances: 4, medianMs: 250, p90Ms: 400 });
  });

  it("excludes units with unknown or audio-span timing from offset statistics and reports shares", () => {
    const truth = truthOf([utt("A", "alpha one", 0, 1000), utt("A", "beta two", 2000, 3000), utt("A", "gamma three", 4000, 5000), utt("A", "delta four", 6000, 7000)]);
    const r = scoreTranscript(
      truth,
      resultOf([
        unit("alpha one", "A", 100, 1000, "provider"),
        unit("beta two", "A", 9000, 9500, "unknown"),
        unit("gamma three", "A", 4000, 5000, "audio-span"),
        unit("delta four", "A", null, null, "unknown"),
      ]),
    );
    expect(r.offset).toEqual({ matchedUtterances: 1, medianMs: 100, p90Ms: 100 });
    expect(r.timing).toEqual({ provider: 0.25, audioSpan: 0.25, unknown: 0.5, totalUnits: 4 });
  });

  it("uses the earliest matching provider unit of an utterance", () => {
    const truth = truthOf([utt("A", "red green blue yellow", 1000, 5000)]);
    const r = scoreTranscript(truth, resultOf([unit("blue yellow", "A", 3000, 5000), unit("red green", "A", 1300, 3000)]));
    expect(r.offset.medianMs).toBe(300);
  });

  it("tokenizes CJK characters one by one and Latin runs as lower-case words", () => {
    expect(tokenize("Hello, 世界 API2 don't!")).toEqual(["hello", "世", "界", "api2", "don't"]);
    expect(tokenize("，。 !? ")).toEqual([]);
  });

  it("measures mixed CJK and English text error over tokens", () => {
    // Reference tokens: 我 用 python 写 代 码 (6). One word substituted -> 1/6.
    const truth = truthOf([utt("A", "我用 Python 写代码", 0, 1000)]);
    const r = scoreTranscript(truth, resultOf([unit("我用 Java 写代码", "A", 0, 1000)]));
    expect(r.text.referenceTokens).toBe(6);
    expect(r.text.editDistance).toBe(1);
    expect(r.text.errorRate).toBeCloseTo(1 / 6, 10);
  });

  it("computes edit distance with insertions, deletions and substitutions", () => {
    expect(editDistance(["a", "b", "c"], ["a", "c"])).toBe(1);
    expect(editDistance([], ["a", "b"])).toBe(2);
    expect(editDistance(["a", "b", "c"], ["x", "b", "y", "z"])).toBe(3);
  });

  it("handles an empty hypothesis without dividing by zero", () => {
    const r = scoreTranscript(two, resultOf([], ""));
    expect(r.speaker.hypothesisSpeakers).toBe(0);
    expect(r.speaker.referenceSpeakers).toBe(2);
    expect(r.speaker.wrongShare).toBe(0);
    expect(r.speaker.coverage).toBe(0);
    expect(r.offset).toEqual({ matchedUtterances: 0, medianMs: null, p90Ms: null });
    expect(r.timing).toEqual({ provider: 0, audioSpan: 0, unknown: 0, totalUnits: 0 });
    // Four reference tokens, all missing.
    expect(r.text.errorRate).toBe(1);
  });

  it("scores the English fixture pair as clean", () => {
    const dir = new URL("./fixtures/accuracy-baseline/", import.meta.url);
    const truth = JSON.parse(readFileSync(new URL("english-truth.json", dir), "utf8")) as GroundTruth;
    const result = JSON.parse(readFileSync(new URL("english-result.json", dir), "utf8")) as AsrTranscriptResult;
    const r = scoreTranscript(truth, result);
    expect(r.speaker.wrongShare).toBe(0);
    expect(r.text.errorRate).toBe(0);
    expect(r.offset.matchedUtterances).toBe(8);
  });

  it("scores the mixed-language fixture pair with its known defects", () => {
    const dir = new URL("./fixtures/accuracy-baseline/", import.meta.url);
    const truth = JSON.parse(readFileSync(new URL("mixed-truth.json", dir), "utf8")) as GroundTruth;
    const result = JSON.parse(readFileSync(new URL("mixed-result.json", dir), "utf8")) as AsrTranscriptResult;
    const r = scoreTranscript(truth, result);
    // One character substituted (五 -> 伍), one unit without timing, one utterance given to the wrong speaker.
    expect(r.text.editDistance).toBe(1);
    expect(r.timing.unknown).toBe(1 / 8);
    expect(r.offset.matchedUtterances).toBe(7);
    expect(r.speaker.wrongShare).toBeGreaterThan(0);
    expect(r.speaker.mapping).toEqual({ spk_2: "Alice", spk_0: "Bob", spk_1: "Carol" });
  });
});

describe("number normalization and hypothesis text", () => {
  it("writes Chinese numerals as Arabic digits", () => {
    expect(normalizeNumbers("还剩十一个，四十二万，百分之十五，二〇二六年，两点")).toBe("还剩11个，420000，15，2026年，2点");
  });

  it("scores units' text, not result.text with time and speaker labels", () => {
    const truth = { title: "t", language: "zh" as const, utterances: [{ speaker: "A", text: "还剩十一个", startMs: 0, endMs: 1000 }] };
    const result = {
      text: "[00:00] [Speaker 1] 还剩11个",
      rawText: null,
      providerId: "p",
      units: [{ rawText: "还剩11个", normalizedText: "还剩11个", speakerId: "0", speakerName: null, startMs: 0, endMs: 1000, timing: "provider" as const }],
    };
    const score = scoreText(truth, result);
    // Reference 还 剩 十 一 个 (5) vs hypothesis 还 剩 11 个 (4): 十→11 substitution plus 一 deletion = 2 edits.
    expect(score.editDistance).toBe(2);
    expect(score.numberNormalizedErrorRate).toBe(0);
  });
});

describe("offset matching window", () => {
  it("does not match a repeated short reply to a unit minutes away", () => {
    const truth = {
      title: "t", language: "zh" as const,
      utterances: [
        { speaker: "A", text: "对。", startMs: 1_000, endMs: 1_500 },
        { speaker: "B", text: "我们下周再讨论预算。", startMs: 2_000, endMs: 5_000 },
        { speaker: "A", text: "对。", startMs: 600_000, endMs: 600_500 },
      ],
    };
    const unit = (text: string, startMs: number) => ({ rawText: text, normalizedText: text, speakerId: null, speakerName: null, startMs, endMs: startMs + 500, timing: "provider" as const });
    // The early 对 is missing from the hypothesis; only the late one is present.
    const result = { text: "", rawText: null, providerId: "p", units: [unit("我们下周再讨论预算。", 2_100), unit("对。", 600_050)] };
    const score = scoreTranscript(truth, result).offset;
    // Matches: 预算 sentence (100 ms) and the late 对 (50 ms); the early 对 stays unmatched instead of a 599 s offset.
    expect(score.matchedUtterances).toBe(2);
    expect(score.p90Ms).toBe(100);
  });
});
