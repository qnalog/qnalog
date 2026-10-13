import { describe, expect, it } from "vitest";
import { classifyShortRecordingContent } from "../src/audio/short-recording-content";

describe("短录音转写文本判定", () => {
  it("把空白、仅语气词和仅标点判为空白", () => {
    expect(classifyShortRecordingContent("  \n\t ")).toBe("blank");
    expect(classifyShortRecordingContent("嗯啊呃哦 uh um hmm")).toBe("blank");
    expect(classifyShortRecordingContent("。，！？…—?!")).toBe("blank");
  });

  it("按汉字和英文词数区分成文与短片段", () => {
    expect(classifyShortRecordingContent("明天下午三")).toBe("fragment");
    expect(classifyShortRecordingContent("明天下午三点")).toBe("sentence");
    expect(classifyShortRecordingContent("hello there")).toBe("fragment");
    expect(classifyShortRecordingContent("hello there friend")).toBe("sentence");
  });

  it("待办提示词和中英混合文本属于成文", () => {
    expect(classifyShortRecordingContent("提醒我买牛奶")).toBe("sentence");
    expect(classifyShortRecordingContent("We should meet 明天下午三点")).toBe("sentence");
  });
});
