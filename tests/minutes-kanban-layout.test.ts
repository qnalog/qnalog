import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("minutes kanban layout", () => {
  it("lets ordinary desktop columns share the available board width", () => {
    expect(styles).toMatch(/\.qnalog-kanban-view\s*\{[^}]*--qnalog-kanban-column-min-width:\s*196px/s);
    expect(styles).toMatch(/\.qnalog-kanban-board\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%/s);
    expect(styles).toMatch(/\.qnalog-kanban-column\s*\{[^}]*flex:\s*1 1 var\(--qnalog-kanban-column-width\)[^}]*min-width:\s*var\(--qnalog-kanban-column-min-width\)[^}]*max-width:\s*none/s);
  });

  it("keeps the mobile board as one readable horizontal lane", () => {
    expect(styles).toMatch(/@media \(max-width:\s*600px\)\s*\{[\s\S]*?--qnalog-kanban-column-min-width:\s*min\(82vw,\s*300px\)/);
  });
});
