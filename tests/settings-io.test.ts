import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

vi.mock("../src/shared/settings-runtime-deps", () => ({
  normalizeAudioInputMode: (value: unknown) => {
    if (value === "mix") return "mix-virtual";
    if (value === "system") return "virtualCable";
    return value === "mic" || value === "mix-virtual" || value === "virtualCable" ? value : "mic";
  },
  normalizeAsrConcurrency: (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(1, Math.min(3, Math.floor(number))) : 1;
  },
  normalizeLlmProfiles: (value: unknown) => Array.isArray(value)
    ? value.filter(item => item !== null && typeof item === "object")
    : [],
  normalizePeopleContextMode: (value: unknown) =>
    value === "hotwords" || value === "localFull" ? value : "privacy",
  normalizePeopleSuggestionIgnores: (value: unknown) => Array.isArray(value) ? value : [],
  normalizePeopleSuggestionCache: (value: unknown) => {
    if (value !== null && typeof value === "object" && "pending" in value && Array.isArray(value.pending)) return value;
    return { pending: [] };
  },
  isCustomPromptModeTemplate: (value: unknown) => {
    if (value === null || typeof value !== "object") return false;
    const template = value as { customMode?: unknown; id?: unknown; mode?: unknown };
    return template.customMode === true && typeof template.id === "string" && template.id === template.mode;
  },
  normalizeKnowledgeExtractionHistory: (value: unknown) => {
    if (value !== null && typeof value === "object" && "vocabulary" in value && "people" in value) return value;
    return { vocabulary: {}, people: {} };
  },
}));

