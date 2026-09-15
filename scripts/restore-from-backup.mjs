// 从备份目录还原插件（回滚）。
// 用法：npm run restore:vault -- "<备份目录>" ["<知识库路径>"]
//
// 备份目录由 `npm run install:vault` 创建（<知识库>/.obsidian/qnalog-install-backups/<时间戳>/），
// 也可以是任何包含 manifest.json 的插件目录快照（例如手工收藏的上游版本目录）。
//
// 还原是双向可逆的：动手前先把当前插件目录另存一份，所以误操作也能再回来。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BACKUP_ROOT = "qnalog-install-backups";
const ENABLED_FILE = "community-plugins.json";

function fail(message) {
  console.error(`[restore] ${message}`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function timestamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function countFiles(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { recursive: true })) {
    try {
      if (statSync(path.join(dir, String(entry))).isFile()) total += 1;
    } catch {
      /* 忽略竞态删除 */
    }
  }
  return total;
}

const args = process.argv.slice(2).filter(arg => arg !== "--");
const backupArg = args[0] ?? "";
const vaultArg = args[1] ?? process.env.QNALOG_VAULT ?? "";

if (!backupArg.trim()) {
  fail(`缺少备份目录。

用法：npm run restore:vault -- "<备份目录>" ["<知识库路径>"] [--set-enabled]
也可以设置环境变量：QNALOG_VAULT="<知识库路径>" npm run restore:vault -- "<备份目录>"

备份目录由 npm run install:vault 创建：<知识库>/.obsidian/${BACKUP_ROOT}/<时间戳>/`);
}

const backupDir = path.resolve(backupArg.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
if (!existsSync(backupDir) || !statSync(backupDir).isDirectory()) {
  fail(`备份目录不存在或不是目录：${backupDir}`);
}

const backupManifest = readJson(path.join(backupDir, "manifest.json"));
if (!backupManifest || typeof backupManifest.id !== "string" || !backupManifest.id) {
  fail(`${path.join(backupDir, "manifest.json")} 缺失或无法解析出插件 id，无法确定还原位置。`);
}
if (!existsSync(path.join(backupDir, "main.js"))) {
  fail(`${path.join(backupDir, "main.js")} 不存在：这不是一个可用的插件备份。`);
}
const restoredId = backupManifest.id;
const restoredVersion = String(backupManifest.version || "");

if (!vaultArg.trim()) {
  fail(`缺少知识库路径（备份里只有插件文件，无法推断它属于哪个知识库）。

用法：npm run restore:vault -- "${backupDir}" "<知识库路径>"`);
}
const vault = path.resolve(vaultArg.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
const configDir = path.join(vault, ".obsidian");
if (!existsSync(configDir) || !statSync(configDir).isDirectory()) {
  fail(`没有找到 ${configDir}，请确认这是 Obsidian 知识库根目录。`);
}
const pluginsDir = path.join(configDir, "plugins");
const targetDir = path.join(pluginsDir, restoredId);

// 动手前先给"当前状态"留一份，保证这次还原本身也可逆。
let safetyDir = "";
if (existsSync(targetDir)) {
  safetyDir = path.join(configDir, BACKUP_ROOT, `${timestamp()}-before-restore`);
  mkdirSync(safetyDir, { recursive: true });
  cpSync(targetDir, safetyDir, { recursive: true });
  console.log(`[restore] 当前 ${restoredId} 目录已另存 → ${safetyDir}`);
}

mkdirSync(targetDir, { recursive: true });
cpSync(backupDir, targetDir, { recursive: true });

console.log(`[restore] 已还原 ${restoredId} ${restoredVersion}（${countFiles(backupDir)} 个文件）→ ${targetDir}`);

// 从"还原后的内容"判断是否需要提示设置结构差异，而不是靠调用方传参。
// data.json 有两种形态：{settings:{schemaVersion}} 与顶层平铺的旧结构。
const restoredSettings = readJson(path.join(targetDir, "data.json"));
const restoredSchemaValue = restoredSettings && typeof restoredSettings === "object"
  ? (restoredSettings.settings && typeof restoredSettings.settings === "object"
      ? restoredSettings.settings.schemaVersion
      : restoredSettings.schemaVersion)
  : undefined;
const restoredSchema = Number(restoredSchemaValue);
if (Number.isFinite(restoredSchema)) {
  console.log(`[restore] 该备份的 data.json 设置结构版本：${restoredSchema}。下次加载插件时，若与当前代码期望的结构不同，插件会给出迁移报告（通知 + 诊断日志）。`);
} else {
  console.log("[restore] 该备份不含可解析的 data.json：当前设置文件保持原样，插件会沿用现有设置。");
}

// 启用列表：还原到别的插件 id 时，Obsidian 里启用的仍是原来那个。
const enabledPath = path.join(configDir, ENABLED_FILE);
const enabled = readJson(enabledPath);
// 待还原目录之外的候选插件目录：上游的 lexvoice* 目录，或本插件自身的目录。
// 括号是必需的：不加会因 && 优先级高于 || 而改变判定。
const otherIds = existsSync(pluginsDir)
  ? readdirSync(pluginsDir).filter(name =>
      name !== restoredId
      && ((name.startsWith("lexvoice") || name === "qnalog") && existsSync(path.join(pluginsDir, name, "manifest.json"))))
  : [];
if (Array.isArray(enabled)) {
  const activeIdList = enabled.filter(id => typeof id === "string" && (id === restoredId || otherIds.includes(id)));
  if (!activeIdList.includes(restoredId)) {
    const lines = [
      `[restore] 注意：Obsidian 的启用列表里当前是 ${activeIdList.length ? activeIdList.join("、") : "（未启用相关插件）"}，不是 ${restoredId}。`,
      "[restore] 建议在 Obsidian 界面里切换（设置 → 第三方插件）：停用另一个，启用 " + restoredId + "。",
      "[restore] 也可以加 --set-enabled 让本脚本改写 community-plugins.json；Obsidian 正在运行时该改动可能被它覆盖，改完需要重新加载。",
    ];
    const setEnabled = process.argv.includes("--set-enabled");
    if (setEnabled) {
      const next = enabled.filter(id => !(typeof id === "string" && otherIds.includes(id)));
      if (!next.includes(restoredId)) next.push(restoredId);
      cpSync(enabledPath, `${enabledPath}.bak-${timestamp()}`);
      writeFileSync(enabledPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      console.log(`[restore] 已改写 ${ENABLED_FILE}：启用 ${restoredId}，停用 ${otherIds.join("、") || "（无）"}（原文件已备份为 .bak-<时间戳>）`);
    } else {
      for (const line of lines) console.log(line);
    }
  }
}

console.log(`[restore] 下一步：在 Obsidian 中重新加载（Ctrl/Cmd + R）。`);
if (safetyDir) console.log(`[restore] 如需撤销本次还原，再执行一次：npm run restore:vault -- "${safetyDir}" "${vault}"`);
