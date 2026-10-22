// 行内改名：把标题元素切到可编辑状态，回车或失焦提交、Esc 取消、不允许清空。
// 纪要列表改名与「沉淀」候选改名共用。

export function enterInlineTitleEdit(titleEl: HTMLElement, original: string, commitFn: (next: string) => unknown): void {
  if (titleEl.classList.contains("is-editing")) return;
  const before = (original || "").trim();
  titleEl.contentEditable = "true";
  titleEl.classList.add("is-editing");
  titleEl.focus();
  const sel = window.getSelection();
  if (sel) {
    const range = activeDocument.createRange();
    range.selectNodeContents(titleEl);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  let done = false;
  const finish = async (shouldSave: boolean) => {
    if (done) return;
    done = true;
    titleEl.contentEditable = "false";
    titleEl.classList.remove("is-editing");
    titleEl.removeEventListener("keydown", onKey);
    titleEl.removeEventListener("blur", onBlur);
    const next = (titleEl.textContent || "").trim();
    if (shouldSave && next && next !== before) {
      await commitFn(next);
    } else if (shouldSave && !next) {
      titleEl.textContent = before; // 不允许清空
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); void finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); titleEl.textContent = before; void finish(false); }
  };
  const onBlur = () => { void finish(true); };
  titleEl.addEventListener("keydown", onKey);
  titleEl.addEventListener("blur", onBlur);
}
