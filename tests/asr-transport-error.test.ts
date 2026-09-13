import { describe, expect, it } from "vitest";

import {
  getAsrTransportTaskRecoveryPatch,
  getNextAsrTaskRetryCount,
  getTranscribeSegmentPlaceholder,
  isAsrTransportError,
  isTransientAsrError,
} from "../src/shared/util-audio";

describe("ASR transport error classification", () => {
  it("recognizes browser, Electron, timeout, and localized connection failures", () => {
    for (const message of [
      "Failed to fetch",
      "net::ERR_CONNECTION_CLOSED",
      "ECONNRESET",
      "转写请求超时：120 秒内没有响应",
      "无法连接转写服务；音频已保留，恢复连接后可继续重试",
    ]) {
      expect(isAsrTransportError(new Error(message))).toBe(true);
      expect(isTransientAsrError(new Error(message))).toBe(true);
    }
  });

  it("does not classify an audio-specific empty response as a transport outage", () => {
    expect(isAsrTransportError(new Error("转写返回空结果"))).toBe(false);
    expect(isTransientAsrError(new Error("转写返回空结果"))).toBe(true);
  });

  it("keeps deterministic configuration failures non-retryable", () => {
    const error = new Error("转写访问密钥未配置");
    expect(isAsrTransportError(error)).toBe(false);
    expect(isTransientAsrError(error)).toBe(false);
  });

  it("does not consume an audio task retry for a service outage", () => {
    expect(getNextAsrTaskRetryCount(2, 3, new Error("Failed to fetch"))).toBe(2);
    expect(getNextAsrTaskRetryCount(1, 3, new Error("转写返回空结果"))).toBe(2);
    expect(getNextAsrTaskRetryCount(1, 3, new Error("无法解码音频"))).toBe(3);
  });

  it("keeps technical transport errors out of the note body", () => {
    const pending = getTranscribeSegmentPlaceholder(new Error("Failed to fetch"));
    expect(pending).toBe("_[等待后台转写，音频已保留]_");
    expect(pending).not.toContain("Failed to fetch");

    const incomplete = getTranscribeSegmentPlaceholder(new Error("无法解码音频"), { retryable: false });
    expect(incomplete).toBe("_[此段尚未完成转写，音频已保留]_");
    expect(incomplete).not.toContain("无法解码");
  });

  it("restores exhausted network tasks when loading an older queue", () => {
    expect(getAsrTransportTaskRecoveryPatch({
      type: "transcribe",
      status: "failed",
      retries: 3,
      lastError: "Failed to fetch",
    }, 3)).toEqual({
      status: "pending",
      retries: 2,
      deferredReason: "service-unavailable",
    });
    expect(getAsrTransportTaskRecoveryPatch({
      type: "transcribe",
      status: "failed",
      retries: 3,
      lastError: "无法解码音频",
    }, 3)).toBeNull();
  });
});
