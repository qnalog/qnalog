/** Removes model-emitted source addresses while preserving ordinary Obsidian links. */
export function stripSourceIdTokens(text: string, memberIds: readonly string[]): string {
  const openWide = String.fromCharCode(0xff3b, 0x3010);
  const closeWide = String.fromCharCode(0xff3d, 0x3011);
  const openParenWide = String.fromCharCode(0xff08);
  const closeParenWide = String.fromCharCode(0xff09);
  const tokenPattern = new RegExp(`(?<!\\[)(?:\\[|[${openWide}])(?:qnalog-[^\\]\\r\\n]+|path:[^\\]\\r\\n]+)(?:\\]|[${closeWide}])(?!\\])`, "giu");
  let result = text.replace(tokenPattern, "");
  const variants = new Set(memberIds.flatMap((value) => [value, value.replace(/\.md$/i, ""), value.replace(/\\/g, "/")]));
  for (const value of [...variants].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = `(?<![\\p{L}\\p{N}_/])(?:\\[|[${openWide}]|\\(|${openParenWide})?${escaped}(?:\\]|[${closeWide}]|\\)|${closeParenWide})?(?![\\p{L}\\p{N}_/])`;
    result = result.replace(new RegExp(pattern, "giu"), "");
  }
  return result.replace(/([。！？.!?])(?:\s*[。！？.!?])+/gu, "$1")
    .replace(/\s+([，。！？；：,.!?;:])/gu, "$1")
    .replace(/([，；：,;:])\s*([，；：,;:])/gu, "$1")
    .replace(/[ \t]{2,}/g, " ").replace(/ *\n */g, "\n").trim();
}
