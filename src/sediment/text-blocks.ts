import { NS_CARDS_BLOCK_RE, NS_SEDIMENT_BEGIN, NS_SEDIMENT_END } from "../shared/namespace";

const stringifyUnknown: (value: unknown) => string = String;

export function getSedimentPreExtractionBlockPatterns(global: boolean): RegExp[] {
  const flags = global ? "gi" : "i";
  return [
    new RegExp(`<!--\\s*${NS_SEDIMENT_BEGIN}\\s*([\\s\\S]*?)\\s*${NS_SEDIMENT_END}\\s*-->`, flags),
    new RegExp(`<!--\\s*${NS_SEDIMENT_BEGIN}\\s*-->\\s*(?:\`\`\`json\\s*)?([\\s\\S]*?)(?:\\s*\`\`\`)?\\s*<!--\\s*${NS_SEDIMENT_END}\\s*-->`, flags),
    NS_CARDS_BLOCK_RE,
  ];
}

export function stripSedimentPreExtractionBlocks(markdown: unknown): string {
  let text = stringifyUnknown(markdown || "");
  for (const pattern of getSedimentPreExtractionBlockPatterns(true)) {
    text = text.replace(pattern, "");
  }
  return text.trimEnd();
}

export function splitOutSedimentBlock(markdown: unknown): { body: string; block: string } {
  const text = stringifyUnknown(markdown || "");
  for (const pattern of getSedimentPreExtractionBlockPatterns(false)) {
    const match = pattern.exec(text);
    if (match && match[0]) {
      return { body: stripSedimentPreExtractionBlocks(text), block: String(match[0]).trim() };
    }
  }
  return { body: text, block: "" };
}
