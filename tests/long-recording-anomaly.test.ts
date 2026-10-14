import { describe, expect, it } from "vitest";
import { classifyLongRecordingAnomaly } from "../src/audio/long-recording-anomaly";

describe("classifyLongRecordingAnomaly", () => {
  it("accepts a normal Chinese transcript for ten minutes", () => {
    const transcript = "今天我们讨论项目安排。随后确认负责人和时间。对外答复由运营团队准备。".repeat(90);
    expect(Array.from(transcript).length).toBe(3060);
    expect(classifyLongRecordingAnomaly(transcript, 600_000)).toEqual([]);
  });

  it("accepts a normal long English transcript", () => {
    const transcript = "We reviewed the schedule and agreed on the next steps. ".repeat(100);
    expect(classifyLongRecordingAnomaly(transcript, 600_000)).toEqual([]);
  });

  it("detects a repeated service marker in a 41 KB result", () => {
    const repeatedMarkup = "<chinese>".repeat(4552);
    expect(repeatedMarkup.length).toBe(40_968);
    expect(classifyLongRecordingAnomaly(repeatedMarkup, 4_000_000)).toEqual(["repetition"]);
  });

  it("accepts a short repeated fragment when it occupies less than sixty percent", () => {
    const transcript = `${"正常讨论内容。".repeat(40)}${"<tag>".repeat(50)}${"后续事项已经确认。".repeat(40)}`;
    expect(classifyLongRecordingAnomaly(transcript, 600_000)).toEqual([]);
  });

  it("accepts empty, punctuation-only, and short audio results", () => {
    expect(classifyLongRecordingAnomaly("", 600_000)).toEqual([]);
    expect(classifyLongRecordingAnomaly("。，！？…—?!".repeat(100), 600_000)).toEqual([]);
    expect(classifyLongRecordingAnomaly("字".repeat(500), 9_999)).toEqual([]);
  });

  it("uses a strict density boundary of fifteen characters per second", () => {
    expect(classifyLongRecordingAnomaly("字".repeat(150), 10_000)).toEqual([]);
    expect(classifyLongRecordingAnomaly("字".repeat(151), 10_000)).toEqual(["density"]);
  });

  it("detects repetition only above both size and share boundaries", () => {
    expect(classifyLongRecordingAnomaly("abcde".repeat(40), 600_000)).toEqual([]);
    expect(classifyLongRecordingAnomaly("x".repeat(200), 600_000)).toEqual([]);
    expect(classifyLongRecordingAnomaly("x".repeat(201), 600_000)).toEqual(["repetition"]);
    expect(classifyLongRecordingAnomaly(`${"x".repeat(180)}${"normal".repeat(20)}`, 600_000)).toEqual([]);
  });

  it("adds separated runs of the same short marker when measuring repetition share", () => {
    const transcript = `${"abc".repeat(40)}${"normal".repeat(10)}${"abc".repeat(40)}`;
    expect(classifyLongRecordingAnomaly(transcript, 600_000)).toEqual(["repetition"]);
  });

  it("processes a 200 KB transcript within 200 milliseconds", () => {
    const input = "<chinese>".repeat(22_223);
    const startedAt = performance.now();
    expect(classifyLongRecordingAnomaly(input, 20_000_000)).toEqual(["repetition"]);
    expect(performance.now() - startedAt).toBeLessThan(200);
  });
});
