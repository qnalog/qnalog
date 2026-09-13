import { describe, expect, it } from "vitest";
import { cleanApimimoAsrRepeatedLoops } from "../src/asr/apimimo-clean";

describe("cleanApimimoAsrRepeatedLoops", () => {
  it("collapses repeated MiMo decoder loops made of sentence groups", () => {
    const loop = "主要是会议纪要，它做这种文本转写，它里面工程做好，它其实不需要它模型有多高级。那你要上那些什么，呃，GPT，我没用过。我不确定它的意图理解好不好。";
    const result = cleanApimimoAsrRepeatedLoops(`为什么用Mimo？便宜啊。${loop}${loop}${loop}${loop}`);

    expect(result.text).toBe(`为什么用Mimo？便宜啊。${loop}`);
    expect(result.suppressedRepeats).toBe(3);
    expect(result.suppressedChars).toBeGreaterThan(100);
  });

  it("keeps short natural oral repetition", () => {
    const text = "对对对。嗯嗯。这个地方我们确实要再看一下。";
    const result = cleanApimimoAsrRepeatedLoops(text);

    expect(result.text).toBe(text);
    expect(result.suppressedRepeats).toBe(0);
  });

  it("collapses two copies of a long repeated paragraph", () => {
    const loop = "那就随便用。是啊，其实还好，因为我们像我们配音的基本上用谷歌，但是我倒觉得第一理解会好。但是我们是文字啊。那这里面有AI sound吗？你可以把这个端点发给我，我去配一下。";
    const result = cleanApimimoAsrRepeatedLoops(`${loop}${loop}`);

    expect(result.text).toBe(loop);
    expect(result.suppressedRepeats).toBe(1);
  });
});
