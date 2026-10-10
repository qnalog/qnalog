import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class {}, TFolder: class {},
}));
import {
  SETTINGS_MIGRATIONS,
  classifySettingsSchema,
  hasStoredSettings,
  migrateSettingsForward,
  readSavedSchemaVersion,
} from "../src/shared/settings-schema";
import { SETTINGS_SCHEMA_VERSION } from "../src/shared/settings-io";

// 这组测试钉住 1.0.0 之后的设置政策：正式用户的配置**不能**因为结构变更被清空。
// 反例是 1.0.0 发布时的实现——版本不一致就整份丢弃。那个策略只在「没有用户」时成立。
describe("设置结构版本政策", () => {
  it("版本一致 → current，直接读回", () => {
    expect(classifySettingsSchema({ settings: { schemaVersion: SETTINGS_SCHEMA_VERSION } })).toBe("current");
    expect(classifySettingsSchema({ schemaVersion: SETTINGS_SCHEMA_VERSION })).toBe("current");
  });

  it("版本更高 → future（用户回退了插件，不得写盘）", () => {
    expect(classifySettingsSchema({ settings: { schemaVersion: SETTINGS_SCHEMA_VERSION + 1 } })).toBe("future");
    expect(classifySettingsSchema({ settings: { schemaVersion: 99 } })).toBe("future");
  });

  it("1.0.0 及以后的历史版本 → migrate（必须迁移，不得丢弃）", () => {
    expect(classifySettingsSchema({ settings: { schemaVersion: 1 } })).toBe(
      SETTINGS_SCHEMA_VERSION === 1 ? "current" : "migrate",
    );
  });

  it("无版本号 / 无法识别 → foreign（pre-1.0、别的项目、损坏）", () => {
    for (const saved of [undefined, null, {}, { settings: {} }]) {
      expect(classifySettingsSchema(saved), JSON.stringify(saved)).toBe("foreign");
    }
  });

  it("版本号非数字 → foreign，不猜成 0 之外的任何版本", () => {
    expect(classifySettingsSchema({ settings: { schemaVersion: "x" } })).toBe("foreign");
    expect(classifySettingsSchema({ settings: { schemaVersion: null } })).toBe("foreign");
  });

  it("版本读取兼容两种落盘形态（分组内 / 顶层平铺）", () => {
    expect(readSavedSchemaVersion({ settings: { schemaVersion: 7 } })).toBe(7);
    expect(readSavedSchemaVersion({ schemaVersion: 7 })).toBe(7);
    expect(readSavedSchemaVersion(undefined)).toBe(0);
  });

  it("空对象不算有内容，不触发留档", () => {
    expect(hasStoredSettings({})).toBe(false);
    expect(hasStoredSettings(null)).toBe(false);
    expect(hasStoredSettings({ settings: { schemaVersion: 1 } })).toBe(true);
  });
});

// 迁移链的行为契约。用假迁移验证「逐层执行、结果合并、缺链拒绝」，
// 不依赖当前是否已有真实迁移步骤。
describe("向前迁移", () => {
  it("current / future / foreign 不产生迁移结果", () => {
    for (const saved of [
      { settings: { schemaVersion: SETTINGS_SCHEMA_VERSION } },
      { settings: { schemaVersion: SETTINGS_SCHEMA_VERSION + 1 } },
      {},
    ]) {
      const out = migrateSettingsForward(saved);
      expect(out.settings, JSON.stringify(saved)).toBeNull();
      expect(out.path).toEqual([]);
    }
  });

  it("缺少迁移步骤时拒绝产出半成品，调用方据此不写盘", () => {
    const version = SETTINGS_SCHEMA_VERSION - 1;
    const original = SETTINGS_MIGRATIONS[version];
    delete SETTINGS_MIGRATIONS[version];
    try {
      const out = migrateSettingsForward({ settings: { schemaVersion: version, 用户数据: "保留" } });
      expect(out.state).toBe("migrate");
      expect(out.settings).toBeNull();
      expect(out.path).toEqual([]);
    } finally {
      if (original !== undefined) SETTINGS_MIGRATIONS[version] = original;
    }
  });

  it("1 → 2 迁移增加 SecretStorage 命名空间并保留现有用户配置", () => {
    const out = migrateSettingsForward({
      settings: {
        schemaVersion: 1,
        speech: { compatApiKey: "transcribe-key", providers: { openai: { apiKey: "provider-key" } } },
        composer: { apiKey: "llm-key", profiles: [{ id: "p1", apiKey: "profile-key" }] },
        prompts: { custom: "keep" },
        storage: { topicsFolder: "My Topics" },
      },
    });
    expect(out.state).toBe("migrate");
    expect(out.settings?.security).toEqual({ apiKeyStorageNamespace: "" });
    expect(out.settings?.speech).toEqual({ compatApiKey: "transcribe-key", providers: { openai: { apiKey: "provider-key" } } });
    expect(out.settings?.composer).toEqual({ apiKey: "llm-key", profiles: [{ id: "p1", apiKey: "profile-key" }] });
    expect(out.settings?.prompts).toEqual({ custom: "keep" });
    expect(out.settings?.storage).toEqual({ topicsFolder: "My Topics" });
    expect(out.settings?.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(out.path).toEqual([2]);
  });

  it("迁移保留用户既有字段（不是重建默认值）", () => {
    // 临时注册一条 1 → 2 的迁移，验证行为而非当前清单。
    const original = SETTINGS_MIGRATIONS[1];
    SETTINGS_MIGRATIONS[1] = (s) => ({ ...s, 新字段: "新默认值" });
    try {
      if (SETTINGS_SCHEMA_VERSION >= 2) {
        const out = migrateSettingsForward({ settings: { schemaVersion: 1, composer: { apiKey: "用户填的密钥" } } });
        expect(out.settings?.composer).toEqual({ apiKey: "用户填的密钥" });
        expect(out.settings?.新字段).toBe("新默认值");
        expect(out.settings?.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
        expect(out.path).toEqual(SETTINGS_SCHEMA_VERSION === 2 ? [2] : [2, 3]);
      }
    } finally {
      if (original === undefined) delete SETTINGS_MIGRATIONS[1];
      else SETTINGS_MIGRATIONS[1] = original;
    }
  });
});
