import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (p: string) => p, TFile: class {}, TFolder: class {}, Notice: class {}, Platform: {} }));
import { dropKnownSpeakersFromEntityWarning } from "../src/notes/note-markdown";

const warning = (lines: string[]) => [
  "正文",
  "",
  "> [!warning] 人物指认核对",
  ...lines,
  "> 检测按字面计数，转写错字可能造成误报；确认无误后可删除本块。",
  "",
  "<!-- qnalog-people: 张华 -->",
].join("\n");

describe("person attribution check and known speakers", () => {
  it("removes the whole block when every finding is a known speaker or a numbered label", () => {
    const md = warning([
      "> - 「张华」：正文引用 5 次，原始转写仅出现 0 次——其身份/角色可能是 AI 推断，请核对",
      "> - 「说话人3」：正文引用 12 次，原始转写仅出现 0 次——其身份/角色可能是 AI 推断，请核对",
    ]);
    const out = dropKnownSpeakersFromEntityWarning(md, ["张华", "柳林"]);
    expect(out).not.toContain("人物指认核对");
    expect(out).toContain("正文");
    expect(out).toContain("<!-- qnalog-people: 张华 -->");
  });

  it("keeps other people, without mention brackets", () => {
    const md = warning([
      "> - 「『张华』」：正文引用 5 次，原始转写仅出现 0 次——其身份/角色可能是 AI 推断，请核对",
      "> - 「『王总』」：正文引用 4 次，原始转写仅出现 1 次——其身份/角色可能是 AI 推断，请核对",
    ]);
    const out = dropKnownSpeakersFromEntityWarning(md, ["张华"]);
    expect(out).toContain("> [!warning] 人物指认核对");
    expect(out).toContain("> - 「王总」：正文引用 4 次");
    expect(out).not.toContain("张华」：");
    expect(out).not.toContain("『");
    expect(out).toContain("> 检测按字面计数");
  });

  it("leaves notes without the block unchanged", () => {
    expect(dropKnownSpeakersFromEntityWarning("正文\n\n> [!note] 其他", ["张华"])).toBe("正文\n\n> [!note] 其他");
  });
});
