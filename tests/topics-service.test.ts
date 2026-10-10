import { describe, expect, it } from "vitest";
import { TopicsService, type TopicsServicePort } from "../src/topics/topics-service";
import type { TopicStorePort } from "../src/topics/topic-store";
import type { TopicIntegrationPort } from "../src/topics/topic-integration";
import { createTopicPage, parseTopicPage, serializeTopicPage } from "../src/topics/topic-page";

describe("topics service", () => {
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
    await expect(setup.service.preview({ topicId: "climate-topic", startPath: "Notes/b.md", memberPaths: ["Notes/b.md"], basis: "overview" })).rejects.toThrow("before any batch completed");
    expect(await setup.storePort.read("Topics/Climate.md")).toBe(initial);
    expect(setup.writes).toEqual([]);
    expect(setup.activities.failed).toHaveLength(1);
  });

  it("refreshes the arrived note's metadata before matching without requesting model integration", async () => {
    const setup = harness();
    setup.storePort.seed("Topics/Climate.md", topicMarkdown("climate-topic", "Climate", ["qnalog"]));
    await setup.service.getCandidates("Notes/a.md");
    const mtime = setup.files[0].mtime;
    setup.files[0].tags.push("qnalog");
    const prompts = await setup.service.noteArrived("Notes/a.md");
    expect(setup.files[0].mtime).toBe(mtime);
    expect(prompts).toContainEqual({ topicId: "climate-topic", title: "Climate", matchedTags: ["qnalog"], path: "Notes/a.md" });
    expect(setup.requests).toHaveLength(0);
    expect(setup.writes).toEqual([]);
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

  it("applies only the selected operations to a newly created topic and completes activity", async () => {
    const setup = harness();
    const preview = await setup.service.preview({ startPath: "Notes/a.md", memberPaths: ["Notes/a.md"], basis: "overview", title: "Climate" });
    const selected = preview.items[0];
    expect(selected).toBeDefined();
    const result = await setup.service.apply(preview, [selected.id]);
    expect(result.path).toBe("Topics/Climate.md");
    const page = parseTopicPage(result.markdown);
    expect(page?.id).toBe(preview.topicId);
    expect(result.markdown).toContain("accepted update");
    expect(result.markdown).not.toContain("unselected update");
    expect(setup.storePort.created).toHaveLength(1);
    expect(setup.activities.completed).toEqual([["topics:create:topic-1"]]);
    expect(setup.activities.failed).toEqual([]);
    await expect(setup.service.apply(preview, [])).rejects.toThrow("no longer available");
  });

  it("updates an existing topic and persists selected member and tag changes", async () => {
    const setup = harness();
    const initial = topicMarkdown("climate-topic", "Climate", ["climate"], ["Notes/a.md"]);
    setup.storePort.seed("Topics/Climate.md", initial);
    const preview = await setup.service.preview({ topicId: "climate-topic", startPath: "Notes/b.md", memberPaths: ["Notes/b.md"], basis: "overview" });
    const result = await setup.service.apply(preview, [preview.items[0].id]);
    expect(result.path).toBe("Topics/Climate.md");
    expect(result.markdown).toContain("accepted update");
    expect(parseTopicPage(result.markdown)?.members).toEqual(["Notes/a.md", "Notes/b.md"]);
    expect(setup.storePort.created.some(({ path }) => path.includes("topic-history"))).toBe(true);
    expect(setup.activities.completed).toEqual([["topics:update:climate-topic"]]);
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
function harness(options: { roots?: string[]; request?: TopicIntegrationPort["request"] } = {}) {
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
    listMarkdown: async (folder) => [...contents.keys()].filter((path) => path.startsWith(`${folder}/`) && path.endsWith(".md")).map((path) => ({ path, name: path.split("/").pop()! })),
    ensureFolder: async () => {}, deleteHistory: async (path) => { contents.delete(path); }, trashFile: async (path) => { contents.delete(path); }, now: () => now,
  };
  const requests: Array<Array<{ role: "system" | "user"; content: string }>> = [];
  const integration: TopicIntegrationPort = { request: options.request ?? (async (messages) => {
    requests.push(messages);
    const payload = JSON.parse(messages[1].content) as { members: Array<{ sourceId: string }> };
    const sourceId = payload.members[0]?.sourceId || "";
    return { choices: [{ message: { content: JSON.stringify({ operations: [
      { type: "add_item", section: "当前状态", text: "accepted update", sourceId },
      { type: "add_item", section: "当前状态", text: "unselected update", sourceId },
    ] }) } }] };
  }) };
  if (options.request) {
    const original = integration.request;
    integration.request = async (messages, signal) => { requests.push(messages); return original(messages, signal); };
  }
  const activities = { started: [] as Array<[string, string]>, completed: [] as Array<[string]>, failed: [] as Array<[string, unknown]>, cancelled: [] as Array<[string, string]> };
  let ids = 0;
  const service = new TopicsService({ overviewCards, topicStore: storePort, getRoots: () => options.roots ?? ["Notes"], getFolder: () => "Topics", integration,
    createId: () => `topic-${++ids}`, startActivity: (id, title) => activities.started.push([id, title]), completeActivity: (id) => activities.completed.push([id]), failActivity: (id, error) => activities.failed.push([id, error]), cancelActivity: (id, reason) => activities.cancelled.push([id, reason]) });
  return { service, files, writes, readPaths, storePort, requests, activities };
}

function emptyHost(overviewCards: TopicsServicePort) {
  const noopStore: TopicStorePort = {
    read: async () => "", create: async () => {}, process: async () => {}, listMarkdown: async () => [],
    ensureFolder: async () => {}, deleteHistory: async () => {}, trashFile: async () => {}, now: () => Date.now(),
  };
  return { overviewCards, topicStore: noopStore, getRoots: () => [], getFolder: () => "Topics",
    integration: { request: async () => ({ operations: [] }) }, createId: () => "unused",
    startActivity: () => {}, completeActivity: () => {}, failActivity: () => {} };
}
