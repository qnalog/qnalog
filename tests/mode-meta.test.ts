import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  setIcon: vi.fn(),
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
}));
import * as obsidian from "obsidian";
import {
  getBuiltInVisiblePolishModeKeys,
  getCustomPromptModeTemplate,
  getCustomPromptModeTemplates,
  getEffectivePolishMode,
  getModeMeta,
  getModePrefix,
  getVisibleModeEntries,
  getVisiblePolishModeKeys,
  isCustomPromptModeTemplate,
  isKnownPolishMode,
  makeCustomPromptModeId,
  sanitizePromptTemplate,
  setModePillIcon,
} from "../src/shared/mode-meta";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

let languageBefore: ReturnType<typeof getActiveUiLanguage>;
beforeEach(() => { languageBefore = getActiveUiLanguage(); });
afterEach(() => {
  setActiveUiLanguage(languageBefore);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const A = { id: "custom-a", mode: "custom-a", customMode: true, name: "Alpha" };
const Z = { id: "custom-z", mode: "custom-z", customMode: true, name: "Zulu" };
const customSettings = { promptTemplates: { "custom-z": Z, "custom-a": A } };
const modeKey = (value: unknown) => value as Parameters<typeof getEffectivePolishMode>[0];
const unknownSettings = (value: unknown) => value as Parameters<typeof getCustomPromptModeTemplates>[0];

function language(id: "zh" | "en"): void {
  setActiveUiLanguage(resolveUiLanguage(id, id));
}

describe("mode metadata boundaries", () => {
  it("guards custom templates and honors map keys without rebuilding aliases", () => {
    expect(isCustomPromptModeTemplate(A)).toBe(true);
    for (const invalid of [null, "custom", { ...A, customMode: false }, { ...A, id: "other" }, { ...A, id: 1 }]) {
      expect(isCustomPromptModeTemplate(invalid)).toBe(false);
    }
    expect(getCustomPromptModeTemplate(customSettings, "custom-a")).toBe(A);
    expect(getCustomPromptModeTemplate(customSettings, "missing")).toBeNull();
    expect(getCustomPromptModeTemplates(customSettings)).toEqual([A, Z]);
    expect(getCustomPromptModeTemplates(customSettings)).not.toBe(customSettings.promptTemplates);
    const aliasSettings = { promptTemplates: { alias: A } };
    expect(getCustomPromptModeTemplate(aliasSettings, "custom-a")).toBeNull();
    expect(getCustomPromptModeTemplate(aliasSettings, "alias")).toBe(A);
    expect(getCustomPromptModeTemplates(null)).toEqual([]);
    expect(getCustomPromptModeTemplates(undefined)).toEqual([]);
    expect(getCustomPromptModeTemplates({ promptTemplates: null })).toEqual([]);
    expect(getCustomPromptModeTemplates(unknownSettings({ promptTemplates: "not a map" }))).toEqual([]);
  });

  it("keeps visible mode order, language-specific prefixes, and off visibility", () => {
    expect(getBuiltInVisiblePolishModeKeys(customSettings)).toEqual([
      "synthesis", "meeting", "seminar", "interview", "monologue", "learning",
    ]);
    expect(getVisiblePolishModeKeys(customSettings)).toEqual([
      "synthesis", "meeting", "seminar", "interview", "monologue", "learning", "custom-a", "custom-z",
    ]);
    expect(isKnownPolishMode(customSettings, "huddle")).toBe(true);
    expect(getVisiblePolishModeKeys(customSettings)).not.toContain("huddle");
    language("zh");
    expect(getVisibleModeEntries(customSettings, true)[0]).toEqual(["off", "关闭（仅转写）"]);
    expect(getVisibleModeEntries(customSettings, false)[0]).toEqual(["synthesis", "综合纪要"]);
    expect(getVisibleModeEntries(customSettings, false).slice(-2)).toEqual([["custom-a", "Alpha"], ["custom-z", "Zulu"]]);
    language("en");
    expect(getVisibleModeEntries(customSettings, true)[0]).toEqual(["off", "Off (transcription only)"]);
    expect(getVisibleModeEntries(customSettings, false).slice(-2)).toEqual([["custom-a", "Alpha"], ["custom-z", "Zulu"]]);
  });

  it("preserves requested, configured, fallback, and display-only mode distinctions", () => {
    const settings = { ...customSettings, polishMode: "custom-a" };
    expect(getEffectivePolishMode(settings, "seminar")).toBe("seminar");
    expect(getEffectivePolishMode(settings, "")).toBe("custom-a");
    expect(getEffectivePolishMode(settings, "off")).toBe("off");
    expect(getEffectivePolishMode(settings, "unknown", "off")).toBe("off");
    expect(getEffectivePolishMode(null, undefined)).toBe("meeting");
    expect(getEffectivePolishMode(settings, "cleanscript")).toBe("meeting");
    expect(getEffectivePolishMode(settings, "unknown", "unknown-fallback")).toBe("unknown-fallback");
    expect(getEffectivePolishMode(settings, "unknown", "")).toBe("");
    expect(getModeMeta({}, "meeting")).toBe(getModeMeta({}, "unknown"));
    expect(isKnownPolishMode(customSettings, "cleanscript")).toBe(false);
  });

  it("builds custom metadata and prefixes in the active language", () => {
    language("zh");
    expect(getModeMeta(customSettings, "custom-a")).toMatchObject({ prefix: "Alpha", label: "自定义提示词：Alpha", goal: "用户自定义提示词。", baseMode: "learning" });
    expect(getModePrefix(getModeMeta(customSettings, "custom-a"))).toBe("Alpha");
    expect(getModePrefix(null)).toBe("");
    expect(getModePrefix(undefined)).toBe("");
    expect(getModeMeta({ promptTemplates: { x: { ...A, id: "x", mode: "x", name: "", description: "" } } }, "x"))
      .toMatchObject({ prefix: "自定义提示词", goal: "用户自定义提示词。" });
    language("en");
    expect(getModePrefix(getModeMeta(customSettings, "custom-a"))).toBe("Custom prompt:Alpha");
    expect(getModePrefix({ prefix: "Prefix" })).toBe("Prefix");
  });

  it("creates stable identifiers while preserving the original fallback and conversion errors", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(makeCustomPromptModeId("  A_B 中文!?  ")).toBe("custom-a-b-中文-i");
    expect(makeCustomPromptModeId("***")).toBe("custom-muyrsao0-i");
    expect(makeCustomPromptModeId("a".repeat(30))).toBe(`custom-${"a".repeat(28)}-i`);
    const failure = new Error("conversion failed");
    const badSeed = { toString: () => { throw failure; } };
    let caught: unknown;
    try { makeCustomPromptModeId(badSeed); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
  });

  it("normalizes templates without mutating input or dropping extension properties", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    language("en");
    const extra = { retained: true };
    const input = {
      id: " custom-existing ", mode: "old", name: "  Weekly  ", description: "  goal  ",
      prompt: "  BODY $& $` $' $$  ", baseMode: "unknown", createdAt: "original-created",
      updatedAt: "old-updated", source: "source", extra,
    };
    const original = { ...input };
    const result = sanitizePromptTemplate(input, "seminar") as typeof input & {
      isBuiltin: boolean; customMode: boolean; baseMode: string; updatedAt: string;
    };
    expect(result).toMatchObject({
      id: "custom-existing", mode: "custom-existing", name: "Weekly", description: "goal",
      prompt: "BODY $& $` $' $$", baseMode: "seminar", isBuiltin: false, customMode: true,
      createdAt: "original-created", updatedAt: "2026-10-08T00:00:00.000Z", source: "source",
    });
    expect(result.extra).toBe(extra);
    expect(input).toEqual(original);
    expect(sanitizePromptTemplate({ name: "N".repeat(82), description: "D".repeat(242) }, "seminar"))
      .toMatchObject({ name: "N".repeat(80), description: "D".repeat(240) });
    expect(sanitizePromptTemplate({ baseMode: "meeting" }, "seminar").baseMode).toBe("meeting");
    expect(sanitizePromptTemplate(null, null)).toMatchObject({
      name: "Custom prompt", baseMode: "learning", description: "", prompt: "",
      createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
      id: "custom-scene-i", mode: "custom-scene-i",
    });
    expect(sanitizePromptTemplate({ name: 42, prompt: { toString: () => " BODY " } }, "learning"))
      .toMatchObject({ name: "42", prompt: "BODY" });
    const failure = new Error("template conversion failed");
    expect(() => sanitizePromptTemplate({ name: { toString: () => { throw failure; } } }, "learning"))
      .toThrow(failure);
  });


  it("uses a short label only when icon rendering fails, but propagates element errors", () => {
    const icon = vi.mocked(obsidian.setIcon);
    icon.mockImplementation(() => { throw new Error("icon unavailable"); });
    const named = { empty: vi.fn(), addClass: vi.fn(), setText: vi.fn() } as unknown as HTMLElement;
    setModePillIcon(named, { prefix: "  Named", icon: "puzzle" });
    expect(named.setText).toHaveBeenCalledWith("N");
    const fallback = { empty: vi.fn(), addClass: vi.fn(), setText: vi.fn() } as unknown as HTMLElement;
    setModePillIcon(fallback, { icon: "puzzle" }, { label: "Fallback", icon: "file-text" });
    expect(fallback.setText).toHaveBeenCalledWith("F");
    const empty = { empty: vi.fn(), addClass: vi.fn(), setText: vi.fn() } as unknown as HTMLElement;
    setModePillIcon(empty, { icon: "puzzle" });
    expect(empty.setText).toHaveBeenCalledWith("L");
    const failure = new Error("element failure");
    const broken = { empty: () => { throw failure; }, addClass: vi.fn(), setText: vi.fn() } as unknown as HTMLElement;
    let caught: unknown;
    try { setModePillIcon(broken, { prefix: "Named", icon: "puzzle" }); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
  });
});
