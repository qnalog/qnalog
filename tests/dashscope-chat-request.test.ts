import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || ""),
  TFile: class TFile {},
  TFolder: class TFolder {},
  Notice: class Notice {},
}));

import {
  DASHSCOPE_CHAT_ASR_PROTOCOL,
  requestChatInputAudioChunk,
  getChatInputAudioProfile,
} from "../src/asr/transcribe";

const dashscopeProfile = getChatInputAudioProfile({ protocol: DASHSCOPE_CHAT_ASR_PROTOCOL })!;
const apimimoProfile = getChatInputAudioProfile({ protocol: "apimimo-chat-input-audio" })!;

/** 服务端回的 SSE 形状取自官方文档：先一个空 delta，再正文，最后 finish_reason + [DONE]。 */
function makeSseResponse(content: string) {
  const body = [
    JSON.stringify({ choices: [{ delta: { content: "", role: "assistant" } }] }),
    JSON.stringify({ choices: [{ delta: { content } }] }),
    JSON.stringify({ choices: [{ delta: { content: "" }, finish_reason: "stop" }] }),
    "[DONE]",
  ].map((e) => `data: ${e}\n\n`).join("");
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/event-stream" : "") },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    text: async () => body,
  };
}

interface Captured {
  url: string;
  init: { headers: Record<string, string>; body: string };
}

let captured: Captured | null = null;

function stubFetch(content = "转写正文。"): void {
  captured = null;
  vi.stubGlobal("window", {
    fetch: vi.fn(async (url: string, init: Captured["init"]) => {
      captured = { url, init };
      return makeSseResponse(content);
    }),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
}

const blob = {
  size: 1024,
  type: "audio/webm",
  arrayBuffer: async () => new ArrayBuffer(8),
};

const dashscopeProvider = {
  id: "dashscope-chat",
  endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: "sk-test",
  model: "qwen3-asr-flash",
  language: "",
};

const endpoint = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

describe("百炼分段转写的请求形状", () => {
  afterEach(() => { vi.unstubAllGlobals(); captured = null; });

  it("打到 /chat/completions，带 Bearer 鉴权", async () => {
    stubFetch();
    await requestChatInputAudioChunk(dashscopeProfile, dashscopeProvider, { blob, mime: "audio/webm" }, endpoint);
    expect(captured!.url).toBe(endpoint);
    expect(captured!.init.headers.Authorization).toBe("Bearer sk-test");
  });

  it("请求体是文档规定的 input_audio 形状", async () => {
    stubFetch();
    await requestChatInputAudioChunk(dashscopeProfile, dashscopeProvider, { blob, mime: "audio/webm" }, endpoint);
    const payload = JSON.parse(captured!.init.body);
    expect(payload.model).toBe("qwen3-asr-flash");
    expect(payload.messages[0].role).toBe("user");
    expect(payload.messages[0].content[0].type).toBe("input_audio");
    expect(payload.messages[0].content[0].input_audio.data).toMatch(/^data:audio\/webm;base64,/);
    expect(payload.stream).toBe(true);
  });

  it("语种留空时不下发 asr_options（文档要求不确定就省略该字段）", async () => {
    stubFetch();
    await requestChatInputAudioChunk(dashscopeProfile, dashscopeProvider, { blob, mime: "audio/webm" }, endpoint);
    expect(JSON.parse(captured!.init.body).asr_options).toBeUndefined();
  });

  it("指定语种时透传", async () => {
    stubFetch();
    await requestChatInputAudioChunk(dashscopeProfile, { ...dashscopeProvider, language: "zh" }, { blob, mime: "audio/webm" }, endpoint);
    expect(JSON.parse(captured!.init.body).asr_options).toEqual({ language: "zh" });
  });

  it("从 SSE 里取出正文", async () => {
    stubFetch("百炼返回的正文。");
    const text = await requestChatInputAudioChunk(dashscopeProfile, dashscopeProvider, { blob, mime: "audio/webm" }, endpoint);
    expect(text).toBe("百炼返回的正文。");
  });

  it("APIMiMo 仍下发 auto，未被百炼的改动带偏", async () => {
    stubFetch();
    await requestChatInputAudioChunk(
      apimimoProfile,
      { ...dashscopeProvider, id: "apimimo", model: "mimo-v2.5-asr" },
      { blob, mime: "audio/wav" },
      "https://api.xiaomimimo.com/v1/chat/completions",
    );
    expect(JSON.parse(captured!.init.body).asr_options).toEqual({ language: "auto" });
  });
});
