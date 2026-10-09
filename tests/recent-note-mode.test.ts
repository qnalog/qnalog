import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  TFile: class {},
  TFolder: class {},
}));
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { detectRecentNoteMode } from "../src/recent/recent-notes";
import {
  detectRecentModeFromFilename,
  getRecentModePrefixEntries,
  stripRecentDatePrefix,
} from "../src/recent/recent-note-mode";

let languageBefore: ReturnType<typeof getActiveUiLanguage>;
beforeEach(() => { languageBefore = getActiveUiLanguage(); });
afterEach(() => {
  setActiveUiLanguage(languageBefore);
  vi.restoreAllMocks();
});

const customTemplates = {
  "custom-a": { id: "custom-a", mode: "custom-a", customMode: true, name: "Alpha", prompt: "fixture" },
  "custom-long": { id: "custom-long", mode: "custom-long", customMode: true, name: "Alpha Extended", prompt: "fixture" },
  "custom-special": { id: "custom-special", mode: "custom-special", customMode: true, name: "A.+(B)", prompt: "fixture" },
};
const settings = { ...DEFAULT_SETTINGS, promptTemplates: customTemplates };
function language(id: "zh" | "en"): void {
  setActiveUiLanguage(resolveUiLanguage(id, id));
}

describe("recent filename mode helpers", () => {
  it("strips only the supported date and compact time prefix", () => {
    expect(stripRecentDatePrefix("2026-10-09 0930 · Work notes - Topic")).toBe("Work notes - Topic");
    expect(stripRecentDatePrefix("2026-10-09 · Topic")).toBe("Topic");
    expect(stripRecentDatePrefix("2026-10-09 09:30 · Work notes - Topic")).toBe("09:30 · Work notes - Topic");
    expect(stripRecentDatePrefix(null)).toBe("");
    expect(stripRecentDatePrefix(0)).toBe("");
    expect(stripRecentDatePrefix({ toString: () => "2026-10-09 0930 · Work notes - Topic" })).toBe("Work notes - Topic");
    const failure = new Error("basename conversion failed");
    expect(() => stripRecentDatePrefix({ toString: () => { throw failure; } })).toThrow(failure);
  });

  it("keeps prefix ordering, duplicate labels, and off entries", () => {
    const entries = getRecentModePrefixEntries(settings);
    expect(entries.findIndex(([, mode]) => mode === "custom-long")).toBeLessThan(entries.findIndex(([, mode]) => mode === "custom-a"));
    expect(entries.filter(([prefix, mode]) => prefix === "综合纪要" && mode === "synthesis")).toHaveLength(2);
    expect(entries).toContainEqual(["Recording", "off"]);
  });

  it.each(["zh", "en"] as const)("detects supported filename labels and keeps inline precedence in %s", (id) => {
    language(id);
    expect(detectRecentModeFromFilename(settings, "2026-10-09 0930 · Work notes - Topic")).toBe("meeting");
    expect(detectRecentModeFromFilename(settings, "2026-10-09 09:30 · Work notes - Topic")).toBe("off");
    expect(detectRecentModeFromFilename(settings, "Work notesExtra")).toBe("off");
    expect(detectRecentModeFromFilename(settings, "Alpha Extended - Topic")).toBe("custom-long");
    expect(detectRecentModeFromFilename(settings, "A.+(B) - Topic")).toBe("custom-special");
    expect(detectRecentModeFromFilename(settings, "AzzzB - Topic")).toBe("off");
    expect(detectRecentModeFromFilename(settings, "Alpha · 学习记录 - Topic")).toBe("learning");
    expect(detectRecentModeFromFilename(settings, "Learning notes - Topic")).toBe("off");
    expect(detectRecentModeFromFilename(settings, "Study notes - Topic")).toBe("learning");
    expect(detectRecentModeFromFilename(settings, null)).toBe("off");
    expect(detectRecentModeFromFilename(settings, 0)).toBe("off");
    expect(detectRecentModeFromFilename(settings, "unknown")).toBe("off");
  });

  it("propagates settings and basename getter failures", () => {
    const failure = new Error("settings getter failed");
    const brokenSettings = Object.defineProperty({}, "promptTemplates", { get: () => { throw failure; } });
    expect(() => getRecentModePrefixEntries(brokenSettings)).toThrow(failure);
    const conversionFailure = new Error("basename getter failed");
    expect(() => detectRecentModeFromFilename(settings, { toString: () => { throw conversionFailure; } })).toThrow(conversionFailure);
  });

  it("keeps frontmatter preference and filename fallback through the recent-note entry point", () => {
    expect(detectRecentNoteMode({ settings }, { basename: "Study notes - Topic" }, { qnalog_mode: "meeting" })).toBe("meeting");
    expect(detectRecentNoteMode({ settings }, { basename: "Study notes - Topic" }, { qnalog_mode: "off" })).toBe("learning");
    expect(detectRecentNoteMode({ settings }, { basename: "Alpha Extended - Topic" }, {})).toBe("custom-long");
  });
});
