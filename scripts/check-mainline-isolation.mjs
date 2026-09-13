// 主线隔离检查：本仓库的代码与产物里不得出现上游仓库地址（见 MAINTAINING.md §3）。
//
// 为什么要有这条：上游 main 分发的是 2.2.0 及之后的专有构建物，
// 一旦有代码/产物指向上游，插件内的「检查更新」就会把闭源版本覆盖到本分支上。
// 靠人工 grep 容易漏，所以固化成脚本：CI 每次 push 跑，本地也可随时跑。
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 上游仓库的持有者与仓库名。命中即违规（README / NOTICE / LICENSE 的来源说明除外，
// 它们不参与本检查）。
const UPSTREAM_MARKERS = [/Lynn-x/i, /lynn-x\/LexVoice/i];
// 本仓库的更新源地址：必须出现在构建产物里，否则说明更新源被改到了别处。
const EXPECTED_REPO_URL = "https://github.com/qnalog/qnalog";
const EXPECTED_PLUGIN_ID = "qnalog";

export const SCANNED_FILES = [
  "main.js",
  "manifest.json",
  "esbuild.config.mjs",
  "package.json",
];

const SCANNED_DIRS = ["src", "scripts"];

// 本脚本自身必须包含上游标识才能识别它们，因此排除在外（它的内容由代码评审负责，
// 不承载任何运行时行为）。
const SELF_PATH = "scripts/check-mainline-isolation.mjs";

function collectFiles(root, dirs) {
  const out = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    let entries;
    try {
      entries = readdirSync(abs, { recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = path.join(dir, String(entry));
      const abs2 = path.join(root, rel);
      if (!/\.(ts|mjs|js|json)$/.test(rel)) continue;
      try {
        if (statSync(abs2).isFile()) out.push(rel);
      } catch {
        /* 忽略竞态删除的文件 */
      }
    }
  }
  return out;
}

// 返回违规项（空数组表示通过）。files 为 { 相对路径: 内容 }，便于单测注入。
export function checkMainlineIsolation(files) {
  const violations = [];

  for (const [file, content] of Object.entries(files)) {
    if (file === SELF_PATH) continue;
    const isBundle = file === "main.js";
    if (!isBundle && !file.startsWith("src/") && !file.startsWith("scripts/") && !SCANNED_FILES.includes(file)) {
      continue;
    }
    const lines = String(content).split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      for (const marker of UPSTREAM_MARKERS) {
        if (marker.test(lines[i])) {
          violations.push(`${file}:${i + 1} 出现上游仓库标识：${lines[i].trim().slice(0, 120)}`);
          break;
        }
      }
    }
  }

  const bundle = files["main.js"];
  if (bundle === undefined) {
    violations.push("main.js 缺失：更新源无法校验，请先 npm run build");
  } else if (!String(bundle).includes(EXPECTED_REPO_URL)) {
    violations.push(`main.js 未包含本仓库更新源 ${EXPECTED_REPO_URL}：更新源可能被改到别处`);
  }

  const manifest = files["manifest.json"];
  if (manifest !== undefined) {
    try {
      const parsed = JSON.parse(String(manifest));
      if (parsed.id !== EXPECTED_PLUGIN_ID) {
        violations.push(`manifest.json 的 id 是 ${JSON.stringify(parsed.id)}，预期 ${EXPECTED_PLUGIN_ID}（同 id 会让社区目录的上游版本成为本插件的更新源）`);
      }
    } catch (error) {
      violations.push(`manifest.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return violations;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = {};
  for (const rel of [...SCANNED_FILES, ...collectFiles(root, SCANNED_DIRS)]) {
    try {
      files[rel] = readFileSync(path.join(root, rel), "utf8");
    } catch {
      /* 缺失的文件在下游分别报错 */
    }
  }

  const violations = checkMainlineIsolation(files);
  if (violations.length) {
    console.error("[mainline] 主线隔离检查未通过：");
    for (const line of violations) console.error(`  - ${line}`);
    console.error("[mainline] 见 MAINTAINING.md §3：代码与产物不得指向上游仓库。");
    process.exit(1);
  }
  console.log(`[mainline] OK: 检查 ${Object.keys(files).length} 个文件，未发现上游地址；更新源指向 ${EXPECTED_REPO_URL}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
