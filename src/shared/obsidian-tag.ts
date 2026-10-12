/** Normalize a generated tag to Obsidian's accepted tag characters. */
export function cleanObsidianTag(value: unknown): string {
  let tag = (typeof value === "string" || typeof value === "number" || typeof value === "bigint" ? String(value) : "").replace(/^#+/, "").trim();
  tag = tag.replace(/[^\p{L}\p{N}_\-/]/gu, "").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  if (!tag || /^[\p{N}]+$/u.test(tag)) return "";
  return tag;
}
