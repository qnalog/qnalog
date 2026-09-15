import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
}));
import {
  NS_AUDIO_PREFIX, NS_AUDIO_ALT, stripAudioPrefix,
  NS_SEDIMENT_ID_PREFIX, NS_SEDIMENT_ID_PREFIX_LEGACY, legacySedimentIdVariants,
  NS_ID_PREFIX,
} from "../src/shared/namespace";
import { genId } from "../src/shared/util-common";

// 1.0.0 把 lex- 录音文件名与 lv- 标记写进了用户数据（改名时漏掉这几处）。
// 这组测试钉住「写入用新前缀、读取兼容旧前缀」，防止以后只改一半。
describe("1.0.0 遗留前缀的兼容", () => {
  it("音频文件名写入用 qnalog 前缀", () => {
    expect(NS_AUDIO_PREFIX).toBe("qnalog");
  });

  it("分段文件名解析同时接受 qnalog- 与 lex-", () => {
    const re = new RegExp(`^${NS_AUDIO_ALT}-(\\d{8}-\\d{6})-seg(\\d+)\\.([a-z0-9]+)$`, "i");
    // 1.0.0 已写进知识库的名字
    expect("lex-20260915-100353-seg01.webm".match(re)).not.toBeNull();
    // 新写入的名字
    expect("qnalog-20260915-100353-seg01.webm".match(re)).not.toBeNull();
    // 不相关文件不得命中
    expect("会议录音.webm".match(re)).toBeNull();
    expect("lexvoice-20260915-100353-seg01.webm".match(re)).toBeNull();
  });

  it("主录音名正则同样兼容两种前缀", () => {
    const re = new RegExp(`^(${NS_AUDIO_ALT}-\\d{8}-\\d{6})-seg\\d+\\.(\\w+)$`, "i");
    expect(re.exec("lex-20260915-100353-seg01.webm")?.[1]).toBe("lex-20260915-100353");
    expect(re.exec("qnalog-20260915-100353-seg01.webm")?.[1]).toBe("qnalog-20260915-100353");
  });

  it("stripAudioPrefix 剥掉任一种前缀", () => {
    expect(stripAudioPrefix("lex-20260915-100353.webm")).toBe("20260915-100353.webm");
    expect(stripAudioPrefix("qnalog-20260915-100353.webm")).toBe("20260915-100353.webm");
    expect(stripAudioPrefix("")).toBe("");
    expect(stripAudioPrefix(undefined)).toBe("");
  });

  it("沉淀 id 能还原出 1.0.0 写的旧写法（否则日记里会重复写一条待办）", () => {
    const newId = `${NS_SEDIMENT_ID_PREFIX}-todo-abc123`;
    expect(legacySedimentIdVariants(newId)).toEqual([`${NS_SEDIMENT_ID_PREFIX_LEGACY}-todo-abc123`]);
    // 旧 id 本身不产生变体，避免无限套娃
    expect(legacySedimentIdVariants("lv-sed-todo-abc123")).toEqual([]);
    expect(legacySedimentIdVariants(null)).toEqual([]);
  });

  it("genId 用 qnalog 前缀（不透明 id，无人解析旧前缀）", () => {
    expect(genId().startsWith(`${NS_ID_PREFIX}-`)).toBe(true);
    expect(genId().startsWith("lv-")).toBe(false);
  });
});
