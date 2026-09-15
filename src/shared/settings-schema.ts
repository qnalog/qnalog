// 设置结构版本政策。
//
// 两层规则，分界线是 2026-09-15 的 1.0.0 发布：
//
// 1. **pre-1.0 / 别的项目**：Q&A Log 是独立项目，不承接它们的数据。
//    无法识别来源的 data.json 一律丢弃、按默认值重建——但**先留档**，
//    因为正式用户也可能因同步冲突或手工编辑拿到一份坏文件。
// 2. **1.0.0 及以后**：用户存在。版本向前走时**必须迁移**，不得丢弃。
//    从这一版起，`SETTINGS_SCHEMA_VERSION` 每次递增都要在 MIGRATIONS 里补一段，
//    把上一版的设置改写成当前结构。用户自己填的 API Key、服务配置、提示词、
//    路径与设备选择都是他们的财产，不能因为结构变更就清空。
//
// 三种方向的处理：
//
//   saved < current   → 依次跑迁移链，保留用户数据
//   saved = current   → 直接读回
//   saved > current   → **不写盘**。用户回退了插件版本，磁盘上是新版写的设置；
//                       此时按旧结构读、再整份写回，会把新版新增的字段洗掉。
//                       保留原文件不动，只提示用户升级插件或保持现状。

import { SETTINGS_SCHEMA_VERSION } from "./settings-io";

/** 磁盘设置的来源判定。 */
export type SettingsSchemaState =
  /** 版本与当前一致：直接读回。 */
  | "current"
  /** 版本更低且可迁移：跑迁移链。 */
  | "migrate"
  /** 版本更高：用户回退了插件版本，不得写盘。 */
  | "future"
  /** 无法识别来源（别的项目、损坏、无版本号）：丢弃并先留档。 */
  | "foreign";

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

/** data.json 里有没有实质内容（空对象 = 全新安装，不算 foreign）。 */
export function hasStoredSettings(savedData: unknown): boolean {
  if (!savedData || typeof savedData !== "object" || Array.isArray(savedData)) return false;
  return Object.keys(savedData).length > 0;
}

/**
 * 判定磁盘设置的处理方式。
 *
 * `0`（无版本号）一律算 foreign：本项目的 1.0.0 起所有 data.json 都带版本号，
 * 没有版本号的东西不可能是本项目写的。这也是 pre-1.0 与 LexVoice 遗留数据的出口。
 */
export function classifySettingsSchema(savedData: unknown): SettingsSchemaState {
  const version = readSavedSchemaVersion(savedData);
  if (version === SETTINGS_SCHEMA_VERSION) return "current";
  if (version > SETTINGS_SCHEMA_VERSION) return "future";
  if (version >= 1) return "migrate";
  return "foreign";
}

/**
 * 迁移链：把 `from` 版的设置改写成 `from + 1` 版。
 *
 * 每一步只负责自己那一次结构变更，返回值合并进设置对象。
 * 1.0.0 之后新增结构变更时：
 *   1. `SETTINGS_SCHEMA_VERSION` +1；
 *   2. 在下面登记一个 `[旧版本, 迁移函数]`；
 *   3. 在 `tests/settings-migration.test.ts` 里加一条「旧 data.json → 用户配置仍在」的用例。
 *
 * **不要**在这里处理 pre-1.0 / LexVoice 的数据：那些版本走 foreign 分支。
 */
export const SETTINGS_MIGRATIONS: Record<number, (settings: Record<string, unknown>) => Record<string, unknown>> = {
  // 尚无 1.0.0 之后的变更。下一版在此登记：
  // 1: (s) => ({ ...s, 新字段: 默认值 }),
};

export interface SettingsMigrationOutcome {
  state: SettingsSchemaState;
  /** 迁移经过的版本，供诊断与通知展示，例如 [1, 2, 3]。 */
  path: number[];
  /** 逐层迁移后的设置；state 为 current/migrate 时使用。 */
  settings: Record<string, unknown> | null;
}

/**
 * 按需逐层迁移到当前版本。
 *
 * 缺链（例如磁盘是 1 而当前是 3，但只登记了 2→3）时返回 `null` 设置并保持
 * `state: "migrate"`，调用方据此拒绝写盘——宁可让用户停在可读状态，
 * 也不要用一半的迁移结果覆盖他的配置。
 */
export function migrateSettingsForward(savedData: unknown): SettingsMigrationOutcome {
  const state = classifySettingsSchema(savedData);
  if (state !== "migrate") return { state, path: [], settings: null };

  const raw = savedData as Record<string, unknown>;
  const container = raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)
    ? raw.settings as Record<string, unknown>
    : raw;

  let current: Record<string, unknown> = { ...container };
  const path: number[] = [];
  const from = readSavedSchemaVersion(savedData);
  for (let version = from; version < SETTINGS_SCHEMA_VERSION; version += 1) {
    const step = SETTINGS_MIGRATIONS[version];
    if (!step) return { state: "migrate", path, settings: null };
    current = step(current);
    path.push(version + 1);
  }
  current.schemaVersion = SETTINGS_SCHEMA_VERSION;
  return { state: "migrate", path, settings: current };
}
