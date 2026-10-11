import { describe, expect, it } from "vitest";
import { cleanTopicOverviewExcerpt } from "../src/topics/topic-overview-display";

describe("topic overview display", () => {
  it("removes Markdown presentation syntax while preserving visible text", () => {
    expect(cleanTopicOverviewExcerpt("# **底层数据结构的优化**\n> - __说话人__：昨晚睡前 `回顾`")).toBe("底层数据结构的优化 说话人：昨晚睡前 回顾");
    expect(cleanTopicOverviewExcerpt("[[Notes/one.md|项目笔记]] and [documentation](https://example.test)")).toBe("项目笔记 and documentation");
  });

  it("keeps plain words and does not mutate the original overview value", () => {
    const overview = "**keep** this text";
    const result = cleanTopicOverviewExcerpt(overview);
    expect(result).toBe("keep this text");
    expect(overview).toBe("**keep** this text");
  });
});
