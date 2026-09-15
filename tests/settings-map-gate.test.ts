import { describe, expect, it } from "vitest";
import { checkSettingsMap, parseMapTable, parseSerializeMap } from "../scripts/check-settings-map.mjs";

// 设置映射表（MAINTAINING.md §9.1）是「改设置界面之前先看现状」的依据，
// 它一旦与代码脱节就会把人引到错误的分组上。这里验证门禁本身拦得住三种漂移，
// 并反向验证它不会对无关改动（文案、顺序）误报。
const TYPE_SOURCE = `
export interface PluginSettings {
  alphaFolder: string;
  betaLevel: "loose" | "balanced";
  gammaMode: string;
}
`;

const SERIALIZE_SOURCE = `
export function serializePluginSettings(s: PluginSettings) {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    storage: {
      alphaPath: s.alphaFolder,
      nested: {
        deepPath: s.betaLevel,
      },
    },
    composer: {
      mode: s.gammaMode || "balanced",
    },
    // providers: s.transcribeProviders || {},   ← 注释掉的登记不算数
  };
}

export function extractJobItems(savedData: unknown) {
  return [];
}
`;

const GOOD = [
  "### 9.1 逐键映射",
  "",
  "| 设置键 | 默认值 | 落盘位置 | 读回别名 | 作用 | 现入口 | 拟归属 |",
  "|---|---|---|---|---|---|---|",
  "| `alphaFolder` | `\"\"` | `storage.alphaPath` | — | a | 常规 | 基本设置 |",
  "| `betaLevel` | `\"balanced\"` | `storage.nested.deepPath` | — | b | AI 整理 | 高级 · 输出 |",
  "| `gammaMode` | `\"\"` | `composer.mode` | `old.mode` | c | API | 基本设置 |",
  "",
  "### 9.2 拟定",
].join("\n");

describe("设置映射表门禁", () => {
  it("一致的表格通过", () => {
    expect(checkSettingsMap({ typeSource: TYPE_SOURCE, settingsIoSource: SERIALIZE_SOURCE, markdown: GOOD })).toEqual([]);
  });

  it("代码新增设置键、表里没有 → 拦下", () => {
    const typeSource = TYPE_SOURCE.replace("  gammaMode: string;\n", "  gammaMode: string;\n  deltaFlag: boolean;\n");
    const found = checkSettingsMap({ typeSource, settingsIoSource: SERIALIZE_SOURCE, markdown: GOOD });
    expect(found.some((line) => line.includes("deltaFlag"))).toBe(true);
  });

  it("表里有、代码已删除 → 拦下", () => {
    const typeSource = TYPE_SOURCE.replace("  betaLevel: \"loose\" | \"balanced\";\n", "");
    const found = checkSettingsMap({ typeSource, settingsIoSource: SERIALIZE_SOURCE, markdown: GOOD });
    expect(found.some((line) => line.includes("betaLevel"))).toBe(true);
  });

  it("落盘路径改过 → 拦下", () => {
    const markdown = GOOD.replace("`storage.alphaPath`", "`storage.alphaPathOld`");
    const found = checkSettingsMap({ typeSource: TYPE_SOURCE, settingsIoSource: SERIALIZE_SOURCE, markdown });
    expect(found.some((line) => line.includes("alphaFolder"))).toBe(true);
  });

  it("嵌套分组路径按层级拼出，不会被同行值里的花括号带偏", () => {
    const source = `
export function serializePluginSettings(s) {
  return {
    speech: {
      asrConcurrency: s.concurrency,
      providers: s.providers || {},
    },
    retryPolicy: {
      maxAttempts: s.maxRetries,
    },
  };
}

export function extractJobItems(x) { return []; }
`;
    const map = parseSerializeMap(source);
    expect(map.get("providers")).toBe("speech.providers");
    expect(map.get("maxRetries")).toBe("retryPolicy.maxAttempts");
  });

  it("只读表体，不认 §9.1 之前的同名表格", () => {
    const stray = "| `ghostKey` | `1` | `ghost.path` | — | x | y | z |\n" + GOOD;
    const rows = parseMapTable(stray);
    expect(rows.has("ghostKey")).toBe(false);
    expect(rows.get("alphaFolder")).toBe("storage.alphaPath");
  });
});
