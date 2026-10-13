/** Remove transcript segment references from model-generated Markdown bodies. */
export function sanitizeBriefingModelOutput(text: string): string {
  const protectedParts: string[] = [];
  const protect = (value: string): string => {
    const marker = `\uE000${protectedParts.length}\uE001`;
    protectedParts.push(value);
    return marker;
  };

  let output = text;
  if (output.startsWith("---\n") || output.startsWith("---\r\n")) {
    const firstLineEnd = output.indexOf("\n") + 1;
    const closingOffset = output.slice(firstLineEnd).search(/^---[ \t]*\r?$/m);
    if (closingOffset >= 0) {
      const closing = firstLineEnd + closingOffset;
      const closingEnd = output.indexOf("\n", closing);
      const end = closingEnd < 0 ? output.length : closingEnd + 1;
      output = protect(output.slice(0, end)) + output.slice(end);
    }
  }

  output = output.replace(/(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\r?\n[\s\S]*?(?:\r?\n|^)[ \t]*\3[ \t]*(?=\r?\n|$)/gm, (match, prefix: string) => `${prefix}${protect(match.slice(prefix.length))}`);
  output = output.replace(/<!--[\s\S]*?-->/g, protect);
  output = output.replace(/(`+)[^\n]*?\1/g, protect);

  output = output.replace(/^[ \t]*===SEG[^\r\n]*===[ \t]*\r?\n?/gmi, "");
  const segmentReference = /(?:\(\s*SEG\s+\d+(?:\s*[-–—~]\s*\d+|\s*[,，、;；]\s*\d+)*\s*\)|（\s*SEG\s+\d+(?:\s*[-–—~]\s*\d+|\s*[,，、;；]\s*\d+)*\s*）|\[\s*SEG\s+\d+(?:\s*[-–—~]\s*\d+|\s*[,，、;；]\s*\d+)*\s*\])/gi;
  output = output.replace(new RegExp(`[ \\t]*(${segmentReference.source})[ \\t]*`, "gi"), (match, _reference: string, offset: number, source: string) => {
    const before = offset > 0 && /[ \t]$/.test(source.slice(0, offset));
    const after = /[ \t]/.test(match.slice(-1));
    return before && after ? " " : "";
  });

  output = output.replace(/[ \t]+(?=\r?$)/gm, "").replace(/[ \t]+([，,。.!?！？；;：:])/g, "$1");
  return output.replace(/\uE000(\d+)\uE001/g, (_marker, index: string) => protectedParts[Number(index)] || "");
}
