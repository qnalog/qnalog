import { describe, expect, it } from "vitest";
import { computeAudioRms } from "../src/audio/audio-level";

describe("音频片段均方根（RMS）", () => {
  it("全零片段为 0", () => {
    expect(computeAudioRms([new Float32Array(1000)], 1000, 0, 1000)).toBe(0);
  });

  it("恒定幅度的 RMS 等于幅度", () => {
    expect(computeAudioRms([new Float32Array(500).fill(0.25)], 1000, 0, 500)).toBeCloseTo(0.25, 10);
    expect(computeAudioRms([new Float32Array(500).fill(-0.25)], 1000, 0, 500)).toBeCloseTo(0.25, 10);
  });

  it("正弦波的 RMS 为幅度除以根号 2", () => {
    // 采样率 8000 Hz，1 秒内 440 个完整周期，RMS 理论值 0.8 / √2。
    const sampleRate = 8000;
    const samples = new Float32Array(sampleRate);
    for (let i = 0; i < samples.length; i++) samples[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    expect(computeAudioRms([samples], sampleRate, 0, 1000)).toBeCloseTo(0.8 / Math.SQRT2, 3);
  });

  it("按毫秒切片时只统计区间内的采样", () => {
    // 采样率 1000 Hz：前 1 秒为 0，后 1 秒为 1。
    const samples = new Float32Array(2000).fill(1, 1000);
    expect(computeAudioRms([samples], 1000, 0, 1000)).toBe(0);
    expect(computeAudioRms([samples], 1000, 1000, 2000)).toBe(1);
    // [500, 1500)：500 个 0 与 500 个 1，均方为 0.5，RMS 为 √0.5。
    expect(computeAudioRms([samples], 1000, 500, 1500)).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it("结束时间超过音频末尾时截到末尾", () => {
    const samples = new Float32Array(2000).fill(1, 1000);
    expect(computeAudioRms([samples], 1000, 1000, 9000)).toBe(1);
  });

  it("多声道按全部采样的平方平均计算", () => {
    const left = new Float32Array(100).fill(1);
    const right = new Float32Array(100);
    // 一个声道满量程、一个声道静音：均方为 0.5。
    expect(computeAudioRms([left, right], 100, 0, 1000)).toBeCloseTo(Math.SQRT1_2, 10);
    // 两个声道等幅：结果与单声道相同。
    expect(computeAudioRms([new Float32Array(100).fill(0.3), new Float32Array(100).fill(0.3)], 100, 0, 1000)).toBeCloseTo(0.3, 5);
  });

  it("区间内没有采样或没有声道时返回 NaN，调用方不会把它判为静音", () => {
    expect(computeAudioRms([new Float32Array(100)], 100, 1000, 1000)).toBeNaN();
    expect(computeAudioRms([], 100, 0, 1000)).toBeNaN();
    expect(computeAudioRms([new Float32Array(100)], 0, 0, 1000)).toBeNaN();
    expect(computeAudioRms([new Float32Array(100)], 100, 0, 1000) < 0.01).toBe(true);
  });
});
