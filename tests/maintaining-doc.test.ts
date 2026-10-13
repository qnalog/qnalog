import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// MAINTAINING.md §0 第 9 条：写入约束中可机械核对的部分。
const text = fs.readFileSync(path.resolve(__dirname, "..", "MAINTAINING.md"), "utf8");
const lines = text.split("\n");

function headingsOutsideCodeFences(): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (!inFence && /^#{2,4} /.test(line)) out.push(line.trim());
  }
  return out;
}

function sectionBetween(startHeading: string, endHeading: string): string {
  const start = text.indexOf(startHeading);
  const end = text.indexOf(endHeading, start + startHeading.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

const STATUS_WORDS = ["已决定", "待决定", "取证中", "探索", "暂缓", "待规格"];

describe("MAINTAINING.md 写入约束", () => {
  it("标题不重复", () => {
    const seen = new Map<string, number>();
    for (const h of headingsOutsideCodeFences()) seen.set(h, (seen.get(h) || 0) + 1);
    const dup = [...seen].filter(([, n]) => n > 1).map(([h]) => h);
    expect(dup).toEqual([]);
  });

  it("§6.1 编号条目带状态词且不超过 400 字", () => {
    const body = sectionBetween("### 6.1 当前推进", "### 已完成");
    const items = body.split(/\n(?=\d+\. )/).filter((b) => /^\d+\. /.test(b));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const head = item.split("\n")[0].slice(0, 80);
      expect(STATUS_WORDS.some((w) => item.includes(`（${w}`)), `缺少状态词：${head}`).toBe(true);
      expect(item.trim().length, `超过 400 字：${head}`).toBeLessThanOrEqual(400);
    }
  });

  it("「已完成」不超过 5 条", () => {
    const body = sectionBetween("### 已完成", "### 6.2 ");
    const bullets = body.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBeLessThanOrEqual(5);
  });

  it("不含本机绝对路径与 40 位提交哈希", () => {
    expect(text).not.toMatch(/\/Users\/[A-Za-z0-9_.-]+\//);
    expect(text).not.toMatch(/\b[0-9a-f]{40}\b/);
  });
});
