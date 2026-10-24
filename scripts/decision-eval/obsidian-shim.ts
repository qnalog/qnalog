/**
 * Stand-in for the `obsidian` module when the organizing pipeline runs in Node (decision evaluation
 * runner). Extends the accuracy baseline shim with what the note and briefing modules reference at
 * load time. Nothing here ships in the plugin bundle.
 */
export { requestUrl, normalizePath, TFile, Notice, Platform } from "../accuracy-baseline/obsidian-shim";

export class TFolder {}
export class Modal {
  constructor(_app?: unknown) { /* the runner has no UI */ }
  open(): void { /* no UI */ }
  close(): void { /* no UI */ }
}
export class Menu {}
export function setIcon(): void { /* no UI */ }
/** Frontmatter is not used by the runner (it passes no original frontmatter). */
export function parseYaml(_text: string): Record<string, unknown> {
  return {};
}
export function stringifyYaml(value: unknown): string {
  return JSON.stringify(value ?? {});
}
