// 原始转写写在 <details> 里，紧跟 <summary> 的 [[录音|mm:ss]] 处在 HTML 块中，Obsidian 不把它渲染成链接，
// 阅读视图里显示为原文、不可点击。这里在渲染后把这类文本换成与补转写重试相同的 internal-link 锚点，
// 交给已有的回听点击处理；不改笔记文件。

export type LiteralAudioLinkPart = { text: string } | { target: string; label: string };

// [[目标|时间]]：目标不含 ] | 与换行；时间为 m:ss / mm:ss / h:mm:ss，可带「–结束时间」。
const LITERAL_AUDIO_LINK_RE = /\[\[([^\]|\n]+)\|((?:\d{1,2}:)?\d{1,2}:\d{2}(?:\s*[–-]\s*(?:\d{1,2}:)?\d{1,2}:\d{2})?)\]\]/g;

/**
 * 把文本拆成普通文字与回听链接两类片段；目标不是音频文件的 [[…|…]] 保持原文。
 * 没有可替换的链接时返回 null，调用方据此跳过该文本节点。
 */
export function splitLiteralAudioTimeLinks(text: string, isAudioTarget: (target: string) => boolean): LiteralAudioLinkPart[] | null {
  const parts: LiteralAudioLinkPart[] = [];
  let last = 0;
  let found = false;
  for (const match of text.matchAll(LITERAL_AUDIO_LINK_RE)) {
    const target = match[1].trim();
    if (!target || !isAudioTarget(target)) continue;
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ target, label: match[2].trim() });
    last = start + match[0].length;
    found = true;
  }
  if (!found) return null;
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

function isInside(node: Node, root: HTMLElement, tagNames: readonly string[]): boolean {
  for (let current = node.parentElement; current; current = current.parentElement) {
    if (tagNames.includes(current.tagName)) return true;
    if (current === root) return false;
  }
  return false;
}

/**
 * 在 root 内 <details> 里的文本节点中，把 [[音频|mm:ss]] 换成 `a.internal-link` 锚点；
 * 代码块与已有链接里的文字不动。返回替换的链接数。
 */
export function upgradeLiteralAudioTimeLinks(root: HTMLElement, isAudioTarget: (target: string) => boolean): number {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.instanceOf(Text) && node.data.includes("[[")) textNodes.push(node);
  }
  let upgraded = 0;
  for (const node of textNodes) {
    // 只处理 <details> 内的文字：节点在 root 内的 details 里，或 root 本身位于 details 中。
    if (!isInside(node, root, ["DETAILS"]) && !root.closest("details")) continue;
    if (isInside(node, root, ["CODE", "PRE", "A"])) continue;
    const parts = splitLiteralAudioTimeLinks(node.data, isAudioTarget);
    if (!parts) continue;
    const fragment = createFragment();
    for (const part of parts) {
      if ("text" in part) {
        fragment.appendChild(doc.createTextNode(part.text));
        continue;
      }
      fragment.appendChild(doc.win.createEl("a", {
        cls: "internal-link",
        text: part.label,
        attr: { "data-href": part.target, href: part.target },
      }));
      upgraded++;
    }
    node.replaceWith(fragment);
  }
  return upgraded;
}
