vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\/+/g, "/"),
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSegmentStatusList, getVersionStoreFolder, normalizeVersionId } from "../src/versions/version-identity";
beforeEach(() => vi.stubGlobal("window", {}));
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { hashRealtimeOutlineText } from "../src/notes/outline-text";
import { sanitizeFilename } from "../src/shared/util-common";

describe("version identity helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("builds normalized version cache folders and uses the default folder when unset", () => {
    const safeSourceId = sanitizeFilename("id/a");
    expect(getVersionStoreFolder({ mdFolder: "QnALog//转写纪要" } as never, "id/a"))
      .toBe(`QnALog/转写纪要/.versions/${safeSourceId}`);
    for (const settings of [{ mdFolder: "" }, {}, null]) {
      expect(getVersionStoreFolder(settings as never, "id/a"))
        .toBe(`${DEFAULT_SETTINGS.mdFolder}/.versions/${safeSourceId}`);
    }
    expect(getVersionStoreFolder({ mdFolder: "QnALog/转写纪要" } as never, ""))
      .toBe("QnALog/转写纪要/.versions/unknown-session");
  });

  it("normalizes version IDs with the host clock and falls back to the ISO clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
    (window as Window & { moment?: () => { format: (format: string) => string } }).moment = () => ({
      format: () => "20261009-120000",
    });
    expect(normalizeVersionId("Label/A")).toBe(`20261009-120000-${sanitizeFilename("Label/A")}`);
    expect(normalizeVersionId("")).toBe("20261009-120000-version");

    delete (window as Window & { moment?: () => { format: (format: string) => string } }).moment;
    expect(normalizeVersionId("fallback")).toMatch(/^20261009120000-fallback$/);
  });

  it("builds stable segment status records for empty and completed transcript text", () => {
    expect(buildSegmentStatusList(null)).toEqual([]);
    expect(buildSegmentStatusList(undefined)).toEqual([]);
    const result = buildSegmentStatusList([
      { index: 9, startOffsetMs: 1200, endOffsetMs: 0, text: "   " },
      { index: 8, startOffsetMs: Number.NaN, endOffsetMs: undefined as unknown as number, text: " hello  " },
    ]);
    expect(result).toEqual([
      { id: "seg-0001", index: 0, startOffsetMs: 1200, endOffsetMs: 1200, status: "pending", textHash: "" },
      {
        id: "seg-0002", index: 1, startOffsetMs: 0, endOffsetMs: 0, status: "done",
        textHash: hashRealtimeOutlineText("hello"),
      },
    ]);
  });
});
