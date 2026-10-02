// 从备份目录还原插件（回滚）。
// 用法：npm run restore:vault -- "<备份目录>" ["<知识库路径>"]
//
// 备份目录由 `npm run install:vault` 创建（<知识库>/.obsidian/qnalog-install-backups/<时间戳>/），
// 也可以是任何包含 manifest.json 的插件目录快照（例如手工收藏的上游版本目录）。
//
// 还原是双向可逆的：动手前先把当前插件目录另存一份，所以误操作也能再回来。
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const BACKUP_ROOT = "qnalog-install-backups";
const ENABLED_FILE = "community-plugins.json";
const UNSAFE_PATH_MESSAGE = "还原路径包含不安全的文件系统链接或文件类型，已停止还原。";
const OVERLAP_MESSAGE = "备份源与还原目标或留档目录重叠，已停止还原。";

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
      if (lstatSync(path.join(dir, String(entry))).isFile()) total += 1;
    } catch {
      /* 忽略竞态删除 */
    }
  }
  return total;
}

function readEntryIfPresent(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function validatePluginId(id) {
  if (typeof id !== "string" || !id || id.trim() !== id || id === "." || id === "..") return null;
  if (/[\\/:<>"|?*\u0000-\u001f\u007f]/u.test(id) || /[ .]$/u.test(id)) return null;
  if (path.posix.isAbsolute(id) || path.win32.isAbsolute(id)) return null;
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(id)) return null;
  return id;
}

function isPathWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function requireDirectory(entry) {
  if (!entry?.isDirectory()) fail(UNSAFE_PATH_MESSAGE);
}

function requireRegularFile(entry) {
  if (!entry?.isFile()) fail(UNSAFE_PATH_MESSAGE);
}

function inspectTree(dir, rejectHardLinks) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    const stat = readEntryIfPresent(entryPath);
    if (!stat || (!stat.isDirectory() && !stat.isFile())) fail(UNSAFE_PATH_MESSAGE);
    if (stat.isFile() && rejectHardLinks && stat.nlink > 1) fail(UNSAFE_PATH_MESSAGE);
    if (stat.isDirectory()) inspectTree(entryPath, rejectHardLinks);
  }
}

function realDirectory(root) {
  const realRoot = realpathSync(root);
  requireDirectory(readEntryIfPresent(realRoot));
  return realRoot;
}

