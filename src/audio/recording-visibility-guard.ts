// 录音期间监听页面可见性：进入后台前先落盘，回到前台后检查录音输入是否仍有效。

type VisibilityDocument = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

export interface RecordingVisibilityHandlers {
  /** 页面变为 hidden：把已录音频写入分片目录。 */
  onHidden(): void;
  /** 页面变为 visible：检查输入是否失效，失效时给出可恢复的提示。 */
  onVisible(): void;
}

/** 开始监听，返回取消函数。 */
export function watchRecordingVisibility(
  handlers: RecordingVisibilityHandlers,
  doc: VisibilityDocument | null = typeof document !== "undefined" ? document : null,
): () => void {
  if (!doc) return () => undefined;
  const listener = () => {
    if (doc.visibilityState === "hidden") handlers.onHidden();
    else if (doc.visibilityState === "visible") handlers.onVisible();
  };
  doc.addEventListener("visibilitychange", listener);
  return () => doc.removeEventListener("visibilitychange", listener);
}
