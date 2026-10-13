import { describe, expect, it } from "vitest";
import { classifyShortRecordingContent } from "../src/audio/short-recording-content";

describe("短录音转写文本判定", () => {
  it("把空白、仅语气词和仅标点判为空白", () => {
    expect(classifyShortRecordingContent("  \n\t ", 2000)).toBe("blank");
    expect(classifyShortRecordingContent("嗯啊呃哦 uh um hmm", 2000)).toBe("blank");
    expect(classifyShortRecordingContent("。，！？…—?!", 2000)).toBe("blank");
    expect(classifyShortRecordingContent("嗯啊，".repeat(100), 2000)).toBe("blank");
  });

  it("按汉字和英文词数区分成文与短片段", () => {
    expect(classifyShortRecordingContent("明天下午三", 2000)).toBe("fragment");
    expect(classifyShortRecordingContent("明天下午三点", 2000)).toBe("sentence");
    expect(classifyShortRecordingContent("hello there", 2000)).toBe("fragment");
    expect(classifyShortRecordingContent("hello there friend", 2000)).toBe("sentence");
  });

  it("待办提示词和中英混合文本属于成文", () => {
    expect(classifyShortRecordingContent("提醒我买牛奶", 2000)).toBe("sentence");
    expect(classifyShortRecordingContent("We should meet 明天下午三点", 2000)).toBe("sentence");
  });

  it("按录音时长拦截远超合理文字量的识别结果", () => {
    const repeatedMarkup = "<chinese>重复识别文本</chinese>".repeat(1600);
    expect(Buffer.byteLength(repeatedMarkup, "utf8")).toBeGreaterThan(41_000);
    expect(classifyShortRecordingContent(repeatedMarkup, 2000)).toBe("anomalous");
    const normalTwoSecondText = "明天开会讨论项目进度以及后续安排任务分类";
    expect(Array.from(normalTwoSecondText).length).toBe(20);
    expect(classifyShortRecordingContent(normalTwoSecondText, 2000)).toBe("sentence");
    expect(classifyShortRecordingContent("甲".repeat(150), 10_000)).toBe("sentence");
  });
});
