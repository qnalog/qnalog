import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"), TFile: class TFile {} }));
import * as obsidian from "obsidian";
import { TopicsService, type TopicsServicePort } from "../src/topics/topics-service";
import type { TopicStorePort } from "../src/topics/topic-store";
import type { TopicIntegrationPort } from "../src/topics/topic-integration";
import { createTopicPage, parseTopicPage, parseTopicPageBlocks, renderTopicPage, serializeTopicPage, type TopicPageV2Model } from "../src/topics/topic-page";
import { TopicErrataStore, type TopicErrataStorePort } from "../src/topics/topic-errata-store";
import { topicMemberExcludeSelectionId } from "../src/topics/topic-integration";

describe("topics service", () => {
  function makeTopicErrata(files: Map<string, string>, language = "zh", throwAfterProcessWrite = false) {
    type File = InstanceType<typeof obsidian.TFile> & { path: string; basename: string; extension: string };
    const fileObjects = new Map<string, File>();
    const getFile = (path: string): File => {
      let file = fileObjects.get(path);
      if (!file) {
        file = Object.assign(new obsidian.TFile(), { path, basename: path.split("/").pop()?.replace(/\.md$/i, "") || "", extension: "md" }) as File;
        fileObjects.set(path, file);
      }
      return file;
    };
    return new TopicErrataStore({
      read: async (file) => files.get(file.path) ?? "",
      listErrataFiles: () => [...files.keys()].filter((path) => path.startsWith("QnALog/勘误表/")).map(getFile),
      getByPath: (path) => files.has(path) ? getFile(path) : null,
      getFrontmatter: (file) => files.get(file.path)?.includes("qnalog_topic_errata: true") ? { qnalog_topic_errata: true } : {},
      getLinks: (file) => [...(files.get(file.path)?.matchAll(/\[\[([^\]]+)\]\]/g) || [])].map((match) => ({ link: match[1] })),
      resolveLink: (link) => {
        const path = link.replace(/\.md$/i, "");
        return files.has(`${path}.md`) ? getFile(`${path}.md`) : null;
      },
      ensureFolder: async () => undefined,
      create: async (path, content) => { files.set(path, content); return getFile(path); },
      process: async (file, transform) => {
        files.set(file.path, transform(files.get(file.path) || ""));
        if (throwAfterProcessWrite) {
          throwAfterProcessWrite = false;
          throw new Error("errata process failed after write");
        }
      },
      uiLanguage: () => language,
    });
  }

  it("writes scoped errata only after a selected removal succeeds; keeps it after undo and skips edited blocks", async () => {
    const errataFiles = new Map<string, string>();
    errataFiles.set("Topics/Climate.md", "source topic");
    const topicErrata = makeTopicErrata(errataFiles);
    const setup = harness({ topicErrata });
    const model: TopicPageV2Model = { overview: "Climate planning continues.", threads: [{ id: "work", title: "Work", summary: "The topic has two details.", points: [
      { id: "p1", text: "Off-topic device repair detail. [^source-a]", sources: ["Notes/a.md"] },
      { id: "p2", text: "Off-topic travel booking detail.", sources: ["Notes/a.md"] },
    ] }], disagreements: [], open: [], unsorted: [] };
    const topic = createTopicPage({ id: "clean-topic", title: "Climate", tags: [], basis: "overview", members: [{ path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" }] });
    topic.layout = 2;
    topic.body = renderTopicPage(model, [{ path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" }]);
    setup.storePort.seed("Topics/Climate.md", serializeTopicPage(topic));
    const block = parseTopicPageBlocks(serializeTopicPage(topic)).find((item) => item.text.includes("device repair"))!;
    const preview = await setup.service.previewExcludeBlock("Topics/Climate.md", block.id);
    const errataPath = "QnALog/勘误表/Climate · 主题勘误.md";
    expect(preview.items[0].operation.type).toBe("remove_block");
    expect(errataFiles.has(errataPath)).toBe(false);
    setup.service.cancel("clean-topic");
    expect(errataFiles.has(errataPath)).toBe(false);
    const appliedBlock = parseTopicPageBlocks(serializeTopicPage(topic)).find((item) => item.text.includes("device repair"))!;
    const confirmed = await setup.service.previewExcludeBlock("Topics/Climate.md", appliedBlock.id);
    expect(errataFiles.has(errataPath)).toBe(false);
    await setup.service.apply(confirmed, [confirmed.items[0].id]);
    expect(await setup.storePort.read("Topics/Climate.md")).not.toContain("device repair");
    expect(errataFiles.get(errataPath)).toContain("[[Notes/a]]：");
    expect(errataFiles.get(errataPath)).not.toContain("[^");
    expect(await setup.service.undoLastUpdate("clean-topic")).toMatchObject({ restored: true });
    expect(errataFiles.get(errataPath)).not.toContain("device repair");

    const travelBlock = parseTopicPageBlocks(await setup.storePort.read("Topics/Climate.md")).find((item) => item.text.includes("travel booking"))!;
    const fresh = await setup.service.previewExcludeBlock("Topics/Climate.md", travelBlock.id);
    await setup.storePort.process("Topics/Climate.md", (current) => current.replace("Off-topic travel booking detail.", "User-edited travel booking detail."));
    const result = await setup.service.apply(fresh, [fresh.items[0].id]);
    expect(result.skipped).toEqual([{ id: travelBlock.id, reason: "block-modified" }]);
    expect(result.markdown).toContain("User-edited travel booking detail.");
    expect(errataFiles.get(errataPath)).not.toContain("travel booking");
  });

  it("previews multiple off-topic blocks and writes errata only for selected blocks and their own sources", async () => {
    const errataFiles = new Map<string, string>();
    errataFiles.set("Topics/Climate.md", "source topic");
    const topicErrata = makeTopicErrata(errataFiles);
    const setup = harness({ topicErrata });
    const members = [
      { path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" },
      { path: "Notes/b.md", title: "B", sourceId: "Notes/b.md" },
    ];
    const topic = createTopicPage({ id: "multi-block-topic", title: "Climate", tags: [], basis: "overview", members });
    topic.layout = 2;
    topic.body = renderTopicPage({ overview: "Climate overview.", threads: [{ id: "work", title: "Work", summary: "Two details.", points: [
      { id: "a", text: "Off-topic repair detail.", sources: ["Notes/a.md"] },
      { id: "b", text: "Off-topic travel detail.", sources: ["Notes/b.md"] },
    ] }], disagreements: [], open: [], unsorted: [] }, members);
    setup.storePort.seed("Topics/Climate.md", serializeTopicPage(topic));

    const blocks = parseTopicPageBlocks(serializeTopicPage(topic)).filter((block) => /Off-topic (?:repair|travel) detail/.test(block.text));
    const preview = await setup.service.previewExcludeBlocks("Topics/Climate.md", blocks.map((block) => block.id));
    expect(preview.items).toHaveLength(2);
    expect(preview.items.every((item) => item.operation.type === "remove_block")).toBe(true);
    await setup.service.apply(preview, [preview.items[0].id]);

    const updated = await setup.storePort.read("Topics/Climate.md");
    expect(updated).not.toContain("Off-topic repair detail.");
    expect(updated).toContain("Off-topic travel detail.");
    const errata = errataFiles.get("QnALog/勘误表/Climate · 主题勘误.md") || "";
    expect(errata).toContain("[[Notes/a]]：Off-topic repair detail.");
    expect(errata).not.toContain("Off-topic travel detail.");
    expect(errata).not.toContain("[[Notes/b]]");
    const undone = await setup.service.undoLastUpdate("multi-block-topic");
    expect(undone).toMatchObject({ restored: true, errataRemoved: 1 });
    expect(errataFiles.get("QnALog/勘误表/Climate · 主题勘误.md")).not.toContain("Off-topic repair detail.");
    expect(await setup.storePort.read("Topics/Climate.md")).toContain("Off-topic repair detail.");
  });

  it("rejects a manual exclusion preview after the topic folder changes", async () => {
    const errataFiles = new Map<string, string>([["Topics/A.md", "source topic"], ["OtherTopics/B.md", "source topic"]]);
    const setup = harness({ topicErrata: makeTopicErrata(errataFiles) });
    const markdown = topicWithBlock("shared-topic-id", "Off-topic detail.");
    setup.storePort.seed("Topics/A.md", markdown);
    setup.storePort.seed("OtherTopics/B.md", markdown);
    const block = parseTopicPageBlocks(markdown).find((item) => item.text.includes("Off-topic detail"))!;
    const preview = await setup.service.previewExcludeBlocks("Topics/A.md", [block.id]);

    setup.setFolder("OtherTopics");
    await expect(setup.service.apply(preview, [preview.items[0].id])).rejects.toThrow();
    expect(await setup.storePort.read("Topics/A.md")).toBe(markdown);
    expect(await setup.storePort.read("OtherTopics/B.md")).toBe(markdown);
    expect([...errataFiles.keys()].some((path) => path.startsWith("QnALog/"))).toBe(false);
    setup.setFolder("Topics");
    await expect(setup.service.apply(preview, [preview.items[0].id])).rejects.toThrow("Topic preview is no longer available");
  });

  it("rejects applying a preview when its target ID is duplicated in the captured folder", async () => {
    const setup = harness({ topicErrata: makeTopicErrata(new Map([["Topics/A.md", "source topic"], ["Topics/B.md", "source topic"]])) });
    const markdown = topicWithBlock("duplicate-topic-id", "Off-topic detail.");
    setup.storePort.seed("Topics/A.md", markdown);
    setup.storePort.seed("Topics/B.md", markdown);
    const block = parseTopicPageBlocks(markdown).find((item) => item.text.includes("Off-topic detail"))!;
    const preview = await setup.service.previewExcludeBlocks("Topics/A.md", [block.id]);

    await expect(setup.service.apply(preview, [preview.items[0].id])).rejects.toThrow("This topic ID appears more than once in the topic folder. Resolve the duplicate pages and generate a new preview.");
    expect(await setup.storePort.read("Topics/A.md")).toBe(markdown);
    expect(await setup.storePort.read("Topics/B.md")).toBe(markdown);
    await expect(setup.service.apply(preview, [preview.items[0].id])).rejects.toThrow("Topic preview is no longer available");
  });

  it("allows a unique target when unrelated topic IDs are duplicated", async () => {
    const setup = harness();
    const target = topicMarkdown("target-topic-id", "Target", [], ["Notes/a.md"]);
    const unrelated = topicMarkdown("unrelated-duplicate-id", "Duplicate", [], ["Notes/a.md"]);
    setup.storePort.seed("Topics/Target.md", target);
    setup.storePort.seed("Topics/Other A.md", unrelated);
    setup.storePort.seed("Topics/Other B.md", unrelated);

    const preview = await setup.service.preview({ topicId: "target-topic-id", startPath: "Notes/b.md", memberPaths: ["Notes/b.md"], basis: "overview" });
    const applied = await setup.service.apply(preview, [preview.items[0].id]);

    expect(applied.path).toBe("Topics/Target.md");
    expect(applied.markdown).toContain("accepted update");
    expect(await setup.storePort.read("Topics/Other A.md")).toBe(unrelated);
    expect(await setup.storePort.read("Topics/Other B.md")).toBe(unrelated);
  });

  it("does not follow a moved target or apply an old ID to a replacement page", async () => {
    const moved = harness({ topicErrata: makeTopicErrata(new Map([["Topics/Original.md", "source topic"], ["Topics/Moved.md", "source topic"], ["Topics/Replacement.md", "source topic"], ["Topics/Other-copy.md", "source topic"]])) });
    const markdown = topicWithBlock("moved-topic-id", "Off-topic detail.");
    moved.storePort.seed("Topics/Original.md", markdown);
    const block = parseTopicPageBlocks(markdown).find((item) => item.text.includes("Off-topic detail"))!;
    const movedPreview = await moved.service.previewExcludeBlocks("Topics/Original.md", [block.id]);
    moved.storePort.seed("Topics/Moved.md", markdown);
    moved.storePort.seed("Topics/Replacement.md", topicWithBlock("replacement-topic-id", "Off-topic detail."));
    await moved.storePort.deleteCache("Topics/Original.md");
    await expect(moved.service.apply(movedPreview, [movedPreview.items[0].id])).rejects.toThrow();
    expect(await moved.storePort.read("Topics/Moved.md")).toBe(markdown);

    const replaced = harness({ topicErrata: makeTopicErrata(new Map([["Topics/Original.md", "source topic"], ["Topics/Other-copy.md", "source topic"]])) });
    const original = topicWithBlock("original-topic-id", "Off-topic detail.");
    replaced.storePort.seed("Topics/Original.md", original);
    const originalBlock = parseTopicPageBlocks(original).find((item) => item.text.includes("Off-topic detail"))!;
    const replacedPreview = await replaced.service.previewExcludeBlocks("Topics/Original.md", [originalBlock.id]);
    replaced.storePort.seed("Topics/Original.md", topicWithBlock("replacement-topic-id", "Off-topic detail."));
    replaced.storePort.seed("Topics/Other-copy.md", original);
    await expect(replaced.service.apply(replacedPreview, [replacedPreview.items[0].id])).rejects.toThrow();
    expect(await replaced.storePort.read("Topics/Other-copy.md")).toBe(original);
  });

  it("rejects a new-topic preview when the folder changes during model generation", async () => {
    let folder = "Topics";
    const setup = harness({ getFolder: () => folder, request: async (messages) => {
      folder = "OtherTopics";
      const payload = JSON.parse(messages[1].content) as { members: Array<{ sourceId: string }> };
      const sourceId = payload.members[0]?.sourceId || "Notes/a.md";
      return { choices: [{ message: { content: JSON.stringify({ overview: "Generated overview.", status: "active", threads: [{ title: "Progress", summary: "Current detail.", points: [{ text: "Evidence supports the plan.", sources: [sourceId] }] }], disagreements: [], open: [], unsorted: [] }) } }] };
    } });

    await expect(setup.service.preview({ startPath: "Notes/a.md", memberPaths: [], basis: "overview", title: "New topic" })).rejects.toThrow();
    expect(setup.storePort.created).toHaveLength(0);
  });

  it("rejects create and rebuild previews after their topic folder changes", async () => {
    const setup = harness();
    const createPreview = await setup.service.preview({ startPath: "Notes/a.md", memberPaths: [], basis: "overview", title: "New topic" });
    setup.setFolder("OtherTopics");
    await expect(setup.service.apply(createPreview, [])).rejects.toThrow();
    expect(setup.storePort.created).toHaveLength(0);
    await expect(setup.service.apply(createPreview, [])).rejects.toThrow("Topic preview is no longer available");

    setup.setFolder("Topics");
    const legacy = topicMarkdown("legacy-topic", "Legacy", ["climate"], ["Notes/a.md"]);
    setup.storePort.seed("Topics/Legacy.md", legacy);
    const rebuildPreview = await setup.service.previewRebuild("legacy-topic");
    setup.setFolder("OtherTopics");
    await expect(setup.service.apply(rebuildPreview, [])).rejects.toThrow();
    expect(await setup.storePort.read("Topics/Legacy.md")).toBe(legacy);
    expect(setup.storePort.created.filter(({ path }) => path.includes("topic-history"))).toHaveLength(0);
  });

  it("keeps a rebuild preview bound to the path captured before its second topic listing", async () => {
    const setup = harness();
    const legacy = topicMarkdown("legacy-topic", "Legacy", ["climate"], ["Notes/a.md"]);
    setup.storePort.seed("Topics/Legacy.md", legacy);
    const listMarkdown = setup.storePort.listMarkdown.bind(setup.storePort);
    let calls = 0;
    setup.storePort.listMarkdown = async (folder) => {
      calls += 1;
      if (calls === 2) {
        setup.storePort.seed("Topics/Moved.md", legacy);
        await setup.storePort.deleteCache("Topics/Legacy.md");
      }
      return listMarkdown(folder);
    };

    await expect(setup.service.previewRebuild("legacy-topic")).rejects.toThrow();
    expect(await setup.storePort.read("Topics/Moved.md")).toBe(legacy);
    expect(setup.storePort.created.filter(({ path }) => path.includes("topic-history"))).toHaveLength(0);
  });

  it("keeps the first exclusion undoable when a later errata append fails", async () => {
    const errataFiles = new Map<string, string>([["Topics/Climate.md", "source topic"]]);
    const topicErrata = makeTopicErrata(errataFiles);
    const originalAppendEntry = topicErrata.appendEntry.bind(topicErrata);
    const appendEntry = vi.spyOn(topicErrata, "appendEntry");
    appendEntry
      .mockImplementationOnce((...args) => originalAppendEntry(...args))
      .mockRejectedValueOnce(new Error("second errata write failed"));
    const setup = harness({ topicErrata });
    const members = [
      { path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" },
      { path: "Notes/b.md", title: "B", sourceId: "Notes/b.md" },
    ];
    const topic = createTopicPage({ id: "partial-errata-topic", title: "Climate", tags: [], basis: "overview", members });
    topic.layout = 2;
    topic.body = renderTopicPage({ overview: "Climate overview.", threads: [{ id: "work", title: "Work", summary: "Two details.", points: [
      { id: "repair", text: "Off-topic repair detail.", sources: ["Notes/a.md"] },
      { id: "travel", text: "Off-topic travel detail.", sources: ["Notes/b.md"] },
    ] }], disagreements: [], open: [], unsorted: [] }, members);
    const originalPage = serializeTopicPage(topic);
    setup.storePort.seed("Topics/Climate.md", originalPage);
    const blocks = parseTopicPageBlocks(originalPage).filter((block) => /Off-topic (?:repair|travel) detail/.test(block.text));
    const preview = await setup.service.previewExcludeBlocks("Topics/Climate.md", blocks.map((block) => block.id));
    const selection = preview.items.map((item) => item.id);

    await expect(setup.service.apply(preview, selection)).rejects.toThrow("second errata write failed");
    expect(await setup.storePort.read("Topics/Climate.md")).not.toMatch(/Off-topic (?:repair|travel) detail/);
    await expect(setup.service.apply(preview, selection)).rejects.toThrow("Topic preview is no longer available");

    expect(await setup.service.undoLastUpdate("partial-errata-topic")).toMatchObject({ restored: true, errataRemoved: 1 });
    expect(await setup.storePort.read("Topics/Climate.md")).toBe(originalPage);
    const errata = errataFiles.get("QnALog/勘误表/Climate · 主题勘误.md") || "";
    expect(errata).not.toContain("Off-topic repair detail.");
    expect(errata).not.toContain("Off-topic travel detail.");
  });

  it("records each source of a multi-source exclusion before a later append fails", async () => {
    const errataFiles = new Map<string, string>([["Topics/Climate.md", "source topic"]]);
    const topicErrata = makeTopicErrata(errataFiles);
    const originalAppendEntry = topicErrata.appendEntry.bind(topicErrata);
    const appendEntry = vi.spyOn(topicErrata, "appendEntry");
    appendEntry
      .mockImplementationOnce((...args) => originalAppendEntry(...args))
      .mockRejectedValueOnce(new Error("second source write failed"));
    const setup = harness({ topicErrata });
    const members = [
      { path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" },
      { path: "Notes/b.md", title: "B", sourceId: "Notes/b.md" },
    ];
    const topic = createTopicPage({ id: "multi-source-errata-topic", title: "Climate", tags: [], basis: "overview", members });
    topic.layout = 2;
    topic.body = renderTopicPage({ overview: "Climate overview.", threads: [{ id: "work", title: "Work", summary: "One detail.", points: [
      { id: "shared", text: "Off-topic shared detail.", sources: ["Notes/a.md", "Notes/b.md"] },
    ] }], disagreements: [], open: [], unsorted: [] }, members);
    const originalPage = serializeTopicPage(topic);
    setup.storePort.seed("Topics/Climate.md", originalPage);
    const block = parseTopicPageBlocks(originalPage).find((item) => item.text.includes("Off-topic shared detail"))!;
    const preview = await setup.service.previewExcludeBlock("Topics/Climate.md", block.id);

    await expect(setup.service.apply(preview, [preview.items[0].id])).rejects.toThrow("second source write failed");
    await expect(setup.service.apply(preview, [preview.items[0].id])).rejects.toThrow("Topic preview is no longer available");
    expect(await setup.service.undoLastUpdate("multi-source-errata-topic")).toMatchObject({ restored: true, errataRemoved: 1 });
    expect(await setup.storePort.read("Topics/Climate.md")).toBe(originalPage);
    expect(errataFiles.get("QnALog/勘误表/Climate · 主题勘误.md")).not.toContain("Off-topic shared detail.");
  });

  it("invalidates an exclusion preview when its first errata append fails", async () => {
    const errataFiles = new Map<string, string>([["Topics/Climate.md", "source topic"]]);
    const topicErrata = makeTopicErrata(errataFiles);
    vi.spyOn(topicErrata, "appendEntry").mockRejectedValueOnce(new Error("first errata write failed"));
    const setup = harness({ topicErrata });
    const members = [{ path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" }];
    const topic = createTopicPage({ id: "first-append-failed-topic", title: "Climate", tags: [], basis: "overview", members });
    topic.layout = 2;
    topic.body = renderTopicPage({ overview: "Climate overview.", threads: [{ id: "work", title: "Work", summary: "One detail.", points: [
      { id: "point", text: "Off-topic detail.", sources: ["Notes/a.md"] },
    ] }], disagreements: [], open: [], unsorted: [] }, members);
    const originalPage = serializeTopicPage(topic);
    setup.storePort.seed("Topics/Climate.md", originalPage);
    const block = parseTopicPageBlocks(originalPage).find((item) => item.text.includes("Off-topic detail"))!;
    const preview = await setup.service.previewExcludeBlock("Topics/Climate.md", block.id);

    await expect(setup.service.apply(preview, [preview.items[0].id])).rejects.toThrow("first errata write failed");
    await expect(setup.service.apply(preview, [preview.items[0].id])).rejects.toThrow("Topic preview is no longer available");
    expect(await setup.service.undoLastUpdate("first-append-failed-topic")).toMatchObject({ restored: true });
    expect(await setup.storePort.read("Topics/Climate.md")).toBe(originalPage);
  });

  it("stops after an errata undo association cannot be verified and reports the retained row", async () => {
    const errataFiles = new Map<string, string>([["Topics/Climate.md", "source topic"]]);
    const topicErrata = makeTopicErrata(errataFiles);
    const appendEntry = vi.spyOn(topicErrata, "appendEntry");
    const setup = harness({ topicErrata });
    const originalWrite = setup.storePort.writeCache.bind(setup.storePort);
    setup.storePort.writeCache = async (path, content) => {
      if (path.endsWith("topic-index/association-failure-topic.json") && (JSON.parse(content) as { lastSnapshotErrata?: unknown }).lastSnapshotErrata) return;
      await originalWrite(path, content);
    };
    const members = [
      { path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" },
      { path: "Notes/b.md", title: "B", sourceId: "Notes/b.md" },
    ];
    const topic = createTopicPage({ id: "association-failure-topic", title: "Climate", tags: [], basis: "overview", members });
    topic.layout = 2;
    topic.body = renderTopicPage({ overview: "Climate overview.", threads: [{ id: "work", title: "Work", summary: "Two details.", points: [
      { id: "repair", text: "Off-topic repair detail.", sources: ["Notes/a.md"] },
      { id: "travel", text: "Off-topic travel detail.", sources: ["Notes/b.md"] },
    ] }], disagreements: [], open: [], unsorted: [] }, members);
    setup.storePort.seed("Topics/Climate.md", serializeTopicPage(topic));
    const blocks = parseTopicPageBlocks(serializeTopicPage(topic)).filter((block) => /Off-topic (?:repair|travel) detail/.test(block.text));
    const preview = await setup.service.previewExcludeBlocks("Topics/Climate.md", blocks.map((block) => block.id));

    await expect(setup.service.apply(preview, preview.items.map((item) => item.id))).rejects.toThrow("The topic page was updated. New errata rows were kept, but their undo tracking could not be confirmed.");
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(await setup.storePort.read("Topics/Climate.md")).not.toMatch(/Off-topic (?:repair|travel) detail/);
    const errata = errataFiles.get("QnALog/勘误表/Climate · 主题勘误.md") || "";
    expect(errata).toContain("Off-topic repair detail.");
    expect(errata).not.toContain("Off-topic travel detail.");
  });

  it("associates an errata row written before process throws so Undo removes it", async () => {
    const errataFiles = new Map<string, string>([["Topics/Climate.md", "source topic"]]);
    const topicErrata = makeTopicErrata(errataFiles, "zh", true);
    const setup = harness({ topicErrata });
    const members = [{ path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" }];
    const topic = createTopicPage({ id: "append-throw-after-write-topic", title: "Climate", tags: [], basis: "overview", members });
    topic.layout = 2;
    topic.body = renderTopicPage({ overview: "Climate overview.", threads: [{ id: "work", title: "Work", summary: "One detail.", points: [
      { id: "repair", text: "Off-topic repair detail.", sources: ["Notes/a.md"] },
    ] }], disagreements: [], open: [], unsorted: [] }, members);
    const originalPage = serializeTopicPage(topic);
    setup.storePort.seed("Topics/Climate.md", originalPage);
    const block = parseTopicPageBlocks(originalPage).find((item) => item.text.includes("Off-topic repair detail"))!;
    const preview = await setup.service.previewExcludeBlock("Topics/Climate.md", block.id);

    await expect(setup.service.apply(preview, [preview.items[0].id])).resolves.toMatchObject({ path: "Topics/Climate.md" });
    expect(await setup.storePort.read("Topics/Climate.md")).not.toContain("Off-topic repair detail.");
    const errataPath = "QnALog/勘误表/Climate · 主题勘误.md";
    expect(errataFiles.get(errataPath)).toContain("Off-topic repair detail.");

    await expect(setup.service.undoLastUpdate("append-throw-after-write-topic")).resolves.toMatchObject({ restored: true, errataRemoved: 1 });
    expect(await setup.storePort.read("Topics/Climate.md")).toBe(originalPage);
    expect(errataFiles.get(errataPath)).not.toContain("Off-topic repair detail.");
  });

  it("undoes all newly added scoped and global errata with the matching multi-block snapshot", async () => {
    const errataPath = "QnALog/勘误表/Climate · 主题勘误.md";
    const originalErrata = "---\nqnalog_topic_errata: true\n---\n主题：[[Topics/Climate]]\n\n## 不属于本主题\n- 既有全局事项\n\n## 说明\n维护者备注\n";
    const errataFiles = new Map<string, string>([["Topics/Climate.md", "source topic"], ["Notes/a.md", "member note"], [errataPath, originalErrata]]);
    const topicErrata = makeTopicErrata(errataFiles);
    const setup = harness({ topicErrata });
    const members = [{ path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" }];
    const topic = createTopicPage({ id: "undo-multi-topic", title: "Climate", tags: [], basis: "overview", members });
    topic.layout = 2;
    topic.body = renderTopicPage({ overview: "Climate overview.", threads: [{ id: "work", title: "Work", summary: "Two details.", points: [
      { id: "scoped", text: "Off-topic member detail.", sources: ["Notes/a.md"] },
      { id: "global", text: "Off-topic global detail.", sources: [] },
    ] }], disagreements: [], open: [], unsorted: [] }, members);
    const originalPage = serializeTopicPage(topic);
    setup.storePort.seed("Topics/Climate.md", originalPage);
    const blocks = parseTopicPageBlocks(originalPage).filter((block) => /Off-topic (?:member|global) detail/.test(block.text));
    const preview = await setup.service.previewExcludeBlocks("Topics/Climate.md", blocks.map((block) => block.id));

    await setup.service.apply(preview, preview.items.map((item) => item.id));
    expect(errataFiles.get(errataPath)).toContain("[[Notes/a]]：Off-topic member detail.");
    expect(errataFiles.get(errataPath)).toContain("- Off-topic global detail.");
    expect(await setup.service.undoLastUpdate("undo-multi-topic")).toEqual({ restored: true, errataRemoved: 2 });
    expect(errataFiles.get(errataPath)).toBe(originalErrata);
    expect(await setup.storePort.read("Topics/Climate.md")).toBe(originalPage);
  });

  it("leaves a pre-existing duplicate errata entry in place after undo", async () => {
    const errataPath = "QnALog/勘误表/Climate · 主题勘误.md";
    const originalErrata = "---\nqnalog_topic_errata: true\n---\n主题：[[Topics/Climate]]\n\n## 不属于本主题\n- [[Notes/a]]：Off-topic member detail.\n\n## 说明\nKeep this note.\n";
    const errataFiles = new Map<string, string>([["Topics/Climate.md", "source topic"], ["Notes/a.md", "member note"], [errataPath, originalErrata]]);
    const topicErrata = makeTopicErrata(errataFiles);
    const setup = harness({ topicErrata });
    const members = [{ path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" }];
    const topic = createTopicPage({ id: "existing-errata-topic", title: "Climate", tags: [], basis: "overview", members });
    topic.layout = 2;
    topic.body = renderTopicPage({ overview: "Climate overview.", threads: [{ id: "work", title: "Work", summary: "Current detail.", points: [
      { id: "point", text: "Off-topic member detail.", sources: ["Notes/a.md"] },
    ] }], disagreements: [], open: [], unsorted: [] }, members);
    const originalPage = serializeTopicPage(topic);
    setup.storePort.seed("Topics/Climate.md", originalPage);
    const block = parseTopicPageBlocks(originalPage).find((item) => item.text.includes("Off-topic member detail"))!;
    const preview = await setup.service.previewExcludeBlocks("Topics/Climate.md", [block.id]);
    await setup.service.apply(preview, [preview.items[0].id]);

    expect(await setup.service.undoLastUpdate("existing-errata-topic")).toEqual({ restored: true });
    expect(errataFiles.get(errataPath)).toBe(originalErrata);
    expect(await setup.storePort.read("Topics/Climate.md")).toBe(originalPage);
  });

  it("skips an errata row whose description the user edited", async () => {
    const errataPath = "QnALog/勘误表/Climate · 主题勘误.md";
    const originalErrata = "---\nqnalog_topic_errata: true\n---\n主题：[[Topics/Climate]]\n\n## 不属于本主题\n- 既有全局事项\n\n## 说明\n保留备注\n";
    const errataFiles = new Map<string, string>([["Topics/Climate.md", "source topic"], [errataPath, originalErrata]]);
    const topicErrata = makeTopicErrata(errataFiles);
    const setup = harness({ topicErrata });
    const members = [{ path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" }];
    const topic = createTopicPage({ id: "edited-entry-topic", title: "Climate", tags: [], basis: "overview", members });
    topic.layout = 2;
    topic.body = renderTopicPage({ overview: "Climate overview.", threads: [{ id: "work", title: "Work", summary: "Current detail.", points: [
      { id: "point", text: "Off-topic original wording.", sources: ["Notes/a.md"] },
    ] }], disagreements: [], open: [], unsorted: [] }, members);
    const originalPage = serializeTopicPage(topic);
    setup.storePort.seed("Topics/Climate.md", originalPage);
    const block = parseTopicPageBlocks(originalPage).find((item) => item.text.includes("Off-topic original wording"))!;
    const preview = await setup.service.previewExcludeBlocks("Topics/Climate.md", [block.id]);
    await setup.service.apply(preview, [preview.items[0].id]);
    const afterAppend = errataFiles.get(errataPath)!;
    errataFiles.set(errataPath, afterAppend.replace("Off-topic original wording", "Maintainer edited this wording"));

    expect(await setup.service.undoLastUpdate("edited-entry-topic")).toEqual({ restored: true, errataRemoved: 0 });
    expect(errataFiles.get(errataPath)).toContain("Maintainer edited this wording");
    expect(errataFiles.get(errataPath)).toContain("既有全局事项");
    expect(errataFiles.get(errataPath)).toContain("保留备注");
    expect(await setup.storePort.read("Topics/Climate.md")).toBe(originalPage);
  });

  it("keeps errata unchanged when page-modified prevents undo", async () => {
    const errataFiles = new Map<string, string>([["Topics/Climate.md", "source topic"]]);
    const topicErrata = makeTopicErrata(errataFiles);
    const setup = harness({ topicErrata });
    const members = [{ path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" }];
    const topic = createTopicPage({ id: "modified-page-topic", title: "Climate", tags: [], basis: "overview", members });
    topic.layout = 2;
    topic.body = renderTopicPage({ overview: "Climate overview.", threads: [{ id: "work", title: "Work", summary: "Current detail.", points: [
      { id: "point", text: "Off-topic detail.", sources: ["Notes/a.md"] },
    ] }], disagreements: [], open: [], unsorted: [] }, members);
    const originalPage = serializeTopicPage(topic);
    setup.storePort.seed("Topics/Climate.md", originalPage);
    const block = parseTopicPageBlocks(originalPage).find((item) => item.text.includes("Off-topic detail"))!;
    const preview = await setup.service.previewExcludeBlocks("Topics/Climate.md", [block.id]);
    await setup.service.apply(preview, [preview.items[0].id]);
    const errataBeforeUndo = errataFiles.get("QnALog/勘误表/Climate · 主题勘误.md");
    await setup.storePort.process("Topics/Climate.md", (current) => `${current}\nmanual edit`);

    expect(await setup.service.undoLastUpdate("modified-page-topic")).toEqual({ restored: false, reason: "page-modified" });
    expect(errataFiles.get("QnALog/勘误表/Climate · 主题勘误.md")).toBe(errataBeforeUndo);
  });

  it("returns a manual-removal warning when errata cleanup fails after page restoration", async () => {
    const errataFiles = new Map<string, string>([["Topics/Climate.md", "source topic"]]);
    const topicErrata = makeTopicErrata(errataFiles);
    const removeEntries = vi.spyOn(topicErrata, "removeEntries").mockRejectedValueOnce(new Error("write failed"));
    const setup = harness({ topicErrata });
    const members = [{ path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" }];
    const topic = createTopicPage({ id: "failed-cleanup-topic", title: "Climate", tags: [], basis: "overview", members });
    topic.layout = 2;
    topic.body = renderTopicPage({ overview: "Climate overview.", threads: [{ id: "work", title: "Work", summary: "Current detail.", points: [
      { id: "point", text: "Off-topic detail.", sources: ["Notes/a.md"] },
    ] }], disagreements: [], open: [], unsorted: [] }, members);
    const originalPage = serializeTopicPage(topic);
    setup.storePort.seed("Topics/Climate.md", originalPage);
    const block = parseTopicPageBlocks(originalPage).find((item) => item.text.includes("Off-topic detail"))!;
    const preview = await setup.service.previewExcludeBlocks("Topics/Climate.md", [block.id]);
    await setup.service.apply(preview, [preview.items[0].id]);

    expect(await setup.service.undoLastUpdate("failed-cleanup-topic")).toEqual({ restored: true, errataRemoved: 0, errataFailed: true });
    expect(await setup.storePort.read("Topics/Climate.md")).toBe(originalPage);
    expect(removeEntries).toHaveBeenCalledOnce();
  });

  it("finishes undo from a new service after page restore is followed by a read failure", async () => {
    const errataFiles = new Map<string, string>([["Topics/Climate.md", "source topic"]]);
    const topicErrata = makeTopicErrata(errataFiles);
    const setup = harness({ topicErrata });
    const members = [{ path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" }];
    const topic = createTopicPage({ id: "undo-readback-retry-topic", title: "Climate", tags: [], basis: "overview", members });
    topic.layout = 2;
    topic.body = renderTopicPage({ overview: "Climate overview.", threads: [{ id: "work", title: "Work", summary: "Current detail.", points: [
      { id: "point", text: "Off-topic detail.", sources: ["Notes/a.md"] },
    ] }], disagreements: [], open: [], unsorted: [] }, members);
    const originalPage = serializeTopicPage(topic);
    setup.storePort.seed("Topics/Climate.md", originalPage);
    const block = parseTopicPageBlocks(originalPage).find((item) => item.text.includes("Off-topic detail"))!;
    const preview = await setup.service.previewExcludeBlock("Topics/Climate.md", block.id);
    await setup.service.apply(preview, [preview.items[0].id]);
    const errataPath = "QnALog/勘误表/Climate · 主题勘误.md";
    const originalRead = setup.storePort.read.bind(setup.storePort);
    const originalProcess = setup.storePort.process.bind(setup.storePort);
    let failNextPageRead = false;
    setup.storePort.read = async (path) => {
      if (path === "Topics/Climate.md" && failNextPageRead) {
        failNextPageRead = false;
        throw new Error("page read failed after restore");
      }
      return originalRead(path);
    };
    setup.storePort.process = async (path, transform) => {
      await originalProcess(path, transform);
      if (path === "Topics/Climate.md") {
        failNextPageRead = true;
        throw new Error("process failed after restore");
      }
    };

    await expect(setup.service.undoLastUpdate("undo-readback-retry-topic")).rejects.toThrow("process failed after restore");
    expect(await originalRead("Topics/Climate.md")).toBe(originalPage);
    expect(errataFiles.get(errataPath)).toContain("Off-topic detail.");

    const restartedService = setup.createService();
    await expect(restartedService.undoLastUpdate("undo-readback-retry-topic")).resolves.toEqual({ restored: true, errataRemoved: 1 });
    expect(await originalRead("Topics/Climate.md")).toBe(originalPage);
    expect(errataFiles.get(errataPath)).not.toContain("Off-topic detail.");
  });

  it("returns no cleaning work without errata and does not call the model", async () => {
    const topicErrata = makeTopicErrata(new Map(), "en");
    const setup = harness({ topicErrata });
    setup.storePort.seed("Topics/Climate.md", topicMarkdown("clean-topic", "Climate", [], ["Notes/a.md"]));
    expect(await setup.service.estimateContentCleaning("clean-topic")).toEqual({ chars: 0, tokens: 0 });
    expect((await setup.service.previewContentCleaning("clean-topic")).items).toEqual([]);
    expect(setup.requests).toHaveLength(0);
  });

  it("ensures the current topic errata document and returns its store path", async () => {
    const errataFiles = new Map<string, string>();
    errataFiles.set("Topics/Climate.md", "source topic");
    const topicErrata = makeTopicErrata(errataFiles);
    const setup = harness({ topicErrata });
    setup.storePort.seed("Topics/Climate.md", topicMarkdown("clean-topic", "Climate", [], ["Notes/a.md"]));
    const path = await setup.service.ensureTopicErrata("clean-topic");
    expect(path).toBe(topicErrata.pathForTopic("Topics/Climate.md"));
    expect(errataFiles.get(path)).toContain("qnalog_topic_errata: true");
  });

  it("previews uncited members, removes selected metadata, optionally excludes, and supports undo", async () => {
    const errata = { load: vi.fn(), append: vi.fn(), ensure: vi.fn() } as unknown as TopicErrataStore;
    const setup = harness({ topicErrata: errata });
    const members = [
      { path: "Notes/a.md", title: "A", sourceId: "Notes/a.md", date: "2026-01-01", summary: "A contributed note." },
      { path: "Notes/b.md", title: "B", sourceId: "Notes/b.md", date: "2026-01-02", summary: "No topic claim from B." },
    ];
    const page = createTopicPage({ id: "climate-topic", title: "Climate", tags: [], members, basis: "overview" });
    page.layout = 2;
    page.body = renderTopicPage({ overview: "Overview.", threads: [{ id: "thread", title: "Funding", summary: "A summary.", points: [
      { id: "point", text: "A fact from A.", sources: ["Notes/a.md"] },
    ] }], disagreements: [], open: [], unsorted: [] }, members);
    setup.storePort.seed("Topics/Climate.md", serializeTopicPage(page));

    expect(await setup.service.getUncontributedMembers("climate-topic")).toEqual([{ path: "Notes/b.md", title: "B" }]);
    const before = await setup.storePort.read("Topics/Climate.md");
    const cancelled = await setup.service.previewOrphanMembers("climate-topic");
    expect(cancelled.items).toHaveLength(1);
    expect(cancelled.items[0].operation).toEqual({ type: "remove_member", path: "Notes/b.md" });
    setup.service.cancel("climate-topic");
    expect(await setup.storePort.read("Topics/Climate.md")).toBe(before);
    expect(setup.writes).toEqual([]);

    const preview = await setup.service.previewOrphanMembers("climate-topic");
    const itemId = preview.items[0].id;
    const result = await setup.service.apply(preview, [itemId, topicMemberExcludeSelectionId(itemId)]);
    const removed = parseTopicPage(result.markdown)!;
    expect(removed.members).toEqual(["Notes/a.md"]);
    expect(removed.excluded).toEqual(["Notes/b.md"]);
    expect(removed.memberLinks).toEqual(["[[Notes/a|A]]"]);
    expect(setup.writes.filter((write) => write.path === "Topics/Climate.md")).toHaveLength(1);
    expect(await setup.service.undoLastUpdate("climate-topic")).toMatchObject({ restored: true });
    const restored = parseTopicPage(await setup.storePort.read("Topics/Climate.md"))!;
    expect(restored.members).toEqual(["Notes/a.md", "Notes/b.md"]);
    expect(restored.excluded).toEqual([]);
    expect(errata.load).not.toHaveBeenCalled();
    expect(errata.append).not.toHaveBeenCalled();
  });

  it("only reads through its port when requested and returns statistics", async () => {
    let reads = 0;
    const now = Date.now();
    const port: TopicsServicePort = { listNoteFiles: () => [{ path: "QnALog/one.md", basename: "one", mtime: now, ctime: now }],
      getMtime: (path) => path.endsWith("one.md") ? now : null, getFrontmatter: () => ({}),
      readText: async () => { reads++; return "> [!abstract]\n> A useful overview about shared climate policy"; },
      getResolvedLinks: () => ({}), getUnresolvedLinks: () => ({}), now: () => now };
    const service = new TopicsService({ ...emptyHost(port), getRoots: () => ["QnALog"] });
    expect(reads).toBe(0);
    const result = await service.getSuggestions();
    expect(result.stats.windowedCount).toBe(1); expect(result.stats.readCount).toBe(1); expect(reads).toBe(1);
    const refreshed = await service.getSuggestions();
    expect(refreshed.stats.readCount).toBe(0); expect(reads).toBe(1);
  });

  it("uses the current configured root and excludes linked files outside it", async () => {
    let root = "First";
    let rootReads = 0;
    const now = Date.now();
    const files = ["First/a.md", "First/b.md", "Elsewhere/x.md", "Second/c.md", "Second/d.md"]
      .map((path) => ({ path, basename: path.split("/").pop()?.replace(/\.md$/, "") || "", mtime: now, ctime: now }));
    const readPaths: string[] = [];
    const port: TopicsServicePort = {
      listNoteFiles: () => files.filter((file) => file.path.startsWith(`${root}/`)),
      getMtime: (path) => files.find((file) => file.path === path)?.mtime ?? null,
      getFrontmatter: () => ({}),
      readText: async (path) => { readPaths.push(path); return `> [!abstract]\n> Shared planning notes for ${path}`; },
      getResolvedLinks: () => ({ "First/a.md": { "Elsewhere/x.md": 1 } }), getUnresolvedLinks: () => ({}), now: () => now,
    };
    const service = new TopicsService({ ...emptyHost(port), getRoots: () => { rootReads++; return [root]; } });
    const first = await service.getSuggestions();
    expect(first.stats.windowedCount).toBe(2);
    expect(readPaths).toEqual(["First/a.md", "First/b.md"]);
    expect(first.suggestions.flatMap((suggestion) => suggestion.memberPaths)).not.toContain("Elsewhere/x.md");
    root = "Second";
    const second = await service.getSuggestions({ windowDays: 3650 });
    expect(second.stats.windowedCount).toBe(2);
    expect(readPaths.slice(2)).toEqual(["Second/c.md", "Second/d.md"]);
    expect(rootReads).toBe(2);
  });

  it("keeps candidates, estimates and previews read-only, while preview owns activity lifecycle", async () => {
    const setup = harness();
    const preview = await setup.service.preview({ startPath: "Notes/a.md", memberPaths: ["Notes/b.md", "Notes/a.md", "Notes/b.md"], basis: "overview", title: "Climate" });
    expect(preview.create?.members.map((member) => member.path)).toEqual(["Notes/a.md", "Notes/b.md"]);
    expect(setup.requests).toHaveLength(1);
    expect(setup.activities.progress).toContainEqual(expect.objectContaining({ progress: 100, stageLabel: "Completed 1/1 batches" }));
    expect(setup.writes).toEqual([]);
    expect(setup.activities.started).toEqual([["topics:create:topic-1", "Create topic"]]);
    expect(setup.activities.completed).toEqual([]);
    expect(setup.activities.failed).toEqual([]);

    const estimate = await setup.service.estimate({ memberPaths: ["Notes/a.md", "Notes/b.md"], basis: "overview" });
    expect(estimate).toMatchObject({ chars: expect.any(Number), requests: 1 });
    expect(setup.requests).toHaveLength(1);
    setup.storePort.seed("Topics/Other.md", topicMarkdown("topic-other", "Other", [], ["Notes/b.md"]));
    const candidates = await setup.service.getCandidates("Notes/a.md");
    expect(candidates.byTag.some((candidate) => candidate.path === "Notes/b.md")).toBe(true);
    expect(candidates.byTag.find((candidate) => candidate.path === "Notes/b.md")?.alreadyInTopics).toEqual(["topic-other"]);
    expect(setup.writes).toEqual([]);
    expect(setup.storePort.created).toEqual([]);
  });
  it("records the original request for create and update previews", async () => {
    const setup = harness();
    const createInput = { startPath: "Notes/a.md", memberPaths: ["Notes/a.md", "Notes/b.md"], basis: "overview" as const, title: "Climate" };
    const createPreview = await setup.service.preview(createInput);
    expect(createPreview.request).toEqual({ startPath: createInput.startPath, memberPaths: createInput.memberPaths, basis: createInput.basis });

    setup.storePort.seed("Topics/Climate.md", topicMarkdown("climate-topic", "Climate", [], ["Notes/a.md"]));
    const updateInput = { startPath: "Notes/b.md", memberPaths: ["Notes/a.md", "Notes/b.md"], basis: "overview" as const, topicId: "climate-topic" };
    const updatePreview = await setup.service.preview(updateInput);
    expect(updatePreview.request).toEqual(updateInput);
  });
  it("requires cost confirmation before body-mode model requests", async () => {
    const setup = harness();
    const input = { startPath: "Notes/a.md", memberPaths: ["Notes/a.md"], basis: "body" as const };
    await expect(setup.service.preview(input)).rejects.toThrow("Estimate body-mode cost first");
    expect(setup.requests).toHaveLength(0);
    const estimate = await setup.service.estimate({ memberPaths: input.memberPaths, basis: input.basis });
    expect(estimate.requests).toBe(1);
    const preview = await setup.service.preview({ ...input, bodyConfirmed: true });
    expect(preview.completedBatches).toBe(1);
    expect(setup.requests).toHaveLength(1);
    expect(setup.writes).toEqual([]);
  });

  it("cancels an active preview and records cancellation without writes", async () => {
    let enterRequest!: () => void;
    let releaseRequest!: () => void;
    const entered = new Promise<void>((resolve) => { enterRequest = resolve; });
    const gate = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const setup = harness({ request: async (_messages, signal) => {
      enterRequest();
      await gate;
      signal?.throwIfAborted();
      return { operations: [] };
    } });
    const pending = setup.service.preview({ startPath: "Notes/a.md", memberPaths: ["Notes/a.md"], basis: "overview" });
    await entered;
    setup.service.cancel("topics:create:topic-1");
    releaseRequest();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(setup.activities.failed).toHaveLength(0);
    expect(setup.activities.cancelled).toEqual([["topics:create:topic-1", "Topic operation cancelled; the topic page was not changed"]]);
    expect(setup.writes).toEqual([]);
  });
  it("leaves an existing topic unchanged when the first integration batch fails", async () => {
    const setup = harness({ request: async () => { throw new Error("offline"); } });
    const initial = topicMarkdown("climate-topic", "Climate", ["climate"]);
    setup.storePort.seed("Topics/Climate.md", initial);
    await expect(setup.service.preview({ topicId: "climate-topic", startPath: "Notes/b.md", memberPaths: ["Notes/b.md"], basis: "overview" })).rejects.toThrow("could not be generated");
    expect(await setup.storePort.read("Topics/Climate.md")).toBe(initial);
    expect(setup.writes).toEqual([]);
    expect(setup.activities.failed).toHaveLength(1);
  });

  it("refreshes the arrived note's metadata while excluding system namespace tags", async () => {
    const setup = harness();
    setup.storePort.seed("Topics/Climate.md", topicMarkdown("climate-topic", "Climate", ["qnalog/general"]));
    await setup.service.getCandidates("Notes/a.md");
    const mtime = setup.files[0].mtime;
    setup.files[0].tags.push("qnalog/general");
    const prompts = await setup.service.noteArrived("Notes/a.md");
    expect(setup.files[0].mtime).toBe(mtime);
    expect(prompts).toEqual([]);
    expect(setup.requests).toHaveLength(0);
    expect(setup.writes).toEqual([]);
  });

  it("discards a generated preview once when the dialog closes and does not cancel after apply", async () => {
    const setup = harness();
    const preview = await setup.service.preview({ startPath: "Notes/a.md", memberPaths: ["Notes/a.md"], basis: "overview" });
    setup.service.cancel(preview.topicId);
    expect(setup.activities.cancelled).toEqual([["topics:create:topic-1", "Topic operation cancelled; the topic page was not changed"]]);
    await expect(setup.service.apply(preview, preview.items.map(({ id }) => id))).rejects.toThrow("no longer available");
    expect(setup.writes).toEqual([]);

    const applied = await setup.service.preview({ startPath: "Notes/a.md", memberPaths: ["Notes/a.md"], basis: "overview" });
    await setup.service.apply(applied, applied.items.map(({ id }) => id));
    setup.service.cancel(applied.topicId);
    expect(setup.activities.cancelled).toHaveLength(1);
    expect(setup.activities.completed).toEqual([["topics:create:topic-2"]]);
  });

  it("excludes topic-page files and notes outside configured roots from note scope", async () => {
    const setup = harness({ roots: ["Notes"] });
    setup.files.push(file("Elsewhere/climate.md"), file("Topics/Climate.md"));
    const candidates = await setup.service.getCandidates("Notes/a.md");
    expect(candidates.byTag.map((candidate) => candidate.path)).not.toContain("Elsewhere/climate.md");
    expect(candidates.byTag.map((candidate) => candidate.path)).not.toContain("Topics/Climate.md");
    await expect(setup.service.getCandidates("Elsewhere/climate.md")).rejects.toThrow("outside the configured note scope");
    await expect(setup.service.estimate({ memberPaths: ["Topics/Climate.md"], basis: "overview" })).rejects.toThrow("not in the current note scope");
  });

  it("renders the structured model into a v2 page and completes activity", async () => {
    const setup = harness();
    const preview = await setup.service.preview({ startPath: "Notes/a.md", memberPaths: ["Notes/a.md"], basis: "overview", title: "Climate" });
    expect(preview.items).toEqual([]);
    const result = await setup.service.apply(preview, []);
    expect(result.path).toBe("Topics/Climate.md");
    const page = parseTopicPage(result.markdown);
    expect(page).toMatchObject({ id: preview.topicId, layout: 2 });
    expect(result.markdown).toContain("> [!abstract] Overview");
    expect(result.markdown).toContain("Climate policy reform");
    expect(result.markdown).toContain("## Timeline");
    expect(result.markdown).toContain("## Source notes");
    for (const heading of ["## 概要 / Overview", "## 当前状态 / Current status", "## 分歧与待核实 / Disagreements and verification", "## 未决问题与未完成行动 / Open questions and actions", "## 待整理 / Unsorted"]) {
      expect(result.markdown).not.toContain(heading);
    }
    expect(setup.storePort.created).toHaveLength(1);
    expect(setup.activities.completed).toEqual([["topics:create:topic-1"]]);
    expect(setup.activities.failed).toEqual([]);
    await expect(setup.service.apply(preview, [])).rejects.toThrow("no longer available");
  });

  it("returns create diagnostics and marks a program-generated overview in the preview", async () => {
    const model = JSON.stringify({ status: "active", threads: [{ title: "Progress", summary: "First sentence. Second sentence.", points: [] }], disagreements: [], open: [] });
    const setup = harness({ request: async () => ({ choices: [{ message: { content: model } }] }) });
    const preview = await setup.service.preview({ startPath: "Notes/a.md", memberPaths: ["Notes/a.md"], basis: "overview", title: "Climate" });
    expect(preview.createDiagnostics).toMatchObject({ requests: 2, missingFields: [["overview"], ["overview"]], retried: true, degraded: true });
    expect(preview.create?.overviewGeneratedFromThreads).toBe(true);
    expect(preview.create?.model?.overview).toBe("First sentence.");
    expect(setup.writes).toEqual([]);
  });

  it("keeps the page unchanged and maps empty-thread responses to a localized error", async () => {
    const response = JSON.stringify({ overview: "Present overview.", status: "active", threads: [], disagreements: [], open: [] });
    const setup = harness({ request: async () => ({ choices: [{ message: { content: response } }] }) });
    await expect(setup.service.preview({ startPath: "Notes/a.md", memberPaths: ["Notes/a.md"], basis: "overview" }))
      .rejects.toThrow("The topic page could not be generated");
    expect(setup.requests).toHaveLength(2);
    expect(setup.writes).toEqual([]);
    expect(setup.activities.failed[0]?.[1]).toMatchObject({ message: expect.not.stringContaining("Topic response must contain an overview") });
  });

  it("previews a legacy page rebuild and replaces the page with an undo snapshot", async () => {
    const setup = harness();
    const legacy = topicMarkdown("legacy-topic", "Legacy", ["climate"], ["Notes/a.md"]);
    setup.storePort.seed("Topics/Legacy.md", legacy);
    const preview = await setup.service.previewRebuild("legacy-topic");
    expect(preview.replacement?.path).toBe("Topics/Legacy.md");
    expect(preview.replacement?.markdown).toContain("qnalog_topic_layout: 2");
    for (const heading of ["## 概要 / Overview", "## 当前状态 / Current status", "## 分歧与待核实 / Disagreements and verification", "## 未决问题与未完成行动 / Open questions and actions", "## 待整理 / Unsorted"]) {
      expect(preview.replacement?.markdown).not.toContain(heading);
    }
    expect(setup.writes).toEqual([]);
    const applied = await setup.service.apply(preview, []);
    expect(parseTopicPage(applied.markdown)?.layout).toBe(2);
    expect(setup.storePort.created.some(({ path }) => path.includes("topic-history"))).toBe(true);
    expect(await setup.service.undoLastUpdate("legacy-topic")).toEqual({ restored: true });
    expect(await setup.storePort.read("Topics/Legacy.md")).toBe(legacy);
  });

  it("updates an existing topic and persists selected member and tag changes", async () => {
    const setup = harness();
    const initial = topicMarkdown("climate-topic", "Climate", ["climate"], ["Notes/a.md"]);
    setup.storePort.seed("Topics/Climate.md", initial);
    const preview = await setup.service.preview({ topicId: "climate-topic", startPath: "Notes/b.md", memberPaths: ["Notes/b.md"], basis: "overview" });
    const result = await setup.service.apply(preview, [preview.items[0].id]);
    expect(result.path).toBe("Topics/Climate.md");
    expect(result.markdown).toContain("accepted update");
    expect(result.markdown).toContain("## 待整理 / Unsorted");
    expect(parseTopicPage(result.markdown)?.members).toEqual(["Notes/a.md", "Notes/b.md"]);
    expect(setup.storePort.created.some(({ path }) => path.includes("topic-history"))).toBe(true);
    expect(setup.activities.completed).toEqual([["topics:update:climate-topic"]]);
  });

  it("filters update tags and adds close spellings only to the existing tag aliases", async () => {
    const setup = harness();
    setup.files[1].tags = ["项目/original-material", "项目/QnALogging"];
    const page = createTopicPage({ id: "tag-topic", title: "Tag topic", tags: ["项目/QnALog"], basis: "overview", members: [{ path: "Notes/a.md", title: "a", sourceId: "Notes/a.md" }] });
    page.tagAliases = { "项目/QnALog": ["项目/QnALog"] };
    setup.storePort.seed("Topics/Tag topic.md", serializeTopicPage(page));
    const preview = await setup.service.preview({ topicId: "tag-topic", startPath: "Notes/b.md", memberPaths: ["Notes/b.md"], basis: "overview" });
    expect(preview.tags).toEqual(["项目/QnALog"]);
    expect(preview.tagAliases).toEqual({ "项目/QnALog": ["项目/QnALog", "项目/QnALogging"] });
    expect(preview.tags).not.toContain("项目/original-material");
    expect(preview.tagAliases?.["项目/original-material"]).toBeUndefined();
  });

  it("scans unintegrated notes excluding existing members and explicit exclusions", async () => {
    const setup = harness();
    setup.files.push(noteFile("Notes/c.md", "budget overview", ["climate"]), noteFile("Notes/d.md", "climate project overview", ["climate"]));
    setup.storePort.seed("Topics/Climate.md", topicMarkdown("climate-topic", "Climate", ["climate"], ["Notes/b.md"], ["Notes/d.md"]));
    const scanned = await setup.service.scanUnintegrated("climate-topic");
    const paths = [...scanned.byTag, ...scanned.byContent].map((candidate) => candidate.path);
    expect(paths).toContain("Notes/a.md");
    expect(paths).not.toContain("Notes/b.md");
    expect(paths).not.toContain("Notes/d.md");
    expect(paths).toContain("Notes/c.md");
    await expect(setup.service.scanUnintegrated("missing")).rejects.toThrow("Topic not found");
  });

  it("integrates only notes that are not yet members and does not call the model for an empty update", async () => {
    const setup = harness();
    setup.storePort.seed("Topics/Climate.md", topicMarkdown("climate-topic", "Climate", [], ["Notes/a.md"]));
    const preview = await setup.service.preview({ topicId: "climate-topic", startPath: "Notes/a.md", memberPaths: ["Notes/a.md", "Notes/b.md"], basis: "overview" });
    const payload = JSON.parse(setup.requests[0][1].content) as { members: Array<{ path: string }> };
    expect(payload.members.map((member) => member.path)).toEqual(["Notes/b.md"]);
    expect(preview.memberLinks).toEqual(["[[Notes/a|Notes/a.md]]", "[[Notes/b|b]]"]);
    await expect(setup.service.preview({ topicId: "climate-topic", startPath: "Notes/a.md", memberPaths: ["Notes/a.md"], basis: "overview" }))
      .rejects.toThrow("all selected notes are already topic members");
    expect(setup.requests).toHaveLength(1);
  });
});

function file(path: string) { return { path, basename: path.split("/").pop()!.replace(/\.md$/, ""), mtime: Date.UTC(2026, 0, 2), ctime: Date.UTC(2026, 0, 2) }; }
function noteFile(path: string, overview: string, tags: string[]) { return { ...file(path), overview, tags }; }
function topicMarkdown(id: string, title: string, tags: string[], members: string[] = [], excluded: string[] = []): string {
  const page = createTopicPage({
    id, title, tags, basis: "overview",
    members: members.map((path) => ({ path, title: path, sourceId: path })),
  });
  page.excluded = excluded;
  return serializeTopicPage(page);
}
function topicWithBlock(id: string, text: string): string {
  const members = [{ path: "Notes/a.md", title: "A", sourceId: "Notes/a.md" }];
  const page = createTopicPage({ id, title: "Topic", tags: [], basis: "overview", members });
  page.layout = 2;
  page.body = renderTopicPage({ overview: "Topic overview.", threads: [{ id: "thread", title: "Progress", summary: "Topic detail.", points: [{ id: "point", text, sources: ["Notes/a.md"] }] }], disagreements: [], open: [], unsorted: [] }, members);
  return serializeTopicPage(page);
}
function harness(options: { roots?: string[]; request?: TopicIntegrationPort["request"]; topicErrata?: TopicErrataStore; getFolder?: () => string } = {}) {
  const now = Date.UTC(2026, 0, 2);
  const files = [noteFile("Notes/a.md", "Climate policy reform changes public investment and emissions strategy", ["climate"]), noteFile("Notes/b.md", "Climate policy shifts funding toward clean energy", ["climate"])];
  const writes: Array<{ kind: string; path: string }> = [];
  const readPaths: string[] = [];
  const overviewCards: TopicsServicePort = {
    listNoteFiles: () => files.map(({ path, basename, mtime, ctime }) => ({ path, basename, mtime, ctime })),
    getMtime: (path) => files.find((item) => item.path === path)?.mtime ?? null,
    getFrontmatter: (path) => ({ tags: files.find((item) => item.path === path)?.tags ?? [] }),
    readText: async (path) => {
      readPaths.push(path);
      const item = files.find((entry) => entry.path === path);
      return `---\ntags: [${item?.tags.join(", ") ?? ""}]\n---\n> [!abstract]\n> ${item?.overview ?? ""}\n\nFull body for ${path}`;
    },
    getResolvedLinks: () => ({}), getUnresolvedLinks: () => ({}), now: () => now,
  };
  const contents = new Map<string, string>();
  const storePort: TopicStorePort & { created: Array<{ path: string; content: string }>; seed(path: string, content: string): void } = {
    created: [],
    seed(path, content) { contents.set(path, content); },
    read: async (path) => contents.get(path) ?? "",
    create: async (path, content) => { writes.push({ kind: "create", path }); storePort.created.push({ path, content }); contents.set(path, content); },
    process: async (path, transform) => { writes.push({ kind: "process", path }); contents.set(path, transform(contents.get(path) ?? "")); },
    readCache: async (path) => contents.get(path) ?? null,
    writeCache: async (path, content) => { contents.set(path, content); },
    deleteCache: async (path) => { contents.delete(path); },
    readMemberTags: async (paths) => [...new Set(paths.flatMap((path) => files.find((file) => file.path === path)?.tags || []))],
    listMarkdown: async (folder) => [...contents.keys()].filter((path) => path.startsWith(`${folder}/`) && path.endsWith(".md")).map((path) => ({ path, name: path.split("/").pop()! })),
    ensureFolder: async () => {}, deleteHistory: async (path) => { contents.delete(path); }, trashFile: async (path) => { contents.delete(path); }, now: () => now,
  };
  const requests: Array<Array<{ role: "system" | "user"; content: string }>> = [];
  const integration: TopicIntegrationPort = { request: options.request ?? (async (messages) => {
    requests.push(messages);
    const payload = JSON.parse(messages[1].content) as { members: Array<{ sourceId: string }> };
    const sourceId = payload.members[0]?.sourceId || "";
    if (messages[0].content.startsWith("Create a readable topic page model")) return { choices: [{ message: { content: JSON.stringify({
      overview: "Climate policy reform changes public investment and emissions strategy. The notes describe clean energy funding as the current direction.",
      status: "active", threads: [{ title: "Funding direction", summary: "The notes connect policy changes to public investment.", points: [{ text: "Funding shifts toward clean energy.", sources: [sourceId] }] }],
      disagreements: [], open: [], unsorted: [],
    }) } }] };
    return { choices: [{ message: { content: JSON.stringify({ operations: [
      { type: "add_item", section: "进展脉络", text: "accepted update", sourceId },
      { type: "add_item", section: "进展脉络", text: "unselected update", sourceId },
    ] }) } }] };
  }) };
  if (options.request) {
    const original = integration.request;
    integration.request = async (messages, signal) => { requests.push(messages); return original(messages, signal); };
  }
  const activities = { started: [] as Array<[string, string]>, completed: [] as Array<[string]>, failed: [] as Array<[string, unknown]>, cancelled: [] as Array<[string, string]>, progress: [] as Array<{ progress: number; stageLabel: string }> };
  let ids = 0;
  let folder = "Topics";
  const serviceHost = { overviewCards, topicStore: storePort, ...(options.topicErrata ? { topicErrata: options.topicErrata } : {}), getRoots: () => options.roots ?? ["Notes"], getFolder: options.getFolder ?? (() => folder), integration,
    createId: () => `topic-${++ids}`, startActivity: (id, title) => activities.started.push([id, title]), updateActivity: (_id, patch) => activities.progress.push(patch), completeActivity: (id) => activities.completed.push([id]), failActivity: (id, error) => activities.failed.push([id, error]), cancelActivity: (id, reason) => activities.cancelled.push([id, reason]) };
  const createService = () => new TopicsService(serviceHost);
  const service = createService();
  return { service, createService, files, writes, readPaths, storePort, requests, activities, setFolder: (path: string) => { folder = path; } };
}

function emptyHost(overviewCards: TopicsServicePort) {
  const noopStore: TopicStorePort = {
    read: async () => "", create: async () => {}, process: async () => {}, listMarkdown: async () => [],
    ensureFolder: async () => {}, deleteHistory: async () => {}, readCache: async () => null, writeCache: async () => {}, deleteCache: async () => {}, readMemberTags: async () => [], trashFile: async () => {}, now: () => Date.now(),
  };
  return { overviewCards, topicStore: noopStore, getRoots: () => [], getFolder: () => "Topics",
    integration: { request: async () => ({ operations: [] }) }, createId: () => "unused",
    startActivity: () => {}, completeActivity: () => {}, failActivity: () => {} };
}
