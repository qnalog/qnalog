import { describe, expect, it } from "vitest";
import { parseTopicPageBlocks, renderTopicPage, type TopicMember, type TopicPageV2Model } from "../src/topics/topic-page";

const model: TopicPageV2Model = {
  overview: "项目围绕数据结构优化展开。团队已确定先调整存储接口，再补充迁移验证。",
  status: "进行中",
  threads: [{ id: "storage", title: "存储接口", summary: "讨论从读取边界开始，当前方案已确定。", points: [{ id: "p1", text: "接口先支持增量读取。", sources: ["a"] }] }],
  disagreements: [{ id: "d1", subject: "迁移窗口", positions: [{ text: "需要两周。", sourceId: "a", date: "2026-09-27" }, { text: "一周可以完成。", sourceId: "b", date: "2026-10-02" }] }],
  open: [{ id: "o1", kind: "行动", text: "补充回滚验证。", sources: ["b"], done: false }], unsorted: [],
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
});
