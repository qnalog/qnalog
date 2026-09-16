import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pluginSourceText } from "./plugin-source";

const root = path.resolve(__dirname, "..");
// 队列任务的失败恢复已抽到独立模块；需要断言"同一文件内先后顺序"的用例读该文件本身。
const queueRetrySource = fs.readFileSync(path.join(root, "src/queue/queue-retry-service.ts"), "utf8");
// 版本块与派生笔记的实现同样已抽出；顺序断言读该文件本身。
const versionStoreSource = fs.readFileSync(path.join(root, "src/versions/version-store.ts"), "utf8");
// 会话收尾（逐字稿校验、说话人姓名确认、正文落盘）已抽到该模块。
const finalizeSource = fs.readFileSync(path.join(root, "src/notes/session-finalize-service.ts"), "utf8");
// 导入流程（逐字稿校验、转写提交、进入整理）已抽到该模块。
const importSource = fs.readFileSync(path.join(root, "src/imports/import-service.ts"), "utf8");

describe("import finalization contract", () => {
  it("persists and verifies the raw transcript before starting AI organization", () => {
    const source = importSource;
    // 断言写在导入服务文件里的顺序：校验逐字稿断点 → 记录持久化事件 → 进入整理阶段 → 收尾。
    const verifyIndex = source.indexOf("const transcriptCheckpoint = verifyTranscriptCheckpoint");
    const persistedIndex = source.indexOf('"asr.import_transcript_persisted"', verifyIndex);
    const organizeIndex = source.indexOf("phase: \"organize\"", persistedIndex);
    const finalizeIndex = source.indexOf("await this.host.sessionFinalize.finalizeSession(session);", organizeIndex);

    expect(verifyIndex).toBeGreaterThan(-1);
    expect(persistedIndex).toBeGreaterThan(verifyIndex);
    expect(organizeIndex).toBeGreaterThan(persistedIndex);
    expect(finalizeIndex).toBeGreaterThan(organizeIndex);
  });

  it("rebuilds imported notes after both first-pass and queued AI organization", () => {
    const firstPassPolicy = finalizeSource.indexOf("shouldRewriteConsolidatedNote(this.host.settings, writeSession)");
    const retryStart = queueRetrySource.indexOf("async retryMergeTask(task)");
    const retryPolicy = queueRetrySource.indexOf("shouldRewriteConsolidatedNote(this.host.settings, retrySession)", retryStart);
    const retryRewrite = queueRetrySource.indexOf("await this.host.noteWriter.rewriteConsolidated(retrySession, polished)", retryPolicy);

    expect(firstPassPolicy).toBeGreaterThan(-1);
    expect(retryStart).toBeGreaterThan(-1);
    expect(retryPolicy).toBeGreaterThan(retryStart);
    expect(retryRewrite).toBeGreaterThan(retryPolicy);
  });

  it("refreshes the portable note index only after the final file name is known", () => {
    const finalizeRename = finalizeSource.indexOf("const beforeRenamePath = session.mdPath;");
    const finalizeIndex = finalizeSource.indexOf('reason: "finalize"', finalizeRename);
    const retryStart = queueRetrySource.indexOf("async retryMergeTask(task)");
    const retryRename = queueRetrySource.indexOf("const renamed = (task.mode", retryStart);
    const retryIndex = queueRetrySource.indexOf('reason: "merge-retry"', retryRename);
    const derivedStart = versionStoreSource.indexOf("async createDerivedNote");
    const derivedIndex = versionStoreSource.indexOf('reason: "derived-note"', derivedStart);

    expect(finalizeIndex).toBeGreaterThan(finalizeRename);
    expect(retryIndex).toBeGreaterThan(retryRename);
    expect(derivedIndex).toBeGreaterThan(derivedStart);
    // 刷新索引的实现在笔记索引模块里，用全文断言这两条证据仍存在。
    expect(pluginSourceText()).toContain('"note.index_refresh_failed"');
    expect(pluginSourceText()).toContain("纪要索引更新失败，正文不受影响");
  });

  it("keeps AI configuration failures as blocked, manually recoverable merge tasks", () => {
    // 合并任务的重试实现已在独立模块里，按本文件的约定用全文断言"字符串存在"。
    const source = pluginSourceText();

    expect(source).toContain('status: nonRetryableMergeError ? "blocked" : "pending"');
    expect(source).toContain("speakerFrontmatter,");
    expect(source).toContain("task.speakerFrontmatter || null");
  });

  it("writes confirmed speaker names into the note before AI organization", () => {
    const source = finalizeSource;
    const confirmStart = source.indexOf("async confirmSpeakerNamesBeforeFinal");
    const frontmatterIndex = source.indexOf("nextFrontmatter[NS_FM_SPEAKERS] = mappings", confirmStart);
    const replaceIndex = source.indexOf("replaceSpeakerDisplayName(markdown, speakerId, personName)", frontmatterIndex);
    const persistIndex = source.indexOf("await this.host.app.vault.modify(file, markdown)", replaceIndex);
    const llmCopyIndex = source.indexOf("const llmSegments = hasConfirmedName", persistIndex);

    expect(confirmStart).toBeGreaterThan(-1);
    expect(frontmatterIndex).toBeGreaterThan(confirmStart);
    expect(replaceIndex).toBeGreaterThan(frontmatterIndex);
    expect(persistIndex).toBeGreaterThan(replaceIndex);
    expect(llmCopyIndex).toBeGreaterThan(persistIndex);
  });

  it("keeps final briefings matter-centered and speaker attribution selective", () => {
    const discipline = fs.readFileSync(path.join(root, "src/prompts/discipline.ts"), "utf8");
    
    // 提示词实现已拆到 src/prompts/briefing-prompts.ts 等模块：这里断言的是"插件源码中存在该纪律文本"。
    const source = pluginSourceText();

    expect(discipline).toContain("以事为主轴");
    expect(discipline).toContain("案例必须落位");
    expect(discipline).toContain("人物署名克制");
    expect(source).toContain("【组织主轴·以事为中心】");
    expect(source).toContain("不要机械罗列每个人说了什么");
  });

  it("exposes every imported-audio and AI-organize setting on the merged API page", () => {
    // 「说话人」选项卡已并入 API 页（该页原本另有一份 AI 整理服务配置，与 API 页重复）。
    // 这里断言的是**合并后没有丢设置**，而不是某个方法里的字符串顺序：
    // 原先的用例按方法名切片比对字面量，改结构就失败，且它锁住的正是要删掉的重复副本。
    const source = fs.readFileSync(path.join(root, "src/ui/settings-tab.ts"), "utf8");
    const apiPage = source.slice(source.indexOf("renderApi(c) {"), source.indexOf("renderAI(c)"));

    // 原「说话人」页独有的两项必须随合并保留，否则说话人识别无法关闭或指定人数
    // 文案已改为英文源（i18n 后由词条表提供中文），断言键而非中文值
    expect(apiPage).toContain('.setName(t("Distinguish Speakers"))');
    expect(apiPage).toContain('.setName(t("Number of Speakers"))');
    expect(apiPage).toContain("importSpeakerDiarization");
    expect(apiPage).toContain("importSpeakerCount");

    // 导入音频的转写服务配置随之并入
    expect(apiPage).toContain("importTranscribeProvider");
    expect(apiPage).toContain("fetchImportTranscribeModels");

    // 选项卡本身不应再存在
    expect(source).not.toContain('{ id: "speaker"');
  });
});
