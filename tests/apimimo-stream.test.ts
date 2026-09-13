import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import {
  APIMIMO_ASR_CHUNK_MS,
  applyApimimoSseData,
  estimateApimimoAudioSeconds,
  getApimimoNativeAudioPlan,
  pickAsrRetryDelayMs,
  reserveApimimoTpmSlot,
  requestApimimoAsrChunkWithEmptyRetry,
} from "../src/asr/transcribe";

function makeAcc() {
  return { text: "", finishReason: null, done: false };
}

describe("applyApimimoSseData", () => {
  it("跨多个事件累加 delta.content", () => {
    const acc = makeAcc();
    applyApimimoSseData(acc, JSON.stringify({ choices: [{ delta: { content: "今天" } }] }));
    applyApimimoSseData(acc, JSON.stringify({ choices: [{ delta: { content: "开会" } }] }));
    applyApimimoSseData(acc, JSON.stringify({ choices: [{ delta: { content: "讨论预算。" } }] }));

    expect(acc.text).toBe("今天开会讨论预算。");
    expect(acc.done).toBe(false);
    expect(acc.finishReason).toBeNull();
  });

  it("[DONE] 置 done=true，不改动已累积文本", () => {
    const acc = makeAcc();
    applyApimimoSseData(acc, JSON.stringify({ choices: [{ delta: { content: "结论" } }] }));
    applyApimimoSseData(acc, "[DONE]");

    expect(acc.done).toBe(true);
    expect(acc.text).toBe("结论");
  });

  it("捕获 finish_reason（含末包同时带 delta 的情况）", () => {
    const acc = makeAcc();
    applyApimimoSseData(acc, JSON.stringify({ choices: [{ delta: { content: "完" }, finish_reason: null }] }));
    expect(acc.finishReason).toBeNull(); // null 不算捕获

    applyApimimoSseData(acc, JSON.stringify({ choices: [{ delta: { content: "毕" }, finish_reason: "stop" }] }));
    expect(acc.finishReason).toBe("stop");
    expect(acc.text).toBe("完毕");

    const accLen = makeAcc();
    applyApimimoSseData(accLen, JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }));
    expect(accLen.finishReason).toBe("length");
  });

  it("非法 JSON 事件被忽略，acc 原样返回", () => {
    const acc = makeAcc();
    applyApimimoSseData(acc, JSON.stringify({ choices: [{ delta: { content: "有效" } }] }));
    const returned = applyApimimoSseData(acc, "{broken json!!");

    expect(returned).toBe(acc);
    expect(acc.text).toBe("有效");
    expect(acc.done).toBe(false);
    expect(acc.finishReason).toBeNull();
  });

  it("空 payload 与缺 choices 的事件同样忽略", () => {
    const acc = makeAcc();
    applyApimimoSseData(acc, "");
    applyApimimoSseData(acc, JSON.stringify({ id: "x", object: "chat.completion.chunk" }));

    expect(acc.text).toBe("");
    expect(acc.done).toBe(false);
  });

  it("message.content 全文兜底：仅在比已累积文本更长时整体替换", () => {
    // 更长 → 替换
    const acc = makeAcc();
    applyApimimoSseData(acc, JSON.stringify({ choices: [{ delta: { content: "前半" } }] }));
    applyApimimoSseData(acc, JSON.stringify({ choices: [{ message: { content: "前半后半完整全文" } }] }));
    expect(acc.text).toBe("前半后半完整全文");

    // 更短 → 不覆盖已收全的增量
    const acc2 = makeAcc();
    applyApimimoSseData(acc2, JSON.stringify({ choices: [{ delta: { content: "已经收到的完整增量文本" } }] }));
    applyApimimoSseData(acc2, JSON.stringify({ choices: [{ message: { content: "短兜底" } }] }));
    expect(acc2.text).toBe("已经收到的完整增量文本");

    // 等长 → 也不替换（严格「更长」）
    const acc3 = makeAcc();
    applyApimimoSseData(acc3, JSON.stringify({ choices: [{ delta: { content: "一样长" } }] }));
    applyApimimoSseData(acc3, JSON.stringify({ choices: [{ message: { content: "另三字" } }] }));
    expect(acc3.text).toBe("一样长");
  });
});

