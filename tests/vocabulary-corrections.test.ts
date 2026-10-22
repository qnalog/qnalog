import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class TFile {},
  TFolder: class TFolder {},
  Notice: class Notice {},
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
}));

import { applyVocabularyCorrections } from "../src/vocabulary";

describe("vocabulary corrections literal replacement", () => {
  it("writes correction targets containing $ patterns into the transcript byte-for-byte", () => {
    const groups = { corrections: ["错词 => 更正 $& $` $' $$ $1"] };
    expect(applyVocabularyCorrections("第一句 错词 结束", groups)).toBe("第一句 更正 $& $` $' $$ $1 结束");
  });
});

describe("vocabulary corrections use the same rules as note errata", () => {
  it("does not replace inside English words", () => {
    expect(applyVocabularyCorrections("she said AI is fine", { corrections: ["ai => AI"] })).toBe("she said AI is fine");
    expect(applyVocabularyCorrections("Gotama said Gota", { corrections: ["Gota => GOAT"] })).toBe("Gotama said GOAT");
  });

  it("applies each rule once instead of re-replacing earlier results", () => {
    expect(applyVocabularyCorrections("Juice FS 和 FS", { corrections: ["Juice FS => JuiceFS", "FS => 文件系统"] })).toBe("JuiceFS 和 文件系统");
  });

  it("prefers the longest source term at the same position and keeps Chinese replacements", () => {
    expect(applyVocabularyCorrections("充塞 FS 很快，充塞也行", { corrections: ["充塞 => 冲塞", "充塞 FS => JuiceFS"] })).toBe("JuiceFS 很快，冲塞也行");
  });

  it("matches the errata engine on plain transcript text", async () => {
    const { applyReplacements } = await import("../src/errata/errata-apply");
    const text = "Juice FS 和 FS，she said Gota";
    const rules = ["Juice FS => JuiceFS", "FS => 文件系统", "Gota => GOAT"];
    const pairs = rules.map((rule) => { const [from, to] = rule.split(" => "); return { from, to }; });
    expect(applyVocabularyCorrections(text, { corrections: rules })).toBe(applyReplacements(text, pairs));
  });
});
