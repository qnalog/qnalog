import { describe, expect, it } from "vitest";
import { checkDomainBoundaries } from "../scripts/check-domain-boundaries.mjs";

// 检查器自身要有回归保护：它拦的是「@ts-nocheck 下不报错、运行时才失效」的引用不一致。
const MAIN = `
class LexVoicePlugin extends obsidian.Plugin {
  declare settings;
  async onload() {
    this.recording = new RecordingService(this);
    this.diagnostics = new DiagnosticsService(this);
  }
  async saveAll() {}
}
`;

function files(extra) {
  return { "src/main.ts": MAIN, ...extra };
}

describe("domain boundary checker", () => {
  it("接受经域服务访问的调用", () => {
    const problems = checkDomainBoundaries(files({
      "src/ui/panel.ts": `export function f(plugin) { plugin.recording.startRecording(); plugin.saveAll(); }`,
    }));
    expect(problems).toEqual([]);
  });

  it("拦下指向已搬走成员的调用", () => {
    const problems = checkDomainBoundaries(files({
      "src/ui/panel.ts": `export function f(plugin) { plugin.startRecording(); }`,
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("plugin.startRecording 不在插件对象上");
  });

  it("拦下未在 Host 接口声明的宿主能力", () => {
    const problems = checkDomainBoundaries(files({
      "src/domain/thing-service.ts": `export interface ThingHost { settings: unknown }
export class ThingService {
  declare host: ThingHost;
  run() { return this.host.saveAll(); }
}`,
    }));
    expect(problems.some((p) => p.includes("this.host.saveAll 未在 Host 接口里声明"))).toBe(true);
  });

  it("拦下 Host 接口指向不存在的插件能力", () => {
    const problems = checkDomainBoundaries(files({
      "src/domain/thing-service.ts": `export interface ThingHost { startRecording(): void }
export class ThingService {
  declare host: ThingHost;
  run() { return this.host.startRecording(); }
}`,
    }));
    expect(problems.some((p) => p.includes("this.host.startRecording 不在插件对象上"))).toBe(true);
  });

  it("拦下跨服务调用里拼错的成员名", () => {
    const problems = checkDomainBoundaries(files({
      "src/ui/panel.ts": `export function f(plugin) { plugin.recording.stopRecordingXX(); }`,
      "src/recording/recording-service.ts": `export class RecordingService {
  declare host;
  stopRecording() { return 1; }
}`,
    }));
    expect(problems.some((p) => p.includes("plugin.recording.stopRecordingXX 不在 RecordingService 上"))).toBe(true);
  });

  it("拦下跨服务调用里指向错误服务的成员（内联类型手抄错的场景）", () => {
    // recording 字段指向 RecordingService，接口里却声明了只有 SessionFinalizeService 才有的成员
    const problems = checkDomainBoundaries({
      "src/main.ts": `
class LexVoicePlugin extends obsidian.Plugin {
  declare settings;
  async onload() {
    this.recording = new RecordingService(this);
    this.sessionFinalize = new SessionFinalizeService(this);
  }
  async saveAll() {}
}
`,
      "src/queue/q-service.ts": `export interface QHost {
  recording: { confirmSpeakerNamesBeforeFinal(): Promise<boolean> };
  sessionFinalize: SessionFinalizeService;
}
export class QService {
  declare host: QHost;
  run() { return this.host.recording.confirmSpeakerNamesBeforeFinal(); }
}`,
      "src/recording/recording-service.ts": `export class RecordingService {
  declare host;
  startRecording() { return 1; }
}`,
      "src/finalize/session-finalize-service.ts": `export class SessionFinalizeService {
  declare host;
  confirmSpeakerNamesBeforeFinal() { return Promise.resolve(true); }
}`,
    });
    expect(problems.some((p) => p.includes("this.host.recording.confirmSpeakerNamesBeforeFinal 不在 RecordingService 上"))).toBe(true);
  });

  it("接受域服务上真实存在的成员", () => {
    const problems = checkDomainBoundaries(files({
      "src/ui/panel.ts": `export function f(plugin) { plugin.recording.stopRecording(); }`,
      "src/recording/recording-service.ts": `export class RecordingService {
  declare host;
  stopRecording() { return 1; }
}`,
    }));
    expect(problems).toEqual([]);
  });
});