describe("pickAsrRetryDelayMs", () => {
  it("错误信息带 Retry-After → 按服务端秒数 + 0-2s 抖动", () => {
    for (let i = 0; i < 20; i++) {
      const ms = pickAsrRetryDelayMs("转写失败 429 Too Many Requests；服务限流；Retry-After: 30s", i + 1);
      expect(ms).toBeGreaterThanOrEqual(30000);
      expect(ms).toBeLessThan(32000);
    }
  });

  it("Retry-After 支持中文冒号", () => {
    const ms = pickAsrRetryDelayMs("限流；Retry-After：5", 1);
    expect(ms).toBeGreaterThanOrEqual(5000);
    expect(ms).toBeLessThan(7000);
  });

  it("Retry-After 过大时封顶 90s（≤92s）", () => {
    for (let i = 0; i < 20; i++) {
      const ms = pickAsrRetryDelayMs("Retry-After: 600", 1);
      expect(ms).toBe(90000);
      expect(ms).toBeLessThanOrEqual(92000);
    }
  });

  it("429 / 限流 / rate limit → 30-45s 长退避", () => {
    for (const msg of ["转写失败 429 Too Many Requests", "服务限流，请稍后重试", "Rate limit exceeded", "too many requests"]) {
      for (let i = 0; i < 20; i++) {
        const ms = pickAsrRetryDelayMs(msg, i + 1);
        expect(ms).toBeGreaterThanOrEqual(30000);
        expect(ms).toBeLessThan(45000);
      }
    }
  });

  it("不把 4290 之类的数字误判为 429，但仍按 500 网络故障退避", () => {
    const ms = pickAsrRetryDelayMs("转写失败 500；trace 42900", 1);
    expect(ms).toBeGreaterThanOrEqual(5000);
    expect(ms).toBeLessThan(6000);
  });

  it("网络与超时按尝试次数指数退避", () => {
    for (const msg of ["转写请求超时：120 秒内没有响应", "network error", "Failed to fetch"]) {
      const first = pickAsrRetryDelayMs(msg, 1);
      const second = pickAsrRetryDelayMs(msg, 2);
      const third = pickAsrRetryDelayMs(msg, 3);
      expect(first).toBeGreaterThanOrEqual(5000);
      expect(first).toBeLessThan(6000);
      expect(second).toBeGreaterThanOrEqual(10000);
      expect(second).toBeLessThan(11000);
      expect(third).toBeGreaterThanOrEqual(20000);
      expect(third).toBeLessThan(21000);
    }
  });

  it("空消息仍使用短退避", () => {
    for (const msg of ["", "empty result"]) {
      for (let i = 0; i < 20; i++) {
        const ms = pickAsrRetryDelayMs(msg, i + 1);
        expect(ms).toBeGreaterThanOrEqual(1200);
        expect(ms).toBeLessThan(2000);
      }
    }
  });
});

describe("reserveApimimoTpmSlot", () => {
  it("在等待前原子预留连续 FIFO 时段", () => {
    const first = reserveApimimoTpmSlot(0, 10_000, 1_000);
    const second = reserveApimimoTpmSlot(first.nextAllowedAt, 10_000, 1_000);
    const third = reserveApimimoTpmSlot(second.nextAllowedAt, 10_000, 1_000);

    expect(first).toEqual({ waitMs: 0, nextAllowedAt: 11_000 });
    expect(second).toEqual({ waitMs: 10_000, nextAllowedAt: 21_000 });
    expect(third).toEqual({ waitMs: 20_000, nextAllowedAt: 31_000 });
  });
});

describe("estimateApimimoAudioSeconds", () => {
  it("wav 按 32,000 字节/秒（16kHz 单声道 16-bit）", () => {
    expect(estimateApimimoAudioSeconds({ size: 320000 }, "audio/wav")).toBe(10);
    // 3 分钟 wav 块 ≈ 5.76MB → 180s → 配速间隔 180*160 = 28.8s
    expect(estimateApimimoAudioSeconds({ size: 180 * 32000 }, "audio/wav")).toBe(180);
  });

  it("mp3（及其它非 wav）按 16,000 字节/秒估", () => {
    expect(estimateApimimoAudioSeconds({ size: 160000 }, "audio/mpeg")).toBe(10);
    expect(estimateApimimoAudioSeconds({ size: 160000 }, "")).toBe(10);
  });

  it("mime 缺省时回退 blob.type；非法体积按 0 处理", () => {
    expect(estimateApimimoAudioSeconds({ size: 32000, type: "audio/wav" }, "")).toBe(1);
    expect(estimateApimimoAudioSeconds({ size: -5 }, "audio/wav")).toBe(0);
    expect(estimateApimimoAudioSeconds(null, "audio/wav")).toBe(0);
  });
});

describe("getApimimoNativeAudioPlan", () => {
  it("原生 wav/mp3 在未知真实时长时都先检查，不再仅按体积直发", () => {
    expect(getApimimoNativeAudioPlan({ size: 32000, type: "audio/wav" }, "audio/wav").action).toBe("inspect");
    expect(getApimimoNativeAudioPlan({ size: 16000, type: "audio/mpeg" }, "audio/mpeg").action).toBe("inspect");
  });

  it("解码后不超过 2 分钟才直发，超过则切块", () => {
    const wav = { size: 1024, type: "audio/wav" };
    expect(getApimimoNativeAudioPlan(wav, "audio/wav", APIMIMO_ASR_CHUNK_MS).action).toBe("direct");
    expect(getApimimoNativeAudioPlan(wav, "audio/wav", APIMIMO_ASR_CHUNK_MS + 1).action).toBe("split");
  });

  it("非原生格式走转码", () => {
    expect(getApimimoNativeAudioPlan({ size: 1024, type: "audio/webm" }, "audio/webm")).toEqual({
      nativeMime: "",
      action: "transcode",
    });
  });
});

describe("requestApimimoAsrChunkWithEmptyRetry", () => {
  it("首轮空结果时只重试当前块一次", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("恢复后的正文");
    const wait = vi.fn().mockResolvedValue(undefined);
    const logDiagnostic = vi.fn().mockResolvedValue(undefined);
    const text = await requestApimimoAsrChunkWithEmptyRetry(
      { logDiagnostic }, {}, { blob: { size: 123 }, mime: "audio/wav" }, "https://example.test", 1, 3, request, wait,
    );

    expect(text).toBe("恢复后的正文");
    expect(request).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(logDiagnostic).toHaveBeenCalledWith("warn", "asr.apimimo_empty_chunk", "APIMiMo 单块转写为空", expect.objectContaining({ attempt: 1 }));
  });

  it("连续空结果必须失败，不能把缺块拼成成功转写", async () => {
    const request = vi.fn().mockResolvedValue("");
    await expect(requestApimimoAsrChunkWithEmptyRetry(
      null, {}, { blob: { size: 123 }, mime: "audio/wav" }, "https://example.test", 0, 2, request, async () => {},
    )).rejects.toThrow("连续返回空结果");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
