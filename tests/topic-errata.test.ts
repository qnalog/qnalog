import { describe, expect, it, vi } from "vitest";
import { parseTopicErrata } from "../src/topics/topic-errata-parser";
import { buildTopicErrataPrompt } from "../src/topics/topic-errata-prompt";
import { TopicErrataStore, type TopicErrataStorePort } from "../src/topics/topic-errata-store";
import { isTopicErrataFrontmatter } from "../src/shared/namespace";

describe("topic errata parser", () => {
  it("parses bilingual sections, global entries, member entries, and hand-edited list forms", () => {
    expect(parseTopicErrata("## Off-topic\n\n- global description\n- [[Notes/a|A]]: member description\n\n## Notes\nmanual note")).toEqual({
      entries: [
        { memberLink: null, description: "global description" },
        { memberLink: "Notes/a", description: "member description" },
      ],
      notes: ["manual note"],
    });
  });

  it("deduplicates repeated entries and bounds parsed line counts", () => {
    expect(parseTopicErrata("## 不属于本主题\n- 不相关方面\n- 不相关方面").entries).toHaveLength(1);
  });
});

describe("topic errata store", () => {
  function fixture(initial: Record<string, string> = {}) {
    const files = new Map(Object.entries(initial));
    const processTail: { value: Promise<void> } = { value: Promise.resolve() };
    const diagnostic = vi.fn();
    const port: TopicErrataStorePort = {
      read: async (path) => files.get(path) ?? null,
      create: async (path, content) => { files.set(path, content); },
      process: async (path, transform) => {
        const next = processTail.value.then(() => { const value = files.get(path); if (value === undefined) throw new Error("missing"); files.set(path, transform(value)); });
        processTail.value = next.catch(() => undefined);
        await next;
      },
      uiLanguage: () => "zh",
      diagnostic,
    };
    return { files, diagnostic, store: new TopicErrataStore(port) };
  }

  it("creates a localized sibling document and repeated append is idempotent across blank lines", async () => {
    const f = fixture();
    const topicPath = "QnALog/主题/研究.md";
    await f.store.append(topicPath, "研究", "设备维修", "Notes/a.md");
    await f.store.append(topicPath, "研究", "设备维修", "Notes/a.md");
    const value = f.files.get("QnALog/主题/研究 勘误.md") || "";
    expect(value).toContain("qnalog_topic_errata: true");
    expect(value.match(/设备维修/g)).toHaveLength(1);
    expect(value).toContain("## 不属于本主题\n- [[Notes/a]]：设备维修");
  });

  it("ensures a new empty marked document and leaves an existing document unchanged", async () => {
    const f = fixture();
    const topicPath = "QnALog/主题/研究.md";
    const errataPath = "QnALog/主题/研究 勘误.md";
    expect(await f.store.ensure(topicPath, "研究")).toBe(errataPath);
    const created = f.files.get(errataPath) || "";
    expect(created).toContain("qnalog_topic_errata: true");
    expect(isTopicErrataFrontmatter({ qnalog_topic_errata: true })).toBe(true);
    expect(created).toContain("## 不属于本主题");
    expect(created).toContain("## 说明");
    expect((await f.store.load(topicPath, [])).entries).toEqual([]);
    expect((await f.store.load(topicPath, [])).notes).toEqual([]);
    expect(await f.store.ensure(topicPath, "其他标题")).toBe(errataPath);
    expect(f.files.get(errataPath)).toBe(created);

    const existing = fixture({ [errataPath]: "## Off-topic\n- User-authored rule\n" });
    expect(await existing.store.ensure(topicPath, "研究")).toBe(errataPath);
    expect(existing.files.get(errataPath)).toBe("## Off-topic\n- User-authored rule\n");
  });

  it("ignores stale member links and records a diagnostic while retaining global entries", async () => {
    const path = "QnALog/主题/研究 勘误.md";
    const f = fixture({ [path]: "## Off-topic\n- 全局事项\n- [[Notes/removed]]: 旧成员事项\n- [[Notes/current]]：成员事项\n## Notes" });
    const loaded = await f.store.load("QnALog/主题/研究.md", ["Notes/current.md"]);
    expect(loaded.entries.map((entry) => [entry.description, entry.memberPath])).toEqual([
      ["全局事项", null], ["成员事项", "Notes/current.md"],
    ]);
    expect(f.diagnostic).toHaveBeenCalledWith("topic.errata_member_not_in_topic", expect.objectContaining({ memberLink: "Notes/removed" }));
  });
});

describe("topic errata prompt", () => {
  it("enforces the 3000 character cap and marks truncation", () => {
    const result = buildTopicErrataPrompt({ entries: Array.from({ length: 120 }, (_, index) => ({ memberLink: null, memberPath: null, description: `${index} ${"无关方面".repeat(20)}` })), notes: [] });
    expect(result.text.length).toBeLessThanOrEqual(3000);
    expect(result.truncated).toBe(true);
  });

  it("trims global entries before member-scoped entries", () => {
    const result = buildTopicErrataPrompt({ entries: [
      { memberLink: null, memberPath: null, description: `全局${"甲".repeat(3200)}` },
      { memberLink: "Notes/a", memberPath: "Notes/a.md", description: "成员范围的排除方面" },
    ], notes: [] });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("成员范围的排除方面");
    expect(result.text).not.toContain("全局");
  });
});
