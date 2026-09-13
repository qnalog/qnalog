import fs from "node:fs";
import path from "node:path";

const srcRoot = path.resolve(__dirname, "..", "src");

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * 插件源码全文（src/ 下所有 .ts，按路径排序后拼接）。
 *
 * 契约测试用它来锁定"某个字符串必须存在于插件源码中"这类事实。
 * 用全文而不是单个 main.ts：实现会被拆分到多个模块，断言不应因为文件位置变化而失效；
 * 断言强度不变——字符串仍必须真实存在于插件源码里。
 * 需要断言"同一文件内的先后顺序"时，仍应读取具体文件，而不是用这个拼接结果。
 */
export function pluginSourceText(): string {
  return collect(srcRoot)
    .sort()
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
}
