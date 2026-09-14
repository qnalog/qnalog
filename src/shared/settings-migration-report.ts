// 设置迁移结果自检：把「这次加载对 data.json 做了什么」如实报出来。
//
// 为什么需要：设置是按**重建式白名单**写回的（serializeLexVoiceSettings 返回全新对象），
// 任何没有登记的键会在下一次保存时静默消失。从更新过的版本回退时（例如上游 2.2.0+
// 的 schemaVersion 5 → 本版本 4），用户只会看到"某些设置不见了"，却不知道少了什么、
// 要重新填什么。这里在迁移发生的那一刻给出对照表：丢掉了哪些分组、保留了哪些、
// 需要用户手动做什么。

export type MigrationDirection = "upgrade" | "downgrade" | "same";

export interface SettingsMigrationReport {
  savedVersion: number;
  currentVersion: number;
  direction: MigrationDirection;
  /** 磁盘上有、写回时被丢弃的顶层分组 */
  droppedGroups: string[];
  /** 磁盘上有、写回后仍在的顶层分组 */
  keptGroups: string[];
  /** 需要用户处理的事项（自然语言，可直接展示） */
  actions: string[];
  /** 一行摘要，用于通知 */
  summary: string;
  /** 多行详情，用于诊断日志 */
  details: string;
}

// 已知分组被丢弃后的后果说明。键是磁盘上的顶层分组名。
const DROPPED_GROUP_ACTIONS: Record<string, string> = {
  services: "「任务与服务的绑定」（实时转写 / 会后导入转写 / AI 整理分别使用哪个服务）不再被本版本读取。"
    + "服务条目与访问密钥本身已保留，但需要到「设置 → QnALog (MIT) → 转写服务 / 导入音频 / AI 整理」重新选择一次。",
  recruiting: "招聘与晋升评审场景已从本版本移除，这一组设置不再被读取。"
    + "已有的招聘/晋升笔记文件不会被删除或改写；如需继续使用这些场景，请停留在旧版本。",
  promotionReview: "招聘与晋升评审场景已从本版本移除，这一组设置不再被读取。"
    + "已有的招聘/晋升笔记文件不会被删除或改写；如需继续使用这些场景，请停留在旧版本。",
};

// 已知分组被保留后的说明（让用户知道不必重填什么）。
const KEPT_GROUP_NOTES: Record<string, string> = {
  speech: "转写服务配置与访问密钥已保留",
  composer: "AI 整理服务与访问密钥已保留",
  vocabulary: "热词表与人员/学习卡片目录已保留",
  storage: "保存路径与收件箱设置已保留",
};

const DIRECTION_LABEL: Record<MigrationDirection, string> = {
  upgrade: "按更新后的结构重写",
  downgrade: "按较早的结构重写",
  same: "结构一致",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysOf(value: unknown): string[] {
  return isPlainObject(value) ? Object.keys(value).filter(key => key !== "schemaVersion") : [];
}

// savedSettings：磁盘上的 settings 对象（迁移前）
// writtenSettings：本次写回磁盘的 settings 对象（迁移后）
export function buildSettingsMigrationReport(
  savedSettings: unknown,
  writtenSettings: unknown,
  versions: { savedVersion: number; currentVersion: number },
): SettingsMigrationReport | null {
  const { savedVersion, currentVersion } = versions;
  const written = keysOf(writtenSettings);
  const saved = keysOf(savedSettings);
  const droppedGroups = saved.filter(key => !written.includes(key));
  const keptGroups = saved.filter(key => written.includes(key));

  // 旧版平铺结构（无 schemaVersion）本来就是靠迁移转成分组的，
  // 逐键比对只会在那个阶段误报，因此只在分组结构时代给出报告。
  if (!Number.isFinite(savedVersion) || savedVersion < 1) return null;

  const direction: MigrationDirection = savedVersion > currentVersion
    ? "downgrade"
    : savedVersion < currentVersion
      ? "upgrade"
      : "same";

  if (direction === "same" && droppedGroups.length === 0) return null;

  const actions: string[] = [];
  for (const group of droppedGroups) {
    actions.push(DROPPED_GROUP_ACTIONS[group]
      ?? `「${group}」分组不再被本版本读取，其中的设置已失效。`);
  }
  if (direction === "downgrade") {
    actions.push("本版本比磁盘上的设置结构旧：写回后无法再还原被丢弃的分组。"
      + "如需要，可从安装前的备份取回 data.json（安装脚本会打印留档位置，位于配置目录下的 `lexvoice-install-backups/<时间戳>/`）。");
  }
  const keptNotes = keptGroups
    .filter(group => KEPT_GROUP_NOTES[group])
    .map(group => KEPT_GROUP_NOTES[group]);

  // 通知里只放"是什么 + 丢了什么 + 有几组保住了"，保留明细进诊断日志：
  // 逐组列举会把通知挤成一段墙，反而看不清重点。
  const summaryParts = [
    `QnALog 设置结构 ${savedVersion} → ${currentVersion}（${DIRECTION_LABEL[direction]}）`,
    droppedGroups.length ? `已丢弃：${droppedGroups.join("、")}` : "无分组被丢弃",
    keptGroups.length ? `已保留 ${keptGroups.length} 个分组` : "",
    actions.length ? "详情见诊断日志" : "",
  ].filter(Boolean);

  const details = [
    `设置结构：${savedVersion} → ${currentVersion}（${DIRECTION_LABEL[direction]}）`,
    `被丢弃的分组：${droppedGroups.length ? droppedGroups.join("、") : "无"}`,
    `保留的分组：${keptGroups.length ? keptGroups.join("、") : "无"}`,
    keptNotes.length ? `保留内容说明：\n${keptNotes.map(line => `- ${line}`).join("\n")}` : "",
    actions.length ? `需要处理：\n${actions.map(line => `- ${line}`).join("\n")}` : "需要处理：无",
  ].filter(Boolean).join("\n");

  return {
    savedVersion,
    currentVersion,
    direction,
    droppedGroups,
    keptGroups,
    actions,
    summary: summaryParts.join("；"),
    details,
  };
}