function ensureStrictChild(parent, child, expectedRelative) {
  const relative = path.relative(parent, child);
  if (relative !== expectedRelative || relative === "" || !isPathWithin(parent, child)) fail(UNSAFE_PATH_MESSAGE);
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
if (!vaultArg.trim()) {
  fail("缺少知识库路径（备份里只有插件文件，无法推断它属于哪个知识库）。");
}

const backupInput = path.resolve(backupArg.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
if (!readEntryIfPresent(backupInput)) fail(`备份目录不存在或不是目录：${backupInput}`);
const backupDir = realDirectory(backupInput);
inspectTree(backupDir, false);
const manifestPath = path.join(backupDir, "manifest.json");
const mainPath = path.join(backupDir, "main.js");
const manifestEntry = readEntryIfPresent(manifestPath);
const mainEntry = readEntryIfPresent(mainPath);
if (!manifestEntry) {
  fail(`${manifestPath} 缺失或无法解析出插件 id，无法确定还原位置。`);
}
requireRegularFile(manifestEntry);
const backupManifest = readJson(manifestPath);
if (!backupManifest) fail(`${manifestPath} 缺失或无法解析出插件 id，无法确定还原位置。`);
const restoredId = validatePluginId(backupManifest.id);
if (!restoredId) fail("备份 manifest.json 的插件 id 不是安全的单目录名，已停止还原。");
if (!mainEntry) fail(`${mainPath} 不存在：这不是一个可用的插件备份。`);
requireRegularFile(mainEntry);
const restoredVersion = String(backupManifest.version || "");

const vaultInput = path.resolve(vaultArg.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
if (!readEntryIfPresent(vaultInput)) fail(`知识库目录不存在或不是目录：${vaultInput}`);
const vault = realDirectory(vaultInput);
const configPath = path.join(vault, ".obsidian");
const configEntry = readEntryIfPresent(configPath);
if (!configEntry) fail(`没有找到 ${configPath}，请确认这是 Obsidian 知识库根目录。`);
requireDirectory(configEntry);
const configDir = realDirectory(configPath);
const pluginsDir = path.join(configDir, "plugins");
const pluginsEntry = readEntryIfPresent(pluginsDir);
if (pluginsEntry) requireDirectory(pluginsEntry);
const targetDir = path.resolve(pluginsDir, restoredId);
ensureStrictChild(pluginsDir, targetDir, restoredId);
const targetEntry = readEntryIfPresent(targetDir);
if (targetEntry) requireDirectory(targetEntry);

// 从 vault 派生的目录不得经过符号链接或 junction；输入的根目录本身允许是链接别名。
const backupRoot = path.join(configDir, BACKUP_ROOT);
const backupRootEntry = readEntryIfPresent(backupRoot);
if (backupRootEntry) requireDirectory(backupRootEntry);
const enabledPath = path.join(configDir, ENABLED_FILE);
const enabled = readJson(enabledPath);
const otherIds = pluginsEntry
  ? readdirSync(pluginsDir).filter(name => {
      if (name === restoredId || name !== "qnalog") return false;
      const pluginEntry = readEntryIfPresent(path.join(pluginsDir, name));
      if (!pluginEntry?.isDirectory()) return false;
      return readEntryIfPresent(path.join(pluginsDir, name, "manifest.json"))?.isFile() ?? false;
    })
  : [];
const setEnabled = process.argv.includes("--set-enabled");
const activeIdList = Array.isArray(enabled)
  ? enabled.filter(id => typeof id === "string" && (id === restoredId || otherIds.includes(id)))
  : [];
const writeEnabled = Array.isArray(enabled) && !activeIdList.includes(restoredId) && setEnabled;

const operationStamp = timestamp();
let safetyDir = "";
if (targetEntry) safetyDir = path.join(backupRoot, `${operationStamp}-before-restore`);
const enabledBackupPath = writeEnabled ? `${enabledPath}.bak-${operationStamp}` : "";

if (targetEntry) inspectTree(targetDir, true);
inspectTree(backupDir, false);
if (!isPathWithin(backupDir, targetDir) && !isPathWithin(targetDir, backupDir)) {
  // Independent trees may proceed.
} else {
  fail(OVERLAP_MESSAGE);
}
if (safetyDir) {
  if (!isPathWithin(backupRoot, safetyDir) || safetyDir === backupRoot) fail(OVERLAP_MESSAGE);
  if (isPathWithin(backupDir, safetyDir) || isPathWithin(safetyDir, backupDir)
    || isPathWithin(targetDir, safetyDir) || isPathWithin(safetyDir, targetDir)) fail(OVERLAP_MESSAGE);
  if (readEntryIfPresent(safetyDir)) fail(OVERLAP_MESSAGE);
}
if (writeEnabled) {
  const enabledEntry = readEntryIfPresent(enabledPath);
  requireRegularFile(enabledEntry);
  if (enabledEntry.nlink > 1 || readEntryIfPresent(enabledBackupPath)) fail(UNSAFE_PATH_MESSAGE);
}

// 所有路径、链接、文件类型与留档冲突检查均在首次写入之前完成。
if (safetyDir) {
  mkdirSync(safetyDir, { recursive: true });
  cpSync(targetDir, safetyDir, { recursive: true });
  console.log(`[restore] 当前 ${restoredId} 目录已另存 → ${safetyDir}`);
}
mkdirSync(targetDir, { recursive: true });
cpSync(backupDir, targetDir, { recursive: true });

console.log(`[restore] 已还原 ${restoredId} ${restoredVersion}（${countFiles(backupDir)} 个文件）→ ${targetDir}`);

// 从“还原后的内容”判断是否需要提示设置结构差异，而不是靠调用方传参。
const restoredSettings = readJson(path.join(targetDir, "data.json"));
const restoredSchemaValue = restoredSettings && typeof restoredSettings === "object"
  ? (restoredSettings.settings && typeof restoredSettings.settings === "object"
      ? restoredSettings.settings.schemaVersion
      : restoredSettings.schemaVersion)
  : undefined;
const restoredSchema = Number(restoredSchemaValue);
if (Number.isFinite(restoredSchema)) {
  console.log(`[restore] 该备份的 data.json 设置结构版本：${restoredSchema}。下次加载插件时，若与当前版本不一致，插件会丢弃这份设置、改用默认值并给出通知。`);
} else {
  console.log("[restore] 该备份不含可解析的 data.json：当前设置文件保持原样，插件会沿用现有设置。");
}

if (Array.isArray(enabled) && !activeIdList.includes(restoredId)) {
  const lines = [
    `[restore] 注意：Obsidian 的启用列表里当前是 ${activeIdList.length ? activeIdList.join("、") : "（未启用相关插件）"}，不是 ${restoredId}。`,
    "[restore] 建议在 Obsidian 界面里切换（设置 → 第三方插件）：停用另一个，启用 " + restoredId + "。",
    "[restore] 也可以加 --set-enabled 让本脚本改写 community-plugins.json；Obsidian 正在运行时该改动可能被它覆盖，改完需要重新加载。",
  ];
  if (writeEnabled) {
    const next = enabled.filter(id => !(typeof id === "string" && otherIds.includes(id)));
    if (!next.includes(restoredId)) next.push(restoredId);
    cpSync(enabledPath, enabledBackupPath);
    writeFileSync(enabledPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(`[restore] 已改写 ${ENABLED_FILE}：启用 ${restoredId}，停用 ${otherIds.join("、") || "（无）"}（原文件已备份为 .bak-<时间戳>）`);
  } else {
    for (const line of lines) console.log(line);
  }
}

console.log("[restore] 下一步：在 Obsidian 中重新加载（Ctrl/Cmd + R）。");
if (safetyDir) console.log(`[restore] 如需撤销本次还原，再执行一次：npm run restore:vault -- "${safetyDir}" "${vault}"`);
