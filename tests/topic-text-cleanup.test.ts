import { describe, expect, it } from "vitest";
import { stripSourceIdTokens } from "../src/topics/topic-text-cleanup";

describe("stripSourceIdTokens", () => {
  it("removes qnalog IDs, path markers, and member addresses", () => {
    expect(stripSourceIdTokens("确认[qnalog-mu21313n-0kp4rv]修复 [path:QnALog/a.md] (QnALog/a.md)", ["QnALog/a.md"]))
      .toBe("确认修复");
  });
  it("cleans repeated punctuation and supports bracket variants", () => {
    expect(stripSourceIdTokens("完成。 。［qnalog-one］（source-a）！！", ["source-a"])).toBe("完成。");
    expect(stripSourceIdTokens("A [qnalog-one] B [qnalog-two].", [])).toBe("A B.");
  });
  it("keeps ordinary Obsidian links", () => {
    expect(stripSourceIdTokens("参见 [[QnALog/a|来源]]。", ["source-a"])).toBe("参见 [[QnALog/a|来源]]。");
  });
});
