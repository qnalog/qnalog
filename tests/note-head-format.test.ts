import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
  // 与真实实现一致：返回的 YAML 以单个换行结尾（既有人员卡的闭合 --- 独立成行可证）。
  stringifyYaml: (obj: Record<string, unknown>) =>
    Object.entries(obj || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? "" : String(v)}`).join("\n") + "\n",
  parseYaml: () => ({}),
}));
import { mergeLeadingFrontmatterIntoDocument } from "../src/notes/note-markdown";
import { upsertFrontmatterInMarkdown } from "../src/shared/util-note";
import { applyVersionTitle, splitLeadingFrontmatter } from "../src/version-content";

// 新格式约定：frontmatter 闭合 --- 与正文首行（通常是 H1）之间只留一个换行，属性面板
// 下方不再出现空行。1.0.0 起各写入点用空串 spacer / "\n\n" 多写了一个空行（b822319 起，
// 全部既有笔记字节同构），维护者决定新笔记去掉；既有笔记不迁移——所以本组测试同时锁住
// 旧格式（---\n\n#）仍能被解析，改写路径收敛为新格式时也不破坏结构。
describe("笔记头部：frontmatter 与正文单换行紧贴", () => {
  it("mergeLeadingFrontmatterIntoDocument：新 fm 覆盖后不留空行", () => {
    const doc = "---\nmode: monologue\ntime: 2026-09-24T10:01:38\n---\n\n# 旧标题\n\n正文段落";
    const gen = "---\nmode: monologue\ntime: 2026-09-24T10:01:38\n状态: 已整理\n---\n\n# 新标题\n\n新正文";
    const r = mergeLeadingFrontmatterIntoDocument(doc, gen);
    expect(r.content).toContain("---\n# 旧标题");
    expect(r.content).not.toContain("---\n\n# 旧标题");
  });

  it("upsertFrontmatterInMarkdown：无 fm 的正文加头后不留空行", () => {
    const out = upsertFrontmatterInMarkdown("# 标题\n\n正文", { mode: "monologue" });
    expect(out).toContain("---\n# 标题");
    expect(out).not.toContain("---\n\n# 标题");
  });

  it("upsertFrontmatterInMarkdown：已有 fm 替换后不留空行", () => {
    const out = upsertFrontmatterInMarkdown("---\nmode: old\n---\n\n# 旧标题\n\n正文", { mode: "new" });
    expect(out).toContain("mode: new");
    expect(out).toContain("---\n# 旧标题");
    expect(out).not.toContain("---\n\n# 旧标题");
  });

  it("applyVersionTitle：改写标题后头部单换行（旧格式顺带收敛）", () => {
    const out = applyVersionTitle("---\nmode: x\n---\n\n# 2026-01-02 03:04 · 旧后缀\n\n正文", "个人笔记");
    expect(out).toContain("---\n# 2026-01-02 03:04 · 个人笔记");
    expect(out).not.toContain("---\n\n# 2026");
  });

  it("applyVersionTitle：无标题时插入的新标题也紧贴", () => {
    const out = applyVersionTitle("---\nmode: x\n---\n\n正文没有标题", "个人笔记", "2026-01-02 03:05");
    expect(out).toContain("---\n# 2026-01-02 03:05 · 个人笔记");
    expect(out).not.toContain("---\n\n# 2026");
  });

  it("splitLeadingFrontmatter：新旧两种头部都解析（兼容守卫）", () => {
    const fresh = splitLeadingFrontmatter("---\nmode: x\n---\n# T");
    expect(fresh.frontmatter).toBe("---\nmode: x\n---\n");
    expect(fresh.body).toBe("# T");
    const legacy = splitLeadingFrontmatter("---\nmode: x\n---\n\n# T");
    expect(legacy.frontmatter).toBe("---\nmode: x\n---\n");
    expect(legacy.body).toBe("# T");
  });
});
