import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || ""),
  TFile: class {}, TFolder: class {},
}));
import { classifyAudioInputDevices, describeAudioDeviceAvailability, pickComputerAudioDevices } from "../src/ui/helpers";

// 「麦克风」下拉必须列出全部输入设备，虚拟声卡不能因为名字像虚拟设备就被藏掉：
// 用户可能就想用虚拟声卡录人声，也可能自己的实体麦克风名字里带 SoundWire 之类关键词，
// 过滤会把他真正的麦克风弄丢。这里锁定「分类只影响分组与标注，不减少可选项」。

const dev = (deviceId: string, label: string, kind = "audioinput") => ({ deviceId, label, kind });

describe("音频输入设备分类", () => {
  it("虚拟声卡与实体麦克风都留在列表里，只按名字分到不同组", () => {
    const r = classifyAudioInputDevices([
      dev("mic-1", "MacBook Pro Microphone"),
      dev("bh", "BlackHole 2ch"),
    ]);
    const ids = r.dongles.map((d) => d.deviceId);
    expect(ids).toContain("bh");
    expect(ids).toContain("mic-1");
  });

  it("实体麦克风名字里带虚拟设备关键词时不被丢掉", () => {
    // 「SoundWire」在关键词表里，但这只设备是用户的真实麦克风，必须仍可被选中。
    const r = classifyAudioInputDevices([dev("mic-2", "SoundWire USB Microphone")]);
    expect(r.dongles.map((d) => d.deviceId)).toEqual(["mic-2"]);
  });

  it("系统默认输入由下拉的空值项代表，不重复列进设备组", () => {
    const r = classifyAudioInputDevices([
      dev("default", "Default - MacBook Pro Microphone"),
      dev("", "空 ID 也算默认"),
      dev("mic-1", "MacBook Pro Microphone"),
    ]);
    expect(r.dongles.map((d) => d.deviceId)).toEqual(["mic-1"]);
  });

  it("只取音频输入，忽略输出设备", () => {
    const r = classifyAudioInputDevices([
      dev("spk", "MacBook Pro Speakers", "audiooutput"),
      dev("mic-1", "MacBook Pro Microphone"),
    ]);
    expect(r.dongles.map((d) => d.deviceId)).toEqual(["mic-1"]);
  });

  it("已选设备能被识别出来，用于把它单独列成「当前选择」", () => {
    const r = classifyAudioInputDevices([dev("mic-1", "Mic A"), dev("mic-2", "Mic B")], "mic-2");
    expect(r.selectedInput?.deviceId).toBe("mic-2");
  });

  it("已选设备不在列表里时 selectedInput 为 null（不假装它在）", () => {
    const r = classifyAudioInputDevices([dev("mic-1", "Mic A")], "gone");
    expect(r.selectedInput).toBeNull();
  });

  it("输入为空或缺失时不抛错", () => {
    expect(classifyAudioInputDevices(null).dongles).toEqual([]);
    expect(classifyAudioInputDevices([]).dongles).toEqual([]);
  });
});

describe("音频设备可用性判断", () => {
  it("有设备且读得到名字时算 named", () => {
    expect(describeAudioDeviceAvailability([dev("mic-1", "Mic A")]).state).toBe("named");
  });

  it("有设备但名字全空算 unnamed —— 不等于没有设备", () => {
    // enumerateDevices() 未授权时仍返回设备与 deviceId，只有 label 是空的。
    // 把「名字为空」当「没有设备」会让用户看到「未检测到设备」而实际只是没授权。
    const r = describeAudioDeviceAvailability([dev("mic-1", ""), dev("default", "")]);
    expect(r.state).toBe("unnamed");
    expect(r.count).toBe(2);
  });

  it("真的一个输入设备都没有时才算 none", () => {
    expect(describeAudioDeviceAvailability([dev("spk", "Speakers", "audiooutput")]).state).toBe("none");
    expect(describeAudioDeviceAvailability([]).state).toBe("none");
  });

  it("只要有一只有名字就算 named（不因个别空名误报未授权）", () => {
    const r = describeAudioDeviceAvailability([dev("a", ""), dev("b", "Mic B")]);
    expect(r.state).toBe("named");
  });
});

describe("电脑音频下拉的候选设备", () => {
  it("有虚拟声卡时只列虚拟声卡，普通麦克风不铺进来", () => {
    const r = pickComputerAudioDevices([
      dev("mic-1", "MacBook Pro Microphone"),
      dev("bh", "BlackHole 2ch"),
    ]);
    expect(r.listed.map((d) => d.deviceId)).toEqual(["bh"]);
    expect(r.virtualCables.map((d) => d.deviceId)).toEqual(["bh"]);
  });

  it("认不出虚拟声卡时退回列出全部输入设备 —— 否则列表空了用户没得选", () => {
    // 关键词表只是启发式。用户的虚拟声卡若名字不在表里，
    // 照旧只列虚拟声卡会得到空列表，那比多列几只更难用。
    const r = pickComputerAudioDevices([
      dev("mic-1", "MacBook Pro Microphone"),
      dev("weird", "某厂商虚拟音频设备"),
    ]);
    expect(r.listed.map((d) => d.deviceId).sort()).toEqual(["mic-1", "weird"]);
    expect(r.virtualCables).toEqual([]);
  });

  it("没有任何输入设备时列表为空（由提示文案说明要先装虚拟声卡）", () => {
    const r = pickComputerAudioDevices([]);
    expect(r.listed).toEqual([]);
    expect(r.virtualCables).toEqual([]);
  });
});
