export function normalizeVocabularyCorrectionSide(text: unknown): string {
  return (typeof text === "string" ? text : "")
    .trim()
    .replace(/^\*\*(.*?)\*\*$/, "$1")
    .replace(/^__(.*?)__$/, "$1")
    .replace(/^[`"'「『]+/, "")
    .replace(/[`"'」』]+$/, "")
    .trim();
}

export function normalizeVocabularyCorrectionTerm(line: unknown): string {
  let text = (typeof line === "string" ? line : "").trim();
  if (!text) return "";
  if (text.startsWith("<!--") || text.startsWith("//") || text.startsWith(">")) return "";
  if (text === "---" || /^\|?\s*-{3,}/.test(text)) return "";
  text = text.replace(/^- \[[ x]\]\s+/i, "").replace(/^[-*+]\s+/, "").replace(/^\d+[.)、]\s+/, "").trim();
  text = text.replace(/^\*\*(.*?)\*\*$/, "$1").replace(/^__(.*?)__$/, "$1");
  const pair = text.match(/^(.+?)\s*(?:=>|->|→|=|：|:)\s*(.+)$/);
  if (!pair) return "";
  const from = normalizeVocabularyCorrectionSide(pair[1]);
  const to = normalizeVocabularyCorrectionSide(pair[2]);
  if (!from || !to || from === to) return "";
  if (from.length > 60 || to.length > 60) return "";
  return `${from} => ${to}`;
}
