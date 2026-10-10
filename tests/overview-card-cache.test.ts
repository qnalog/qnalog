import { describe, expect, it } from "vitest";
import { OverviewCardCache, type OverviewCardCachePort } from "../src/topics/overview-card-cache";

function port(): OverviewCardCachePort & { reads: string[]; files: Array<{ path: string; basename: string; mtime: number }> } {
  const reads: string[] = [];
  const files = [{ path: "QnALog/a.md", basename: "a", mtime: Date.now() - 10 * 86400000 }];
  return { reads, files, listNoteFiles: () => files,
    getMtime: (path) => files.find((file) => file.path === path)?.mtime ?? null,
    getFrontmatter: () => ({ qnalog_time: "2001-01-01" }),
    readText: async (path) => { reads.push(path); return "> [!abstract]\n> overview"; },
    getResolvedLinks: () => ({}), getUnresolvedLinks: () => ({}), now: () => Date.now() };
}
describe("overview card cache", () => {
  it("reads changed files once, then reports zero reads; deletes removed entries", async () => {
    const p = port(); const cache = new OverviewCardCache(p, ["QnALog"]);
    const first = await cache.refresh({ windowDays: 3650 }); expect(first.readCount).toBe(1);
    expect((await cache.refresh({ windowDays: 3650 })).readCount).toBe(0);
    p.files[0].mtime++; expect((await cache.refresh({ windowDays: 3650 })).updated).toBe(1);
    p.files.splice(0); expect((await cache.refresh()).removed).toBe(1);
  });
  it("does not read files outside a requested window", async () => {
    const p = port(); const cache = new OverviewCardCache(p, ["QnALog"]);
    expect((await cache.refresh({ windowDays: 1 })).readCount).toBe(0);
    expect(p.reads).toEqual([]);
  });
  it("does not load topic pages into the source-note overview cache", async () => {
    const p = port();
    p.files.push({ path: "QnALog/Topics/topic.md", basename: "topic", mtime: Date.now() });
    p.getFrontmatter = (path) => path.endsWith("topic.md") ? { qnalog_type: "qnalog-topic" } : { qnalog_time: "2001-01-01" };
    const cache = new OverviewCardCache(p, ["QnALog"]);
    await cache.refresh({ windowDays: 3650 });
    expect(p.reads).toEqual(["QnALog/a.md"]);
    expect(cache.getCards({ windowDays: 3650 }).map((card) => card.path)).toEqual(["QnALog/a.md"]);
  });
});
