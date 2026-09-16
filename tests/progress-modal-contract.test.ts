import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modalSource = readFileSync(new URL("../src/ui/modals.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

// 这些用例断言的是「界面里有没有这些事实」，而不是源码里写了哪个中文字面量。
// i18n 改造把界面文案改为英文源后，按字面量比对的写法会随文案语言变化而失败，
// 那类断言锁定的是实现而不是行为。因此改为断言：这些事实所需的数据字段
// 与展示结构仍然存在（字段名不随语言变化）。

describe("progress modal interaction contract", () => {
  it("shows concrete task context instead of a generic running-health sentence", () => {
    // 任务上下文的字段必须仍在组装：来源文件夹、时长、模式变化
    expect(modalSource).toContain("sourceFolder");
    expect(modalSource).toContain("durationMs");
    expect(modalSource).toContain("sourceModeLabel");
    expect(modalSource).toContain("targetModeLabel");
    // 运行中不应被当成异常状态
    expect(modalSource).toContain('"running"');
  });

  it("uses the available width for task facts and collapses responsively", () => {
    expect(styles).toContain(".qnalog-progress-current-facts");
    expect(styles).toContain("grid-template-columns: repeat(4, minmax(0, 1fr));");
    expect(styles).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
  });

  it("restores list scroll after dynamic rows have been rendered", () => {
    expect(modalSource).toContain("const restoreScrollTop = this._scrollTop;");
    expect(modalSource).toContain("window.requestAnimationFrame(() => {");
    expect(modalSource).toContain("list.scrollTop = Math.min(restoreScrollTop, maxScrollTop);");
  });

  it("does not refresh the entire modal while the user is scrolling", () => {
    expect(modalSource).toContain("this._lastScrollAt = Date.now();");
    expect(modalSource).toContain("if (Date.now() - this._lastScrollAt < 900) return;");
  });

  it("keeps the current-step icon and copy in one padded row", () => {
    expect(styles).toMatch(/\.qnalog-progress-row\.qnalog-progress-legacy-current\s*\{[^}]*grid-template-columns:\s*24px\s+minmax\(0,\s*1fr\)/s);
    expect(styles).toMatch(/\.qnalog-progress-row\.qnalog-progress-legacy-current\s*\{[^}]*padding:\s*var\(--size-4-3\)\s+var\(--size-4-6\)/s);
  });

  it("hides low-value transport events while keeping them available to diagnostics", () => {
    // 低价值传输入事件按标签过滤，被过滤的只是「显示」，记录仍在
    expect(modalSource).toContain("hiddenEventLabels.has(String(event.label || \"\").trim())");
    expect(modalSource).toContain("if (visibleEvents.length) {");
  });

  it("does not present a long-running task as a product failure before it actually fails", () => {
    // 慢/停滞用中性措辞，且不计入失败集合
    expect(modalSource).toContain('const taskProblems = taskActivities.filter((task) => String(task.status || "") === "failed");');
    expect(modalSource).toContain('["slow", "stalled"].includes(stageLiveness)');
    expect(styles).toMatch(/\.qnalog-progress-state\.is-slow,\s*\.qnalog-progress-state\.is-stalled,\s*\.qnalog-progress-state\.is-retrying/);
  });
});
