/**
 * Block markers in topic page text: block IDs (`^tpc-xxxxxx`), footnote
 * references (`[^s…]`) and list prefixes. Model text is cleaned with these
 * helpers before the renderer adds its own IDs and footnotes.
 */

const BLOCK_ID_PATTERN = /\s*\^tpc-[\da-f]{6}\b/gi;

/** Removes block IDs, footnote references and leading list or checkbox prefixes from model text. */
export function stripBlockMarkers(text: string): string {
  return text
    .replace(BLOCK_ID_PATTERN, "")
    .replace(/\s*\[\^[\w-]+\]/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\[[ xX]\]\s+)/, "").replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

/** Appends a block ID to a line unless the line already carries that ID. */
export function withBlockId(content: string, id: string): string {
  if (new RegExp(`(?:^|\\s)\\^${id}\\b`).test(content)) return content;
  return `${content} ^${id}`;
}

/** Keeps the first line occurrence of each block ID and removes later ones (in the same line or any later line). */
export function dedupeBlockIds(markdown: string): { markdown: string; duplicates: string[] } {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const lines = markdown.split("\n").map((line) => line.replace(/\s\^(tpc-[\da-f]{6})\b/gi, (match, id: string) => {
    const key = id.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      return match;
    }
    duplicates.push(key);
    return "";
  }));
  return { markdown: lines.join("\n"), duplicates };
}
