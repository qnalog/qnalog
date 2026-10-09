import { vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class {}, TFolder: class {},
}));
import { describe, expect, it } from "vitest";
import {
  mergeUniqueStrings,
  normalizePersonLookupText,
  normalizePeopleArray,
  parsePeopleFromOutput,
  splitPersonFieldValue,
} from "../src/people/person-text";

describe("person text contracts", () => {
  it("flattens arrays and object values while preserving a whole wikilink", () => {
    expect(splitPersonFieldValue(["甲，乙", { first: "[[丙 丁]]", second: ["戊;己"] }]))
      .toEqual(["甲", "乙", "[[丙 丁]]", "戊", "己"]);
    expect(splitPersonFieldValue("甲、乙|丙；丁;戊")) .toEqual(["甲", "乙", "丙", "丁", "戊"]);
  });

  it("normalizes lookup text and merges unique trimmed spellings", () => {
    expect(normalizePersonLookupText(" [[张 三]] #人物/甲 ")).toBe("张三");
    expect(normalizePeopleArray(["'张三'", "\"李四\""])).toEqual(["张三", "李四"]);
    expect(mergeUniqueStrings([" 张三 ", "李四"], ["[[张三]]", "王五", " "]))
      .toEqual(["张三", "李四", "王五"]);
  });

  it("extracts and removes the people comment with normalized trailing newline", () => {
    expect(parsePeopleFromOutput(`正文\n<!-- qnalog-people: #人物/张三, 张三, 李四, 发言人1, ${"超".repeat(25)} -->\n\n`))
      .toEqual({ people: ["张三", "李四", "发言人1"], cleaned: "正文\n" });
    expect(parsePeopleFromOutput("没有机器块")).toEqual({ people: [], cleaned: "没有机器块" });
    expect(parsePeopleFromOutput("")).toEqual({ people: [], cleaned: "" });
  });
});
