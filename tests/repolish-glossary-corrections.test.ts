import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class TAbstractFile { path: string; constructor(path: string) { this.path = path; } }
  class TFile extends TAbstractFile {}
  return {
    TAbstractFile,
    TFile,
    Notice: class Notice {},
    Modal: class Modal {},
    normalizePath: (value: string) => String(value || "").replace(/\\/g, "/"),
    requestUrl: vi.fn(),
  };
});

import * as obsidian from "obsidian";
import { withGlossaryCorrections } from "../src/errata/errata-apply";
import { RepolishService } from "../src/notes/repolish-service";

describe("glossary corrections during reorganize", () => {
  it("adds glossary corrections to note errata, with the note's own rule winning for the same term", () => {
    const merged = withGlossaryCorrections(
      { replacements: [{ from: "余涵", to: "余晗" }], noise: ["背景广播内容很长"], prompt: "## 勘误表" },
      [{ from: "余涵", to: "于涵" }, { from: "齐静", to: "祁婧" }],
    );
    expect(merged).toEqual({
      replacements: [{ from: "齐静", to: "祁婧" }, { from: "余涵", to: "余晗" }],
      noise: ["背景广播内容很长"],
      prompt: "## 勘误表",
    });
  });

  it("uses glossary corrections when the note has no errata, and leaves rules unchanged without a glossary", () => {
    expect(withGlossaryCorrections(null, [{ from: "余涵", to: "于涵" }])).toEqual({ replacements: [{ from: "余涵", to: "于涵" }], noise: [] });
    expect(withGlossaryCorrections(null, [])).toBeNull();
  });

  it("loads the vault glossary corrections for every reorganize path", async () => {
    const host = {
      app: { vault: { getAbstractFileByPath: () => null } },
      settings: { vocabularyFile: "", customVocabulary: "## 易错写法\n- 余涵 => 于涵\n- 齐静 => 祁婧" },
      errata: { loadForFile: vi.fn(async () => null) },
    };
    const service = new RepolishService(host as never, {} as never, (async () => undefined) as never);
    const file = new obsidian.TFile("QnALog/转写纪要/2026-10-29 1002 余涵.md");
    const ports = service as unknown as Record<string, () => { loadErrata(file: obsidian.TFile): Promise<unknown> }>;
    for (const name of ["repolishPort", "reorganizeInPlacePort", "cleanScriptPort"]) {
      expect(await ports[name]().loadErrata(file)).toEqual({
        replacements: [{ from: "余涵", to: "于涵" }, { from: "齐静", to: "祁婧" }],
        noise: [],
      });
    }
  });
});
