import { describe, expect, it } from "vitest";
import { CLEAN_TRANSCRIPT_SYSTEM, buildCleanTranscriptChunkPrompt } from "../src/prompts/clean-transcript";

describe("清稿提示词", () => {
  it("把清稿定义为高保真轻处理，而不是摘要或纪要", () => {
    const prompt = buildCleanTranscriptChunkPrompt("原始转写", 1, 1, "00:00–10:00");
    expect(CLEAN_TRANSCRIPT_SYSTEM).toContain("不以缩短篇幅为目标");
    expect(CLEAN_TRANSCRIPT_SYSTEM).toContain("不摘要、不提炼结论、不重组议题");
    expect(prompt).toContain("完整的例子和反例");
    expect(prompt).toContain("旁支解释");
    expect(prompt).toContain("不要因为内容看起来“跑题”就删除");
    expect(prompt).toContain("拿不准是否应该删除时，一律保留");
  });
});
