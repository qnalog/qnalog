import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  TFile: class {},
  TFolder: class {},
}));
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeModeFromLabel } from "../src/shared/mode-label";

let languageBefore: ReturnType<typeof getActiveUiLanguage>;
beforeEach(() => { languageBefore = getActiveUiLanguage(); });
afterEach(() => { setActiveUiLanguage(languageBefore); });

const customTemplates = {
  "custom-a": { id: "custom-a", mode: "custom-a", customMode: true, name: "Alpha", prompt: "fixture" },
  "custom-long": { id: "custom-long", mode: "custom-long", customMode: true, name: "Alpha Extended", prompt: "fixture" },
  "custom-special": { id: "custom-special", mode: "custom-special", customMode: true, name: "A.+(B)", prompt: "fixture" },
};
const settings = { ...DEFAULT_SETTINGS, promptTemplates: customTemplates };

function language(id: "zh" | "en"): void {
  setActiveUiLanguage(resolveUiLanguage(id, id));
}

describe("mode label normalization", () => {
  it.each([null, undefined, false, 0, "   ", 42])("returns an empty label for %s", (label) => {
    expect(normalizeModeFromLabel(settings, label)).toBe("");
  });

  it.each(["zh", "en"] as const)("recognizes built-in labels and one namespace prefix in %s", (id) => {
    language(id);
    expect(normalizeModeFromLabel(settings, " meeting ")).toBe("meeting");
    expect(normalizeModeFromLabel(settings, "off")).toBe("off");
    expect(normalizeModeFromLabel(settings, "cleanscript")).toBe("");
    expect(normalizeModeFromLabel(settings, "会议")).toBe("meeting");
    expect(normalizeModeFromLabel(settings, "Work notes")).toBe("meeting");
    expect(normalizeModeFromLabel(settings, "QnALog/ Work notes")).toBe("meeting");
    expect(normalizeModeFromLabel(settings, "qnalog/qnalog/meeting")).toBe("");
    expect(normalizeModeFromLabel(settings, "work notes")).toBe("");
  });

  it("recognizes custom ids and names from visible templates without rebuilding alias maps", () => {
    expect(normalizeModeFromLabel(settings, "custom-a")).toBe("custom-a");
    expect(normalizeModeFromLabel(settings, "Alpha")).toBe("custom-a");
    expect(normalizeModeFromLabel(settings, "A.+(B)")).toBe("custom-special");
    const aliasOnly = { ...settings, promptTemplates: { alias: { ...customTemplates["custom-a"], id: "alias", mode: "alias" } } };
    expect(normalizeModeFromLabel(aliasOnly, "custom-a")).toBe("");
    expect(normalizeModeFromLabel(aliasOnly, "Alpha")).toBe("alias");
  });

  it("preserves ordinary-object inherited prefix lookup behavior", () => {
    expect(normalizeModeFromLabel(settings, "constructor")).toBe("constructor");
    expect(normalizeModeFromLabel(settings, "qnalog/__proto__")).toBe("__proto__");
  });

  it("uses String conversion and propagates conversion failures unchanged", () => {
    expect(normalizeModeFromLabel(settings, { toString: () => " Work notes " })).toBe("meeting");
    const failure = new Error("label conversion failed");
    let caught: unknown;
    try { normalizeModeFromLabel(settings, { toString: () => { throw failure; } }); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
  });
});
