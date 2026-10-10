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
    const service = new TopicsService({ overviewCards: port }, ["QnALog"]);
    expect(reads).toBe(0);
    const result = await service.getSuggestions();
    expect(result.stats.windowedCount).toBe(1); expect(result.stats.readCount).toBe(1); expect(reads).toBe(1);
    const refreshed = await service.getSuggestions();
    expect(refreshed.stats.readCount).toBe(0); expect(reads).toBe(1);
  });
});
