import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  TFile: class TFile {},
}));
import * as obsidian from "obsidian";
import { parseTopicErrata } from "../src/topics/topic-errata-parser";
import { buildTopicErrataPrompt } from "../src/topics/topic-errata-prompt";
import { TopicErrataStore, type TopicErrataStorePort } from "../src/topics/topic-errata-store";
import { isTopicErrataFrontmatter } from "../src/shared/namespace";
import { isErrataPath } from "../src/errata/errata-path";
import { t } from "../src/shared/i18n";

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
    type File = InstanceType<typeof obsidian.TFile> & { path: string; basename: string; extension: string };
    const files = new Map<string, { file: File; text: string }>();
    const makeFile = (path: string): File => Object.assign(new obsidian.TFile(), { path, basename: path.split("/").pop()?.replace(/\.md$/i, "") || "", extension: "md" }) as File;
    const topicPath = "QnALog/主题/研究.md";
    files.set(topicPath, { file: makeFile(topicPath), text: "topic" });
    for (const [path, text] of Object.entries(initial)) files.set(path, { file: makeFile(path), text });
    const processTail: { value: Promise<void> } = { value: Promise.resolve() };
    const diagnostic = vi.fn();
    const resolve = vi.fn((link: string, sourcePath: string) => {
      const target = link.split("#")[0].split("|")[0].trim().replace(/\.md$/i, "");
      const direct = files.get(`${target}.md`)?.file;
      if (direct) return direct;
      const basenameMatch = [...files.values()].find(({ file }) => file.path.startsWith("Notes/") && file.basename === target);
      return basenameMatch?.file || null;
    });
    const create = vi.fn(async (path: string, content: string) => {
      const file = makeFile(path);
      files.set(path, { file, text: content });
      return file;
    });
    const listErrataFiles = vi.fn(() => [...files.values()].map(({ file }) => file).filter((file) => file.path.startsWith("QnALog/勘误表/")));
    const port: TopicErrataStorePort = {
      read: async (file) => files.get(file.path)?.text ?? "",
      listErrataFiles,
      getByPath: (path) => files.get(path)?.file || null,
      getFrontmatter: (file) => files.get(file.path)?.text.includes("qnalog_topic_errata: true") ? { qnalog_topic_errata: true } : {},
      getLinks: (file) => [...(files.get(file.path)?.text.matchAll(/\[\[([^\]]+)\]\]/g) || [])].map((match) => ({ link: match[1] })),
      resolveLink: resolve,
      ensureFolder: async () => undefined,
      create,
      process: async (file, transform) => {
        const next = processTail.value.then(() => { const record = files.get(file.path); if (!record) throw new Error("missing"); record.text = transform(record.text); });
        processTail.value = next.catch(() => undefined);
        await next;
      },
      uiLanguage: () => "zh",
      diagnostic,
    };
    return { files, diagnostic, resolve, create, listErrataFiles, port, store: new TopicErrataStore(port) };
  }

  it("creates a linked errata document in the errata folder and repeated append is idempotent", async () => {
    const f = fixture({ "Notes/a.md": "member" });
    const topicPath = "QnALog/主题/研究.md";
    await f.store.append(topicPath, "研究", "设备维修", "Notes/a.md");
    await f.store.append(topicPath, "研究", "设备维修", "Notes/a.md");
    const value = f.files.get("QnALog/勘误表/研究 · 主题勘误.md")?.text || "";
    expect(value).toContain("qnalog_topic_errata: true");
    expect(value.match(/设备维修/g)).toHaveLength(1);
    expect(value).toContain("主题：[[QnALog/主题/研究]]");
    expect(value).toContain("## 不属于本主题\n- [[Notes/a]]：设备维修");
    expect(isErrataPath("QnALog/勘误表/研究 · 主题勘误.md")).toBe(true);
  });

  it("reports whether append created a row and removes only matching scoped or global rows", async () => {
    const f = fixture({ "Notes/a.md": "member" });
    const topicPath = "QnALog/主题/研究.md";
    const path = await f.store.ensure(topicPath);
    const original = f.files.get(path)!.text;
    const scoped = await f.store.appendEntry(topicPath, "研究", "  设备   维修 ", "Notes/a.md");
    expect(scoped).toEqual({ path, description: "设备 维修", memberLink: "Notes/a", added: true });
    const duplicate = await f.store.appendEntry(topicPath, "研究", "设备 维修", "Notes/a.md");
    expect(duplicate).toMatchObject({ path, description: "设备 维修", memberLink: "Notes/a", added: false });
    const global = await f.store.appendEntry(topicPath, "研究", "全局事项");
    expect(global).toMatchObject({ description: "全局事项", memberLink: null, added: true });

    const afterAppend = f.files.get(path)!.text;
    const removed = await f.store.removeEntries(topicPath, [scoped, global]);
    expect(removed).toBe(2);
    expect(f.files.get(path)!.text).toBe(original);
    expect(afterAppend).toContain("## 不属于本主题");
  });

  it("returns the added row when process writes the complete document before throwing", async () => {
    const f = fixture({ "Notes/a.md": "member" });
    const topicPath = "QnALog/主题/研究.md";
    const path = await f.store.ensure(topicPath);
    f.port.process = async (file, transform) => {
      const current = f.files.get(file.path)!.text;
      f.files.get(file.path)!.text = transform(current);
      throw new Error("process failed after write");
    };

    await expect(f.store.appendEntry(topicPath, "研究", "新设备维修", "Notes/a.md")).resolves.toEqual({
      path,
      description: "新设备维修",
      memberLink: "Notes/a",
      added: true,
    });
    expect(f.files.get(path)!.text).toContain("- [[Notes/a]]：新设备维修");
  });

  it("keeps a duplicate row out of Undo when process throws after a no-op", async () => {
    const f = fixture({ "Notes/a.md": "member" });
    const topicPath = "QnALog/主题/研究.md";
    const path = await f.store.ensure(topicPath);
    await f.store.appendEntry(topicPath, "研究", "已存在的维修", "Notes/a.md");
    const before = f.files.get(path)!.text;
    f.port.process = async (file, transform) => {
      f.files.get(file.path)!.text = transform(f.files.get(file.path)!.text);
      throw new Error("process failed after no-op");
    };

    await expect(f.store.appendEntry(topicPath, "研究", "已存在的维修", "Notes/a.md")).resolves.toMatchObject({ added: false });
    expect(f.files.get(path)!.text).toBe(before);
  });

  it("confirms a same-description row in a different scope after a write-then-throw", async () => {
    const f = fixture({ "Notes/a.md": "member a", "Notes/b.md": "member b" });
    const topicPath = "QnALog/主题/研究.md";
    await f.store.ensure(topicPath);
    await f.store.appendEntry(topicPath, "研究", "同一描述", "Notes/a.md");
    f.port.process = async (file, transform) => {
      f.files.get(file.path)!.text = transform(f.files.get(file.path)!.text);
      throw new Error("process failed after scoped write");
    };

    await expect(f.store.appendEntry(topicPath, "研究", "同一描述", "Notes/b.md")).resolves.toMatchObject({
      description: "同一描述",
      memberLink: "Notes/b",
      added: true,
    });
    expect(f.files.get(f.store.pathForTopic(topicPath))!.text).toContain("- [[Notes/b]]：同一描述");
  });

  it.each(["before-callback", "callback-without-write", "read-failed", "changed-after-write", "truncated-after-write"] as const)("preserves the process error when post-failure readback is %s", async (failure) => {
    const f = fixture({ "Notes/a.md": "member" });
    const topicPath = "QnALog/主题/研究.md";
    const path = await f.store.ensure(topicPath);
    const originalRead = f.port.read.bind(f.port);
    f.port.process = async (file, transform) => {
      if (failure === "before-callback") throw new Error("process failed before callback");
      const current = f.files.get(file.path)!.text;
      const next = transform(current);
      if (failure === "callback-without-write") throw new Error("process failed before write");
      if (failure === "changed-after-write") f.files.get(file.path)!.text = `${next}\nmanual edit`;
      else if (failure === "truncated-after-write") f.files.get(file.path)!.text = next.slice(0, next.length - 8);
      else f.files.get(file.path)!.text = next;
      throw new Error("process failed after callback");
    };
    if (failure === "read-failed") f.port.read = async () => { throw new Error("read failed"); };

    await expect(f.store.appendEntry(topicPath, "研究", "需要保全的维修", "Notes/a.md")).rejects.toThrow("process failed");
    if (failure === "read-failed") expect(f.files.get(path)!.text).toContain("需要保全的维修");
    if (failure === "changed-after-write") expect(f.files.get(path)!.text).toContain("manual edit");
    f.port.read = originalRead;
  });

  it("skips an edited errata row and preserves unrelated rows, notes, and section headings", async () => {
    const path = "QnALog/勘误表/研究 · 主题勘误.md";
    const initial = "---\nqnalog_topic_errata: true\n---\n主题：[[QnALog/主题/研究]]\n\n## 不属于本主题\n- [[Notes/a]]：用户改过的说明\n- 其它全局事项\n\n## 说明\n- 保留这条备注\n";
    const f = fixture({ [path]: initial, "Notes/a.md": "member" });
    const removed = await f.store.removeEntries("QnALog/主题/研究.md", [{ path, description: "原始说明", memberLink: "Notes/a" }]);
    expect(removed).toBe(0);
    expect(f.files.get(path)!.text).toBe(initial);
  });

  it("records and rethrows a failed row removal", async () => {
    const f = fixture();
    const path = await f.store.ensure("QnALog/主题/研究.md");
    const row = await f.store.appendEntry("QnALog/主题/研究.md", "研究", "不能删除");
    const file = f.files.get(path)!.file;
    const originalProcess = f.port.process;
    f.port.process = async () => { throw new Error("write failed"); };
    await expect(f.store.removeEntries("QnALog/主题/研究.md", [row])).rejects.toThrow("write failed");
    expect(f.diagnostic).toHaveBeenCalledWith("topic.errata_remove_failed", expect.objectContaining({ errataPath: path }));
    f.port.process = originalProcess;
    expect(file.path).toBe(path);
  });

  it("ensures a new empty marked document and leaves an existing document unchanged", async () => {
    const f = fixture();
    const topicPath = "QnALog/主题/研究.md";
    const errataPath = "QnALog/勘误表/研究 · 主题勘误.md";
    expect(await f.store.ensure(topicPath)).toBe(errataPath);
    const created = f.files.get(errataPath)?.text || "";
    expect(created).toContain("qnalog_topic_errata: true");
    expect(created.split("\n")[3]).toBe("主题：[[QnALog/主题/研究]]");
    expect(isTopicErrataFrontmatter({ qnalog_topic_errata: true })).toBe(true);
    expect(created).toContain("## 不属于本主题");
    expect(created).toContain("## 说明");
    expect((await f.store.load(topicPath, [])).entries).toEqual([]);
    expect((await f.store.load(topicPath, [])).notes).toEqual([]);
    expect(await f.store.ensure(topicPath)).toBe(errataPath);
    expect(f.files.get(errataPath)?.text).toBe(created);

    const existing = fixture({ [errataPath]: "主题：[[QnALog/主题/研究]]\n\n## Off-topic\n- User-authored rule\n" });
    expect(await existing.store.ensure(topicPath)).toBe(errataPath);
    expect(existing.files.get(errataPath)?.text).toBe("主题：[[QnALog/主题/研究]]\n\n## Off-topic\n- User-authored rule\n");
  });

  it("ignores stale member links and records a diagnostic while retaining global entries", async () => {
    const path = "QnALog/勘误表/研究 · 主题勘误.md";
    const f = fixture({ [path]: "---\nqnalog_topic_errata: true\n---\n主题：[[QnALog/主题/研究]]\n## Off-topic\n- 全局事项\n- [[Notes/removed]]: 旧成员事项\n- [[Notes/current]]：成员事项\n## Notes", "Notes/current.md": "", "Notes/removed.md": "" });
    const loaded = await f.store.load("QnALog/主题/研究.md", ["Notes/current.md"]);
    expect(loaded.entries.map((entry) => [entry.description, entry.memberPath])).toEqual([
      ["全局事项", null], ["成员事项", "Notes/current.md"],
    ]);
    expect(f.diagnostic).toHaveBeenCalledWith("topic.errata_member_not_in_topic", expect.objectContaining({ memberLink: "Notes/removed" }));
  });

  it.each(["rename", "move"]) ("finds the linked errata document after topic %s", async (change) => {
    const oldTopic = "QnALog/主题/研究.md";
    const newTopic = change === "rename" ? "QnALog/主题/研究项目.md" : "QnALog/项目/研究.md";
    const f = fixture();
    const errataPath = await f.store.ensure(oldTopic);
    const topicFile = f.files.get(oldTopic)!.file;
    f.files.delete(oldTopic);
    topicFile.path = newTopic;
    topicFile.basename = newTopic.split("/").pop()!.replace(/\.md$/i, "");
    f.files.set(newTopic, { file: topicFile, text: "topic" });
    f.resolve.mockImplementation((link) => link === oldTopic.replace(/\.md$/i, "") ? topicFile : null);
    f.store.refreshForVaultEvent(newTopic, oldTopic);
    expect(await f.store.find(newTopic)).toBe(f.files.get(errataPath)!.file);
    const createsBefore = f.create.mock.calls.length;
    expect(await f.store.ensure(newTopic)).toBe(errataPath);
    expect(f.create).toHaveBeenCalledTimes(createsBefore);
  });

  it("rebuilds the index only for known topic or errata paths", async () => {
    const f = fixture();
    const topicPath = "QnALog/主题/研究.md";
    const errataPath = await f.store.ensure(topicPath);

    f.listErrataFiles.mockClear();
    f.store.refreshForVaultEvent("Notes/a.md");
    f.store.refreshForVaultEvent("QnALog/主题/新主题.md");
    expect(f.listErrataFiles).not.toHaveBeenCalled();

    f.store.refreshForVaultEvent("QnALog/勘误表/其他.md");
    expect(f.listErrataFiles).toHaveBeenCalledTimes(1);

    f.listErrataFiles.mockClear();
    f.store.refreshForVaultEvent("QnALog/主题/研究-改名.md", topicPath);
    expect(f.listErrataFiles).toHaveBeenCalledTimes(1);

    f.listErrataFiles.mockClear();
    f.store.refreshForVaultEvent(errataPath);
    expect(f.listErrataFiles).toHaveBeenCalledTimes(1);
  });

  it.each(["another topic", "broken link"]) ("rejects a target path occupied by %s", async (kind) => {
    const topicPath = "QnALog/主题/研究.md";
    const errataPath = "QnALog/勘误表/研究 · 主题勘误.md";
    const otherPath = "QnALog/主题/其他.md";
    const frontmatter = "---\nqnalog_topic_errata: true\n---\n";
    const link = kind === "another topic" ? "[[QnALog/主题/其他]]" : "[[QnALog/主题/已删除]]";
    const initial = { [otherPath]: "topic", [errataPath]: `${frontmatter}主题：${link}\n\n## 不属于本主题\n` };
    const f = fixture(initial);
    await expect(f.store.ensure(topicPath)).rejects.toThrow(t("A different errata note already uses this file name."));
    expect(f.create).not.toHaveBeenCalled();
  });

  it("returns the concurrently created matching file after create rejects", async () => {
    const f = fixture();
    const path = "QnALog/勘误表/研究 · 主题勘误.md";
    f.create.mockImplementationOnce(async (targetPath, content) => {
      const file = Object.assign(new obsidian.TFile(), { path: targetPath, basename: "研究 · 主题勘误", extension: "md" }) as InstanceType<typeof obsidian.TFile> & { path: string; basename: string; extension: string };
      f.files.set(targetPath, { file, text: content });
      throw new Error("already exists");
    });
    await expect(f.store.ensure("QnALog/主题/研究.md")).resolves.toBe(path);
  });

  it("resolves member links exactly and skips unresolved or non-member targets", async () => {
    const path = "QnALog/勘误表/研究 · 主题勘误.md";
    const f = fixture({
      [path]: "---\nqnalog_topic_errata: true\n---\n主题：[[QnALog/主题/研究]]\n## 不属于本主题\n- [[Notes/a/item]]：命中成员\n- [[Other/a/item]]：同名但非成员\n- [[Notes/missing/item]]：断链\n",
      "Notes/a/item.md": "member", "Other/a/item.md": "other",
    });
    const loaded = await f.store.load("QnALog/主题/研究.md", ["Notes/a/item.md"]);
    expect(loaded.entries.map((entry) => entry.memberPath)).toEqual(["Notes/a/item.md"]);
    expect(f.diagnostic).toHaveBeenCalledTimes(2);
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
