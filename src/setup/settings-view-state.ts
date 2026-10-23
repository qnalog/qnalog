// 设置页的界面状态判定（纯函数，无 DOM）。
// 这些状态只存在内存里，不落盘，不涉及设置 schema。

export type SetupStateName = "missing" | "untested" | "success" | "failure";

export interface QuickSetupVisibilityInput {
  transcribeState: SetupStateName;
  llmState: SetupStateName;
  /** 用户点了「快速配置」并确认覆盖：本次设置会话内一直显示。 */
  openedByUser: boolean;
  /** 用户点了卡片上的关闭按钮：配置缺失时也隐藏，直到再次点「快速配置」。 */
  dismissed: boolean;
}

/**
 * 首页「快速配置」卡片是否显示。每次渲染都按当前配置重新判定，
 * 不缓存首次渲染的结果：配置补全后卡片应当消失。
 */
export function isQuickSetupVisible(input: QuickSetupVisibilityInput): boolean {
  if (input.openedByUser) return true;
  if (input.dismissed) return false;
  return input.transcribeState === "missing" || input.llmState === "missing";
}

/** 服务商面板的展开状态：用户操作过就沿用，第一次出现时按「未配好则展开」。 */
export function resolvePanelOpen(
  store: Record<string, boolean>,
  key: string,
  defaultOpen: boolean,
): boolean {
  return Object.prototype.hasOwnProperty.call(store, key) ? !!store[key] : defaultOpen;
}

/**
 * 重新渲染后的滚动位置：同一标签页内重画保持原位置；
 * 切换标签页或首次打开设置时回到顶部。
 */
export function resolveScrollTop(
  previousTab: string | null,
  nextTab: string,
  previousScrollTop: number,
): number {
  if (previousTab === null || previousTab !== nextTab) return 0;
  return previousScrollTop > 0 ? previousScrollTop : 0;
}

/** 「快速配置」按钮要不要先确认覆盖：只有两项服务都已配好时才确认。 */
export function quickSetupNeedsConfirm(input: {
  transcribeState: SetupStateName;
  llmState: SetupStateName;
}): boolean {
  return input.transcribeState !== "missing" && input.llmState !== "missing";
}
