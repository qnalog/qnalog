// 把本仓库的构建产物安装到指定 Obsidian 知识库。
// 用法：npm run install:vault -- "<知识库路径>"
//
// 本插件的 id 是 qnalog，与上游 lexvoice（Obsidian 社区目录中的专有版本）以及此前的
// lexvoice-mit 都不同：id 若与社区目录条目相同，Obsidian 会把上游版本提示为更新，
// 一次误点就会覆盖本项目。
//
// 覆盖前把目标插件目录整份留档，并在首次安装时按优先级沿用已有插件的设置（data.json）。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildIdentity } from "./build-identity.mjs";

const PLUGIN_ID = "qnalog";
const UPSTREAM_PLUGIN_ID = "lexvoice";
const BACKUP_ROOT = "qnalog-install-backups";
// LICENSE 随插件一起安装：MIT 要求副本随附版权与许可声明。
const ARTIFACTS = ["main.js", "manifest.json", "styles.css", "LICENSE", "NOTICE"];
// 开发构建的标识文件（仅由本脚本写入知识库；仓库里不存在，也不进版本控制）。
const BUILD_INFO_FILE = "build-info.json";
const BACKUP_FILES = [...ARTIFACTS, "data.json"];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`[install] ${message}`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function compareVersions(a, b) {
  const left = String(a).split(".").map(part => Number.parseInt(part, 10) || 0);
  const right = String(b).split(".").map(part => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function timestamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const vaultArg = process.argv.slice(2).find(arg => arg !== "--") ?? process.env.QNALOG_VAULT ?? "";
if (!vaultArg.trim()) {
  fail(`缺少知识库路径。

用法：npm run install:vault -- "<知识库路径>"
也可以设置环境变量：QNALOG_VAULT="<知识库路径>" npm run install:vault

路径应当是包含 .obsidian 目录的知识库根目录。`);
}

const vault = path.resolve(vaultArg.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
if (!existsSync(vault) || !statSync(vault).isDirectory()) {
  fail(`知识库路径不存在或不是目录：${vault}`);
}
const configDir = path.join(vault, ".obsidian");
if (!existsSync(configDir) || !statSync(configDir).isDirectory()) {
  fail(`没有找到 ${configDir}，请确认这是 Obsidian 知识库根目录。`);
}

const missing = ARTIFACTS.filter(name => !existsSync(path.join(repoRoot, name)));
if (missing.length) {
  fail(`缺少发布文件：${missing.join("、")}。main.js 等产物请先运行 npm run build。`);
}

const manifest = readJson(path.join(repoRoot, "manifest.json"));
if (manifest.id !== PLUGIN_ID) {
  fail(`manifest.json 的 id 是 ${JSON.stringify(manifest.id)}，预期 ${PLUGIN_ID}；目录名必须与 id 一致才能沿用设置。`);
}

const pluginsDir = path.join(configDir, "plugins");
const targetDir = path.join(pluginsDir, PLUGIN_ID);
const upstreamDir = path.join(pluginsDir, UPSTREAM_PLUGIN_ID);
const installedManifestPath = path.join(targetDir, "manifest.json");
const installedVersion = existsSync(installedManifestPath)
  ? (() => {
      try {
        return String(readJson(installedManifestPath).version || "");
      } catch {
        return "";
      }
    })()
  : "";

let backupDir = "";
if (existsSync(targetDir)) {
  const present = BACKUP_FILES.filter(name => existsSync(path.join(targetDir, name)));
  if (present.length) {
    // 备份放在 plugins/ 之外：Obsidian 会扫描 plugins/*/manifest.json，
    // 备份目录里的 manifest.json 会被当成一个同 id 的插件。
    // 整目录快照（含 topic-memory.json、briefing-checkpoints 等运行期状态），
    // 这样 `npm run restore:vault` 能把插件目录完整还原，而不只是几个代码文件。
    backupDir = path.join(configDir, BACKUP_ROOT, timestamp());
    mkdirSync(backupDir, { recursive: true });
    cpSync(targetDir, backupDir, { recursive: true });
    console.log(`[install] 已备份现有插件目录（${present.length} 个文件）→ ${backupDir}`);
  }
}

mkdirSync(targetDir, { recursive: true });
for (const name of ARTIFACTS) {
  cpSync(path.join(repoRoot, name), path.join(targetDir, name));
}

// 开发分支编译出的构建：把构建标识写进知识库里这份 manifest，这样 Obsidian 自己的
// 插件列表也能看出当前跑的是开发版，而不只是插件设置页。
// 只改知识库里的副本；仓库里的 manifest.json 保持发版身份不变（CI 会校验它与
// package.json / package-lock.json / versions.json 一致）。
const buildIdentity = resolveBuildIdentity();
if (buildIdentity.channel === "dev") {
  const stampedPath = path.join(targetDir, "manifest.json");
  const stamped = readJson(stampedPath);
  stamped.version = buildIdentity.displayVersion;
  writeFileSync(stampedPath, `${JSON.stringify(stamped, null, 2)}\n`);
  // 插件启动时读这个文件来显示构建来源，所以它必须与 manifest 一起安装；
  // 通过 Obsidian / BRAT 安装的正式发布没有它，此时显示 manifest 版本即可。
  writeFileSync(path.join(targetDir, BUILD_INFO_FILE), `${JSON.stringify({
    version: buildIdentity.version,
    displayVersion: buildIdentity.displayVersion,
    channel: buildIdentity.channel,
    branch: buildIdentity.branch,
    sha: buildIdentity.sha,
    dirty: buildIdentity.dirty,
    builtAt: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(`[install] 开发构建：知识库中的 manifest 版本标为 ${buildIdentity.displayVersion}
[install] （分支 ${buildIdentity.branch}${buildIdentity.dirty ? "，有未提交改动" : ""}；仓库里的 manifest.json 仍是 ${buildIdentity.version}）`);
} else {
  // 发版构建：清掉上一次开发安装留下的标识文件。
  // 不清的话，知识库里的 manifest 与产物都是发版版本，唯独这个文件还写着开发标识，
  // 设置页会一直显示 "x.y.z-dev.<分支>.<提交>"，与另外两处对不上（§4.1.1 要求开发标识只出现在开发安装里）。
  const staleBuildInfo = path.join(targetDir, BUILD_INFO_FILE);
  if (existsSync(staleBuildInfo)) {
    rmSync(staleBuildInfo, { force: true });
    console.log(`[install] 发版构建：已移除上一次开发安装留下的 ${BUILD_INFO_FILE}`);
  }
}

// 首次安装时沿用已有插件的设置：data.json 跟着插件目录走，id 变了就默认读不到旧设置。
// 按优先级取第一个有设置的目录：lexvoice-mit（本项目前身，设置已是当前 schema，直接可用）
// → lexvoice（上游版，需要一次降级迁移）。
const ADOPT_FROM_IDS = ["lexvoice-mit", UPSTREAM_PLUGIN_ID];
const targetSettings = path.join(targetDir, "data.json");
const adoptDir = existsSync(targetSettings)
  ? null
  : ADOPT_FROM_IDS.map(id => path.join(pluginsDir, id)).find(dir => existsSync(path.join(dir, "data.json"))) || null;
const upstreamDirToArchive = adoptDir === upstreamDir ? upstreamDir : null;
let migrated = false;
if (adoptDir) {
  cpSync(path.join(adoptDir, "data.json"), targetSettings);
  migrated = true;
  console.log(`[install] 已沿用已有插件的设置：${path.join(adoptDir, "data.json")} → ${targetSettings}`);
}
if (upstreamDirToArchive) {
  // 顺手把上游插件目录整份留档：README 建议用户确认不需要后删掉它，
  // 删掉之后就没有回到闭源版本的路了。有了这份快照，`npm run restore:vault` 就能还原。
  const upstreamManifest = path.join(upstreamDir, "manifest.json");
  const upstreamId = existsSync(upstreamManifest) ? String(readJson(upstreamManifest).id || UPSTREAM_PLUGIN_ID) : UPSTREAM_PLUGIN_ID;
  const upstreamBackup = path.join(configDir, BACKUP_ROOT, `${timestamp()}-upstream-${upstreamId}`);
  mkdirSync(upstreamBackup, { recursive: true });
  cpSync(upstreamDir, upstreamBackup, { recursive: true });
  console.log(`[install] 已留档上游插件目录 → ${upstreamBackup}
[install] 需要回到该版本时：npm run restore:vault -- "${upstreamBackup}" "${vault}"`);
}

console.log(`[install] 已安装 QnALog ${manifest.version} → ${targetDir}`);
if (installedVersion && compareVersions(installedVersion, manifest.version) > 0) {
  console.log(`[install] 注意：覆盖的是更高版本 ${installedVersion}（降级安装）。
[install] 本项目按 2.1.2 线的设置结构重写 data.json，上游 2.2.0 起新增的设置分组（如 services 连接与任务绑定）会在首次加载时被丢弃。
[install] 转写与 LLM 服务配置（speech.providers、composer）会保留。
[install] 首次加载时插件会给出迁移报告（通知 + 诊断日志），列出被丢弃的分组与需要重新选择的服务。
[install] 如需回退到 ${installedVersion}：npm run restore:vault -- "${backupDir || "<备份目录>"}"`);
} else if (installedVersion) {
  console.log(`[install] 覆盖了原有版本 ${installedVersion}。data.json 由插件自身处理，请确认设置仍然正确。
[install] 如需回退：npm run restore:vault -- "${backupDir || "<备份目录>"}"`);
}
if (existsSync(upstreamDir)) {
  console.log(`[install] 检测到上游插件目录仍存在：${upstreamDir}
[install] Obsidian 社区目录里的 LexVoice 是上游闭源版本，会继续提示它自己的更新。若不再需要，请在 Obsidian 中停用它并删除该目录。`);
}
console.log(`[install] 下一步：重新加载 Obsidian（Ctrl/Cmd + R），在「设置 → 第三方插件」中启用 QnALog。`);
