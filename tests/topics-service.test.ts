import { describe, expect, it } from "vitest";
import { TopicsService, type TopicsServicePort } from "../src/topics/topics-service";

describe("topics service", () => {
  it("only reads through its port when requested and returns statistics", async () => {
    let reads = 0;
    const now = Date.now();
    const port: TopicsServicePort = { listNoteFiles: () => [{ path: "QnALog/one.md", basename: "one", mtime: now, ctime: now }],
      getMtime: (path) => path.endsWith("one.md") ? now : null, getFrontmatter: () => ({}),
      readText: async () => { reads++; return "> [!abstract]\n> A useful overview about shared climate policy"; },
      getResolvedLinks: () => ({}), getUnresolvedLinks: () => ({}), now: () => now };
    const service = new TopicsService({ overviewCards: port, getRoots: () => ["QnALog"] });
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
      readText: async (path) => {
        readPaths.push(path);
        return `> [!abstract]\n> Shared planning notes for ${path.includes("Elsewhere") ? "external" : "topic"} work`;
      },
      getResolvedLinks: () => ({ "First/a.md": { "Elsewhere/x.md": 1 } }),
      getUnresolvedLinks: () => ({}), now: () => now,
    };
    const service = new TopicsService({ overviewCards: port, getRoots: () => { rootReads++; return [root]; } });
    expect(rootReads).toBe(0);
    const first = await service.getSuggestions({ windowDays: 3650 });
    expect(first.stats.windowedCount).toBe(2);
    expect(readPaths).toEqual(["First/a.md", "First/b.md"]);
    expect(first.suggestions.flatMap((suggestion) => suggestion.memberPaths)).not.toContain("Elsewhere/x.md");
    root = "Second";
    const second = await service.getSuggestions({ windowDays: 3650 });
    expect(second.stats.windowedCount).toBe(2);
    expect(readPaths.slice(2)).toEqual(["Second/c.md", "Second/d.md"]);
    expect(rootReads).toBe(2);
  });
});
