import { describe, expect, it } from "vitest";

import {
  isCanonicalImportSource,
  shouldRewriteConsolidatedNote,
} from "../src/briefing/note-layout-policy";

describe("briefing note layout policy", () => {
  it("uses the canonical briefing-first layout by default", () => {
    expect(shouldRewriteConsolidatedNote({}, {})).toBe(true);
    expect(shouldRewriteConsolidatedNote({ consolidatedLayout: true }, {})).toBe(true);
  });

  it("keeps the legacy append layout only for ordinary recordings that explicitly request it", () => {
    expect(shouldRewriteConsolidatedNote({ consolidatedLayout: false }, {})).toBe(false);
    expect(shouldRewriteConsolidatedNote({ consolidatedLayout: false }, { source: "recording" })).toBe(false);
  });

  it.each(["import", "text-import", "merged-notes"])(
    "always rebuilds %s sessions so the briefing stays above raw material",
    (source) => {
      expect(isCanonicalImportSource(source)).toBe(true);
      expect(shouldRewriteConsolidatedNote({ consolidatedLayout: false }, { source })).toBe(true);
    },
  );
});
