// 移动端：内容区被系统状态栏（时间、信号）遮住时，按遮住的高度补上顶部留白。

/** 需要补的顶部留白（px）：安全区高度减去内容区顶边已经离屏幕顶端的距离。 */
export function missingSafeAreaTop(insetTop: number, contentTop: number): number {
  if (!Number.isFinite(insetTop) || insetTop <= 0) return 0;
  const top = Number.isFinite(contentTop) ? Math.max(0, contentTop) : 0;
  return Math.max(0, Math.ceil(insetTop - top));
}

/** 用一个探针元素读出 env(safe-area-inset-top) 的实际像素值。 */
function readSafeAreaInsetTop(root: HTMLElement): number {
  const probe = root.createDiv({ cls: "qnalog-safe-area-probe" });
  try {
    return parseFloat(getComputedStyle(probe).paddingTop) || 0;
  } finally {
    probe.remove();
  }
}

/**
 * 在 root 上设置 --qnalog-safe-area-top-gap。
 * 宿主已经给视图留出顶部空间（标题栏可见）时结果为 0，不会重复留白。
 */
export function applySafeAreaTopGap(root: Element): void {
  if (!root.instanceOf(HTMLElement)) return;
  const gap = missingSafeAreaTop(readSafeAreaInsetTop(root), root.getBoundingClientRect().top);
  root.style.setProperty("--qnalog-safe-area-top-gap", `${gap}px`);
}
