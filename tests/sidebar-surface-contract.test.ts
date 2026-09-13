import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("sidebar surface contract", () => {
  it("uses one theme-derived surface for the sidebar, sticky chrome, and top mask", () => {
    expect(styles).toMatch(/\.lexvoice-outline\s*\{[^}]*--lex-sidebar-surface:\s*var\(--background-secondary\)/s);
    expect(styles).toMatch(/\.lexvoice-outline\.is-idle-view\s*\{[^}]*background:\s*var\(--lex-sidebar-surface\)/s);
    expect(styles).toMatch(/\.lexvoice-outline-sticky-chrome\s*\{[^}]*background:\s*var\(--lex-sidebar-surface\)/s);
    expect(styles).toMatch(/\.lexvoice-outline-sticky-chrome::before\s*\{[^}]*background:\s*var\(--lex-sidebar-surface\)/s);
  });
});
