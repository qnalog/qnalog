/** Clean Markdown presentation syntax without mutating the overview stored in a card. */
export function cleanTopicOverviewExcerpt(value: string): string {
  return String(value || "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/[*_]/g, "")
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s{0,3}>\s?/, "")
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
