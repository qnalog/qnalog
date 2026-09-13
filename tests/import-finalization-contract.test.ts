import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");

describe("import finalization contract", () => {
  it("persists and verifies the raw transcript before starting AI organization", () => {
    const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
    const verifyIndex = source.indexOf("const transcriptCheckpoint = verifyTranscriptCheckpoint");
    const persistedIndex = source.indexOf('"asr.import_transcript_persisted"', verifyIndex);
    const organizeIndex = source.indexOf('phase: "organize"', persistedIndex);
    const finalizeIndex = source.indexOf("await this.finalizeSession(session);", organizeIndex);

    expect(verifyIndex).toBeGreaterThan(-1);
    expect(persistedIndex).toBeGreaterThan(verifyIndex);
    expect(organizeIndex).toBeGreaterThan(persistedIndex);
    expect(finalizeIndex).toBeGreaterThan(organizeIndex);
  });

  it("rebuilds imported notes after both first-pass and queued AI organization", () => {
    const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
    const firstPassPolicy = source.indexOf("shouldRewriteConsolidatedNote(this.settings, writeSession)");
    const retryStart = source.indexOf("async retryMergeTask(task)");
    const retryPolicy = source.indexOf("shouldRewriteConsolidatedNote(this.settings, retrySession)", retryStart);
    const retryRewrite = source.indexOf("await this.rewriteConsolidated(retrySession, polished)", retryPolicy);

    expect(firstPassPolicy).toBeGreaterThan(-1);
    expect(retryStart).toBeGreaterThan(-1);
    expect(retryPolicy).toBeGreaterThan(retryStart);
    expect(retryRewrite).toBeGreaterThan(retryPolicy);
  });

  it("refreshes the portable note index only after the final file name is known", () => {
    const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
    const finalizeRename = source.indexOf("const beforeRenamePath = session.mdPath;");
    const finalizeIndex = source.indexOf('reason: "finalize"', finalizeRename);
    const retryStart = source.indexOf("async retryMergeTask(task)");
    const retryRename = source.indexOf("const renamed = (task.mode", retryStart);
    const retryIndex = source.indexOf('reason: "merge-retry"', retryRename);
    const derivedStart = source.indexOf("async createLexVoiceDerivedNote");
    const derivedIndex = source.indexOf('reason: "derived-note"', derivedStart);

    expect(finalizeIndex).toBeGreaterThan(finalizeRename);
    expect(retryIndex).toBeGreaterThan(retryRename);
    expect(derivedIndex).toBeGreaterThan(derivedStart);
    expect(source).toContain('"note.index_refresh_failed"');
    expect(source).toContain("纪要索引更新失败，正文不受影响");
  });

  it("keeps AI configuration failures as blocked, manually recoverable merge tasks", () => {
    const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");

    expect(source).toContain('status: nonRetryableMergeError ? "blocked" : "pending"');
    expect(source).toContain("speakerFrontmatter,");
    expect(source).toContain("task.speakerFrontmatter || null");
  });

  it("writes confirmed speaker names into the note before AI organization", () => {
    const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
    const confirmStart = source.indexOf("async confirmSpeakerNamesBeforeFinal");
    const frontmatterIndex = source.indexOf("nextFrontmatter.lexvoice_speakers = mappings", confirmStart);
    const replaceIndex = source.indexOf("replaceSpeakerDisplayName(markdown, speakerId, personName)", frontmatterIndex);
    const persistIndex = source.indexOf("await this.app.vault.modify(file, markdown)", replaceIndex);
    const llmCopyIndex = source.indexOf("const llmSegments = hasConfirmedName", persistIndex);

    expect(confirmStart).toBeGreaterThan(-1);
    expect(frontmatterIndex).toBeGreaterThan(confirmStart);
    expect(replaceIndex).toBeGreaterThan(frontmatterIndex);
    expect(persistIndex).toBeGreaterThan(replaceIndex);
    expect(llmCopyIndex).toBeGreaterThan(persistIndex);
  });

  it("keeps final briefings matter-centered and speaker attribution selective", () => {
    const discipline = fs.readFileSync(path.join(root, "src/prompts/discipline.ts"), "utf8");
    const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");

    expect(discipline).toContain("以事为主轴");
    expect(discipline).toContain("案例必须落位");
    expect(discipline).toContain("人物署名克制");
    expect(source).toContain("【组织主轴·以事为中心】");
    expect(source).toContain("不要机械罗列每个人说了什么");
  });

  it("exposes AI service selection and connection checks on the speaker settings page", () => {
    const source = fs.readFileSync(path.join(root, "src/ui/settings-tab.ts"), "utf8");
    const speakerPage = source.slice(source.indexOf("renderSpeaker(c)"), source.indexOf("renderAI(c)"));

    expect(speakerPage).toContain('.setName("AI 整理")');
    expect(speakerPage).toContain('.setName("大模型服务")');
    expect(speakerPage).toContain('.setName("服务地址")');
    expect(speakerPage).toContain('"复用转写密钥"');
    expect(speakerPage).toContain('.setName("AI 模型")');
    expect(speakerPage).toContain("fetchLlmModelList");
    expect(speakerPage).toContain("testLlmConnection");
  });
});
