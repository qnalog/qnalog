import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
}));
import { probeAudioDurationMs } from "../src/notes/audio-refs";

// MediaRecorder 录出的 WebM 头部没有 Duration 字段，Chromium 把 audio.duration 报成 Infinity：
// 侧边栏纪要播放器因此把总时长显示成 0:00、进度条停在最左、点击进度条不跳转（导入路径读到 0 时长同因）。
// probeAudioDurationMs 的契约：已有限时长直接返回现值且不动播放头；无限时长时推播放头到 1e101
// 强制解码器扫到文件尾回填总长，结束后播放头归位；超时/报错返回 0 且同样归位。
// 真实文件行为见交付说明中的 Chromium 实测（Infinity → 5.396s）。

// vitest 跑在 Node 环境，没有 window；探测函数用 window.setTimeout，把全局对象挂成 window。
const globalsWithWindow = globalThis as unknown as { window?: typeof globalThis };
globalsWithWindow.window = globalThis;

class FakeAudio {
  duration = Infinity;
  currentTime = 0;
  private listeners: Record<string, Array<() => void>> = {};
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  emit(type: string) {
    for (const fn of [...(this.listeners[type] || [])]) fn();
  }
}

function asElement(fake: FakeAudio): HTMLAudioElement {
  // FakeAudio 只实现被测函数用到的成员，结构上无法与完整 HTMLAudioElement 统一：测试专用转换。
  const element = fake as unknown as HTMLAudioElement;
  return element;
}

describe("probeAudioDurationMs", () => {
  it("时长已有限时直接返回现值，不动播放头", async () => {
    const audio = new FakeAudio();
    audio.duration = 12.5;
    audio.currentTime = 3;
    await expect(probeAudioDurationMs(asElement(audio))).resolves.toBe(12500);
    expect(audio.currentTime).toBe(3);
  });

  it("时长为 Infinity 时推播放头逼出真实总长，结束后播放头归位", async () => {
    const audio = new FakeAudio();
    const pending = probeAudioDurationMs(asElement(audio), 5000);
    // 探测同步发出超远 seek——这是逼出时长的手段本身。
    expect(audio.currentTime).toBe(1e101);
    audio.duration = 5.396;
    audio.emit("durationchange");
    await expect(pending).resolves.toBe(5396);
    // 播放头必须回到探测前的位置，否则用户一打开播放器就停在结尾。
    expect(audio.currentTime).toBe(0);
  });

  it("超时时返回 0，播放头同样归位（不把 1e101 留给播放）", async () => {
    const audio = new FakeAudio();
    await expect(probeAudioDurationMs(asElement(audio), 25)).resolves.toBe(0);
    expect(audio.currentTime).toBe(0);
  });

  it("元素报错时立即返回 0，不等超时", async () => {
    const audio = new FakeAudio();
    const pending = probeAudioDurationMs(asElement(audio), 5000);
    audio.emit("error");
    await expect(pending).resolves.toBe(0);
    expect(audio.currentTime).toBe(0);
  });

  it("探测结束后监听器已卸载，后续 durationchange 不再产生副作用", async () => {
    const audio = new FakeAudio();
    const pending = probeAudioDurationMs(asElement(audio), 5000);
    audio.duration = 2;
    audio.emit("durationchange");
    await pending;
    audio.duration = 99;
    audio.emit("durationchange");
    expect(audio.currentTime).toBe(0);
  });
});
