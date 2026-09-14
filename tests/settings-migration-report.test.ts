import { describe, expect, it } from "vitest";
import { buildSettingsMigrationReport } from "../src/shared/settings-migration-report";

// 从更新过的版本回退时（上游 2.2.0+ 的 schemaVersion 5 → 本版本 4），
// 用户只会看到"某些设置不见了"。这份报告是他们对上账的唯一途径：
// 丢了哪些分组、保住了哪些、要重新填什么。
describe("settings migration report", () => {
  const saved = {
    schemaVersion: 5,
    services: { bindings: { reportLlm: { connectionId: "openai" } } },
    speech: { providers: { siliconflow: { apiKey: "lvk1:x" } } },
    composer: { apiKey: "lvk1:y" },
    storage: { recordingLibraryPath: "LexVoice/录音" },
  };
  const written = {
    schemaVersion: 4,
    speech: { providers: { siliconflow: { apiKey: "lvk1:x" } } },
    composer: { apiKey: "lvk1:y" },
    storage: { recordingLibraryPath: "LexVoice/录音" },
  };

  it("回退时列出被丢弃的分组、保留的分组与需要处理的事项", () => {
    const report = buildSettingsMigrationReport(saved, written, { savedVersion: 5, currentVersion: 4 });
    expect(report).not.toBeNull();
    expect(report!.direction).toBe("downgrade");
    expect(report!.droppedGroups).toEqual(["services"]);
    expect(report!.keptGroups).toEqual(["speech", "composer", "storage"]);
    // 需要重新指定服务绑定，并提示备份可还原
    expect(report!.actions.join("\n")).toContain("重新选择一次");
    expect(report!.actions.join("\n")).toContain("qnalog-install-backups");
    expect(report!.actions.join("\n")).not.toContain(".obsidian");
    // 摘要要能直接给用户看
    expect(report!.summary).toContain("5 → 4");
    expect(report!.summary).toContain("已丢弃：services");
    expect(report!.summary).toContain("已保留 3 个分组");
    // 通知保持短：明细（保留内容说明）只在诊断日志里
    expect(report!.summary).not.toContain("转写服务配置与访问密钥已保留");
    expect(report!.details).toContain("被丢弃的分组：services");
    expect(report!.details).toContain("转写服务配置与访问密钥已保留");
  });

  it("升级方向同样报告，但不提示备份还原", () => {
    const report = buildSettingsMigrationReport(
      { schemaVersion: 3, speech: {}, legacyGroup: { a: 1 } },
      { schemaVersion: 4, speech: {} },
      { savedVersion: 3, currentVersion: 4 },
    );
    expect(report!.direction).toBe("upgrade");
    expect(report!.droppedGroups).toEqual(["legacyGroup"]);
    expect(report!.actions.join("\n")).toContain("legacyGroup");
    expect(report!.actions.join("\n")).not.toContain("qnalog-install-backups");
  });

  it("结构一致且无丢弃时不产生报告（正常加载零噪音）", () => {
    expect(buildSettingsMigrationReport({ schemaVersion: 4, speech: {} }, { schemaVersion: 4, speech: {} }, { savedVersion: 4, currentVersion: 4 })).toBeNull();
  });

  it("旧版平铺结构不报告，避免逐键误报", () => {
    const report = buildSettingsMigrationReport(
      { llmApiKey: "x", mdFolder: "LexVoice/转写纪要" },
      { schemaVersion: 4, composer: {}, storage: {} },
      { savedVersion: 0, currentVersion: 4 },
    );
    expect(report).toBeNull();
  });

  // 场景裁剪（MAINTAINING.md §7）：schemaVersion 4 → 5 移除了招聘/晋升场景。
  // 用户手里那份 data.json 里这两个分组会消失，报告必须说清"丢了什么"以及"笔记文件不受影响"。
  it("裁剪 HR 场景时，明确报告被丢弃的招聘/晋升分组且不改动用户笔记", () => {
    const savedV4 = {
      schemaVersion: 4,
      speech: { providers: { siliconflow: { apiKey: "lvk1:x" } } },
      recruiting: { unlocked: true, jdFolder: "JD", context: { jd: "岗位职责" } },
      promotionReview: { context: { requirements: "P8/P9" } },
    };
    const writtenV5 = { schemaVersion: 5, speech: savedV4.speech };

    const report = buildSettingsMigrationReport(savedV4, writtenV5, { savedVersion: 4, currentVersion: 5 });
    expect(report).not.toBeNull();
    expect(report!.direction).toBe("upgrade");
    expect(report!.droppedGroups.sort()).toEqual(["promotionReview", "recruiting"]);
    expect(report!.keptGroups).toEqual(["speech"]);

    const actions = report!.actions.join("\n");
    expect(actions).toContain("招聘与晋升评审场景已从本版本移除");
    // 兼容底线：只重写设置文件，不碰知识库内容
    expect(actions).toContain("不会被删除或改写");
    // 招聘/晋升不再是"已保留"，不得再出现在保留说明里
    expect(report!.details).not.toContain("招聘上下文与资料库已保留");
  });

  it("未知分组也会被如实列出，不静默吞掉", () => {
    const report = buildSettingsMigrationReport(
      { schemaVersion: 5, somethingNew: { a: 1 } },
      { schemaVersion: 4 },
      { savedVersion: 5, currentVersion: 4 },
    );
    expect(report!.droppedGroups).toEqual(["somethingNew"]);
    expect(report!.actions.join("\n")).toContain("somethingNew");
  });
});
