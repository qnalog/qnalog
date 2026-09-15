import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || ""),
  TFile: class {}, TFolder: class {},
}));
import { TranscribeProfileService } from "../src/asr/transcribe-profile-service";

const host = { settings: { activeTranscribeProvider: "siliconflow", transcribeProviders: {} } } as never;
const svc = new TranscribeProfileService(host);

// 用户自建 / 未预设的转写服务：密钥栏提示必须与实际运行要求一致。
// 反例：一律沿用 custom 的 requiresKey:false，界面显示「可选」，运行时却因缺 key 报错。
describe("未预设转写服务的密钥必填判定", () => {
  it("远端服务 → 要求密钥", () => {
    for (const endpoint of [
      "https://api.example.com/v1/audio/transcriptions",
      "https://gateway.corp.cn/v1/audio/transcriptions",
      "http://203.0.113.10:8000/v1/audio/transcriptions",
    ]) {
      const profile = svc.getTranscribeProviderProfile("用户自建", { endpoint }) as { requiresKey: boolean };
      expect(profile.requiresKey, endpoint).toBe(true);
    }
  });

  it("本地 / 内网服务 → 不要求密钥", () => {
    for (const endpoint of [
      "http://127.0.0.1:8000/v1/audio/transcriptions",
      "http://localhost:9000/v1/audio/transcriptions",
      "http://192.168.1.20:8000/v1/audio/transcriptions",
      "http://10.0.0.5/v1/audio/transcriptions",
    ]) {
      const profile = svc.getTranscribeProviderProfile("本地服务", { endpoint }) as { requiresKey: boolean };
      expect(profile.requiresKey, endpoint).toBe(false);
    }
  });

  it("地址缺失或不可解析 → 按远端处理，避免界面误导", () => {
    for (const endpoint of ["", "not a url", undefined]) {
      const profile = svc.getTranscribeProviderProfile("未配置", { endpoint }) as { requiresKey: boolean };
      expect(profile.requiresKey, String(endpoint)).toBe(true);
    }
  });

  it("内置预设不受影响", () => {
    expect((svc.getTranscribeProviderProfile("siliconflow", {}) as { requiresKey: boolean }).requiresKey).toBe(true);
    expect((svc.getTranscribeProviderProfile("local", {}) as { requiresKey: boolean }).requiresKey).toBe(false);
  });
});
