import { describe, expect, it } from "vitest";
import { createTopicPage, isLegacyTopicStatusLine, parseTopicPage, parseTopicPageBlocks, renderTopicPage, serializeTopicPage, summarizeForTimeline, type TopicMember, type TopicPageV2Model } from "../src/topics/topic-page";

const model: TopicPageV2Model = {
  overview: "项目围绕数据结构优化展开。团队已确定先调整存储接口，再补充迁移验证。",
  threads: [{ id: "storage", title: "存储接口", summary: "讨论从读取边界开始，当前方案已确定。", points: [{ id: "p1", text: "接口先支持增量读取。", sources: ["a"] }] }],
  disagreements: [{ id: "d1", subject: "迁移窗口", positions: [{ text: "需要两周。", sourceId: "a", date: "2026-09-27" }, { text: "一周可以完成。", sourceId: "b", date: "2026-10-02" }] }],
  open: [{ id: "o1", kind: "action", text: "补充回滚验证。", sources: ["b"], done: false }], unsorted: [],
};
const members: TopicMember[] = [
  { path: "Notes/a.md", title: "会议 A", sourceId: "a", date: "2026-09-27", summary: "提出增量读取方案。后续补充测试。" },
  { path: "Notes/b.md", title: "会议 B", sourceId: "b", date: "2026-10-02", summary: "确认回滚验证作为行动。" },
];

describe("topic page v2", () => {
  it("renders deterministic narrative, footnotes, and a date ordered timeline", () => {
    const first = renderTopicPage(model, members);
    expect(renderTopicPage(model, members)).toBe(first);
    expect(first).toContain("> [!abstract] 概要");
    expect(first).toContain("## 进展脉络\n\n### 存储接口");
    expect(first).toContain("[^s" );
    const timeline = first.slice(first.indexOf("## 时间线"));
    expect(timeline.indexOf("2026-09-27 ·")).toBeLessThan(timeline.indexOf("2026-10-02 ·"));
    expect(first).not.toContain("待整理");
    expect(first).toContain("## 来源笔记");
  });

  it("omits empty optional sections and parses block IDs without rejecting edited pages", () => {
    const rendered = renderTopicPage({ ...model, disagreements: [], open: [] }, members);
    expect(rendered).not.toContain("## 分歧与待核实");
    expect(rendered).not.toContain("## 未决问题与行动");
    const edited = `${rendered}\n## 我的补充\n\n用户新增段落。\n`;
    expect(parseTopicPageBlocks(edited).some((block) => block.type === "point")).toBe(true);
    expect(edited).toContain("用户新增段落。");
  });

  it("matches only the complete renderer-generated legacy status row", () => {
    const prefixes = ["**状态**：", "**Status**: "];
    expect(isLegacyTopicStatusLine("**状态**：进行中 · **最近更新** 2026-10-08 · 4篇笔记", prefixes)).toBe(true);
    expect(isLegacyTopicStatusLine("**Status**: Active · **Updated** 2026-10-08 · 4 notes", prefixes)).toBe(true);
    expect(isLegacyTopicStatusLine("**状态**：用户自己写的说明", prefixes)).toBe(false);
    expect(isLegacyTopicStatusLine("**状态**：进行中 · **最近更新** 2026-10-08 · 4篇笔记 用户补充", prefixes)).toBe(false);
  });

  it("does not append the legacy empty skeleton when serializing a v2 page", () => {
    const page = createTopicPage({ id: "topic", title: "Topic", tags: [], members, basis: "overview" });
    page.layout = 2;
    page.body = renderTopicPage(model, members);
    const markdown = serializeTopicPage(page);
    expect(parseTopicPage(markdown)?.layout).toBe(2);
    expect(markdown).toContain("cssclasses: qnalog-topic");
    expect(markdown).not.toContain("[qnalog-");
    for (const heading of ["## 概要 / Overview", "## 当前状态 / Current status", "## 分歧与待核实 / Disagreements and verification", "## 未决问题与未完成行动 / Open questions and actions", "## 待整理 / Unsorted"]) {
      expect(markdown).not.toContain(heading);
    }
  });

  it("keeps a user-authored v2 section with a legacy heading", () => {
    const page = createTopicPage({ id: "topic", title: "Topic", tags: [], members, basis: "overview" });
    page.layout = 2;
    page.body = `${renderTopicPage(model, members)}\n## 待整理\n\n用户自己补充的内容。`;
    const markdown = serializeTopicPage(page);
    expect(markdown).toContain("## 待整理\n\n用户自己补充的内容。");
    expect(markdown).not.toContain("## 待整理 / Unsorted");
  });

  it("cleans Markdown and speaker labels before taking a bounded timeline sentence", () => {
    expect(summarizeForTimeline("**说话人**：我现在正在对 Q&A-Log 这个项目的设置页面进行优化和整理。因为原始菜单结构比较乱。", { maxChars: 60 }))
      .toBe("我现在正在对 Q&A-Log 这个项目的设置页面进行优化和整理。");
    expect(summarizeForTimeline("Speaker 1: We changed [[Notes/settings|the settings panel]] after [review](https://example.test). Next step.", { maxChars: 60 }))
      .toBe("We changed the settings panel after review.");
    expect(summarizeForTimeline("- **结论**：采用 `[[属性名|qnalog_topic_layout]]`。[^s1234] 后续补测试。", { maxChars: 60 }))
      .toBe("结论：采用 qnalog_topic_layout。");
    expect(summarizeForTimeline("> # \n> - \n**__` `__**", { title: "Fallback title" })).toBe("Fallback title");
    expect(summarizeForTimeline("S1: " + "abcdefghij".repeat(10), { maxChars: 20 })).toBe("abcdefghijabcdefghi…");
    expect(summarizeForTimeline("A long sentence with several words and no ending", { maxChars: 22 })).toBe("A long sentence with…");
  });

  it("uses the note title when a member overview contains only markup", () => {
    const page = createTopicPage({ id: "topic", title: "Topic", tags: [], members: [{ ...members[0], summary: "**__` `__**" }], basis: "overview" });
    page.layout = 2;
    page.body = renderTopicPage({ ...model, disagreements: [], open: [] }, [{ ...members[0], summary: "**__` `__**" }]);
    expect(serializeTopicPage(page)).toContain("— 会议 A");
  });

  it("omits status data and renders open-item kinds in Chinese and English", () => {
    const localizedModel: TopicPageV2Model = {
      ...model,
          open: [
        { id: "q", kind: "question", text: "是否完成迁移？", sources: ["a"], done: false },
        { id: "a", kind: "action", text: "补测试。", sources: ["a"], done: false },
        { id: "b", kind: "bug", text: "修正路径。", sources: ["b"], done: false },
      ],
    };
    const chinese = renderTopicPage(localizedModel, members);
    expect(chinese).not.toContain("**状态**");
    expect(chinese).toContain("## 进展脉络");
    expect(chinese).toContain("问题：是否完成迁移？");
    expect(chinese).toContain("行动：补测试。");
    expect(chinese).toContain("缺陷：修正路径。");
    const english = renderTopicPage(localizedModel, members, {
      overview: "Overview", progress: "Progress", disagreements: "Disagreements", open: "Open items",
      timeline: "Timeline", sources: "Source notes", conflict: "Conflicting accounts",
      openQuestion: "Question", openAction: "Action", openBug: "Bug",
    });
    expect(english).not.toContain("**Status**");
    expect(english).toContain("Question: 是否完成迁移？");
    expect(english).toContain("Action: 补测试。");
    expect(english).toContain("Bug: 修正路径。");
    expect(english).not.toContain("进行中");
  });
});
