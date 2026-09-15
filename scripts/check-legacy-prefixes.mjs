// 旧品牌前缀的静态检查：拦住 whitelist 之外的 lex / lv / lvk 前缀。
//
// 为什么要有这条：品牌改名是靠人工枚举字面量做的，实测漏了三轮——
//   1. 第一次改名（PR #14）只处理 `lexvoice-*`，把更短的 `lex-*` 整个漏掉
//      （录音文件名一直叫 `lex-<时间戳>.webm`，1.0.0 用户已有这类文件）；
//   2. L2 层改名时漏了 `--lv-sediment-*`（123 处）与 `--lvk-*`（9 处）；
//   3. 同一批还漏了 `genId()` 的 `lv-`、`lvtask-`、沉淀 id 与实时转写块标记。
//
// 三轮都是「改完了，但漏了几处」，而漏掉的那些一旦进入用户数据就变成了兼容负担
// （`lex-` 文件名已经写进 1.0.0 用户的知识库，只能双读）。
// 这条检查把「有没有漏」变成机械可判定的问题。
//
// 注意：本检查只拦**新增**的旧前缀。已经在用户数据里、需要继续识别的旧写法，
// 登记在下面的 ALLOWED 里，并写明理由与对应文件。

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 扫描的文件：源码、样式、脚本、清单与文档。 */
const SCANNED_DIRS = ["src", "scripts", "tests", ".github"];
const SCANNED_FILES = ["styles.css", "main.js", "manifest.json", "package.json"];

/**
 * 允许出现旧前缀的位置。每一条都要写清「为什么必须保留」。
 * 新增条目时先自问：这是**读取兼容**，还是漏改？
 */
const ALLOWED = [
  {
    file: "src/shared/namespace.ts",
    reason: "1.0.0 写进用户数据的旧写法常量：音频文件名前缀、沉淀 id、实时转写块标记、不透明 id。读取兼容的唯一来源。",
  },
  {
    file: "src/notes/meeting-workbench-service.ts",
    reason: "清理 1.0.0 写下的 <!-- lv-live-* --> 块；只读不写。",
  },
  {
    file: "src/sediment/index.ts",
    reason: "按旧沉淀 id 查找 1.0.0 已写进日记的待办标记；只读不写。",
  },
  {
    file: "src/report/render.ts",
    reason: "HTML 报告模板的 .lv-* 类与 --lv-* 变量：报告是自带内联样式表的独立 HTML，不改动（维护者 2026-09-15 决定）。",
  },
  {
    file: "src/ui/outline-text.ts",
    reason: "注释里举例说明残缺锚点，不含实际前缀用法。",
  },
];

/** 本脚本自身必须能写出这些前缀才能识别它们，与 check-mainline-isolation 同样的自我豁免。 */
const SELF_PATH = "scripts/check-legacy-prefixes.mjs";

/** 上游插件 id：安装/还原脚本要识别并**只作提示**，不读取不移动不删除它的内容。 */
const UPSTREAM_ID_FILES = new Set(["scripts/install-to-vault.mjs", "scripts/restore-from-backup.mjs"]);

/** 兼容性测试必须写出 1.0.0 的旧写法，否则就测不出兼容。 */
const COMPAT_TEST_FILES = new Set([
  "tests/legacy-prefix-compat.test.ts",
  // 门禁自身的用例必须写出旧前缀，否则测不出它能不能拦
  "tests/legacy-prefix-gate.test.ts",
]);

/**
 * 旧前缀。
 *
 * 这里必须覆盖实际出现过的形态，否则门禁本身会漏（第一版就漏了）：
 *   `lex-${stamp}.webm`  模板串里前缀后紧跟 `${`  → 后缀要允许为空
 *   `"lv-"`              裸前缀串
 *   `lvtask-`            前缀无连字符（显式列出）
 *   `--lex-sidebar-…`    CSS 自定义属性前是 `-` → 不能用 `[^\w-]` 排除连字符
 *
 * 前视用 `(?<![A-Za-z0-9_])` 而非 `\b`：`flex-wrap`、`shelve`、`solve-` 里的
 * lex/lv 都被前一个字母挡住，不会误报。
 */
