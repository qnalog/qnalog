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