import {
  SETTINGS_SCHEMA_VERSION,
  extractJobItems,
  normalizePluginSettings,
  serializePluginSettings,
} from "../src/shared/settings-io";
import { DEFAULT_LIBRARY_PATHS, DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { PluginSettings } from "../src/shared/types";

// 模拟真实的「保存 → 落盘 → 重启读回」链路：
// saveAll 写 { settings: serialize(...) } 且经过 JSON 深拷贝落盘（saveData），
// loadAll 再 normalizePluginSettings(saved)。JSON round-trip 能同时暴露 undefined 被丢弃等问题。
// （saveAll 里的 API Key 混淆层 transformApiKeyFieldsDeep 包在 serialize 之外、读回时先解混淆，
// 对 normalize/serialize 本身是透明的，故这里按明文测试。）
function roundTrip(settings: PluginSettings): PluginSettings {
  const persisted = JSON.parse(JSON.stringify({ settings: serializePluginSettings(settings) })) as unknown;
  return normalizePluginSettings(persisted);
}

describe("settings-io round-trip（白名单防丢键兜底）", () => {
  it("默认资料目录集中在资料库，诊断日志集中在系统目录", () => {
    expect(DEFAULT_SETTINGS.vocabularyFile).toBe("LexVoice/资料库/词汇表.md");
    expect(DEFAULT_SETTINGS.peopleDirectoryFolder).toBe("LexVoice/资料库/人员");
    expect(DEFAULT_SETTINGS.peopleBaseFile).toBe("LexVoice/资料库/视图/人员库.base");
    expect(DEFAULT_SETTINGS.todoCardsFolder).toBe("LexVoice/资料库/待办");
    expect(DEFAULT_SETTINGS.basesFolder).toBe("LexVoice/资料库/视图");
    expect(DEFAULT_SETTINGS.diagnosticsLogFolder).toBe("LexVoice/系统/诊断日志");
    expect(DEFAULT_LIBRARY_PATHS.archiveFolder).toBe("LexVoice/资料库/归档");
    expect(DEFAULT_LIBRARY_PATHS.duplicatePeopleArchiveFolder).toBe("LexVoice/资料库/归档/重复人员");
    expect(SETTINGS_SCHEMA_VERSION).toBe(6);
  });

  it("serialize 输出携带 schemaVersion", () => {
    const a = normalizePluginSettings({});
    expect(serializePluginSettings(a).schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it("默认设置：DEFAULT_SETTINGS 的每个顶层键都必须在 normalize→serialize→normalize 后原样存活", () => {
    const a = normalizePluginSettings({});
    const b = roundTrip(a);
    // serialize 是重建式白名单：任何没登记的键会在这里现形（b[key] 回退成默认值或丢失）。
    // 若本测试对某个键失败：
    //  - 真属遗漏 → 去 settings-io.ts 的 serialize 登记该键（参照 sedimentAutoExtract 修法）；
    //  - 确属派生/瞬态键 → 在此显式排除并注释原因（当前没有此类键）。
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      expect(b[key], `设置键 "${key}" 在保存-读回 round-trip 后丢失或漂移`).toEqual(a[key]);
    }
  });

  it("非默认值改动：跨分组抽样修改后 round-trip 必须逐项存活", () => {
    const a = normalizePluginSettings({});

    // —— 白名单脚枪第三例（回归钉子）：sedimentAutoExtract 曾因未登记 serialize 而保存即丢 ——
    a.sedimentAutoExtract = true;

    // 字符串路径类
    a.audioFolder = "自定义/录音库";
    a.mdFolder = "自定义/纪要目录";
    a.inboxFolder = "收件箱";
    a.reportBrandName = "测试公司";
    a.customVocabulary = "术语A，术语B";
    a.vocabularyFile = "自定义/词汇表.md";
    a.peopleDirectoryFolder = "自定义/人员";
    a.peopleBaseFile = "自定义/视图/人员库.base";
    a.todoCardsFolder = "自定义/待办";
    a.basesFolder = "自定义/视图";
    a.diagnosticsLogFolder = "自定义/诊断日志";

    // 布尔开关类（含「默认 true 改 false」这种最容易被 || 兜底吃掉的方向）
    a.inboxAutoImport = false;
    a.consolidatedLayout = false;
    a.autoRenameWithTitle = false;
    a.showFloatingBall = false;
    a.enableRealtimeOutline = false;
    a.diagnosticsLogEnabled = false;
    a.autoCheckUpdates = false;
    a.writeDailyMeetingOverview = false;
    a.filterShortRecordings = false;
    a.keepSegmentAudioFiles = true;

    // 数值类
    a.maxRetries = 7;
    a.segmentIntervalMinutes = 10;
    a.asrConcurrency = 2;
    a.realtimeOutlineDebounceMs = 9000;

    // 枚举/受限值类
    a.captureMode = "mix-virtual";
    a.bubbleSize = "small";
    a.thinkingMode = "fast";
    a.peopleContextMode = "hotwords";
    a.polishMode = "meeting";

    // LLM 工作字段 + 配置库
    a.llmEndpoint = "https://llm.example.com/v1/chat/completions";
    a.llmApiKey = "sk-llm-test";
    a.llmModel = "test-model";
    a.llmProfiles = [
      { id: "p1", name: "测试配置", endpoint: "https://llm.example.com/v1", apiKey: "sk-p1", model: "m1" },
    ];
    a.activeLlmProfile = "p1";

    // 转写 provider 注册表（嵌套 bag）
    a.activeTranscribeProvider = "openai";
    a.importTranscribeProvider = "dashscope-filetrans";
    a.importSpeakerDiarization = false;
    a.importSpeakerCount = 4;
    a.transcribeProviders.siliconflow.apiKey = "sk-asr-test";

    // UI 位置对象
    a.floatingBallPos = { left: 10, top: 20 };

    const b = roundTrip(a);

    expect(b.sedimentAutoExtract, "sedimentAutoExtract（历史丢失键回归）").toBe(true);

    expect(b.audioFolder).toBe("自定义/录音库");
    expect(b.mdFolder).toBe("自定义/纪要目录");
    expect(b.inboxFolder).toBe("收件箱");
    expect(b.reportBrandName).toBe("测试公司");
    expect(b.customVocabulary).toBe("术语A，术语B");
    expect(b.vocabularyFile).toBe("自定义/词汇表.md");
    expect(b.peopleDirectoryFolder).toBe("自定义/人员");
    expect(b.peopleBaseFile).toBe("自定义/视图/人员库.base");
    expect(b.todoCardsFolder).toBe("自定义/待办");
    expect(b.basesFolder).toBe("自定义/视图");
    expect(b.diagnosticsLogFolder).toBe("自定义/诊断日志");

    expect(b.inboxAutoImport).toBe(false);
    expect(b.consolidatedLayout).toBe(false);
    expect(b.autoRenameWithTitle).toBe(false);
    expect(b.showFloatingBall).toBe(false);
    expect(b.enableRealtimeOutline).toBe(false);
    expect(b.diagnosticsLogEnabled).toBe(false);
    expect(b.autoCheckUpdates).toBe(false);
    expect(b.writeDailyMeetingOverview).toBe(false);
    expect(b.filterShortRecordings).toBe(false);
    expect(b.keepSegmentAudioFiles).toBe(true);

    expect(b.maxRetries).toBe(7);
    expect(b.segmentIntervalMinutes).toBe(10);
    expect(b.asrConcurrency).toBe(2);
    expect(b.realtimeOutlineDebounceMs).toBe(9000);

    expect(b.captureMode).toBe("mix-virtual");
    expect(b.bubbleSize).toBe("small");
    expect(b.thinkingMode).toBe("fast");
    expect(b.peopleContextMode).toBe("hotwords");
    expect(b.polishMode).toBe("meeting");

    expect(b.llmEndpoint).toBe("https://llm.example.com/v1/chat/completions");
    expect(b.llmApiKey).toBe("sk-llm-test");
    expect(b.llmModel).toBe("test-model");
    expect(b.llmProfiles).toEqual([
      { id: "p1", name: "测试配置", endpoint: "https://llm.example.com/v1", apiKey: "sk-p1", model: "m1" },
    ]);
    expect(b.activeLlmProfile).toBe("p1");

    expect(b.activeTranscribeProvider).toBe("openai");
    expect(b.importTranscribeProvider).toBe("dashscope-filetrans");
    expect(b.importSpeakerDiarization).toBe(false);
    expect(b.importSpeakerCount).toBe(4);
    expect(b.transcribeProviders.siliconflow.apiKey).toBe("sk-asr-test");

    expect(b.floatingBallPos).toEqual({ left: 10, top: 20 });
  });

  it("坏 JSON 字段不能污染核心设置，且同组的合法字段仍可读取", () => {
    const settings = normalizePluginSettings({
      settings: {
        storage: {
          recordingLibraryPath: 42,
          briefingNotePath: "合法/纪要",
          autoImportInbox: "false",
          syncQuietMs: Number.POSITIVE_INFINITY,
        },
        capture: {
          sourceMode: "not-a-mode",
          liveSegmentsEnabled: "yes",
          segmentMinutes: "10",
        },
        speech: {
          activeProviderId: { polluted: true },
          providers: {
            siliconflow: { apiKey: 123, model: "合法模型" },
            broken: "not-an-object",
          },
        },
        composer: {
          endpoint: [],
          structureLevel: "extreme",
          thinkingMode: 99,
          industryProfile: { industry: ["bad"], focus: "合法焦点" },
        },
        ui: {
          bubbleSize: "huge",
          floatingControlPosition: { left: "10", top: 25 },
        },
        updates: {
          lastCheckedAt: 123,
          available: { version: "2.0.0", rawBaseUrl: "https://github.com/qnalog/qnalog" },
        },
      },
    });

    expect(settings.audioFolder).toBe(DEFAULT_SETTINGS.audioFolder);
    expect(settings.mdFolder).toBe("合法/纪要");
    expect(settings.inboxAutoImport).toBe(DEFAULT_SETTINGS.inboxAutoImport);
    expect(settings.inboxStabilizeDelayMs).toBe(DEFAULT_SETTINGS.inboxStabilizeDelayMs);
    expect(settings.captureMode).toBe(DEFAULT_SETTINGS.captureMode);
    expect(settings.enableInterimOutput).toBe(DEFAULT_SETTINGS.enableInterimOutput);
    expect(settings.segmentIntervalMinutes).toBe(DEFAULT_SETTINGS.segmentIntervalMinutes);
    expect(settings.activeTranscribeProvider).toBe(DEFAULT_SETTINGS.activeTranscribeProvider);
    expect(settings.transcribeProviders.siliconflow.apiKey).toBe(DEFAULT_SETTINGS.transcribeProviders.siliconflow.apiKey);
    expect(settings.transcribeProviders.siliconflow.model).toBe("合法模型");
    expect(settings.transcribeProviders.broken).toBeUndefined();
    expect(settings.llmEndpoint).toBe(DEFAULT_SETTINGS.llmEndpoint);
    expect(settings.briefingStructureLevel).toBe(DEFAULT_SETTINGS.briefingStructureLevel);
    expect(settings.thinkingMode).toBe(DEFAULT_SETTINGS.thinkingMode);
    expect(settings.industryProfile.industry).toBe(DEFAULT_SETTINGS.industryProfile.industry);
    expect(settings.industryProfile.focus).toBe("合法焦点");
    expect(settings.bubbleSize).toBe(DEFAULT_SETTINGS.bubbleSize);
    expect(settings.floatingBallPos).toEqual({ left: DEFAULT_SETTINGS.floatingBallPos.left, top: 25 });
    expect(settings.lastUpdateCheckAt).toBe(DEFAULT_SETTINGS.lastUpdateCheckAt);
    expect(settings.availableUpdate).toBeNull();
  });

  it("旧版扁平字段继续迁移，包含 provider 与旧 prompt 覆盖", () => {
    const settings = normalizePluginSettings({
      audioFolder: "旧版/录音",
      inboxAutoImport: false,
      captureMode: "system",
      transcribeApiKey: "legacy-asr-key",
      transcribeModel: "legacy-asr-model",
      transcribeProviders: {
        legacyCustom: {
          name: "旧服务",
          endpoint: "https://legacy.example/asr",
          apiKey: "legacy-provider-key",
          model: "legacy-provider-model",
        },
      },
      polishPromptMeeting: "旧版会议提示词",
    });

    expect(settings.audioFolder).toBe("旧版/录音");
    expect(settings.inboxAutoImport).toBe(false);
    expect(settings.captureMode).toBe("virtualCable");
    expect(settings.transcribeProviders.legacyCustom).toMatchObject({
      name: "旧服务",
      endpoint: "https://legacy.example/asr",
      apiKey: "legacy-provider-key",
      model: "legacy-provider-model",
    });
    expect(settings.transcribeProviders.siliconflow.apiKey).toBe("legacy-asr-key");
    expect(settings.transcribeProviders.siliconflow.model).toBe("legacy-asr-model");
    expect(settings.promptTemplates["builtin-meeting"].prompt).toBe("旧版会议提示词");
  });

  it("丢弃指向上游仓库的历史更新记录", () => {
    // 从上游版本（2.3.2）迁移过来时，data.json 里会残留这条记录：
    // 设置页会把它显示成"可用版本 2.3.2"，「安装更新」也可能据此去取产物。
    const normalized = normalizePluginSettings({
      schemaVersion: 5,
      updates: {
        autoCheck: true,
        available: {
          version: "2.3.2",
          currentVersion: "2.3.2",
          rawBaseUrl: "https://raw.githubusercontent.com/Lynn-x/LexVoice/main",
          manifestUrl: "https://raw.githubusercontent.com/Lynn-x/LexVoice/main/manifest.json",
          checkedAt: "2026-09-13T06:00:00.000Z",
        },
      },
    });
    expect(normalized.availableUpdate).toBeNull();
  });

  it("保留来自本仓库的更新记录", () => {
    const normalized = normalizePluginSettings({
      schemaVersion: 4,
      updates: {
        autoCheck: true,
        available: {
          version: "2.1.6",
          currentVersion: "2.1.5",
          rawBaseUrl: "https://fastly.jsdelivr.net/gh/qnalog/qnalog@main",
          manifestUrl: "https://fastly.jsdelivr.net/gh/qnalog/qnalog@main/manifest.json",
          checkedAt: "2026-09-13T07:00:00.000Z",
        },
      },
    });
    expect(normalized.availableUpdate?.version).toBe("2.1.6");
  });

  it("二次 round-trip 稳定（不会每次保存都漂移一点）", () => {
    const a = normalizePluginSettings({});
    a.sedimentAutoExtract = true;
    const b = roundTrip(a);
    const c = roundTrip(b);
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      expect(c[key], `设置键 "${key}" 在第二次 round-trip 后漂移`).toEqual(b[key]);
    }
  });
});

describe("extractJobItems", () => {
  it("按 backgroundJobs.items → jobs.items → queue 的优先级取任务列表", () => {
    expect(extractJobItems({ backgroundJobs: { items: [{ id: 1 }] } })).toEqual([{ id: 1 }]);
    expect(extractJobItems({ jobs: { items: [{ id: 2 }] } })).toEqual([{ id: 2 }]);
    expect(extractJobItems({ queue: [{ id: 3 }] })).toEqual([{ id: 3 }]);
  });

  it("无数据/坏数据回退空数组", () => {
    expect(extractJobItems(undefined)).toEqual([]);
    expect(extractJobItems(null)).toEqual([]);
    expect(extractJobItems({ backgroundJobs: { items: "not-array" } })).toEqual([]);
  });
});
