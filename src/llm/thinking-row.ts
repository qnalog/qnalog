import { getThinkingControl } from "./thinking";

/** 设置页「思考」下拉的可选值，与 PluginSettings.thinkingMode 一致。 */
export type ThinkingModeValue = "auto" | "fast" | "reasoning";

export const THINKING_MODE_OPTIONS: ReadonlyArray<{ value: ThinkingModeValue; label: string }> = [
  { value: "auto", label: "Default mode" },
  { value: "fast", label: "Quick mode" },
  { value: "reasoning", label: "Reasoning mode" },
];

/** 当前服务与模型是否支持调节思考档；不支持时设置页不显示该行。 */
export function shouldShowThinkingRow(endpoint: string, model: string): boolean {
  return getThinkingControl(endpoint, model) !== null;
}

/** 把存储值收窄为下拉可选值；未知值按「默认」显示，不改写存储。 */
export function normalizeThinkingModeValue(value: unknown): ThinkingModeValue {
  return value === "fast" || value === "reasoning" ? value : "auto";
}
