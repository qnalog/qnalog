import { describe, expect, it, vi } from "vitest";
let captured: any = null;
vi.mock("obsidian", () => ({
  requestUrl: async (o: any) => { captured = { ...captured, lookup: o.url }; return { json: { data: { endpoints: [{ tag: "azure" }] } } }; },
  normalizePath: (p: string) => String(p || ""),
  TFile: class {}, TFolder: class {},
}));
import { transcribeWithOpenRouterDiarize } from "../src/asr/openrouter-diarize";

describe("OpenRouter 分离请求形状", () => {
  it("发 JSON、带 provider.options.azure.diarization.enabled，并要求 verbose_json", async () => {
    let body: any = null;
    (globalThis as any).window = { fetch: async (_u: string, o: any) => { body = JSON.parse(o.body); return { ok: true, json: async () => ({ text: "hi", segments: [{ start: 0, end: 1, text: "hi", speaker: 0 }] }) }; }, setTimeout: () => 0, clearTimeout: () => {} };
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" });
    const out = await transcribeWithOpenRouterDiarize(
      { id: "openrouter-diarize", endpoint: "https://openrouter.ai/api/v1/audio/transcriptions", apiKey: "sk-x", model: "microsoft/mai-transcribe-2" },
      blob, "audio/mpeg",
    );
    expect(captured.lookup).toContain("microsoft/mai-transcribe-2/endpoints");
    expect(body.model).toBe("microsoft/mai-transcribe-2");
    expect(body.response_format).toBe("verbose_json");
    expect(body.timestamp_granularities).toEqual(["segment", "word"]);
    expect(body.provider.options.azure.diarization.enabled).toBe(true);
    expect(body.input_audio.format).toBe("mp3");
    expect(typeof body.input_audio.data).toBe("string");
    // 没有 multipart：file 字段不应出现
    expect(body.file).toBeUndefined();
    // 说话人标签被归一成 [说话人N] 前缀（既有 extractTranscriptText 的行为）
    expect(out.text).toBe("[说话人1] hi");
    expect(out.rawText).toBeNull();
    expect(out.units).toEqual([expect.objectContaining({
      rawText: "hi",
      normalizedText: "hi",
      speakerId: "0",
      speakerName: "说话人1",
      startMs: 0,
      endMs: 1000,
      timing: "provider",
    })]);
  });

  it("groups word-only responses by speaker and sentence punctuation", async () => {
    (globalThis as any).window = {
      fetch: async () => ({
        ok: true,
        json: async () => ({
          text: "Let's go.",
          words: [
            { word: "Let", speaker: 0, start: 0, end: 0.2 },
            { word: " us", speaker: 0, start: 0.2, end: 0.4 },
            { word: " go.", speaker: 0, start: 0.4, end: 0.8 },
          ],
        }),
      }),
      setTimeout: () => 0,
      clearTimeout: () => {},
    };
    const out = await transcribeWithOpenRouterDiarize(
      { id: "openrouter-diarize", endpoint: "https://openrouter.ai/api/v1/audio/transcriptions", apiKey: "sk-x", model: "microsoft/mai-transcribe-2" },
      new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }),
      "audio/mpeg",
    );
    expect(out.units).toEqual([expect.objectContaining({
      rawText: "Let us go.",
      speakerId: "0",
      speakerName: "说话人1",
      startMs: 0,
      endMs: 800,
      timing: "provider",
    })]);
  });
});
