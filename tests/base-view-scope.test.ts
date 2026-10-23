import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
  TFile: class {},
  Notice: class {},
}));
import { isQnalogBasePath } from "../src/views/library-view-service";

const settings = { basesFolder: "QnALog/资料库/视图", peopleBaseFile: "QnALog/资料库/视图/人员库.base" };

describe("Bases card styling scope", () => {
  it("matches the people base and .base files under the QnALog views folder", () => {
    expect(isQnalogBasePath("QnALog/资料库/视图/人员库.base", settings)).toBe(true);
    expect(isQnalogBasePath("QnALog/资料库/视图/场景/全部纪要总览.base", settings)).toBe(true);
    expect(isQnalogBasePath("QnALog/资料库/人员/张三.base", { ...settings, peopleBaseFile: "QnALog/资料库/人员/张三.base" })).toBe(true);
  });

  it("leaves the user's own Bases and non-base files alone", () => {
    expect(isQnalogBasePath("Projects/读书.base", settings)).toBe(false);
    expect(isQnalogBasePath("QnALog/资料库/视图-备份/x.base", settings)).toBe(false);
    expect(isQnalogBasePath("QnALog/资料库/视图/说明.md", settings)).toBe(false);
    expect(isQnalogBasePath("", settings)).toBe(false);
  });

  it("styles.css never styles Obsidian Bases views outside .qnalog-base-view", () => {
    const css = readFileSync("styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const unscoped: string[] = [];
    for (const rule of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const selector of rule[1].split(",").map((part) => part.trim())) {
        if (selector.includes(".bases-") && !selector.includes(".qnalog-base-view")) unscoped.push(selector);
      }
    }
    expect(unscoped).toEqual([]);
  });
});
