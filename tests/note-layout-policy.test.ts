import { describe, expect, it } from "vitest";

import { isTextImportSession } from "../src/briefing/note-layout-policy";

describe("briefing note layout policy", () => {
  it.each([
    null,
    undefined,
    {},
    { source: 1 },
    { source: "recording" },
    { source: "import" },
    { source: "merged-notes" },
    { source: " text-import " },
  ])("requires an exact text-import source: %o", (session) => {
    expect(isTextImportSession(session)).toBe(false);
  });

  it("accepts only the exact text-import source", () => {
    expect(isTextImportSession({ source: "text-import" })).toBe(true);
  });
});
