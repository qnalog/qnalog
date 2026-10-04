import { describe, expect, it } from "vitest";

import { getActiveUiLanguage, matchUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import {
  getAsrTransportTaskRecoveryPatch,
  getNextAsrTaskRetryCount,
  getTranscribeSegmentPlaceholder,
  isAsrNonRetryableError,
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
    // 占位文案随界面语言（labelText）：先锁 zh 校验存量中文占位，再锁 en 校验英文占位。
    const original = getActiveUiLanguage();
    try {
      setActiveUiLanguage(matchUiLanguage("zh") as never);
      const pending = getTranscribeSegmentPlaceholder(new Error("Failed to fetch"));
      expect(pending).toBe("_[等待后台转写，音频已保留]_");
      expect(pending).not.toContain("Failed to fetch");

      const incomplete = getTranscribeSegmentPlaceholder(new Error("无法解码音频"), { retryable: false });
      expect(incomplete).toBe("_[此段尚未完成转写，音频已保留]_");
      expect(incomplete).not.toContain("无法解码");

      setActiveUiLanguage(matchUiLanguage("en") as never);
      const pendingEn = getTranscribeSegmentPlaceholder(new Error("Failed to fetch"));
      expect(pendingEn).toBe("_[Waiting for background transcription; the audio has been kept]_");
      expect(pendingEn).not.toContain("Failed to fetch");

      const incompleteEn = getTranscribeSegmentPlaceholder(new Error("无法解码音频"), { retryable: false });
      expect(incompleteEn).toBe("_[This segment is not fully transcribed yet; the audio has been kept]_");
      expect(incompleteEn).not.toContain("无法解码");
    } finally {
      setActiveUiLanguage(original);
    }
  });

  it("preserves classification and recovery behavior for unknown queue inputs", () => {
    expect(isAsrTransportError("Failed to fetch")).toBe(true);
    expect(isAsrTransportError({ message: "ECONNRESET" })).toBe(true);
    expect(isAsrTransportError({ asrTransport: true, nonRetryable: true })).toBe(false);
    expect(isTransientAsrError({ asrTransport: true, nonRetryable: true })).toBe(false);
    expect(isAsrNonRetryableError("API key is not configured")).toBe(true);
    expect(getNextAsrTaskRetryCount(1, 3, "API key is not configured")).toBe(3);
    expect(getNextAsrTaskRetryCount(1, 3, "转写返回空结果")).toBe(2);

    const persistedTask = {
      type: "transcribe",
      status: "failed",
      retries: "3",
      lastError: "Failed to fetch",
      unrelated: "retained",
    };
    const snapshot = JSON.stringify(persistedTask);
    expect(getAsrTransportTaskRecoveryPatch(persistedTask, 3)).toEqual({
      status: "pending",
      retries: 2,
      deferredReason: "service-unavailable",
    });
    expect(persistedTask).toEqual(JSON.parse(snapshot));
    expect(getAsrTransportTaskRecoveryPatch({ ...persistedTask, type: "merge" }, 3)).toBeNull();
    expect(getAsrTransportTaskRecoveryPatch({ ...persistedTask, status: "pending" }, 3)).toBeNull();
  });
});
