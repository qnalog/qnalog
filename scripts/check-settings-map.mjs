// 设置映射表（MAINTAINING.md §9.1）的漂移检查。
//
// 为什么要有这条：§9.1 那张表是「动手改设置界面之前，先把现状盘清」的产物，
// 它的价值全在「与代码一致」。设置键增删、落盘路径改名之后，人不会记得回来改文档——
// 过期的映射表比没有映射表更坏：它会让后来的人按错误的分组去搬动配置。
//
// 这里只校验两件机械可判的事（不比对文案，文案改动不该弄红构建）：
//   1. §9.1 表格里的设置键集合，与 `PluginSettings` 的顶层键集合完全一致；
//   2. 每个键的「落盘位置」与 `serializePluginSettings` 实际写出的分组路径一致。
//
// 键集合取自 src/shared/types.ts 的 `interface PluginSettings`（DEFAULT_SETTINGS 的键由
// settings-io 的 round-trip 测试保证与它一致），落盘路径由源码文本解析得出——
// 不 import 被测模块：这些文件是 @ts-nocheck 的运行时模块，直接 import 会拖入 obsidian 依赖。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 表格里「内部」分组用的占位符，不是真实落盘路径。 */
export const MAP_SECTION_START = "### 9.1 逐键映射";
export const MAP_SECTION_END = "### 9.2";

/** 取 `interface PluginSettings {…}` 的顶层键。 */
export function parseSettingsKeys(typeSource) {
  const start = typeSource.indexOf("export interface PluginSettings {");
  if (start < 0) throw new Error("types.ts 里找不到 interface PluginSettings");
  const end = typeSource.indexOf("\n}", start);
  if (end < 0) throw new Error("interface PluginSettings 没有正常闭合");
  const body = typeSource.slice(start, end);
  const keys = [];
  for (const line of body.split("\n")) {
    const m = /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??:/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/**
 * 解析 `serializePluginSettings` 的返回值，得到 设置键 → 落盘路径。
 *
 * 做法是按行跟踪花括号深度：进入 `xxx: {` 记一层分组名，遇到 `s.key` 时把当前分组链拼成路径。
 * 只认「`键: 表达式`」这种字面登记，计算得出的值（如 `s.transcribeProviders || {}`）同样能取到 `s.<键>`。
 */
export function parseSerializeMap(settingsIoSource) {
  const start = settingsIoSource.indexOf("export function serializePluginSettings");
  if (start < 0) throw new Error("settings-io.ts 里找不到 serializePluginSettings");
  const end = settingsIoSource.indexOf("export function extractJobItems", start);
  if (end < 0) throw new Error("serializePluginSettings 之后找不到 extractJobItems，无法界定函数范围");

  const map = new Map();
  const stack = [];
  for (const rawLine of settingsIoSource.slice(start, end).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;

    const group = /^([A-Za-z_][A-Za-z0-9_]*):\s*\{/.exec(line);
    if (group) {
      stack.push(group[1]);
      continue;
    }
    const entry = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.+?),?$/.exec(line);
    if (entry) {
      const value = entry[2];
      for (const key of value.matchAll(/\bs\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        map.set(key[1], [...stack, entry[1]].join("."));
      }
      continue;
    }
    // 收尾括号只出现在「整行以 `}` 开头」的行（`},` / `};`）。
    // 不能数行内所有 `}`：像 `providers: s.transcribeProviders || {},` 这样的登记行
    // 值里带着 `{}`，数进去会多弹一层分组，后续所有键的路径都会错位。
    const closes = /^}+[,;]?$/.exec(line);
    if (closes) stack.pop();
  }
  return map;
}

/** 从 MAINTAINING.md 的 §9.1 表格里取 设置键 → 落盘位置。 */
export function parseMapTable(markdown) {
  const start = markdown.indexOf(MAP_SECTION_START);
  if (start < 0) throw new Error(`MAINTAINING.md 里找不到 ${MAP_SECTION_START}`);
  const end = markdown.indexOf(MAP_SECTION_END, start);
  const section = markdown.slice(start, end < 0 ? markdown.length : end);

  const rows = new Map();
  for (const line of section.split("\n")) {
    const m = /^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|([^|]*)\|([^|]*)\|/.exec(line);
    if (m) rows.set(m[1], m[3].trim().replace(/^`|`$/g, ""));
  }
  return rows;
}

export function checkSettingsMap({ typeSource, settingsIoSource, markdown }) {
  const failures = [];

  const live = parseSettingsKeys(typeSource);
  const serialize = parseSerializeMap(settingsIoSource);
  const documented = parseMapTable(markdown);

  const tableKeys = new Set(documented.keys());
  const liveKeys = new Set(live);

  for (const key of live) {
    if (!tableKeys.has(key)) {
      failures.push(`§9.1 缺少设置键 ${key}：代码里新增了，映射表没跟上`);
    }
  }
  for (const key of tableKeys) {
    if (!liveKeys.has(key)) {
      failures.push(`§9.1 多出设置键 ${key}：代码里已删除或改名，映射表没跟上`);
      continue;
    }
    const expected = serialize.get(key);
    const actual = documented.get(key);
    if (!expected) {
      // 没有出现在 serialize 里 = 保存即丢，这是另一类缺陷（settings-io round-trip 测试负责），
      // 这里只提示映射表描述不出路径。
      if (actual !== "—") failures.push(`§9.1 的 ${key} 落盘位置写成了 ${actual}，但 serialize 里没有登记它`);
      continue;
    }
    if (actual !== expected) {
      failures.push(`§9.1 的 ${key} 落盘位置是 ${actual}，serialize 实际写的是 ${expected}`);
    }
  }

  return failures;
}

function main() {
  const typeSource = readFileSync(path.join(REPO_ROOT, "src/shared/types.ts"), "utf8");
  const settingsIoSource = readFileSync(path.join(REPO_ROOT, "src/shared/settings-io.ts"), "utf8");
  const markdown = readFileSync(path.join(REPO_ROOT, "MAINTAINING.md"), "utf8");

  const failures = checkSettingsMap({ typeSource, settingsIoSource, markdown });
  if (failures.length) {
    console.error("[settings-map] 设置映射表与代码不一致：");
    for (const line of failures.slice(0, 30)) console.error(`  - ${line}`);
    if (failures.length > 30) console.error(`  …另有 ${failures.length - 30} 处`);
    console.error("[settings-map] 请更新 MAINTAINING.md §9.1（新键补一行，改路径改对应格）。");
    process.exit(1);
  }
  console.log(`[settings-map] OK: ${parseSettingsKeys(typeSource).length} 个设置键与 §9.1 一致`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
