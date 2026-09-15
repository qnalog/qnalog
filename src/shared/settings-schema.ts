// 设置结构版本检查。
//
// Q&A Log 是独立项目：不承接任何历史项目的设置与数据。版本号与当前值不一致的
// data.json（别的插件写的、旧版本写的、改坏的）一律丢弃，改用默认值重建。
//
// 丢弃是整份丢弃，不做逐键迁移：逐键迁移意味着代码里要长期保留对旧格式的理解，
// 而这些格式不属于本项目。用户在设置页重新配置一次即可。

import { SETTINGS_SCHEMA_VERSION } from "./settings-io";

/** 从磁盘数据里读出版本号；缺省或不是有限数时返回 0。 */
export function readSavedSchemaVersion(savedData: unknown): number {
  if (!savedData || typeof savedData !== "object") return 0;
  const saved = savedData as Record<string, unknown>;
  const settings = saved.settings && typeof saved.settings === "object" && !Array.isArray(saved.settings)
    ? saved.settings as Record<string, unknown>
    : saved;
  const value = settings.schemaVersion !== undefined ? settings.schemaVersion : saved.schemaVersion;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/** 磁盘上的设置是不是本版本写的。false 表示调用方应当丢弃它，用默认值重建。 */
export function isCurrentSettingsSchema(savedData: unknown): boolean {
  return readSavedSchemaVersion(savedData) === SETTINGS_SCHEMA_VERSION;
}