const LEGACY_PREFIX = /(?<![A-Za-z0-9_])((?:lexvoice|lvtask|lex|lvk|lv)-[a-z0-9-]*)/gi;

/** README / NOTICE / MAINTAINING 说明「与 LexVoice 的关系」时会提到它，属正当引用。 */
const DOC_ALLOWLIST = /(^|\/)(README[^/]*\.md|NOTICE|MAINTAINING\.md|LICENSE|THIRD_PARTY_NOTICES\.md|AGENTS\.md|ARCHITECTURE\.md|PRIVACY\.md|SECURITY\.md|DESIGN_SPEC\.md)$/;

function collectFiles(root) {
  const out = [];
  for (const dir of SCANNED_DIRS) {
    const abs = path.join(root, dir);
    let entries;
    try {
      entries = readdirSync(abs, { recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = path.join(dir, String(entry));
      if (!/\.(ts|mjs|js|css|json|md|ya?ml)$/.test(rel)) continue;
      try {
        if (statSync(path.join(root, rel)).isFile()) out.push(rel);
      } catch {
        /* 竞态删除 */
      }
    }
  }
  for (const rel of SCANNED_FILES) {
    try {
      if (statSync(path.join(root, rel)).isFile()) out.push(rel);
    } catch {
      /* 缺失的文件由其它检查负责 */
    }
  }
  return out;
}

/** 返回违规项（空数组表示通过）。files 为 { 相对路径: 内容 }，便于单测注入。 */
export function checkLegacyPrefixes(files, { allowlist = ALLOWED, docAllowlist = DOC_ALLOWLIST } = {}) {
  const violations = [];
  const allowed = new Set(allowlist.map((entry) => entry.file));

  for (const [file, content] of Object.entries(files)) {
    if (allowed.has(file)) continue;
    if (docAllowlist.test(file)) continue;
    if (file === SELF_PATH) continue;
    if (UPSTREAM_ID_FILES.has(file)) continue;
    if (COMPAT_TEST_FILES.has(file)) continue;
    // 产物是源码的重新打包，源码干净则产物必然干净；由源码侧报告问题更可定位。
    if (file === "main.js") continue;

    const lines = String(content).split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // 只关心「像标识符/类名/变量名」的用法，跳过纯文字描述里的引用
      LEGACY_PREFIX.lastIndex = 0;
      let match;
      while ((match = LEGACY_PREFIX.exec(line)) !== null) {
        const token = match[1];
        // CSS 自定义属性 `--lex-x`：回看两个字符补上前导的 `--`
        const at = match.index + match[0].length - token.length;
        const before = line.slice(Math.max(0, at - 2), at);
        const display = before === "--" ? `--${token}` : token;
        violations.push(`${file}:${i + 1} 出现旧品牌前缀 ${display}：${line.trim().slice(0, 110)}`);
      }
    }
  }
  return violations;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = {};
  for (const rel of collectFiles(root)) {
    try {
      files[rel] = readFileSync(path.join(root, rel), "utf8");
    } catch {
      /* 忽略读取失败 */
    }
  }

  const violations = checkLegacyPrefixes(files);
  if (violations.length) {
    console.error("[legacy-prefix] 发现白名单之外的旧品牌前缀：");
    for (const line of violations.slice(0, 40)) console.error(`  - ${line}`);
    if (violations.length > 40) console.error(`  …另有 ${violations.length - 40} 处`);
    console.error("[legacy-prefix] 若是漏改，请改成 qnalog-*；若是读取 1.0.0 遗留数据的兼容代码，");
    console.error("[legacy-prefix] 请把它集中到 src/shared/namespace.ts，并在此脚本的 ALLOWED 里登记理由。");
    process.exit(1);
  }
  console.log(`[legacy-prefix] OK: 检查 ${Object.keys(files).length} 个文件，白名单之外无旧前缀`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
