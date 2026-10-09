import { getActiveUiLanguage, matchUiLanguage, setActiveUiLanguage, t } from "../src/shared/i18n";
import { labelPattern, labelText } from "../src/shared/note-labels";
import { nsMarker, nsRe } from "../src/shared/namespace";
import { getTranscribeSegmentPlaceholder } from "../src/shared/util-audio";
import { describe, expect, it, vi } from "vitest";

const notices: string[] = [];
vi.mock("obsidian", () => ({
  TFile: class TFile {
    path: string;
    name: string;
    basename: string;
    extension: string;
    constructor(path: string) {
      this.path = path;
      this.name = path.split("/").pop() || path;
      this.basename = this.name.replace(/\.[^.]+$/, "");
      this.extension = this.name.split(".").pop() || "";
    }
  },
  Notice: class Notice { constructor(message: string) { notices.push(String(message)); } },
  normalizePath: vi.fn((path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, "")),
}));
import * as obsidian from "obsidian";
import { NoteWriter } from "../src/notes/note-writer";
import type { NoteWriterHost, NoteWriterSettings, NoteWriterVault } from "../src/notes/note-writer";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { attachTextTranscript, getCurrentTranscript } from "../src/transcript/session-transcript";
import { readTranscriptBlocks, serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
import { iterateNoteDetailsBlocks } from "../src/notes/note-document";
import { splitLeadingFrontmatter } from "../src/notes/note-document";
import type { RecordingSession, Segment } from "../src/shared/types";
import type { NoteMergeSourceMetadata } from "../src/notes/note-merge-flow";
import { buildEmptyLlmOutputFallback } from "../src/notes/note-write-content";
import { createRealtimeOutlineSourceCoverage } from "../src/notes/outline-coverage";
import { readCurrentOutlineBlock } from "../src/notes/outline-storage";

type File = InstanceType<typeof obsidian.TFile>;

function memoryVault(initial: Array<{ file: File; markdown: string }> = []) {
  const files = new Map(initial.map((entry) => [entry.file.path, entry]));
  const adapterFiles = new Map<string, string>();
  const folders = new Set<string>();
  const vault = {
    configDir: ".obsidian",
    adapter: {
      exists: async (path: string) => folders.has(path) || adapterFiles.has(path),
      mkdir: async (path: string) => { folders.add(path); },
      write: async (path: string, value: string) => { adapterFiles.set(path, value); },
      read: async (path: string) => {
        const value = adapterFiles.get(path);
        if (value === undefined) throw new Error(`Missing adapter file ${path}`);
        return value;
      },
    },
    getAbstractFileByPath: (path: string) => files.get(path)?.file ?? null,
    read: async (file: File) => {
      const entry = files.get(file.path);
      if (!entry) throw new Error(`Missing note ${file.path}`);
      return entry.markdown;
    },
    modify: async (file: File, markdown: string) => {
      const entry = files.get(file.path);
      if (!entry) throw new Error(`Missing note ${file.path}`);
      entry.markdown = markdown;
    },
    create: async (path: string, markdown: string) => {
      const file = new obsidian.TFile(path);
      files.set(path, { file, markdown });
      return file;
    },
    process: async (file: File, transform: (markdown: string) => string) => {
      const current = await vault.read(file);
      const next = transform(current);
      await vault.modify(file, next);
      return next;
    },
  };
  return {
    vault: vault as unknown as NoteWriterVault,
    files,
    adapterFiles,
  };
}

function unexpectedHost(vault: NoteWriterVault, settings: NoteWriterSettings, overrides: Partial<NoteWriterHost> = {}): NoteWriterHost {
  return {
    vault,
    settings,
    noteIndex: { refreshNoteIndexSafely: async () => { throw new Error("unexpected index refresh"); } },
    getFileFrontmatter: () => undefined,
    ensureFolder: async () => { throw new Error("unexpected folder creation"); },
    findAvailableMarkdownPath: () => { throw new Error("unexpected path allocation"); },
    renameFile: async () => { throw new Error("unexpected rename"); },
    openFile: async () => { throw new Error("unexpected file open"); },
    confirm: async () => { throw new Error("unexpected confirmation"); },
    getRecentNotes: () => { throw new Error("unexpected recent-note lookup"); },
    generateTitleTag: async () => { throw new Error("unexpected title generation"); },
    polishTranscript: async () => { throw new Error("unexpected transcript polish"); },
    mergeAndPolish: async () => { throw new Error("unexpected note merge"); },
    clearCommittedBriefingCheckpoint: async () => { throw new Error("unexpected checkpoint cleanup"); },
    ...overrides,
  };
}



describe("NoteWriter polish materials", () => {
  it("preserves fallback, frontmatter, sediment blocks, and transcript ledgers in both layouts", async () => {
    const literalBody = "模型正文\n$& $` $' $$";
    const folded = [
      "<!--QNALOG_SEDIMENT_BEGIN-->",
      "<details>",
      "<summary>Fixture data</summary>",
      "",
      "```json",
      '{"people":[],"todos":[],"hotwords":{}}',
      "```",
      "",
      "</details>",
      "<!--QNALOG_SEDIMENT_END-->",
    ].join("\n");
    const legacy = "<!--QNALOG_SEDIMENT_BEGIN\n{\"people\":[]}\nQNALOG_SEDIMENT_END-->";
    const fallback = buildEmptyLlmOutputFallback();
    const cases = [
      { input: "", frontmatter: "", body: fallback, block: "" },
      { input: " \r\n\t ", frontmatter: "", body: fallback, block: "" },
      { input: "---\r\ntitle: only\r\n---\r\n\r\n", frontmatter: "---\ntitle: only\n---", body: fallback, block: "" },
      { input: "\uFEFF---\r\ntitle: literal\r\n---\r\n\r\n  " + literalBody + " \r\n\r\n" + folded + "\n", frontmatter: "---\ntitle: literal\n---", body: literalBody, block: folded },
      { input: folded, frontmatter: "", body: fallback, block: folded },
      { input: literalBody + "\n\n" + legacy, frontmatter: "", body: literalBody, block: legacy },
      { input: "prefix\n---\ntitle: not-leading\n---\nbody", frontmatter: "", body: "prefix\n---\ntitle: not-leading\n---\nbody", block: "" },
      { input: literalBody + "\n<!--QNALOG_SEDIMENT_BEGIN\nincomplete", frontmatter: "", body: literalBody + "\n<!--QNALOG_SEDIMENT_BEGIN\nincomplete", block: "" },
    ];
    const path = "QnALog/Minutes/polish-materials.md";
    const file = new obsidian.TFile(path);
    const source = "来源原文 $& $` $' $$";
    const segment = attachTextTranscript({
      index: 0, startOffsetMs: 0, endOffsetMs: 1_000, text: source, isFinal: true,
    }, "polish-materials", "asr");
    const ledger = serializeTranscriptBlock(segment, "### Source transcript", source);
    const original = `---\ntitle: old\n---\n\n# Existing note\n\n${ledger}`;
    const vault = memoryVault([{ file, markdown: original }]);
    const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, llmModel: "consumer-test-model" }));
    const originalLanguage = getActiveUiLanguage();
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00" }) });
    try {
      for (const language of ["zh", "en"]) {
        setActiveUiLanguage(matchUiLanguage(language)!);
        const session: RecordingSession = {
          id: "polish-materials",
          sessionStamp: "polish-materials",
          startedAt: "2026-09-14T12:00:00.000Z",
          mdPath: path,
          mode: "meeting",
          source: "recording",
          segments: [segment],
          finalized: true,
          multiSourceAudio: true,
        };
        for (const entry of cases) {
          await vault.vault.modify(file, original);
          await writer.rewriteConsolidated(session, entry.input);
          const rewritten = await vault.vault.read(file);
          const rewriteParts = splitLeadingFrontmatter(rewritten);
          expect(rewriteParts.frontmatter.replace(/\n$/, "")).toBe(entry.frontmatter);
          const originalHeading = `## ${labelText("originalMaterial")}`;
          const bodyStart = rewritten.indexOf(entry.body);
          expect(bodyStart).toBeGreaterThanOrEqual(0);
          expect(bodyStart).toBeLessThan(rewritten.indexOf(originalHeading));
          expect(rewriteParts.body).toContain(`${entry.body}\n\n---`);
          expect(rewritten.split(entry.block || "\u0000").length - 1).toBe(entry.block ? 1 : 0);
          expect(readTranscriptBlocks(rewritten).map(block => block.visibleBlock)).toEqual([source]);
          const transcript = readTranscriptBlocks(rewritten)[0].segment.transcript!;
          expect(transcript.id).toBe(segment.transcript!.id);
          expect(transcript.sourceId).toBe(segment.transcript!.sourceId);
          expect(transcript.currentRevision).toBe(segment.transcript!.currentRevision);
          expect(transcript.revisions.find(revision => revision.revision === transcript.currentRevision)?.rawText)
            .toBe(segment.transcript!.revisions.find(revision => revision.revision === segment.transcript!.currentRevision)?.rawText);
          if (entry === cases[3]) {
            await writer.rewriteConsolidated(session, entry.input);
            expect(await vault.vault.read(file)).toBe(rewritten);
          }

          await vault.vault.modify(file, original);
          await writer.appendPolishBlock(session, entry.input, null, false, "", original);
          const appended = await vault.vault.read(file);
          const appendedParts = splitLeadingFrontmatter(appended);
          expect(appendedParts.frontmatter.replace(/\n$/, "")).toBe(entry.frontmatter || "---\ntitle: old\n---");
          const appendHeading = labelText("mergedVersionAt", "consumer-test-model ·");
          expect(appended).toContain(entry.body);
          expect(appended.indexOf(entry.body)).toBeGreaterThan(appended.indexOf(appendHeading.slice(0, 8)));
          expect(appended.split(entry.block || "\u0000").length - 1).toBe(entry.block ? 1 : 0);
          expect(readTranscriptBlocks(appended).map(block => block.visibleBlock)).toEqual([source]);
        }
        await vault.vault.modify(file, original);
        await writer.appendPolishBlock(session, cases[3].input, new Error("temporary failure"), false, "", original);
        const failedAppend = await vault.vault.read(file);
        expect(splitLeadingFrontmatter(failedAppend).frontmatter).toContain("title: old");
        expect(failedAppend).toContain(labelText("mergeFailedQueued", "temporary failure"));
        expect(failedAppend).not.toContain(literalBody);
        expect(failedAppend.split(folded).length - 1).toBe(1);
        expect(readTranscriptBlocks(failedAppend).map(block => block.visibleBlock)).toEqual([source]);
      }
    } finally {
      setActiveUiLanguage(originalLanguage);
      vi.unstubAllGlobals();
    }
  });
  it.each(["zh", "en"])("formats actual failed-polish output without writing the model body (%s)", async (language) => {
    const originalLanguage = getActiveUiLanguage();
    const path = `QnALog/Minutes/polish-failure-${language}.md`;
    const file = new obsidian.TFile(path);
    const source = "源稿原文与转写账本";
    const segment = attachTextTranscript({
      index: 0, startOffsetMs: 0, endOffsetMs: 1_000, text: source, isFinal: true,
    }, `polish-failure-${language}`, "asr");
    const ledger = serializeTranscriptBlock(segment, "### Source transcript", source);
    const original = `---\ntitle: failure source\n---\n\n# Existing note\n\n${ledger}`;
    const vault = memoryVault([{ file, markdown: original }]);
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00" }) });
    const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, llmModel: "consumer-test-model" }));
    const session: RecordingSession = {
      id: `polish-failure-${language}`,
      sessionStamp: `polish-failure-${language}`,
      startedAt: "2026-09-14T12:00:00.000Z",
      mdPath: path,
      mode: "meeting",
      source: "recording",
      segments: [segment],
      finalized: true,
    };
    const configMessage = "LLM model name is not configured";
    const serviceMessage = "no available account";
    const cases = [
      {
        message: configMessage,
        nonRetryable: true,
        guidance: language === "en"
          ? `${configMessage}. Please complete it under Settings → API → AI organizing service, then test the connection.`
          : `${configMessage}。请到「设置 → API → AI 整理服务」补齐后先测试连接。`,
      },
      {
        message: serviceMessage,
        nonRetryable: true,
        guidance: language === "en"
          ? `${serviceMessage}. This is a problem returned by the LLM service or account pool, not caused by text length, ASR, or the text-import path; switch the model/endpoint, or retry manually later.`
          : `${serviceMessage}。这是大模型服务端或账号池返回的问题，不是文本长度、ASR 或文本导入路径导致的；请切换模型/端点，或稍后手动重试。`,
      },
      { message: serviceMessage, nonRetryable: false, guidance: "" },
    ] as const;
    try {
      setActiveUiLanguage(matchUiLanguage(language)!);
      for (const entry of cases) {
        await vault.vault.modify(file, original);
        await writer.appendPolishBlock(
          session,
          "BODY MUST NOT BE WRITTEN",
          new Error(entry.message),
          entry.nonRetryable,
          "",
          original,
        );
        const result = await vault.vault.read(file);
        expect(result.startsWith(original.slice(0, original.indexOf(ledger)))).toBe(true);
        expect(splitLeadingFrontmatter(result).frontmatter).toBe("---\ntitle: failure source\n---\n");
        expect(result).not.toContain("BODY MUST NOT BE WRITTEN");
        const failureLine = entry.nonRetryable
          ? `_[${labelText("aiOrganizingFailed", entry.guidance)}]_`
          : `_[${labelText("mergeFailedQueued", entry.message)}]_`;
        expect(result).toContain(`\n${failureLine}\n`);
        expect(readTranscriptBlocks(result).map(block => block.visibleBlock)).toEqual([source]);
        const transcript = readTranscriptBlocks(result)[0].segment.transcript!;
        expect(transcript.id).toBe(segment.transcript!.id);
        expect(transcript.currentRevision).toBe(segment.transcript!.currentRevision);
        expect(transcript.revisions.find(revision => revision.revision === transcript.currentRevision)?.rawText)
          .toBe(segment.transcript!.revisions.find(revision => revision.revision === segment.transcript!.currentRevision)?.rawText);
      }
    } finally {
      setActiveUiLanguage(originalLanguage);
      vi.unstubAllGlobals();
    }
  });
});
describe("NoteWriter audio source materials", () => {
  it.each(["zh", "en"])("preserves audio source selection in rewrite, append, and failure (%s)", async (language) => {
    const path = "QnALog/Minutes/audio-materials.md";
    const file = new obsidian.TFile(path);
    const originalLanguage = getActiveUiLanguage();
    const original = "---\ntitle: old\n---\n\n# Existing note\n";
    const named = "母带 $& $` $' $$.webm";
    const externalName = "外部 $& $` $' $$.wav";
    const audioName = "分段 $& $` $' $$.webm";
    const segment = attachTextTranscript({
      index: 2, startOffsetMs: 61_000, endOffsetMs: 65_000, audioStartOffsetMs: 7_000,
      audioEndOffsetMs: 11_000, audioName, audioPath: "QnALog/Audio/segment.webm",
      rawText: "AUDIO RAW $& $` $' $$", text: "AUDIO RAW $& $` $' $$", isFinal: true,
    }, "audio-materials", "text-import");
    const ledger = serializeTranscriptBlock(segment, "### Segment 3", segment.text);
    const output = "---\ntitle: new\n---\n\nAUDIO BODY $& $` $' $$";
    const states: Array<{
      name: string; source: RecordingSession["source"]; fields?: Partial<RecordingSession>;
      section: "master" | "segment" | "external" | "none";
    }> = [
      { name: "named-master", source: "recording", fields: { masterAudioName: `  ${named}  `, masterAudioPath: "QnALog/Audio/ignored.webm" }, section: "master" },
      { name: "path-master", source: "recording", fields: { masterAudioName: "  ", masterAudioPath: " QnALog/Audio/fallback.webm " }, section: "master" },
      { name: "no-master", source: "recording", section: "segment" },
      { name: "multi-source", source: "recording", fields: { masterAudioName: named, multiSourceAudio: true }, section: "segment" },
      { name: "external-named", source: "import", fields: { masterAudioName: named, externalAudioSource: { name: `  ${externalName}  `, path: "/private/DO_NOT_RENDER/source.wav", fingerprint: "DO_NOT_RENDER_FINGERPRINT" } }, section: "external" },
      { name: "external-blank", source: "import", fields: { masterAudioName: named, externalAudioSource: { name: "  " } }, section: "none" },
      { name: "text-import", source: "text-import", fields: { masterAudioName: named }, section: "none" },
      { name: "combined", source: "text-import", fields: { masterAudioName: named, externalAudioSource: { name: externalName } }, section: "external" },
    ];
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00:00" }) });
    try {
      setActiveUiLanguage(matchUiLanguage(language)!);
      for (const state of states) {
        const inputNote = state.source === "text-import" ? original : `${original}\n${ledger}`;
        const vault = memoryVault([{ file, markdown: inputNote }]);
        const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, llmModel: "consumer-audio-model" }));
        const session: RecordingSession = {
          id: "audio-materials", sessionStamp: "audio-materials", startedAt: "2026-09-14T12:00:00.000Z",
          mdPath: path, mode: "meeting", source: state.source, segments: [segment], finalized: true, ...state.fields,
        };
        for (const method of ["rewrite", "append", "failed"] as const) {
          await vault.vault.modify(file, inputNote);
          if (method === "rewrite") await writer.rewriteConsolidated(session, output);
          else await writer.appendPolishBlock(session, output, method === "failed" ? new Error("audio failure") : null, false, "", inputNote);
          const result = await vault.vault.read(file);
          const master = state.section === "master" ? (state.name === "path-master" ? "fallback.webm" : named) : "";
          const external = state.section === "external" ? externalName : "";
          if (master) {
            expect(result).toContain(`![[${master}]]`);
            expect(result).toContain(`[[${master}|00:00]]`);
          }
          if (external) {
            expect(result).toContain(`${language === "zh" ? "文件：" : "File: "}${external}`);
            expect(result).not.toContain("DO_NOT_RENDER");
            expect(result).not.toContain(`![[${audioName}]]`);
          }
          if (state.section === "segment" && method === "rewrite") {
            expect(result).toContain(`<summary>${language === "zh" ? "原始音频（1 段，01:05）" : "Original audio (1 segments, 01:05)"}</summary>`);
            expect(result).toContain(`![[${audioName}]]`);
            expect(result).toContain(`[[${audioName}|00:07]]`);
          }
          if (state.section === "none" || state.section === "external") {
            expect(result).not.toContain("![[");
          }
          if (method === "failed") {
            expect(result).toContain(language === "zh"
              ? "_[合并润色失败（已加入重试队列）：audio failure]_"
              : "_[Merge failed (queued for retry): audio failure]_");
            expect(result).toContain("title: old");
            expect(result).not.toContain("AUDIO BODY");
          } else {
            expect(result).toContain("title: new");
            expect(result).toContain("AUDIO BODY $& $` $' $$");
          }
          if (state.source !== "text-import") {
            expect(readTranscriptBlocks(result).map((block) => block.visibleBlock)).toEqual(["AUDIO RAW $& $` $' $$"]);
          }
          const timelineDetails = [...iterateNoteDetailsBlocks(result)].filter((range) =>
            labelPattern("playbackTimeline").test(result.slice(range.summaryStart, range.summaryEnd))
          );
          expect(timelineDetails).toEqual([]);
        }
      }
    } finally {
      setActiveUiLanguage(originalLanguage);
      vi.unstubAllGlobals();
    }
  });
});
describe("NoteWriter text-import source materials", () => {
  it("preserves ordered source labels, raw text, and ledgers through rewrite, append, and failure", async () => {
    const path = "QnALog/Minutes/text-materials.md";
    const file = new obsidian.TFile(path);
    const original = "---\ntitle: old\n---\n\n# Existing note\n";
    const vault = memoryVault([{ file, markdown: original }]);
    const writer = new NoteWriter(unexpectedHost(vault.vault, {
      ...DEFAULT_SETTINGS,
      llmModel: "consumer-test-model",
    }));
    const originalLanguage = getActiveUiLanguage();
    const originalWindow = (globalThis as { window?: unknown }).window;
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00:00" }) });
    const first = attachTextTranscript({
      index: 4, startOffsetMs: 0, endOffsetMs: 1_000, isFinal: true,
      sourceName: "来源一 $& $` $' $$", sourcePath: "Notes/source-one.md",
      rawText: "旧原文", text: "来源标签：不可作为原文",
      audioName: "SHOULD_NOT_EMBED.webm", queueTaskId: "SHOULD_NOT_QUEUE",
    }, "text-materials", "text-import");
    first.rawText = "  原文一\r\n$& $` $' $$  ";
    const firstWithHistory = attachTextTranscript(first, "text-materials", "text-import");
    const segments: Segment[] = [
      firstWithHistory,
      {
        index: 9, startOffsetMs: 1_000, endOffsetMs: 2_000, isFinal: true,
        sourcePath: "Notes/source-two.md", text: "第二份原文 $& $` $' $$",
        audioName: "SHOULD_NOT_EMBED.webm", queueTaskId: "SHOULD_NOT_QUEUE",
      },
      {
        index: 12, startOffsetMs: 2_000, endOffsetMs: 3_000, isFinal: true,
        rawText: "", text: "EMPTY RAW MUST NOT DISPLAY",
        audioName: "SHOULD_NOT_EMBED.webm", queueTaskId: "SHOULD_NOT_QUEUE",
      },
      {
        index: 20, startOffsetMs: 3_000, endOffsetMs: 4_000, isFinal: true,
        sourceName: "空白来源", rawText: " \r\n\t ", text: "WHITESPACE RAW MUST NOT DISPLAY",
        audioName: "SHOULD_NOT_EMBED.webm", queueTaskId: "SHOULD_NOT_QUEUE",
      },
    ];
    const session: RecordingSession = {
      id: "text-materials", sessionStamp: "text-materials",
      startedAt: "2026-09-14T12:00:00.000Z", mdPath: path,
      mode: "meeting", source: "text-import", segments, finalized: true,
    };
    const output = "---\ntitle: new\n---\n\n模型正文 $& $` $' $$";
    const modelBody = "模型正文 $& $` $' $$";
    const sourceHeadings = [
      "### 1. [[Notes/source-one.md|来源一 $& $` $' $$]]",
      "### 2. [[Notes/source-two.md|文本 2]]",
      "### 3. 文本 3",
      "### 4. 空白来源",
    ];
    const rawTexts = ["  原文一\r\n$& $` $' $$  ", "第二份原文 $& $` $' $$", "", " \r\n\t "];
    const assertTranscriptState = (markdown: string) => {
      const blocks = readTranscriptBlocks(markdown);
      expect(blocks).toHaveLength(4);
      expect(blocks.map((block) => block.segment.transcript?.id)).toEqual([
        firstWithHistory.transcript!.id, "seg:text-materials:9", "seg:text-materials:12", "seg:text-materials:20",
      ]);
      expect(blocks.map((block) => block.segment.transcript?.sourceId)).toEqual(Array(4).fill("text-materials"));
      expect(blocks.map((block) => block.visibleBlock)).toEqual([
        rawTexts[0], rawTexts[1], labelText("emptyTextSource"), rawTexts[3],
      ]);
      for (const [index, block] of blocks.entries()) {
        const transcript = block.segment.transcript!;
        const id = transcript.id;
        expect(markdown.split(`<!-- qnalog-transcript-start:${id} -->`).length - 1).toBe(1);
        expect(markdown.split(`<!-- qnalog-transcript-end:${id} -->`).length - 1).toBe(1);
        expect(markdown.split(`<!-- qnalog-transcript-text-start:${id} -->`).length - 1).toBe(1);
        expect(markdown.split(`<!-- qnalog-transcript-text-end:${id} -->`).length - 1).toBe(1);
        const current = transcript.revisions.find((revision) => revision.revision === transcript.currentRevision)!;
        expect(current.rawText).toBe(rawTexts[index]);
        expect(current.displayText).toBe(block.visibleBlock);
        const expectedUnits = [
          ["  原文一\r\n", "$& $` $' $$  "],
          ["第二份原文 $& $` $' $$"],
          [],
          [],
        ][index];
        expect(current.normalizationRevision).toBe(1);
        expect(current.corrections).toEqual([]);
        expect(current.utterances).toEqual(expectedUnits.map((text, unitIndex) => ({
          id: `${id}:r${transcript.currentRevision}:u${unitIndex + 1}`,
          parentSegmentId: id,
          rawText: text,
          normalizedText: text,
          speakerId: null,
          speakerName: null,
          startMs: null,
          endMs: null,
          timing: "unknown",
          audioRef: null,
          source: "text-import",
        })));
      }
      const expectedHistory = firstWithHistory.transcript!;
      const actualHistory = blocks[0].segment.transcript!;
      expect(actualHistory.currentRevision).toBe(expectedHistory.currentRevision);
      expect(actualHistory.revisions).toHaveLength(2);
      expect(actualHistory.revisions.map((revision) => ({
        revision: revision.revision,
        normalizationRevision: revision.normalizationRevision,
        rawText: revision.rawText,
        corrections: revision.corrections,
        utterances: revision.utterances,
      }))).toEqual(expectedHistory.revisions.map((revision) => ({
        revision: revision.revision,
        normalizationRevision: revision.normalizationRevision,
        rawText: revision.rawText,
        corrections: revision.corrections,
        utterances: revision.utterances,
      })));
      expect(actualHistory.revisions[0].displayText).toBe(expectedHistory.revisions[0].displayText);
      expect(actualHistory.revisions[1].displayText).toBe(blocks[0].visibleBlock);
      expect(segments.slice(1).every((segment) => segment.transcript === undefined)).toBe(true);
    };
    try {
      for (const language of ["zh", "en"]) {
        setActiveUiLanguage(matchUiLanguage(language)!);
        await vault.vault.modify(file, original);
        await writer.rewriteConsolidated(session, output);
        const rewritten = await vault.vault.read(file);
        await writer.rewriteConsolidated(session, output);
        expect(await vault.vault.read(file)).toBe(rewritten);
        const rewrittenBlocks = readTranscriptBlocks(rewritten);
        assertTranscriptState(rewritten);
        expect(rewritten).toContain(`<summary>${labelText("importedTextSources", 4)}</summary>`);
        expect(rewritten.indexOf(modelBody)).toBeLessThan(rewritten.indexOf(sourceHeadings[0]));
        expect(sourceHeadings.map((heading) => rewritten.indexOf(heading))).toEqual(
          [...sourceHeadings].map((_, index) => rewritten.indexOf(sourceHeadings[index])).sort((a, b) => a - b),
        );
        expect(rewrittenBlocks).toHaveLength(4);
        expect(rewrittenBlocks.map((block) => block.segment.transcript?.sourceId)).toEqual([
          "text-materials", "text-materials", "text-materials", "text-materials",
        ]);
        expect(rewrittenBlocks.map((block) => block.segment.transcript?.id)).toEqual([
          firstWithHistory.transcript?.id,
          "seg:text-materials:9",
          "seg:text-materials:12",
          "seg:text-materials:20",
        ]);
        expect(rewrittenBlocks.map((block) => block.visibleBlock)).toEqual([
          rawTexts[0], rawTexts[1], labelText("emptyTextSource"), rawTexts[3],
        ]);
        expect(rewrittenBlocks.map((block) => {
          const transcript = block.segment.transcript!;
          return transcript.revisions.find((revision) => revision.revision === transcript.currentRevision)?.rawText;
        })).toEqual(rawTexts);
        expect(firstWithHistory.transcript?.revisions).toHaveLength(2);
        expect(segments[1].transcript).toBeUndefined();
        expect(rewritten).not.toContain("![[SHOULD_NOT_EMBED.webm]]");
        expect(rewritten).not.toContain(nsMarker("transcribe-task", "SHOULD_NOT_QUEUE"));
        expect(rewritten).not.toContain(nsMarker("segments-start", session.id));
        expect(rewritten).not.toContain("transcribe-task");

        await vault.vault.modify(file, original);
        await writer.appendPolishBlock(session, output, null, false, "", original);
        const appended = await vault.vault.read(file);
        assertTranscriptState(appended);
        const appendedSourceSummary = `<summary>${labelText("importedTextSources", 4)}</summary>`;
        expect(appended.indexOf(modelBody))
          .toBeLessThan(appended.lastIndexOf("<details>", appended.indexOf(appendedSourceSummary)));
        expect(readTranscriptBlocks(appended)).toHaveLength(4);
        expect(appended.indexOf(modelBody)).toBeLessThan(appended.indexOf(sourceHeadings[0]));
        expect(appended).toContain(`<summary>${labelText("importedTextSources", 4)}</summary>`);

        await vault.vault.modify(file, original);
        await writer.appendPolishBlock(session, output, new Error("temporary failure"), false, "", original);
        const failed = await vault.vault.read(file);
        assertTranscriptState(failed);
        const failedSourceSummary = `<summary>${labelText("importedTextSources", 4)}</summary>`;
        expect(failed.indexOf(labelText("mergeFailedQueued", "temporary failure")))
          .toBeLessThan(failed.lastIndexOf("<details>", failed.indexOf(failedSourceSummary)));
        expect(failed).toContain("title: old");
        expect(failed).toContain(labelText("mergeFailedQueued", "temporary failure"));
        expect(failed).not.toContain(modelBody);
        expect(readTranscriptBlocks(failed)).toHaveLength(4);
        expect(failed).toContain(`<summary>${labelText("importedTextSources", 4)}</summary>`);
      }
    } finally {
      setActiveUiLanguage(originalLanguage);
      vi.unstubAllGlobals();
      if (originalWindow !== undefined) vi.stubGlobal("window", originalWindow);
    }
  });
});

describe("NoteWriter narrow host capabilities", () => {
  it("preserves the transcript ledger and frontmatter ordering across rewrite and append", async () => {
    const path = "QnALog/Minutes/content.md";
    const file = new obsidian.TFile(path);
    const sourceText = "Q&A：第一行\n第二行 $& `$` $$ literal $' ending";
    const segment: Segment = attachTextTranscript({
      index: 0,
      startOffsetMs: 0,
      endOffsetMs: 12_000,
      text: sourceText,
      isFinal: true,
    }, "content-session", "text-import");
    const ledger = serializeTranscriptBlock(segment, "### Source transcript", sourceText);
    const oldMarker = "<!-- qnalog-continuation-committed:prior-session -->";
    const original = [
      "---",
      "title: old",
      "---",
      "",
      "# Existing note",
      ledger,
      oldMarker,
      oldMarker,
    ].join("\n");
    const vault = memoryVault([{ file, markdown: original }]);
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-10-07 12:00" }) });
    try {
      const writer = new NoteWriter(unexpectedHost(vault.vault, {
        ...DEFAULT_SETTINGS,
        llmModel: "consumer-test-model",
      }));
      const session: RecordingSession = {
        id: "content-session",
        sessionStamp: "content-session",
        startedAt: "2026-10-07T12:00:00.000Z",
        mdPath: path,
        mode: "meeting",
        segments: [segment],
        finalized: true,
      };

      await writer.rewriteConsolidated(session, "---\ntitle: polished\n---\n\nRewrite body", "new-session");
      const rewritten = (await vault.vault.read(file));
      expect(splitLeadingFrontmatter(rewritten).frontmatter).toContain("title: polished");
      expect(rewritten.indexOf("Rewrite body")).toBeLessThan(rewritten.indexOf("## Original material"));
      expect(readTranscriptBlocks(rewritten).map(block => block.visibleBlock)).toEqual([sourceText]);
      expect(rewritten.match(/<!-- qnalog-continuation-committed:prior-session -->/g)).toHaveLength(1);
      expect(rewritten.match(/<!-- qnalog-continuation-committed:new-session -->/g)).toHaveLength(1);

      const appendOriginal = [
        "---",
        "title: old",
        "---",
        "",
        "# Existing note",
        ledger,
      ].join("\n");
      await vault.vault.modify(file, appendOriginal);
      await writer.appendPolishBlock(session, "---\ntitle: appended\n---\n\nAppend body", null, false, "append-session", appendOriginal);
      const appended = await vault.vault.read(file);
      expect(splitLeadingFrontmatter(appended).frontmatter).toContain("title: appended");
      expect(appended.indexOf("# Existing note")).toBeLessThan(appended.indexOf("Append body"));
      expect(readTranscriptBlocks(appended).map(block => block.visibleBlock)).toEqual([sourceText]);
      expect(appended.endsWith("<!-- qnalog-continuation-committed:append-session -->\n")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("preserves raw segment materials and ledger across rewrite in both UI languages", async () => {
    const path = "QnALog/Minutes/raw-materials.md";
    const file = new obsidian.TFile(path);
    const audioName = "原音-$&-$`-$'-$$.webm";
    const sourceText = "中文原文\n$& $` $' $$";
    const segment0 = attachTextTranscript({
      index: 0, startOffsetMs: 2_000, endOffsetMs: 5_000,
      audioStartOffsetMs: 18_000, audioEndOffsetMs: 21_000, audioName, text: sourceText,
    }, "raw-materials", "text-import");
    const segment2 = attachTextTranscript({
      index: 2, startOffsetMs: 5_000, endOffsetMs: 6_000,
      audioStartOffsetMs: 0, audioEndOffsetMs: 1_000, audioName: "retry.webm",
      text: "不得显示的错误旧文本", error: "temporary failure", queueTaskId: "raw-retry",
    }, "raw-materials", "text-import");
    const segment5 = attachTextTranscript({
      index: 5, startOffsetMs: 6_000, endOffsetMs: 7_000,
      text: "不得显示的失败旧文本", error: "permanent failure",
    }, "raw-materials", "text-import");
    const segment7: Segment = {
      index: 7, startOffsetMs: 7_000, endOffsetMs: 8_000,
      text: "", queueTaskId: "legacy-retry", error: "temporary failure",
    };
    const segment9: Segment = {
      index: 9, startOffsetMs: 8_000, endOffsetMs: 9_000,
      text: "", isFinal: true,
    };
    const segments = [segment0, segment2, segment5, segment7, segment9];
    const segmentSnapshot = structuredClone(segments);
    const vault = memoryVault([{ file, markdown: "# Existing note\n" }]);
    const writer = new NoteWriter(unexpectedHost(vault.vault, {
      ...DEFAULT_SETTINGS, llmModel: "consumer-test-model",
    }));
    const originalLanguage = getActiveUiLanguage();
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-10-08 08:00" }) });
    try {
      for (const language of ["zh", "en"]) {
        setActiveUiLanguage(matchUiLanguage(language)!);
        const session: RecordingSession = {
          id: "raw-materials",
          sessionStamp: "raw-materials",
          startedAt: "2026-10-08T08:00:00.000Z",
          mdPath: path,
          mode: "meeting",
          source: "recording",
          multiSourceAudio: true,
          segments,
          finalized: true,
        };
        const marker = nsMarker("segments-start", session.id);
        const endMarker = nsMarker("segments-end", session.id);
        const expected0 = serializeTranscriptBlock(
          segment0,
          `### ${labelText("segment", 1)} (00:02–00:05) [[${audioName}|00:18]]`,
          sourceText,
        );
        const expected2 = serializeTranscriptBlock(
          segment2,
          `### ${labelText("segment", 3)} (00:05–00:06) [[retry.webm|00:00]]\n\n${nsMarker("transcribe-task", "raw-retry")}`,
          getTranscribeSegmentPlaceholder(segment2.error, { retryable: true }),
        );
        const expected5 = serializeTranscriptBlock(
          segment5,
          `### ${labelText("segment", 6)} (00:06–00:07) `,
          getTranscribeSegmentPlaceholder(segment5.error, { retryable: false }),
        );
        const expectedRaw = [
          expected0,
          expected2,
          expected5,
          `### ${labelText("segment", 8)} (00:07–00:08) \n\n${nsMarker("transcribe-task", "legacy-retry")}\n${getTranscribeSegmentPlaceholder(segment7.error, { retryable: true })}\n`,
          `### ${labelText("segment", 10)} (00:08–00:09)  · 结束\n\n${labelText("noContentSegment")}\n`,
        ].join("\n");
        await writer.rewriteConsolidated(session, "Rewrite body");
        const first = await vault.vault.read(file);
        const start = first.indexOf(marker);
        const end = first.indexOf(endMarker);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        expect(first.slice(start, end)).toBe(`${marker}\n\n${expectedRaw}\n`);
        const blocks = readTranscriptBlocks(first);
        expect(blocks.map(block => block.visibleBlock)).toEqual([
          sourceText,
          getTranscribeSegmentPlaceholder(segment2.error, { retryable: true }),
          getTranscribeSegmentPlaceholder(segment5.error, { retryable: false }),
        ]);
        expect(blocks.map(block => block.segment.transcript?.sourceId)).toEqual(["raw-materials", "raw-materials", "raw-materials"]);
        expect(blocks.map(block => block.segment.transcript?.currentRevision)).toEqual([
          segment0.transcript!.currentRevision,
          segment2.transcript!.currentRevision,
          segment5.transcript!.currentRevision,
        ]);
        expect(blocks.map(block => {
          const transcript = block.segment.transcript!;
          return transcript.revisions.find(revision => revision.revision === transcript.currentRevision)?.rawText;
        })).toEqual([sourceText, "不得显示的错误旧文本", "不得显示的失败旧文本"]);
        await writer.rewriteConsolidated(session, "Rewrite body");
        expect(await vault.vault.read(file)).toBe(first);
        expect(segments).toEqual(segmentSnapshot);

        await writer.rewriteConsolidated({ ...session, source: "text-import" }, "Rewrite body");
        const imported = await vault.vault.read(file);
        expect(imported).not.toContain(marker);
        expect(imported).not.toContain(endMarker);
        expect(imported).not.toContain(nsMarker("transcribe-task", "raw-retry"));
        expect(imported).not.toContain(nsMarker("transcribe-task", "legacy-retry"));
      }
    } finally {
      setActiveUiLanguage(originalLanguage);
      vi.unstubAllGlobals();
    }
  });
  it("uses the current vault, settings, and frontmatter provider after construction", async () => {
    const file = new obsidian.TFile("QnALog/Minutes/current.md");
    const oldVault = memoryVault([{ file, markdown: "old vault bytes" }]);
    const activeVault = memoryVault([{ file, markdown: "new vault bytes" }]);
    let vault: NoteWriterVault = oldVault.vault;
    let settings: NoteWriterSettings = { ...DEFAULT_SETTINGS, polishMode: "meeting" };
    let frontmatter: obsidian.CachedMetadata["frontmatter"] = { qnalog_mode: "monologue" };
    const host = unexpectedHost(oldVault.vault, settings, {
      get getFileFrontmatter() { return () => frontmatter; },
    });
    Object.defineProperty(host, "vault", { get: () => vault });
    Object.defineProperty(host, "settings", { get: () => settings });
    const writer = new NoteWriter(host);

    vault = activeVault.vault;
    settings = {
      ...settings,
      polishMode: "seminar",
      llmModel: "active model",
      promptTemplates: {
        ...settings.promptTemplates,
        "custom-writer": {
          id: "custom-writer",
          mode: "custom-writer",
          customMode: true,
          name: "Writer template",
          prompt: "Custom prompt body",
        },
      },
    };
    frontmatter = { qnalog_mode: "meeting" };
    await writer.appendToNote(file.path, "new write");
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 11:00:00" }) });
    try {
      await writer.appendPolishBlock({
        id: "writer-session",
        mdPath: file.path,
        mode: "custom-writer",
        startedAt: "2026-09-14T11:00:00.000Z",
        segments: [],
        source: "text-import",
      } as never, "organized user-visible body", null);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(activeVault.files.get(file.path)?.markdown).toContain("active model · Custom prompt:Writer template");
    expect(activeVault.files.get(file.path)?.markdown).toContain("organized user-visible body");
  });

  it("continues a delayed title callback with the current rename capability and storage", async () => {
    const file = new obsidian.TFile("QnALog/Minutes/original.md");
    const oldVault = memoryVault([{ file, markdown: "old title source" }]);
    const newVault = memoryVault([{ file, markdown: "current title source" }]);
    let activeVault = oldVault;
    let settings: NoteWriterSettings = { ...DEFAULT_SETTINGS, autoRenameWithTitle: true };
    let renameCalls = 0;
    const gate = Promise.withResolvers<string>();
    const host = unexpectedHost(oldVault.vault, settings, {
      get vault() { return activeVault.vault; },
      get settings() { return settings; },
      generateTitleTag: async () => gate.promise,
      findAvailableMarkdownPath: (target) => target,
      renameFile: async (targetFile, path) => {
        renameCalls += 1;
        const entry = activeVault.files.get(targetFile.path);
        activeVault.files.delete(targetFile.path);
        targetFile.path = path;
        targetFile.name = path.split("/").pop() || path;
        targetFile.basename = targetFile.name.replace(/\.[^.]+$/, "");
        activeVault.files.set(path, { file: targetFile, markdown: entry.markdown });
      },
    });
    const writer = new NoteWriter(host);
    const rename = writer.renameMarkdownWithGeneratedTitle(file, "polished body", "meeting");

    activeVault = newVault;
    settings = { ...settings, autoRenameWithTitle: false };
    gate.resolve("topic");
    const renamed = await rename;

    expect(renameCalls).toBe(1);
    expect(renamed).toBe(file);
    expect(file.path).toContain("topic");
    expect(newVault.files.get(file.path)?.markdown).toBe("current title source");
    expect(oldVault.files.get("QnALog/Minutes/original.md")?.markdown).toBe("old title source");
  });
  it("keeps title rename guards, lookup boundaries, and no-op results", async () => {
    const file = new obsidian.TFile("QnALog/Minutes/unchanged.md");
    const original = "unchanged body";
    const vault = memoryVault([{ file, markdown: original }]);
    let titleCalls = 0;
    let renameCalls = 0;
    const host = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, autoRenameWithTitle: true }, {
      generateTitleTag: async () => { titleCalls += 1; return "topic"; },
      findAvailableMarkdownPath: (target) => target,
      renameFile: async () => { renameCalls += 1; },
    });
    const writer = new NoteWriter(host);

    expect(await writer.renameMarkdownWithGeneratedTitle("missing.md", "body", "meeting")).toBeNull();
    expect(await writer.renameMarkdownWithGeneratedTitle(null, "body", "meeting")).toBeNull();
    expect(await writer.renameMarkdownWithGeneratedTitle(undefined, "body", "meeting")).toBeNull();
    expect(await writer.renameMarkdownWithGeneratedTitle({ path: file.path }, "body", "meeting")).toBeNull();
    expect(await writer.renameMarkdownWithGeneratedTitle(file, "", "meeting")).toBeNull();
    expect(await writer.renameMarkdownWithGeneratedTitle(file, "body", "off")).toBeNull();
    expect(titleCalls).toBe(0);
    const disabledVault = { ...vault.vault, getAbstractFileByPath: () => { throw new Error("disabled rename must skip lookup"); } } as NoteWriterVault;
    const disabledWriter = new NoteWriter(unexpectedHost(disabledVault, { ...DEFAULT_SETTINGS, autoRenameWithTitle: false }));
    expect(await disabledWriter.renameMarkdownWithGeneratedTitle("missing.md", "body", "meeting")).toBeNull();
    expect(titleCalls).toBe(0);

    const nonFileVault = {
      ...vault.vault,
      getAbstractFileByPath: () => ({ path: file.path }),
    } as unknown as NoteWriterVault;
    const nonFileWriter = new NoteWriter(unexpectedHost(nonFileVault, { ...DEFAULT_SETTINGS, autoRenameWithTitle: true }, {
      generateTitleTag: async () => { titleCalls += 1; return "unexpected"; },
    }));
    expect(await nonFileWriter.renameMarkdownWithGeneratedTitle("present.md", "body", "meeting")).toBeNull();
    expect(titleCalls).toBe(0);
    const activeHost = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, autoRenameWithTitle: true }, {
      generateTitleTag: async () => "",
      findAvailableMarkdownPath: () => { throw new Error("empty title must skip allocation"); },
      renameFile: async () => { renameCalls += 1; },
    });
    const activeWriter = new NoteWriter(activeHost);
    expect(await activeWriter.renameMarkdownWithGeneratedTitle(file, "body", "meeting")).toBe(file);
    expect(renameCalls).toBe(0);

    for (const allocatorResult of ["", "QnALog/Minutes/unchanged.md"]) {
      const noOpWriter = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, autoRenameWithTitle: true }, {
        generateTitleTag: async () => "topic",
        findAvailableMarkdownPath: () => allocatorResult,
        renameFile: async () => { renameCalls += 1; },
      }));
      expect(await noOpWriter.renameMarkdownWithGeneratedTitle(file, "body", "meeting")).toBe(file);
    }
    const backslashWriter = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, autoRenameWithTitle: true }, {
      generateTitleTag: async () => "topic",
      findAvailableMarkdownPath: () => "QnALog\\Minutes\\unchanged.md",
      renameFile: async () => { renameCalls += 1; },
    }));
    expect(await backslashWriter.renameMarkdownWithGeneratedTitle(file, "body", "meeting")).toBe(file);
    expect(renameCalls).toBe(0);
    expect(file.path).toBe("QnALog/Minutes/unchanged.md");
    expect(await vault.vault.read(file)).toBe(original);
  });

  it("renames a string path using the live localized custom template and allocator result", async () => {
    const originalLanguage = getActiveUiLanguage();
    const file = new obsidian.TFile("QnALog/Minutes/original.md");
    const conflict = new obsidian.TFile("QnALog/Minutes/original · 工作纪要-topic.md");
    const original = "# Original\n\nBody.";
    const vault = memoryVault([
      { file, markdown: original },
      { file: conflict, markdown: "conflict body" },
    ]);
    setActiveUiLanguage(matchUiLanguage("zh")!);
    try {
      let titleCalls = 0;
      let allocated = "";
      const writer = new NoteWriter(unexpectedHost(vault.vault, {
        ...DEFAULT_SETTINGS,
        autoRenameWithTitle: true,
        promptTemplates: {
          "custom-title": { id: "custom-title", mode: "custom-title", customMode: true, name: "工作纪要", prompt: "fixture" },
        },
      }, {
        generateTitleTag: async () => { titleCalls += 1; return "topic"; },
        findAvailableMarkdownPath: (target, current) => {
          expect(target).toBe("QnALog/Minutes/original · 工作纪要-topic.md");
          expect(current).toBe("QnALog/Minutes/original.md");
          allocated = "QnALog/Minutes/original · 工作纪要-topic (2).md";
          return allocated;
        },
        renameFile: async (targetFile, path) => {
          const entry = vault.files.get(targetFile.path);
          if (!entry) throw new Error("missing rename source");
          vault.files.delete(targetFile.path);
          targetFile.path = path;
          targetFile.name = path.split("/").pop() || path;
          targetFile.basename = targetFile.name.replace(/\.[^.]+$/, "");
          vault.files.set(path, { file: targetFile, markdown: entry.markdown });
        },
      }));
      expect(await writer.renameMarkdownWithGeneratedTitle(file.path, "polished body", "custom-title")).toBe(file);
      expect(titleCalls).toBe(1);
      expect(vault.files.has("QnALog/Minutes/original.md")).toBe(false);
      expect(vault.files.get(allocated)?.markdown).toBe(original);
      expect(vault.files.get(conflict.path)?.markdown).toBe("conflict body");
      expect(file.path).toBe(allocated);
    } finally {
      setActiveUiLanguage(originalLanguage);
    }
  });

  it("uses current host capabilities after title and rename waits and preserves partial moves", async () => {
    const originalLanguage = getActiveUiLanguage();
    const file = new obsidian.TFile("QnALog/Minutes/original.md");
    const oldVault = memoryVault([{ file, markdown: "A bytes" }]);
    const newVault = memoryVault([{ file, markdown: "B bytes" }]);
    const titleGate = Promise.withResolvers<string>();
    const titleEntered = Promise.withResolvers<void>();
    const renameGate = Promise.withResolvers<void>();
    const renameEntered = Promise.withResolvers<void>();
    let activeHost: NoteWriterHost;
    const initialHost = unexpectedHost(oldVault.vault, {
      ...DEFAULT_SETTINGS,
      autoRenameWithTitle: true,
      promptTemplates: {
        "custom-title": { id: "custom-title", mode: "custom-title", customMode: true, name: "EarlyTemplate", prompt: "fixture" },
      },
    }, {
      generateTitleTag: async () => { titleEntered.resolve(); return titleGate.promise; },
      findAvailableMarkdownPath: () => { throw new Error("old allocator used"); },
      renameFile: async () => { throw new Error("old rename used"); },
    });
    activeHost = initialHost;
    const writer = new NoteWriter(initialHost);
    const originalLanguageValue = originalLanguage;
    setActiveUiLanguage(matchUiLanguage("zh")!);
    try {
      const pending = writer.renameMarkdownWithGeneratedTitle(file.path, "polished", "custom-title");
      await titleEntered.promise;
      oldVault.files.delete(file.path);
      file.path = "QnALog/Minutes/moved.md";
      file.name = "moved.md";
      file.basename = "moved";
      oldVault.files.set(file.path, { file, markdown: "A bytes" });
    newVault.files.delete("QnALog/Minutes/original.md");
    newVault.files.set(file.path, { file, markdown: "B bytes" });
      activeHost = unexpectedHost(newVault.vault, {
        ...DEFAULT_SETTINGS,
        autoRenameWithTitle: false,
        promptTemplates: {
          "custom-title": { id: "custom-title", mode: "custom-title", customMode: true, name: "LateTemplate", prompt: "fixture" },
        },
      }, {
        generateTitleTag: async () => { throw new Error("unexpected title retry"); },
        findAvailableMarkdownPath: (target, current) => {
          expect(target).toBe("QnALog/Minutes/moved · LateTemplate-topic.md");
          expect(current).toBe("QnALog/Minutes/moved.md");
          return target;
        },
        renameFile: async (targetFile, path) => {
          expect(targetFile).toBe(file);
          const entry = newVault.files.get(targetFile.path);
          if (!entry) throw new Error("missing live rename source");
          newVault.files.delete(targetFile.path);
          targetFile.path = path;
          targetFile.name = path.split("/").pop() || path;
          targetFile.basename = targetFile.name.replace(/\.[^.]+$/, "");
          newVault.files.set(path, { file: targetFile, markdown: entry.markdown });
          renameEntered.resolve();
          await renameGate.promise;
        },
      });
      writer.host = activeHost;
      titleGate.resolve("topic");
      await renameEntered.promise;
      const lookupFile = new obsidian.TFile(file.path);
      const lookupVault = memoryVault([{ file: lookupFile, markdown: "B bytes" }]);
      activeHost = unexpectedHost(lookupVault.vault, {
        ...DEFAULT_SETTINGS,
        autoRenameWithTitle: false,
      });
      writer.host = activeHost;
      renameGate.resolve();
      expect(await pending).toBe(lookupFile);
      expect(await lookupVault.vault.read(lookupFile)).toBe("B bytes");
      expect([...oldVault.files.values()].map((entry) => entry.markdown)).toContain("A bytes");
    } finally {
      setActiveUiLanguage(originalLanguageValue);
    }
  });

  it("keeps pre-try rejections distinct from caught post-title failures", async () => {
    const file = new obsidian.TFile("QnALog/Minutes/unchanged.md");
    const vault = memoryVault([{ file, markdown: "original body" }]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const initialFailure = new Error("initial settings failed");
      const initialHost = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, autoRenameWithTitle: true });
      Object.defineProperty(initialHost, "settings", { get: () => { throw initialFailure; } });
      await expect(new NoteWriter(initialHost).renameMarkdownWithGeneratedTitle(file, "body", "meeting")).rejects.toBe(initialFailure);
      expect(logged).not.toHaveBeenCalled();

      const lookupFailure = new Error("initial lookup failed");
      const rejectingLookupVault = { ...vault.vault, getAbstractFileByPath: () => { throw lookupFailure; } } as NoteWriterVault;
      const lookupHost = unexpectedHost(rejectingLookupVault, { ...DEFAULT_SETTINGS, autoRenameWithTitle: true });
      await expect(new NoteWriter(lookupHost).renameMarkdownWithGeneratedTitle(file.path, "body", "meeting")).rejects.toBe(lookupFailure);
      expect(logged).not.toHaveBeenCalled();

      const settingsFailure = new Error("path settings failed");
      let settingsReads = 0;
      const pathHost = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, autoRenameWithTitle: true }, {
        generateTitleTag: async () => "topic",
      });
      Object.defineProperty(pathHost, "settings", {
        get: () => {
          settingsReads += 1;
          if (settingsReads > 1) throw settingsFailure;
          return { ...DEFAULT_SETTINGS, autoRenameWithTitle: true };
        },
      });
      expect(await new NoteWriter(pathHost).renameMarkdownWithGeneratedTitle(file, "body", "meeting")).toBe(file);
      expect(logged).toHaveBeenLastCalledWith("[QnALog] rename failed", settingsFailure);
      expect(file.path).toBe("QnALog/Minutes/unchanged.md");
      expect(await vault.vault.read(file)).toBe("original body");

      const allocationFailure = new Error("allocation failed");
      const allocationHost = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, autoRenameWithTitle: true }, {
        generateTitleTag: async () => "topic",
        findAvailableMarkdownPath: () => { throw allocationFailure; },
      });
      expect(await new NoteWriter(allocationHost).renameMarkdownWithGeneratedTitle(file, "body", "meeting")).toBe(file);
      expect(logged).toHaveBeenLastCalledWith("[QnALog] rename failed", allocationFailure);
      expect(file.path).toBe("QnALog/Minutes/unchanged.md");
      expect(await vault.vault.read(file)).toBe("original body");
    } finally {
      logged.mockRestore();
    }
  });
  it("returns the original object when post-rename lookup is missing or fails without rollback", async () => {
    for (const lookupResult of [null, { path: "QnALog/Minutes/target.md" }]) {
      const file = new obsidian.TFile("QnALog/Minutes/source.md");
      const original = "kept bytes";
      const vault = memoryVault([{ file, markdown: original }]);
      const destination = "QnALog/Minutes/target.md";
      const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, autoRenameWithTitle: true }, {
        generateTitleTag: async () => "topic",
        findAvailableMarkdownPath: () => destination,
        renameFile: async (targetFile, path) => {
          const entry = vault.files.get(targetFile.path)!;
          vault.files.delete(targetFile.path);
          targetFile.path = path;
          targetFile.name = "target.md";
          targetFile.basename = "target";
          vault.files.set(path, { file: targetFile, markdown: entry.markdown });
        },
      }));
      writer.host.vault.getAbstractFileByPath = (path) => {
        expect(path).toBe(destination);
        return lookupResult as File | null;
      };
      expect(await writer.renameMarkdownWithGeneratedTitle(file, "body", "meeting")).toBe(file);
      expect(file.path).toBe(destination);
      expect(vault.files.get(destination)?.markdown).toBe(original);
    }

    const file = new obsidian.TFile("QnALog/Minutes/source.md");
    const vault = memoryVault([{ file, markdown: "kept after lookup error" }]);
    const lookupFailure = new Error("post-rename lookup failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, autoRenameWithTitle: true }, {
        generateTitleTag: async () => "topic",
        findAvailableMarkdownPath: () => "QnALog/Minutes/target.md",
        renameFile: async (targetFile, path) => {
          const entry = vault.files.get(targetFile.path)!;
          vault.files.delete(targetFile.path);
          targetFile.path = path;
          targetFile.name = "target.md";
          targetFile.basename = "target";
          vault.files.set(path, { file: targetFile, markdown: entry.markdown });
        },
      }));
      writer.host.vault.getAbstractFileByPath = (path) => {
        expect(path).toBe("QnALog/Minutes/target.md");
        throw lookupFailure;
      };
      expect(await writer.renameMarkdownWithGeneratedTitle(file, "body", "meeting")).toBe(file);
      expect(file.path).toBe("QnALog/Minutes/target.md");
      expect(vault.files.get(file.path)?.markdown).toBe("kept after lookup error");
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith("[QnALog] rename failed", lookupFailure);
    } finally {
      logged.mockRestore();
    }
  });

  it("preserves editor polish behavior across selection, modes, language, timing, and failures", async () => {
    const originalLanguage = getActiveUiLanguage();
    const vault = memoryVault();
    const settings: NoteWriterSettings = { ...DEFAULT_SETTINGS, polishMode: "meeting" };
    let calls: Array<{ raw: string; mode: string }> = [];
    let response = "POLISHED OUTPUT";
    const host = unexpectedHost(vault.vault, settings, {
      polishTranscript: async (raw, mode) => {
        calls.push({ raw, mode });
        return response;
      },
    });
    const writer = new NoteWriter(host);
    try {
      for (const language of ["en", "zh"]) {
        setActiveUiLanguage(matchUiLanguage(language)!);
        calls = [];
        response = "POLISHED OUTPUT";
        const noticeStart = notices.length;
        let documentReads = 0;
        let selected = "";
        const selectedEditor = {
          getSelection: () => "selected text",
          getValue: () => { documentReads++; return "whole document"; },
          replaceSelection: (value: string) => { selected = value; },
          setValue: () => { throw new Error("selected text must not replace the document"); },
        };
        await writer.polishEditor(selectedEditor as never);
        expect(selected).toBe(response);
        expect(documentReads).toBe(0);
        expect(calls).toEqual([{ raw: "selected text", mode: "meeting" }]);
        expect(notices.slice(noticeStart)).toEqual(language === "en"
          ? ["AI polishing...", "Polishing complete"]
          : ["AI 润色中…", "润色完成"]);
        let fullText = "";
        await writer.polishEditor({
          getSelection: () => "",
          getValue: () => "whole document",
          replaceSelection: () => { throw new Error("empty selection must use setValue"); },
          setValue: (value: string) => { fullText = value; },
        } as never);
        expect(fullText).toBe(response);
        const beforeWhitespace = calls.length;
        await writer.polishEditor({
          getSelection: () => "  selected text  ",
          getValue: () => { throw new Error("selected input must not read the document"); },
          replaceSelection: (value: string) => { selected = value; },
          setValue: () => { throw new Error("selected input must use replaceSelection"); },
        } as never);
        expect(calls[beforeWhitespace]?.raw).toBe("  selected text  ");
        response = "";
        fullText = "prior";
        await writer.polishEditor({
          getSelection: () => "",
          getValue: () => "whole document",
          replaceSelection: () => { throw new Error("empty selection must use setValue"); },
          setValue: (value: string) => { fullText = value; },
        } as never);
        expect(fullText).toBe("");
      }

      setActiveUiLanguage(matchUiLanguage("en")!);
      calls = [];
      let forbiddenSettingsReads = 0;
      const blankHost = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS }, {
        polishTranscript: async () => { throw new Error("blank input must not call the model"); },
      });
      Object.defineProperty(blankHost, "settings", {
        configurable: true,
        get: () => { forbiddenSettingsReads++; throw new Error("blank input must not read settings"); },
      });
      writer.host = blankHost;
      for (const [selection, document] of [["", ""], ["", " \r\n\t "], [" ", "document"]]) {
        let getValueCalls = 0;
        const start = notices.length;
        await writer.polishEditor({
          getSelection: () => selection,
          getValue: () => { getValueCalls++; return document; },
          replaceSelection: () => { throw new Error("blank input must not write a selection"); },
          setValue: () => { throw new Error("blank input must not write a document"); },
        } as never);
        expect(notices.slice(start)).toEqual(["Nothing to polish"]);
        expect(getValueCalls).toBe(selection ? 0 : 1);
      }
      setActiveUiLanguage(matchUiLanguage("zh")!);
      const chineseBlankNoticeStart = notices.length;
      await writer.polishEditor({
        getSelection: () => " ",
        getValue: () => { throw new Error("blank selection must not read the document"); },
        replaceSelection: () => { throw new Error("blank selection must not write"); },
        setValue: () => { throw new Error("blank selection must not write"); },
      } as never);
      expect(notices.slice(chineseBlankNoticeStart)).toEqual(["没有可润色的内容"]);
      expect(forbiddenSettingsReads).toBe(0);
      setActiveUiLanguage(matchUiLanguage("en")!);
      expect(forbiddenSettingsReads).toBe(0);
      expect(calls).toEqual([]);
      writer.host = host;

      for (const [mode, expected] of [
        ["off", "meeting"],
        ["unknown-mode", "meeting"],
        ["seminar", "seminar"],
        ["custom-editor-probe", "custom-editor-probe"],
      ]) {
        const custom = mode === "custom-editor-probe";
        writer.host.settings = {
          ...DEFAULT_SETTINGS,
          polishMode: mode,
          ...(custom ? {
            promptTemplates: {
              "custom-editor-probe": {
                id: "custom-editor-probe",
                mode: "custom-editor-probe",
                customMode: true,
                name: "Editor probe",
                prompt: "Fixed prompt",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            },
          } : {}),
        };
        response = `RESULT ${expected}`;
        let written = "";
        await writer.polishEditor({
          getSelection: () => "input",
          getValue: () => "",
          replaceSelection: (value: string) => { written = value; },
          setValue: (value: string) => { written = value; },
        } as never);
        expect(calls.at(-1)?.mode).toBe(expected);
        expect(written).toBe(response);
      }

      const originalHost = writer.host;
      const hostA = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, polishMode: "meeting" }, {
        polishTranscript: async () => { throw new Error("host A model must not run"); },
      });
      const hostB = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, polishMode: "seminar" }, {
        polishTranscript: async (raw, mode) => {
          expect(["switch host", "switch during selection"]).toContain(raw);
          expect(mode).toBe("seminar");
          return "HOST B OUTPUT";
        },
      });
      Object.defineProperty(hostA, "settings", {
        configurable: true,
        get: () => { writer.host = hostB; return { ...DEFAULT_SETTINGS, polishMode: "meeting" }; },
      });
      writer.host = hostA;
      let hostOutput = "";
      await writer.polishEditor({
        getSelection: () => "switch host",
        getValue: () => "",
        replaceSelection: (value: string) => { hostOutput = value; },
        setValue: (value: string) => { hostOutput = value; },
      } as never);
      expect(hostOutput).toBe("HOST B OUTPUT");
      const selectionHostA = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, polishMode: "meeting" }, {
        polishTranscript: async () => { throw new Error("selection host A model must not run"); },
      });
      writer.host = selectionHostA;
      hostOutput = "";
      await writer.polishEditor({
        getSelection: () => {
          writer.host = hostB;
          return "switch during selection";
        },
        getValue: () => "",
        replaceSelection: (value: string) => { hostOutput = value; },
        setValue: (value: string) => { hostOutput = value; },
      } as never);
      expect(hostOutput).toBe("HOST B OUTPUT");
      writer.host = originalHost;

      let resolveModel!: (value: string) => void;
      const pendingHost = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, polishMode: "meeting" }, {
        polishTranscript: () => new Promise<string>((resolve) => { resolveModel = resolve; }),
      });
      writer.host = pendingHost;
      let currentSelection = "initial selection";
      let replacement = "";
      const pending = writer.polishEditor({
        getSelection: () => currentSelection,
        getValue: () => "whole document",
        replaceSelection: (value: string) => { replacement = value; },
        setValue: () => { throw new Error("initial selection must remain the write target"); },
      } as never);
      setActiveUiLanguage(matchUiLanguage("zh")!);
      currentSelection = "changed while waiting";
      resolveModel("ASYNC OUTPUT");
      await pending;
      expect(replacement).toBe("ASYNC OUTPUT");
      expect(notices.slice(-2)).toEqual(["AI polishing...", "润色完成"]);
      writer.host = originalHost;
      let resolveFullNote!: (value: string) => void;
      writer.host = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, polishMode: "meeting" }, {
        polishTranscript: () => new Promise<string>((resolve) => { resolveFullNote = resolve; }),
      });
      let liveSelection = "";
      let fullDocument = "initial full document";
      const pendingFullNote = writer.polishEditor({
        getSelection: () => liveSelection,
        getValue: () => fullDocument,
        replaceSelection: () => { throw new Error("initially empty selection must keep full-document write mode"); },
        setValue: (value: string) => { fullDocument = value; },
      } as never);
      liveSelection = "selection changed while waiting";
      resolveFullNote("FULL NOTE OUTPUT");
      await pendingFullNote;
      expect(fullDocument).toBe("FULL NOTE OUTPUT");
      writer.host = originalHost;

      setActiveUiLanguage(matchUiLanguage("en")!);
      const failureCases: Array<{ value: unknown; expected: string }> = [
        { value: new Error("service unavailable"), expected: "Polish failed: service unavailable" },
        { value: "service string", expected: "Polish failed: service string" },
        { value: null, expected: "Polish failed: null" },
        { value: { message: "object failure" }, expected: "Polish failed: object failure" },
        { value: { message: 0 }, expected: "Polish failed: [object Object]" },
      ];
      for (const item of failureCases) {
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
          writer.host = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, polishMode: "meeting" }, {
            polishTranscript: async () => { throw item.value; },
          });
          let text = "unchanged";
          const start = notices.length;
          await writer.polishEditor({
            getSelection: () => "failure input",
            getValue: () => "whole document",
            replaceSelection: (value: string) => { text = value; },
            setValue: (value: string) => { text = value; },
          } as never);
          expect(text).toBe("unchanged");
          expect(notices.slice(start)).toEqual(["AI polishing...", item.expected]);
          expect(logged).toHaveBeenCalledWith(item.value);
        } finally {
          logged.mockRestore();
        }
      }
      writer.host = originalHost;

      for (const key of ["getSelection", "getValue"] as const) {
        const failure = new Error(`${key} failure`);
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const before = notices.length;
        try {
          const badEditor = key === "getSelection"
            ? { getSelection: () => { throw failure; }, getValue: () => "", replaceSelection: () => undefined, setValue: () => undefined }
            : { getSelection: () => "", getValue: () => { throw failure; }, replaceSelection: () => undefined, setValue: () => undefined };
          await expect(writer.polishEditor(badEditor as never)).rejects.toBe(failure);
          expect(notices).toHaveLength(before);
          expect(logged).not.toHaveBeenCalled();
        } finally {
          logged.mockRestore();
        }
      }

      const syncFailures = [
        new Error("mode lookup failure"),
        new Error("synchronous model failure"),
      ];
      for (const [index, failure] of syncFailures.entries()) {
        const loggedSync = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
          const failingHost = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, polishMode: "meeting" }, {
            polishTranscript: () => { throw failure; },
          });
          if (index === 0) {
            Object.defineProperty(failingHost, "settings", {
              configurable: true,
              get: () => { throw failure; },
            });
          }
          writer.host = failingHost;
          let text = "original";
          const start = notices.length;
          await writer.polishEditor({
            getSelection: () => "input",
            getValue: () => "document",
            replaceSelection: (value: string) => { text = value; },
            setValue: (value: string) => { text = value; },
          } as never);
          expect(text).toBe("original");
          expect(notices.slice(start)).toEqual(["AI polishing...", index === 0
            ? "Polish failed: mode lookup failure"
            : "Polish failed: synchronous model failure"]);
          expect(loggedSync.mock.calls[0]?.[0]).toBe(failure);
        } finally {
          loggedSync.mockRestore();
        }
      }

      for (const useSelection of [true, false]) {
        for (const partialWrite of [false, true]) {
          const writeFailure = new Error("write failure");
          const loggedWrite = vi.spyOn(console, "error").mockImplementation(() => undefined);
          try {
            writer.host = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, polishMode: "meeting" }, {
              polishTranscript: async () => "written before failure",
            });
            let text = "original";
            const start = notices.length;
            await writer.polishEditor({
              getSelection: () => useSelection ? "input" : "",
              getValue: () => "document",
              replaceSelection: (value: string) => {
                if (useSelection) {
                  if (partialWrite) text = value;
                  throw writeFailure;
                }
              },
              setValue: (value: string) => {
                if (!useSelection) {
                  if (partialWrite) text = value;
                  throw writeFailure;
                }
              },
            } as never);
            expect(text).toBe(partialWrite ? "written before failure" : "original");
            expect(notices.slice(start)).toEqual(["AI polishing...", "Polish failed: write failure"]);
            expect(loggedWrite.mock.calls[0]?.[0]).toBe(writeFailure);
          } finally {
            loggedWrite.mockRestore();
          }
        }
      }
      writer.host = originalHost;

      const getterFailure = new Error("message getter failure");
      const failureObject = Object.defineProperty({}, "message", { get: () => { throw getterFailure; } });
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        writer.host = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, polishMode: "meeting" }, {
          polishTranscript: async () => { throw failureObject; },
        });
        await expect(writer.polishEditor({
          getSelection: () => "input",
          getValue: () => "",
          replaceSelection: () => undefined,
          setValue: () => undefined,
        } as never)).rejects.toBe(getterFailure);
        expect(logged.mock.calls[0]?.[0]).toBe(failureObject);
      } finally {
        logged.mockRestore();
        writer.host = originalHost;
      }
    } finally {
      setActiveUiLanguage(originalLanguage);
    }
  });
  it("leaves both sources untouched when confirmation is canceled or merging fails", async () => {
    const oldFile = new obsidian.TFile("QnALog/Minutes/older.txt");
    const currentFile = new obsidian.TFile("QnALog/Minutes/current.md");
    const oldText = "older source";
    const currentText = "current source";
    const vault = memoryVault([
      { file: oldFile, markdown: oldText },
      { file: currentFile, markdown: currentText },
    ]);
    let accepted = false;
    const host = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS }, {
      getRecentNotes: () => [
        { file: currentFile, timestamp: 2 },
        { file: oldFile, timestamp: 1 },
      ],
      confirm: async () => accepted,
    });
    const writer = new NoteWriter(host);

    await writer.mergeMarkdownFileWithPrevious(currentFile);
    expect(vault.files.size).toBe(2);
    expect(await vault.vault.read(oldFile)).toBe(oldText);
    expect(await vault.vault.read(currentFile)).toBe(currentText);

    accepted = true;
    const beforeFailure = notices.length;
    await writer.mergeMarkdownFileWithPrevious(currentFile);
    expect(vault.files.size).toBe(2);
    expect(await vault.vault.read(oldFile)).toBe(oldText);
    expect(await vault.vault.read(currentFile)).toBe(currentText);
    expect(notices.slice(beforeFailure).some((notice) => notice.includes("Merging minutes failed:"))).toBe(true);
  });
  it("returns the original note when title generation or rename fails", async () => {
    const file = new obsidian.TFile("QnALog/Minutes/unchanged.md");
    const vault = memoryVault([{ file, markdown: "original body" }]);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const titleFailure = new NoteWriter(unexpectedHost(vault.vault, {
        ...DEFAULT_SETTINGS,
        autoRenameWithTitle: true,
      }, {
        generateTitleTag: async () => { throw new Error("title unavailable"); },
      }));
      expect(await titleFailure.renameMarkdownWithGeneratedTitle(file, "body", "meeting")).toBe(file);

      const renameFailure = new NoteWriter(unexpectedHost(vault.vault, {
        ...DEFAULT_SETTINGS,
        autoRenameWithTitle: true,
      }, {
        generateTitleTag: async () => "topic",
        findAvailableMarkdownPath: (target) => target,
        renameFile: async () => { throw new Error("rename unavailable"); },
      }));
      expect(await renameFailure.renameMarkdownWithGeneratedTitle(file, "body", "meeting")).toBe(file);
      expect(file.path).toBe("QnALog/Minutes/unchanged.md");
      expect(await vault.vault.read(file)).toBe("original body");
    } finally {
      error.mockRestore();
    }
  });
  it("preserves append boundaries for existing and newly created notes", async () => {
    const vault = memoryVault();
    const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS }));
    const path = "QnALog/Minutes/append.md";
    const inputs = [
      [null, "body", "body"],
      ["existing", "body", "existing\nbody"],
      ["existing\n", "body", "existing\nbody"],
      ["existing\n\n", "body", "existing\n\nbody"],
      ["existing", "", "existing\n"],
      ["", "", "\n"],
    ] as const;

    for (const [initial, content, expected] of inputs) {
      if (initial !== null) await vault.vault.create(path, initial);
      await writer.appendToNote(path, content);
      expect(vault.files.get(path)?.markdown).toBe(expected);
      vault.files.delete(path);
    }
  });

  it("inserts before the first start marker and appends literally when the marker is absent", async () => {
    const file = new obsidian.TFile("QnALog/Minutes/start.md");
    const original = "before\n<!-- qnalog-segments-start:s1 -->\nmiddle\n<!-- qnalog-segments-start:s1 -->\nafter";
    const literal = "插入内容\n第二行 $& $` $' $$ $`tail";
    const vault = memoryVault([{ file, markdown: original }]);
    const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS }));

    await writer.insertBeforeSegmentsStart(file.path, literal, "s1");
    expect(vault.files.get(file.path)?.markdown).toBe(
      `before\n${literal}\n<!-- qnalog-segments-start:s1 -->\nmiddle\n<!-- qnalog-segments-start:s1 -->\nafter`,
    );

    const noIdPath = "QnALog/Minutes/start-no-id.md";
    await writer.appendToNote(noIdPath, "head\n<!-- qnalog-segments-start:s1 -->\n<!-- qnalog-segments-start -->");
    await writer.insertBeforeSegmentsStart(noIdPath, literal, null);
    expect(vault.files.get(noIdPath)?.markdown).toBe(`head\n<!-- qnalog-segments-start:s1 -->\n${literal}\n<!-- qnalog-segments-start -->`);

    await writer.insertBeforeSegmentsStart(file.path, literal, "missing");
    expect(vault.files.get(file.path)?.markdown).toBe(
      `before\n${literal}\n<!-- qnalog-segments-start:s1 -->\nmiddle\n<!-- qnalog-segments-start:s1 -->\nafter\n${literal}`,
    );
  });

  it("re-reads after a missing end marker before falling back to append", async () => {
    const file = new obsidian.TFile("QnALog/Minutes/end-fallback.md");
    const vault = memoryVault([{ file, markdown: "initial" }]);
    const read = vi.spyOn(vault.vault, "read");
    read.mockImplementationOnce(async () => {
      await vault.vault.modify(file, "concurrent update");
      return "stale read";
    });
    const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS }));

    await writer.insertBeforeSegmentsEnd(file.path, "literal $& $' $$", "missing");

    expect(read).toHaveBeenCalledTimes(2);
    expect(vault.files.get(file.path)?.markdown).toBe("concurrent update\nliteral $& $' $$");
  });

  it("uses the vault selected at each existing read and write point", async () => {
    const file = new obsidian.TFile("QnALog/Minutes/dynamic-segment.md");
    const oldVault = memoryVault([{ file, markdown: "old source" }]);
    const newVault = memoryVault([{ file, markdown: "new target" }]);
    let activeVault = oldVault;
    const host = unexpectedHost(oldVault.vault, { ...DEFAULT_SETTINGS });
    Object.defineProperty(host, "vault", { get: () => activeVault.vault });
    const writer = new NoteWriter(host);

    activeVault = newVault;
    await writer.appendToNote(file.path, "after construction");
    expect(oldVault.files.get(file.path)?.markdown).toBe("old source");
    expect(newVault.files.get(file.path)?.markdown).toBe("new target\nafter construction");

    activeVault = oldVault;
    const readGate = Promise.withResolvers<string>();
    vi.spyOn(oldVault.vault, "read").mockImplementationOnce(() => readGate.promise);
    const insert = writer.insertBeforeSegmentsStart(file.path, "insert", "s1");
    activeVault = newVault;
    readGate.resolve("<!-- qnalog-segments-start:s1 -->");
    await insert;
    expect(oldVault.files.get(file.path)?.markdown).toBe("old source");
    expect(newVault.files.get(file.path)?.markdown).toBe("insert\n<!-- qnalog-segments-start:s1 -->");
  });

  it("propagates storage failures and preserves incomplete session blocks", async () => {
    const file = new obsidian.TFile("QnALog/Minutes/failure.md");
    const vault = memoryVault([{ file, markdown: "before\n<!-- qnalog-session:s1 -->\n## S\n<!-- qnalog-segments-end:other -->" }]);
    const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS }));
    const readError = new Error("read failed");
    vi.spyOn(vault.vault, "read").mockRejectedValueOnce(readError);
    await expect(writer.appendToNote(file.path, "new")).rejects.toBe(readError);
    expect(vault.files.get(file.path)?.markdown).toContain("before");
    const modifyError = new Error("modify failed");
    vi.spyOn(vault.vault, "modify").mockRejectedValueOnce(modifyError);
    await expect(writer.appendToNote(file.path, "new")).rejects.toBe(modifyError);
    expect(vault.files.get(file.path)?.markdown).toContain("before");
    await writer.appendToNote(file.path, "new");
    expect(vault.files.get(file.path)?.markdown).toBe("before\n<!-- qnalog-session:s1 -->\n## S\n<!-- qnalog-segments-end:other -->\nnew");

    const createError = new Error("create failed");
    vi.spyOn(vault.vault, "create").mockRejectedValueOnce(createError);
    await expect(writer.appendToNote("QnALog/Minutes/create-failure.md", "new")).rejects.toBe(createError);
    await writer.appendToNote("QnALog/Minutes/create-failure.md", "new");
    expect(vault.files.get("QnALog/Minutes/create-failure.md")?.markdown).toBe("new");

    const incomplete = vault.files.get(file.path)!.markdown;
    await writer.removeEmptySessionBlock({ mdPath: file.path, id: "s1" } as never);
    expect(vault.files.get(file.path)?.markdown).toBe(incomplete);

    const uniquePath = "QnALog/Minutes/empty-after-cleanup.md";
    await vault.vault.create(uniquePath, "## S\n<!-- qnalog-session:s1 -->\n<!-- qnalog-segments-start:s1 -->\n<!-- qnalog-segments-end:s1 -->");
    await writer.removeEmptySessionBlock({ mdPath: uniquePath, id: "s1" } as never);
    expect(vault.files.has(uniquePath)).toBe(true);
    expect(vault.files.get(uniquePath)?.markdown).toBe("");
  });
});
describe("NoteWriter literal preservation", () => {
  it("retains continuation materials and transcript across repeated rewrites", async () => {
    const path = "QnALog/Minutes/literal-continuation.md";
    const file = new obsidian.TFile(path);
    const sourceText = "账本转写原文";
    const segment: Segment = attachTextTranscript({
      index: 0,
      startOffsetMs: 0,
      endOffsetMs: 12_000,
      text: sourceText,
      isFinal: true,
    }, "literal-session", "text-import");
    const ledger = serializeTranscriptBlock(segment, "### Source transcript", sourceText);
    const vault = memoryVault([{ file, markdown: `# Previous\n\n${ledger}` }]);
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-10-07 12:00:00" }) });
    try {
      const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, llmModel: "consumer-test-model" }));
      const priorInfo = "- 旧录音信息：多行中文\n$&\n$` 和反引号\n$'\n$$";
      const priorAudioNames = ["旧录音-$&-$`-$'-$$.m4a", "qnalog-prior-second.webm"];
      const priorOutline = "- 旧大纲：多行中文\n  - $&\n  - $` 与反引号\n  - $'\n  - $$";
      const session: RecordingSession = {
        id: "literal-session",
        sessionStamp: "literal-session",
        startedAt: "2026-10-07T12:00:00.000Z",
        mdPath: path,
        mode: "meeting",
        segments: [segment],
        finalized: true,
        continuationSourcePath: "QnALog/Minutes/prior.md",
        continuationSourceTitle: "旧纪要",
        continuationPriorRecordingInfo: priorInfo,
        continuationPriorOutline: priorOutline,
        continuationRecordedAt: "2026-09-17T03:56:35.000Z",
        continuationPriorAudioNames: priorAudioNames,
        multiSourceAudio: true,
        realtimeOutline: "- 本场实时新主题",
      };
      await writer.rewriteConsolidated(session, "---\ntitle: literal\n---\n\n重写正文");
      const first = await vault.vault.read(file);
      expect(first).toContain(priorInfo);
      expect(first).toContain("- 本场实时新主题");
      expect(first).toContain("> 以下为追加录音前场次（旧纪要）的实时大纲草稿。");
      expect(first).toContain(priorOutline);
      expect(first).toContain("- 追加录音：2026-10-07 12:00:00");
      for (const name of priorAudioNames) {
        expect(first).toContain(`![[${name}]]`);
        expect(first).toContain(`[[${name}|00:00]]`);
      }
      expect(first.indexOf(`![[${priorAudioNames[0]}]]`)).toBeLessThan(first.indexOf(`![[${priorAudioNames[1]}]]`));
      expect(first).toContain("重写正文");
      expect(readTranscriptBlocks(first).map(block => block.visibleBlock)).toEqual([sourceText]);

      await writer.rewriteConsolidated(session, "---\ntitle: literal\n---\n\n重写正文");
      const second = await vault.vault.read(file);
      expect(second).toBe(first);
      expect(readTranscriptBlocks(second).map(block => block.visibleBlock)).toEqual([sourceText]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("续录时间格式化失败时拒绝重写且保留笔记与账本", async () => {
    const path = "QnALog/Minutes/continuation-format-failure.md";
    const file = new obsidian.TFile(path);
    const segment: Segment = attachTextTranscript({
      index: 0,
      startOffsetMs: 0,
      endOffsetMs: 12_000,
      text: "不可丢失的转写",
      isFinal: true,
    }, "format-failure-session", "text-import");
    const original = `# Original note\n\n${serializeTranscriptBlock(segment, "### Source transcript", "不可丢失的转写")}`;
    const vault = memoryVault([{ file, markdown: original }]);
    const failure = new Error("continuation time format failed");
    const recordedAt = "2026-09-17T03:56:35.000Z";
    vi.stubGlobal("window", {
      moment: (value: string) => {
        if (value === recordedAt) throw failure;
        return { format: () => "2026-10-07 12:00:00" };
      },
    });
    try {
      const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, llmModel: "consumer-test-model" }));
      const session: RecordingSession = {
        id: "format-failure-session",
        sessionStamp: "format-failure-session",
        startedAt: "2026-10-07T12:00:00.000Z",
        mdPath: path,
        mode: "meeting",
        segments: [segment],
        finalized: true,
        continuationSourcePath: "QnALog/Minutes/prior.md",
        continuationRecordedAt: recordedAt,
        continuationPriorRecordingInfo: "- 旧场次信息",
      };
      await expect(writer.rewriteConsolidated(session, "---\ntitle: replacement\n---\n\nreplacement body")).rejects.toBe(failure);
      expect(await vault.vault.read(file)).toBe(original);
      expect(readTranscriptBlocks(await vault.vault.read(file)).map(block => block.visibleBlock)).toEqual(["不可丢失的转写"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
describe("NoteWriter current info materials", () => {
  it("keeps info blocks after output and failures for recording and text imports", async () => {
    const path = "QnALog/Minutes/note-info-materials.md";
    const file = new obsidian.TFile(path);
    const original = "---\ntitle: old\n---\n\n# Existing note\n";
    const recordingSegment = attachTextTranscript({
      index: 0, startOffsetMs: 0, endOffsetMs: 1_000,
      text: "RECORDING RAW $& $` $' $$", isFinal: true,
    }, "note-info-materials", "legacy-transcript");
    const recordingLedger = serializeTranscriptBlock(recordingSegment, "### Recording transcript", recordingSegment.text);
    const textSegments: Segment[] = [
      { index: 0, startOffsetMs: 0, endOffsetMs: 1_000, rawText: "TEXT ONE $& $` $' $$", text: "TEXT ONE $& $` $' $$", isFinal: true },
      { index: 1, startOffsetMs: 1_000, endOffsetMs: 2_000, rawText: "TEXT TWO $& $` $' $$", text: "TEXT TWO $& $` $' $$", isFinal: true },
    ];
    const sessions: Array<{ name: string; session: RecordingSession; sourceNote: string }> = [
      {
        name: "recording",
        session: {
          id: "note-info-materials", sessionStamp: "note-info-materials",
          startedAt: "2026-09-14T12:00:00.000Z", mdPath: path,
          mode: "meeting", source: "recording", segments: [recordingSegment], finalized: true,
        },
        sourceNote: `${original}\n${recordingLedger}`,
      },
      {
        name: "text-import",
        session: {
          id: "note-info-materials", sessionStamp: "note-info-materials",
          startedAt: "2026-09-14T12:00:00.000Z", mdPath: path,
          mode: "meeting", source: "text-import", segments: textSegments, finalized: true,
          textImportSources: [
            { name: "来源一 $& $` $' $$", path: "Notes/one.md", chars: 11 },
            { path: "Notes/two.md" },
            { name: "无路径来源 $& $` $' $$" },
            {},
          ],
        },
        sourceNote: original,
      },
    ];
    const output = "---\ntitle: new\n---\n\nINFO BODY $& $` $' $$";
    const body = "INFO BODY $& $` $' $$";
    const originalLanguage = getActiveUiLanguage();
    const originalWindow = (globalThis as { window?: unknown }).window;
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00:00" }) });
    try {
      const vault = memoryVault([{ file, markdown: original }]);
      const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, llmModel: "consumer-info-model" }));
      for (const language of ["zh", "en"]) {
        setActiveUiLanguage(matchUiLanguage(language)!);
        for (const { name, session, sourceNote } of sessions) {
          const infoSummary = name === "recording"
            ? (language === "zh" ? "<summary>录音信息</summary>" : "<summary>Recording info</summary>")
            : (language === "zh" ? "<summary>导入文本信息</summary>" : "<summary>Imported text info</summary>");
          for (const [kind, action] of [
            ["rewrite", () => writer.rewriteConsolidated(session, output)],
            ["append", () => writer.appendPolishBlock(session, output, null, false, "", sourceNote)],
            ["failed append", () => writer.appendPolishBlock(session, output, new Error("info failure"), false, "", sourceNote)],
          ] as const) {
            await vault.vault.modify(file, sourceNote);
            await action();
            const markdown = await vault.vault.read(file);
            const infoAt = markdown.lastIndexOf(infoSummary);
            const finish = markdown.indexOf("</details>", infoAt);
            expect(infoAt, `${name} ${language} ${kind} info missing`).toBeGreaterThanOrEqual(0);
            expect(finish).toBeGreaterThan(infoAt);
            if (kind === "failed append") {
              expect(markdown).toContain(labelText("mergeFailedQueued", "info failure"));
              expect(markdown).not.toContain(body);
              expect(markdown.indexOf(labelText("mergeFailedQueued", "info failure"))).toBeLessThan(infoAt);
            } else {
              expect(markdown).toContain(body);
              expect(markdown.indexOf(body)).toBeLessThan(infoAt);
            }
            expect(markdown.slice(infoAt, finish)).toContain(language === "zh" ? "2026-09-14 12:00:00" : "2026-09-14 12:00:00");
            expect(markdown.slice(infoAt, finish)).toContain(name === "recording"
              ? "00:01"
              : (language === "zh" ? "来源文件：4" : "Source files: 4"));
          }
        }
      }
    } finally {
      setActiveUiLanguage(originalLanguage);
      vi.unstubAllGlobals();
      if (originalWindow !== undefined) vi.stubGlobal("window", originalWindow);
    }
  });
});
describe("NoteWriter info time capability", () => {
  it("reads moment after the model setting and rejects formatting failures before writing", async () => {
    const path = "QnALog/Minutes/info-time-capability.md";
    const file = new obsidian.TFile(path);
    const original = "---\ntitle: old\n---\n\n# Existing note\n";
    const segment = attachTextTranscript({
      index: 0, startOffsetMs: 0, endOffsetMs: 1_000, text: "recording raw", isFinal: true,
    }, "info-time-capability", "legacy-transcript");
    const sessions: RecordingSession[] = [
      {
        id: "info-time-capability", sessionStamp: "info-time-capability", startedAt: "2026-09-14T12:00:00.000Z",
        mdPath: path, mode: "meeting", source: "recording", segments: [segment], finalized: true,
      },
      {
        id: "info-time-capability", sessionStamp: "info-time-capability", startedAt: "2026-09-14T12:00:00.000Z",
        mdPath: path, mode: "meeting", source: "text-import", segments: [], textImportSources: [{ name: "source" }], finalized: true,
      },
    ];
    const originalLanguage = getActiveUiLanguage();
    const originalWindow = (globalThis as { window?: unknown }).window;
    setActiveUiLanguage(matchUiLanguage("zh")!);
    try {
      const vault = memoryVault([{ file, markdown: original }]);
      for (const session of sessions) {
        const settings = { ...DEFAULT_SETTINGS };
        let mutateMoment = true;
        Object.defineProperty(settings, "llmModel", {
          get: () => {
            if (mutateMoment) {
              const host = (globalThis as { window: { moment: () => { format: () => string } } }).window;
              host.moment = () => ({ format: () => "LATE TIME" });
            }
            return "consumer-info-model";
          },
        });
        const writer = new NoteWriter(unexpectedHost(vault.vault, settings));
        for (const layout of ["rewrite", "append"] as const) {
          vi.stubGlobal("window", { moment: () => ({ format: () => "FIRST TIME" }) });
          await vault.vault.modify(file, original);
          if (layout === "rewrite") await writer.rewriteConsolidated(session, "---\ntitle: new\n---\n\nbody");
          else await writer.appendPolishBlock(session, "---\ntitle: new\n---\n\nbody", null, false, "", original);
          const output = await vault.vault.read(file);
          const infoSummary = session.source === "text-import" ? "<summary>导入文本信息</summary>" : "<summary>录音信息</summary>";
          const infoAt = output.indexOf(infoSummary);
          expect(output.slice(infoAt)).toContain("- 时间：LATE TIME");
          expect(output.slice(infoAt)).not.toContain("FIRST TIME");
        }

        mutateMoment = false;
        const failure = new Error("info format failed");
        vi.stubGlobal("window", {
          moment: () => ({
            format: (pattern: string) => {
              if (pattern === "YYYY-MM-DD HH:mm:ss") throw failure;
              return "2026-09-14 12:00";
            },
          }),
        });
        for (const layout of ["rewrite", "append"] as const) {
          await vault.vault.modify(file, original);
          const operation = layout === "rewrite"
            ? writer.rewriteConsolidated(session, "body")
            : writer.appendPolishBlock(session, "body", null, false, "", original);
          await expect(operation).rejects.toBe(failure);
          expect(await vault.vault.read(file)).toBe(original);
        }
      }
    } finally {
      setActiveUiLanguage(originalLanguage);
      vi.unstubAllGlobals();
      if (originalWindow !== undefined) vi.stubGlobal("window", originalWindow);
    }
  });
});
describe("NoteWriter audio source read timing", () => {
  it("preserves the original read points and propagates source getter failures", async () => {
    const path = "QnALog/Minutes/audio-read-timing.md";
    const file = new obsidian.TFile(path);
    const original = "---\ntitle: old\n---\n\n# Existing note\n";
    const output = "---\ntitle: new\n---\n\nAUDIO BODY";
    const originalLanguage = getActiveUiLanguage();
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00:00" }) });
    try {
      setActiveUiLanguage(matchUiLanguage("zh")!);
      for (const layout of ["rewrite", "append"] as const) {
        const vault = memoryVault([{ file, markdown: original }]);
        const session: RecordingSession = {
          id: "audio-read-timing", sessionStamp: "audio-read-timing", startedAt: "2026-09-14T12:00:00.000Z",
          mdPath: path, mode: "meeting", source: "recording", segments: [], finalized: true,
          masterAudioName: "FIRST MASTER.webm",
        };
        const settings = { ...DEFAULT_SETTINGS } as NoteWriterSettings;
        Object.defineProperty(settings, "llmModel", {
          get() { session.masterAudioName = "LATE MASTER.webm"; return "consumer-audio-model"; },
        });
        const writer = new NoteWriter(unexpectedHost(vault.vault, settings));
        if (layout === "rewrite") await writer.rewriteConsolidated(session, output);
        else await writer.appendPolishBlock(session, output, null, false, "", original);
        const result = await vault.vault.read(file);
        expect(result).toContain(`![[${layout === "rewrite" ? "FIRST" : "LATE"} MASTER.webm]]`);

        const externalVault = memoryVault([{ file, markdown: original }]);
        const externalSession: RecordingSession = {
          id: "audio-read-timing", sessionStamp: "audio-read-timing", startedAt: "2026-09-14T12:00:00.000Z",
          mdPath: path, mode: "meeting", source: "import", segments: [], finalized: true,
          externalAudioSource: { name: "FIRST SOURCE.wav" },
        };
        const externalSettings = { ...DEFAULT_SETTINGS } as NoteWriterSettings;
        Object.defineProperty(externalSettings, "llmModel", {
          get() {
            (externalSession.externalAudioSource as { name: string }).name = "LATE SOURCE.wav";
            return "consumer-audio-model";
          },
        });
        const externalWriter = new NoteWriter(unexpectedHost(externalVault.vault, externalSettings));
        if (layout === "rewrite") await externalWriter.rewriteConsolidated(externalSession, output);
        else await externalWriter.appendPolishBlock(externalSession, output, null, false, "", original);
        expect(await externalVault.vault.read(file)).toContain("LATE SOURCE.wav");

        const failure = new Error("audio material failed");
        for (const kind of ["master", "external"] as const) {
          const errorSession: RecordingSession = {
            id: "audio-read-timing", sessionStamp: "audio-read-timing", startedAt: "2026-09-14T12:00:00.000Z",
            mdPath: path, mode: "meeting", source: kind === "master" ? "recording" : "import",
            segments: [], finalized: true,
          };
          if (kind === "master") Object.defineProperty(errorSession, "masterAudioName", { get: () => { throw failure; } });
          else Object.defineProperty(errorSession, "externalAudioSource", { value: { get name() { throw failure; } } });
          const errorVault = memoryVault([{ file, markdown: original }]);
          const errorWriter = new NoteWriter(unexpectedHost(errorVault.vault, {
            ...DEFAULT_SETTINGS, llmModel: "consumer-audio-model",
          }));
          const run = layout === "rewrite"
            ? errorWriter.rewriteConsolidated(errorSession, output)
            : errorWriter.appendPolishBlock(errorSession, output, null, false, "", original);
          await expect(run).rejects.toBe(failure);
          expect(await errorVault.vault.read(file)).toBe(original);
        }
      }
    } finally {
      setActiveUiLanguage(originalLanguage);
      vi.unstubAllGlobals();
    }
  });
});
describe("NoteWriter meeting workbench materials", () => {
  it.each(["zh", "en"])("preserves meeting materials through rewrite, append, and failure (%s)", async (language) => {
    const path = "QnALog/Minutes/meeting-materials.md";
    const file = new obsidian.TFile(path);
    const original = "---\ntitle: old\n---\n\n# Existing note\n";
    const output = "---\ntitle: new\n---\n\nMEETING BODY $& $` $' $$";
    const rawText = "MEETING RAW $& $` $' $$";
    const segment = attachTextTranscript({
      index: 2, startOffsetMs: 61_000, endOffsetMs: 65_000, audioStartOffsetMs: 7_000,
      audioEndOffsetMs: 11_000, audioName: "meeting-segment.webm", audioPath: "QnALog/Audio/meeting-segment.webm",
      text: rawText, rawText, isFinal: true,
    }, "meeting-materials", "text-import");
    const ledger = serializeTranscriptBlock(segment, "### Segment 3", rawText);
    const sourceWorkbench = {
      notes: "  NOTES $& $` $' $$\r\nSECOND NOTE  ", draft: "DO_NOT_RENDER_DRAFT",
      entries: [
        { id:"entry-one",atMs:61999,text:"  ENTRY $& $` $' $$  ",interaction:{kind:"question",query:"DO_NOT_RENDER_QUERY",status:"done",response:"  FIRST AI $& $` $' $$\r\nSECOND AI\nTHIRD AI  ",error:"DO_NOT_RENDER_ERROR"},materials:[{path:"QnALog\\Materials\\entry.PNG",name:"  图 $& $` $' $$  ",kind:" IMAGE "},{path:"QnALog/Materials/entry.pdf",name:"  ",type:" pdf "}] },
        {id:"entry-two",offsetMs:3661999,text:" ",materials:[{path:"QnALog/Materials/poster.bin",name:"poster",kind:"image"}]},
        {text:" ",interaction:{response:"DO_NOT_RENDER_ORPHAN_RESPONSE"}},
      ],
      materials:[{path:"QnALog/Materials/diagram.SVG"},{path:"QnALog/Materials/report.pdf",name:"报告 $& $` $' $$",kind:"document"},{path:"QnALog/Materials/report.pdf",name:"DO_NOT_RENDER_DUPLICATE"}],
    };
    const expectedDetails = [
      "<details>", `<summary>${language === "en" ? "Material added during the meeting" : "会中补充材料"}</summary>`, "",
      "#### 会中零散记录", "", "NOTES $& $` $' $$\r\nSECOND NOTE", "", "#### 用户补充", "",
      "- 01:01 ENTRY $& $` $' $$", "  - AI：FIRST AI $& $` $' $$\n    SECOND AI\n    THIRD AI",
      "  - [[QnALog/Materials/entry.PNG|图 $& $` $' $$]] · IMAGE", "  ![[QnALog/Materials/entry.PNG]]",
      "  - [[QnALog/Materials/entry.pdf|entry.pdf]] · pdf", "- 1:01:01",
      "  - [[QnALog/Materials/poster.bin|poster]] · image", "  ![[QnALog/Materials/poster.bin]]",
      "", "#### 补充材料", "", "- [[QnALog/Materials/diagram.SVG|diagram.SVG]]", "![[QnALog/Materials/diagram.SVG]]", "",
      "- [[QnALog/Materials/report.pdf|报告 $& $` $' $$]] · document", "", "</details>",
    ].join("\n");
    const originalLanguage = getActiveUiLanguage();
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00:00" }) });
    try {
      setActiveUiLanguage(matchUiLanguage(language)!);
      for (const state of [
        {name:"empty-recording", source:"recording" as const, workbench:undefined},
        {name:"draft-recording", source:"recording" as const, workbench:{draft:"DO_NOT_RENDER_DRAFT"}},
        {name:"full-recording", source:"recording" as const, workbench:sourceWorkbench},
        {name:"full-text-import", source:"text-import" as const, workbench:sourceWorkbench},
      ]) for (const operation of ["rewrite","append","failedAppend"] as const) {
        const recordingMarkdown = state.source === "recording" ? `${original}\n${ledger}` : original;
        const vault = memoryVault([{file, markdown:recordingMarkdown}]);
        const writer = new NoteWriter(unexpectedHost(vault.vault,{...DEFAULT_SETTINGS,llmModel:"consumer-meeting-model"}));
        const workbench = state.workbench ? structuredClone(state.workbench) : undefined;
        const session: RecordingSession = {
          id:"meeting-materials",sessionStamp:"meeting-materials",startedAt:"2026-09-14T12:00:00.000Z",
          mdPath:path,mode:"meeting",source:state.source,segments:[segment],finalized:true,
          ...(workbench ? {meetingWorkbench:workbench} : {}),
        };
        const frozenSegment = structuredClone(segment);
        const run = async () => operation === "rewrite"
          ? writer.rewriteConsolidated(session,output)
          : writer.appendPolishBlock(session,output,operation === "failedAppend" ? new Error("meeting failure") : null,false,"",recordingMarkdown);
        await run();
        const result = await vault.vault.read(file);
        const details = result.match(/<details>\n<summary>(?:会中补充材料|Material added during the meeting)<\/summary>[\s\S]*?<\/details>/g) || [];
        expect(details).toHaveLength(state.workbench === sourceWorkbench ? 1 : 0);
        if (details.length) expect(details[0]).toBe(expectedDetails);
        if (details.length) {
          const detailAt = result.indexOf(details[0]);
          const infoAt = result.indexOf("<summary>");
          expect(detailAt).toBeGreaterThanOrEqual(infoAt);
          if (operation === "rewrite") {
            const originalAt = result.indexOf(rawText);
            expect(detailAt).toBeLessThan(originalAt);
            expect(result.indexOf("MEETING BODY")).toBeLessThan(detailAt);
          } else {
            const originalAt = result.indexOf(rawText);
            expect(detailAt).toBeGreaterThan(originalAt);
            if (operation === "failedAppend") expect(result.indexOf("meeting failure")).toBeLessThan(detailAt);
            else expect(result.indexOf("MEETING BODY")).toBeLessThan(detailAt);
          }
        }
        if (operation === "failedAppend") {
          expect(result).toContain("title: old");
          expect(result).toContain(language === "en" ? "_[Merge failed (queued for retry): meeting failure]_" : "_[合并润色失败（已加入重试队列）：meeting failure]_");
          expect(result).not.toContain("MEETING BODY");
        } else {
          expect(result).toContain("title: new");
          expect(result).toContain("MEETING BODY $& $` $' $$");
        }
        for (const forbidden of ["DO_NOT_RENDER_DRAFT","DO_NOT_RENDER_QUERY","DO_NOT_RENDER_ERROR","DO_NOT_RENDER_ORPHAN_RESPONSE","DO_NOT_RENDER_DUPLICATE"]) expect(result).not.toContain(forbidden);
        if (state.source === "recording") {
          const blocks = readTranscriptBlocks(result);
          expect(blocks).toHaveLength(1);
          expect(blocks[0].visibleBlock).toBe(rawText);
          expect(blocks[0].segment.transcript).toEqual(frozenSegment.transcript);
          expect(result).toContain(rawText);
          expect(blocks[0].segment).toEqual(frozenSegment);
          expect(blocks[0].segment.rawText).toBe(rawText);
          expect(blocks[0].segment.text).toBe(rawText);
          expect(blocks[0].start).toBeLessThan(blocks[0].end);
          const startMarker = `<!-- ${nsRe("transcript-start")}:`;
          const textStartMarker = `<!-- ${nsRe("transcript-text-start")}:`;
          const textEndMarker = `<!-- ${nsRe("transcript-text-end")}:`;
          const dataMarker = `<!-- ${nsRe("transcript-data")} `;
          const parentEndMarker = `<!-- ${nsRe("transcript-end")}:`;
          expect(result.split(startMarker).length - 1).toBe(1);
          expect(result.split(textStartMarker).length - 1).toBe(1);
          expect(result.split(textEndMarker).length - 1).toBe(1);
          expect(result.split(dataMarker).length - 1).toBe(1);
          expect(result.split(parentEndMarker).length - 1).toBe(1);
          expect(result.indexOf(dataMarker)).toBeGreaterThan(result.indexOf(textEndMarker));
          expect(result.indexOf(dataMarker)).toBeLessThan(result.indexOf(parentEndMarker));
        }
        expect(session.meetingWorkbench).toEqual(workbench);
        expect(segment).toEqual(frozenSegment);
        if (operation === "rewrite") {
          await run();
          expect(await vault.vault.read(file)).toBe(result);
        }
      }
    } finally {
      setActiveUiLanguage(originalLanguage);
      vi.unstubAllGlobals();
    }
  });
});
describe("NoteWriter meeting workbench read timing and failures", () => {
  it("observes workbench mutations at legacy settings and vault-read boundaries", async () => {
    const path = "QnALog/Minutes/meeting-timing.md";
    const file = new obsidian.TFile(path);
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00:00" }) });
    try {
    const original = "---\ntitle: old\n---\n\n# Existing note\n";
    const run = async (operation: "rewrite" | "append", mutateOnRead: boolean) => {
      let notes = "FIRST WORKBENCH";
      const vault = memoryVault([{file,markdown:original}]);
      const baseRead = vault.vault.read.bind(vault.vault);
      if (mutateOnRead) vault.vault.read = async target => { notes = "READ WORKBENCH"; return baseRead(target); };
      const settings = {...DEFAULT_SETTINGS};
      Object.defineProperty(settings,"llmModel",{get() { if (!mutateOnRead) notes = "LATE WORKBENCH"; return "consumer-meeting-model"; }});
      const writer = new NoteWriter(unexpectedHost(vault.vault,settings));
      const session: RecordingSession = {id:"meeting-timing",sessionStamp:"meeting-timing",startedAt:"2026-09-14T12:00:00.000Z",mdPath:path,mode:"meeting",source:"recording",segments:[],finalized:true,meetingWorkbench:{notes}};
      Object.defineProperty(session,"meetingWorkbench",{get:() => ({notes})});
      if (operation === "rewrite") await writer.rewriteConsolidated(session,"BODY");
      else await writer.appendPolishBlock(session,"BODY",null,false,"");
      return vault.vault.read(file);
    };
    expect(await run("rewrite",false)).toContain("FIRST WORKBENCH");
    expect(await run("append",false)).toContain("LATE WORKBENCH");
    expect(await run("rewrite",true)).toContain("READ WORKBENCH");
    expect(await run("append",true)).toContain("FIRST WORKBENCH");
    } finally { vi.unstubAllGlobals(); }
  });
  it("rejects identical workbench, entry conversion, and path failures without writing", async () => {
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00:00" }) });
    try {
    const path = "QnALog/Minutes/meeting-errors.md";
    const file = new obsidian.TFile(path);
    const original = "---\ntitle: old\n---\n\n# Existing note\n";
    const resetNormalize = (value: string) => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const failure = new Error("meeting failure");
    const cases: Array<(session: RecordingSession) => void> = [
      session => Object.defineProperty(session,"meetingWorkbench",{get() { throw failure; }}),
      session => { session.meetingWorkbench = {entries:[{text:{toString() { throw failure; }}}]}; },
    ];
    for (const inject of cases) for (const operation of ["rewrite","append"] as const) {
      const vault = memoryVault([{file,markdown:original}]);
      const writer = new NoteWriter(unexpectedHost(vault.vault,{...DEFAULT_SETTINGS,llmModel:"consumer-meeting-model"}));
      const session: RecordingSession = {id:"meeting-errors",sessionStamp:"meeting-errors",startedAt:"2026-09-14T12:00:00.000Z",mdPath:path,mode:"meeting",source:"recording",segments:[],finalized:true};
      inject(session);
      const run = operation === "rewrite" ? writer.rewriteConsolidated(session,"BODY") : writer.appendPolishBlock(session,"BODY",null,false,"",original);
      await expect(run).rejects.toBe(failure);
      expect(await vault.vault.read(file)).toBe(original);
    }
    for (const operation of ["rewrite","append"] as const) {
      const vault = memoryVault([{file,markdown:original}]);
      const writer = new NoteWriter(unexpectedHost(vault.vault,{...DEFAULT_SETTINGS,llmModel:"consumer-meeting-model"}));
      const session: RecordingSession = {id:"meeting-errors",sessionStamp:"meeting-errors",startedAt:"2026-09-14T12:00:00.000Z",mdPath:path,mode:"meeting",source:"recording",segments:[],finalized:true,meetingWorkbench:{materials:[{path:"bad"}]}};
      let calls = 0;
      vi.mocked(obsidian.normalizePath).mockImplementation(value => {
        calls += 1;
        if (calls === 2) throw failure;
        return resetNormalize(value);
      });
      try {
        const run = operation === "rewrite" ? writer.rewriteConsolidated(session,"BODY") : writer.appendPolishBlock(session,"BODY",null,false,"",original);
        await expect(run).rejects.toBe(failure);
        expect(await vault.vault.read(file)).toBe(original);
      } finally {
        vi.mocked(obsidian.normalizePath).mockImplementation(resetNormalize);
      }
    }
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("NoteWriter realtime outline details", () => {
  it.each(["zh", "en"])("preserves current and stale outline proof in all write paths (%s)", async (language) => {
    const originalLanguage = getActiveUiLanguage();
    const path = `QnALog/Minutes/realtime-materials-${language}.md`;
    const file = new obsidian.TFile(path);
    const rawText = "First transcript $& $` $' $$";
    const segments = [0, 1].map((index) => attachTextTranscript({
      index, startOffsetMs: index * 1_000, endOffsetMs: (index + 1) * 1_000,
      text: `${rawText} ${index}`,
    }, `realtime-materials-${language}`, "text-import"));
    const ledger = segments.map((segment) => serializeTranscriptBlock(segment, `### Segment ${segment.index + 1}`, segment.text)).join("\n\n");
    const original = `---\ntitle: old\n---\n\n# Existing note\n\n${ledger}`;
    const outline = "- [[recording.webm|00:00]] Topic $& $` $' $$";
    vi.stubGlobal("window", { moment: (value: string) => ({ format: () => value }) });
    try {
      setActiveUiLanguage(matchUiLanguage(language)!);
      for (const stale of [false, true]) for (const operation of ["rewrite", "append", "failedAppend"] as const) {
        const proof = createRealtimeOutlineSourceCoverage(stale ? `${outline} stale` : outline, segments, 1);
        const session = Object.assign({
          id: `realtime-materials-${language}`,
          sessionStamp: `realtime-materials-${language}`,
          startedAt: "2026-09-14T12:00:00.000Z",
          mdPath: path,
          mode: "meeting",
          source: "recording" as const,
          segments,
          finalized: true,
          realtimeOutline: outline,
          realtimeOutlineCoverageScope: "current-recording",
          realtimeOutlineCoverage: { totalSegmentCount: 2 },
          realtimeOutlineSourceCoverage: proof,
        }) as RecordingSession;
        const vault = memoryVault([{ file, markdown: original }]);
        const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, llmModel: "outline-materials-model" }));
        const run = async () => {
          if (operation === "rewrite") await writer.rewriteConsolidated(session, "BODY");
          else await writer.appendPolishBlock(session, "BODY", operation === "failedAppend" ? new Error("outline failure") : null, false, "", original);
        };
        await run();
        const result = await vault.vault.read(file);
        const current = readCurrentOutlineBlock(result);
        expect(current?.outline).toBe(outline);
        expect(result).toContain("Topic $& $` $' $$");
        expect(result).toContain(stale ? "0/2" : "1/2");
        expect(current?.sourceCoverage).toEqual(stale ? null : proof);
        expect(result).toContain(rawText);
        expect(readTranscriptBlocks(result).map((block) => block.visibleBlock)).toEqual(segments.map((segment) => segment.text));
        if (operation === "failedAppend") {
          expect(result).toContain("outline failure");
          expect(result).not.toContain("\nBODY\n");
        } else {
          expect(result).toContain("\nBODY\n");
        }
        if (operation === "rewrite") {
          await run();
          expect(await vault.vault.read(file)).toBe(result);
        }
      }
    } finally {
      setActiveUiLanguage(originalLanguage);
      vi.unstubAllGlobals();
    }
  });

  it("propagates outline material getter and conversion failures before writing", async () => {
    const path = "QnALog/Minutes/realtime-material-errors.md";
    const file = new obsidian.TFile(path);
    const original = "---\ntitle: old\n---\n\n# Existing note";
    const failure = new Error("realtime outline material failed");
    const injections: Array<(session: RecordingSession) => void> = [
      (session) => Object.defineProperty(session, "realtimeOutline", { get() { throw failure; } }),
      (session) => Object.defineProperty(session, "realtimeOutlineCoverage", {
        get() { return { get totalSegmentCount() { throw failure; } }; },
      }),
      (session) => { session.realtimeOutline = { toString() { throw failure; } } as unknown as string; },
    ];
    vi.stubGlobal("window", { moment: (value: string) => ({ format: () => value }) });
    try {
      for (const inject of injections) for (const operation of ["rewrite", "append"] as const) {
        const vault = memoryVault([{ file, markdown: original }]);
        const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, llmModel: "outline-material-errors" }));
        const session: RecordingSession = {
          id: "outline-material-errors",
          sessionStamp: "outline-material-errors",
          startedAt: "2026-09-14T12:00:00.000Z",
          mdPath: path,
          mode: "meeting",
          source: "recording",
          segments: [],
          finalized: true,
          realtimeOutline: "- failing material",
        };
        inject(session);
        const run = operation === "rewrite"
          ? writer.rewriteConsolidated(session, "BODY")
          : writer.appendPolishBlock(session, "BODY", null, false, "", original);
        await expect(run).rejects.toBe(failure);
        expect(await vault.vault.read(file)).toBe(original);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
describe("NoteWriter polish execution boundaries", () => {
  const path = "QnALog/Minutes/polish-flow.md";
  const sessionId = "polish-flow";
  const modelBody = "BODY $& $` $' $$";
  const rawText = "SOURCE A $& $` $' $$";
  const makeSession = (): RecordingSession => {
    const segment = attachTextTranscript({
      index: 0, startOffsetMs: 0, endOffsetMs: 1_000, text: rawText, rawText, isFinal: true,
    }, sessionId, "text-import");
    return {
      id: sessionId, sessionStamp: sessionId, startedAt: "2026-09-14T12:00:00.000Z",
      mdPath: path, mode: "meeting", source: "recording", segments: [segment], finalized: true,
    };
  };
  const originalLanguage = getActiveUiLanguage();
  const originalWindow = (globalThis as { window?: unknown }).window;

  it("keeps the different vault and settings read boundaries for rewrite and append", async () => {
    setActiveUiLanguage(matchUiLanguage("en")!);
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00:00" }) });
    try {
      for (const operation of ["rewrite", "append"] as const) {
        const file = new obsidian.TFile(path);
        const ledger = serializeTranscriptBlock(makeSession().segments[0], "### Segment 1", rawText);
        const source = `# Source A\n\n${ledger}`;
        const target = "# Target B\n\nTARGET B";
        const vaultA = memoryVault([{ file, markdown: source }]);
        const vaultB = memoryVault([{ file, markdown: target }]);
        let activeVault = vaultA;
        let model = "FIRST MODEL";
        const settings = { ...DEFAULT_SETTINGS, llmModel: "FIRST MODEL" } as NoteWriterSettings;
        const host = unexpectedHost(vaultA.vault, settings);
        Object.defineProperty(host, "vault", { get: () => activeVault.vault });
        Object.defineProperty(host, "settings", { get: () => ({ ...settings, llmModel: model }) });
        const originalRead = vaultA.vault.read.bind(vaultA.vault);
        vaultA.vault.read = async targetFile => {
          const markdown = await originalRead(targetFile);
          activeVault = vaultB;
          model = "LATE MODEL";
          return markdown;
        };
        const writer = new NoteWriter(host);
        if (operation === "rewrite") await writer.rewriteConsolidated(makeSession(), modelBody);
        else await writer.appendPolishBlock(makeSession(), modelBody, null, false);
        const result = vaultB.files.get(path)?.markdown ?? "";
        expect(vaultA.files.get(path)?.markdown).toBe(source);
        expect(result).not.toContain("TARGET B");
        expect(result).toContain(modelBody);
        expect(result).toContain(rawText);
        expect(result).toContain(operation === "rewrite" ? "LATE MODEL" : "FIRST MODEL");
        if (operation === "rewrite") expect(result).toContain("LATE MODEL");
        else expect(result).not.toContain("LATE MODEL");
      }
    } finally {
      setActiveUiLanguage(originalLanguage);
      vi.unstubAllGlobals();
      if (originalWindow !== undefined) vi.stubGlobal("window", originalWindow);
    }
  });

  it("distinguishes supplied, empty, null, and omitted initial markdown", async () => {
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00:00" }) });
    try {
      const cases: Array<{ label: string; initial?: string | null; expectedSource: string; reads: number }> = [
        { label: "supplied", initial: "SUPPLIED BYTES", expectedSource: "SUPPLIED BYTES", reads: 0 },
        { label: "empty", initial: "", expectedSource: "", reads: 0 },
        { label: "null", initial: null, expectedSource: "LIVE VAULT BYTES", reads: 1 },
        { label: "omitted", expectedSource: "LIVE VAULT BYTES", reads: 1 },
      ];
      for (const entry of cases) {
        const file = new obsidian.TFile(path);
        const vault = memoryVault([{ file, markdown: "LIVE VAULT BYTES" }]);
        let reads = 0;
        const read = vault.vault.read.bind(vault.vault);
        vault.vault.read = async target => { reads += 1; return read(target); };
        const writer = new NoteWriter(unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS, llmModel: "initial-markdown-model" }));
        await writer.appendPolishBlock(
          { ...makeSession(), id: "polish-flow-commit" },
          modelBody,
          null,
          false,
          "polish-flow-commit",
          entry.initial,
        );
        const result = vault.files.get(path)?.markdown ?? "";
        expect(reads, entry.label).toBe(entry.reads);
        expect(result).toContain(modelBody);
        if (entry.expectedSource) expect(result).toContain(entry.expectedSource);
        else expect(result).not.toContain("LIVE VAULT BYTES");
        expect(result.endsWith("<!-- qnalog-continuation-committed:polish-flow-commit -->\n")).toBe(true);
      }
    } finally {
      vi.unstubAllGlobals();
      if (originalWindow !== undefined) vi.stubGlobal("window", originalWindow);
    }
  });

  it("returns before reading settings, materials, or content for absent and non-file targets", async () => {
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00:00" }) });
    const noticesBefore = notices.length;
    try {
      for (const target of [null, { path: "QnALog/Minutes", children: [] }]) {
        const file = new obsidian.TFile("QnALog/Minutes/sentinel.md");
        const vault = memoryVault([{ file, markdown: "SENTINEL" }]);
        let reads = 0;
        let writes = 0;
        let lookups = 0;
        const host = unexpectedHost(vault.vault, DEFAULT_SETTINGS as NoteWriterSettings);
        host.vault.getAbstractFileByPath = () => { lookups += 1; return target as never; };
        host.vault.read = async () => { reads += 1; throw new Error("unexpected read"); };
        host.vault.modify = async () => { writes += 1; throw new Error("unexpected write"); };
        Object.defineProperty(host, "settings", { get: () => { throw new Error("unexpected settings"); } });
        const writer = new NoteWriter(host);
        await writer.rewriteConsolidated(makeSession(), modelBody);
        await writer.appendPolishBlock(makeSession(), modelBody, null);
        expect(lookups).toBe(2);
        expect(reads).toBe(0);
        expect(writes).toBe(0);
        expect(vault.files.get(file.path)?.markdown).toBe("SENTINEL");
      }
      expect(notices).toHaveLength(noticesBefore);
    } finally {
      vi.unstubAllGlobals();
      if (originalWindow !== undefined) vi.stubGlobal("window", originalWindow);
    }
  });

  it("propagates read and write failures without modifying the source", async () => {
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00:00" }) });
    try {
      for (const operation of ["rewrite", "append"] as const) for (const stage of ["read", "modify"] as const) {
        const file = new obsidian.TFile(path);
        const original = "# Original";
        const vault = memoryVault([{ file, markdown: original }]);
        const failure = new Error(`${operation} ${stage} failed`);
        if (stage === "read") vault.vault.read = async () => { throw failure; };
        else vault.vault.modify = async () => { throw failure; };
        const writer = new NoteWriter(unexpectedHost(vault.vault, DEFAULT_SETTINGS as NoteWriterSettings));
        const run = operation === "rewrite"
          ? writer.rewriteConsolidated(makeSession(), modelBody)
          : writer.appendPolishBlock(makeSession(), modelBody, null, false, "", null);
        await expect(run).rejects.toBe(failure);
        expect(vault.files.get(path)?.markdown).toBe(original);
      }
    } finally {
      vi.unstubAllGlobals();
      if (originalWindow !== undefined) vi.stubGlobal("window", originalWindow);
    }
  });

  it("rejects a damaged transcript ledger before reading settings or writing", async () => {
    vi.stubGlobal("window", { moment: () => ({ format: () => "2026-09-14 12:00:00" }) });
    try {
      const file = new obsidian.TFile(path);
      const damaged = "# Damaged\n<!-- qnalog-transcript-start:bad -->\n<!-- qnalog-transcript-data {bad} -->\n";
      const vault = memoryVault([{ file, markdown: damaged }]);
      const host = unexpectedHost(vault.vault, DEFAULT_SETTINGS as NoteWriterSettings);
      Object.defineProperty(host, "settings", { get: () => { throw new Error("settings read before ledger validation"); } });
      const writer = new NoteWriter(host);
      await expect(writer.rewriteConsolidated(makeSession(), modelBody))
        .rejects.toThrow("Transcript block bad has no matching end marker");
      expect(vault.files.get(path)?.markdown).toBe(damaged);
    } finally {
      vi.unstubAllGlobals();
      if (originalWindow !== undefined) vi.stubGlobal("window", originalWindow);
    }
  });
});
describe("NoteWriter merge source execution boundaries", () => {
  it("normalizes v2 source offsets without writing and persists a legacy ledger before returning", async () => {
    const originalLanguage = getActiveUiLanguage();
    const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
    const moment = (value: string | Date) => {
      const date = new Date(value);
      return { isValid: () => Number.isFinite(date.getTime()), toDate: () => date };
    };
    vi.stubGlobal("window", { moment });
    try {
      setActiveUiLanguage(matchUiLanguage("en")!);
      const file = new obsidian.TFile("QnALog/Minutes/merge-source.md");
      const firstText = "FIRST $& $` $' $$";
      const secondText = "SECOND $& $` $' $$";
      const first = attachTextTranscript({
        index: 2, startOffsetMs: 1_000, endOffsetMs: 3_000,
        audioStartOffsetMs: 100, audioEndOffsetMs: 2_100,
        sourceName: "Original source", sourcePath: "Notes/original.md",
        text: firstText, rawText: firstText, isFinal: true,
      }, "merge-source", "text-import");
      const second = attachTextTranscript({
        index: 7, startOffsetMs: 4_000, endOffsetMs: 6_000,
        text: secondText, rawText: secondText, isFinal: true,
      }, "merge-source", "text-import");
      const original = `# Source\n\n${serializeTranscriptBlock(first, "### Segment 3", firstText)}\n\n${serializeTranscriptBlock(second, "### Segment 8", secondText)}`;
      const fm = { qnalog_mode: "meeting", qnalog_time: "2026-09-14T11:00:00.000Z" };
      const vault = memoryVault([{ file, markdown: original }]);
      const writer = new NoteWriter(unexpectedHost(vault.vault, DEFAULT_SETTINGS, {
        getFileFrontmatter: () => fm,
      }));
      const modify = vault.vault.modify;
      vault.vault.modify = async () => { throw new Error("unexpected v2 write"); };
      const source = await writer.readMergeSourceFromMarkdown(file, 10_000, 5);
      expect(source).toMatchObject({
        file, content: original, frontmatter: fm, mode: "meeting",
        startedAt: "2026-09-14T11:00:00.000Z", rawDurationMs: 6_000,
      });
      expect(source.segments.map(segment => ({
        index: segment.index, startOffsetMs: segment.startOffsetMs, endOffsetMs: segment.endOffsetMs,
        audioStartOffsetMs: segment.audioStartOffsetMs, audioEndOffsetMs: segment.audioEndOffsetMs,
        sourceName: segment.sourceName, sourcePath: segment.sourcePath, text: segment.text,
      }))).toEqual([
        { index: 5, startOffsetMs: 11_000, endOffsetMs: 13_000, audioStartOffsetMs: 100, audioEndOffsetMs: 2_100,
          sourceName: "Original source", sourcePath: "Notes/original.md", text: `【来源纪要：${file.basename}】\n${firstText}` },
        { index: 6, startOffsetMs: 14_000, endOffsetMs: 16_000, audioStartOffsetMs: 4_000, audioEndOffsetMs: 6_000,
          sourceName: file.basename, sourcePath: file.path, text: secondText },
      ]);
      vault.vault.modify = modify;
      expect(readTranscriptBlocks(await vault.vault.read(file)).map(block => block.visibleBlock)).toEqual([firstText, secondText]);
      const editedFile = new obsidian.TFile("QnALog/Minutes/edited-source.md");
      const editedMarkdown = original.replace(firstText, "EDITED visible text");
      const editedVault = memoryVault([{ file: editedFile, markdown: editedMarkdown }]);
      const editedWriter = new NoteWriter(unexpectedHost(editedVault.vault, DEFAULT_SETTINGS, { getFileFrontmatter: () => fm }));
      const edited = await editedWriter.readMergeSourceFromMarkdown(editedFile, 0, 0);
      const editedBlock = readTranscriptBlocks(await editedVault.vault.read(editedFile))[0];
      expect(editedBlock.segment.transcript?.sourceId).toBe("merge-source");
      expect(editedBlock.segment.transcript?.revisions.map(revision => revision.source)).toEqual(["text-import", "edited-transcript"]);
      expect(getCurrentTranscript(editedBlock.segment.transcript!).rawText).toBeNull();
      expect(edited.segments[0].text).toBe(`【来源纪要：${editedFile.basename}】\nEDITED visible text`);

      const zeroFile = new obsidian.TFile("QnALog/Minutes/zero-duration.md");
      const zeroSegment = attachTextTranscript({
        index: 0, startOffsetMs: 0, endOffsetMs: 0, text: "时长：00:12", isFinal: true,
      }, "zero-duration", "text-import");
      const zeroMarkdown = `# Zero\n\n${serializeTranscriptBlock(zeroSegment, "### Segment 1", zeroSegment.text)}`;
      const zeroVault = memoryVault([{ file: zeroFile, markdown: zeroMarkdown }]);
      const zeroWriter = new NoteWriter(unexpectedHost(zeroVault.vault, DEFAULT_SETTINGS, { getFileFrontmatter: () => ({}) }));
      const zero = await zeroWriter.readMergeSourceFromMarkdown(zeroFile, 0, 0);
      expect(zero.rawDurationMs).toBe(12_000);
      expect(zero.segments[0]).toMatchObject({ startOffsetMs: 0, endOffsetMs: 0, audioStartOffsetMs: 0, audioEndOffsetMs: 0 });

      const legacyFile = new obsidian.TFile("QnALog/Minutes/merge-legacy.md");
      const legacyText = "FIRST $& $` $' $$";
      const legacy = "# Legacy\n\n<!-- qnalog-session:merge-legacy -->\n<!-- qnalog-segments-start:merge-legacy -->\n### Segment 1 (00:00–00:10) [[old.wav|00:00]]\n\n<!-- qnalog-transcribe-task:task-legacy -->\n" +
        `${legacyText}\n<!-- qnalog-segments-end:merge-legacy -->`;
      const legacyVault = memoryVault([{ file: legacyFile, markdown: legacy }]);
      const legacyWriter = new NoteWriter(unexpectedHost(legacyVault.vault, DEFAULT_SETTINGS, { getFileFrontmatter: () => ({}) }));
      const migrated = await legacyWriter.readMergeSourceFromMarkdown(legacyFile, 0, 0);
      const migratedBytes = await legacyVault.vault.read(legacyFile);
      expect(migrated.content).toBe(migratedBytes);
      expect(migrated.rawDurationMs).toBe(10_000);
      expect(migrated.segments[0].text).toBe(`【来源纪要：${legacyFile.basename}】\n${legacyText}`);
      const block = readTranscriptBlocks(migratedBytes)[0];
      expect(block.segment.transcript?.sourceId).toBe("merge-legacy");
      const revision = getCurrentTranscript(block.segment.transcript!);
      expect(revision.source).toBe("legacy-transcript");
      expect(revision.rawText).toBeNull();
      expect(block.visibleBlock).toContain(`<!-- qnalog-transcribe-task:task-legacy -->`);
      expect(block.visibleBlock).toContain(legacyText);
      const noSecondWrite = legacyVault.vault.modify;
      legacyVault.vault.modify = async () => { throw new Error("unexpected repeated ledger write"); };
      const again = await legacyWriter.readMergeSourceFromMarkdown(legacyFile, 0, 0);
      expect(again.content).toBe(migratedBytes);
      legacyVault.vault.modify = noSecondWrite;
    } finally {
      setActiveUiLanguage(originalLanguage);
      if (previousWindow === undefined) vi.unstubAllGlobals();
      else vi.stubGlobal("window", previousWindow);
    }
  });

  it("rejects invalid sources before reading and preserves read/modify failures", async () => {
    const originalLanguage = getActiveUiLanguage();
    try {
      setActiveUiLanguage(matchUiLanguage("en")!);
      const file = new obsidian.TFile("QnALog/Minutes/no-transcript.md");
      const vault = memoryVault([{ file, markdown: "# No transcript" }]);
      let metadataReads = 0;
      const writer = new NoteWriter(unexpectedHost(vault.vault, DEFAULT_SETTINGS, {
        getFileFrontmatter: () => { metadataReads += 1; return {}; },
      }));
      for (const invalid of [null, { path: "folder", children: [] }, new obsidian.TFile("source.txt")]) {
        await expect(writer.readMergeSourceFromMarkdown(invalid, 0, 0))
          .rejects.toThrow(t("Only QnALog Markdown minutes notes can be merged"));
      }
      expect(metadataReads).toBe(0);
      const readFailure = new Error("source read failed");
      vault.vault.read = async () => { throw readFailure; };
      await expect(writer.readMergeSourceFromMarkdown(file, 0, 0)).rejects.toBe(readFailure);
      expect(metadataReads).toBe(0);
      const emptyVault = memoryVault([{ file, markdown: "# No transcript" }]);
      const emptyWriter = new NoteWriter(unexpectedHost(emptyVault.vault, DEFAULT_SETTINGS, {
        getFileFrontmatter: () => { metadataReads += 1; return {}; },
      }));
      await expect(emptyWriter.readMergeSourceFromMarkdown(file, 0, 0))
        .rejects.toThrow(t("No original transcription segments found in \"{0}\"").replace("{0}", file.basename));
      setActiveUiLanguage(matchUiLanguage("zh")!);
      const chineseFile = new obsidian.TFile("QnALog/Minutes/no-transcript-zh.md");
      const chineseVault = memoryVault([{ file: chineseFile, markdown: "# No transcript" }]);
      const chineseWriter = new NoteWriter(unexpectedHost(chineseVault.vault, DEFAULT_SETTINGS, {
        getFileFrontmatter: () => { metadataReads += 1; return {}; },
      }));
      await expect(chineseWriter.readMergeSourceFromMarkdown(chineseFile, 0, 0))
        .rejects.toThrow(t("No original transcription segments found in \"{0}\"").replace("{0}", chineseFile.basename));
      setActiveUiLanguage(matchUiLanguage("en")!);
      const damagedFile = new obsidian.TFile("QnALog/Minutes/damaged.md");
      const damaged = "# Damaged\n<!-- qnalog-transcript-start:bad -->\n<!-- qnalog-transcript-data {bad} -->\n";
      const damagedVault = memoryVault([{ file: damagedFile, markdown: damaged }]);
      const damagedWriter = new NoteWriter(unexpectedHost(damagedVault.vault, DEFAULT_SETTINGS, {
        getFileFrontmatter: () => { metadataReads += 1; return {}; },
      }));
      await expect(damagedWriter.readMergeSourceFromMarkdown(damagedFile, 0, 0)).rejects.toThrow();
      expect(await damagedVault.vault.read(damagedFile)).toBe(damaged);
      expect(metadataReads).toBe(0);
    } finally {
      setActiveUiLanguage(originalLanguage);
    }
  });
  it("uses the current vault on modification and reads frontmatter before mode but time after mode", async () => {
    const originalLanguage = getActiveUiLanguage();
    const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
    const moment = (value: string | Date) => {
      const date = new Date(value);
      return { isValid: () => Number.isFinite(date.getTime()), toDate: () => date };
    };
    vi.stubGlobal("window", { moment });
    try {
      setActiveUiLanguage(matchUiLanguage("en")!);
      const file = new obsidian.TFile("QnALog/Minutes/dynamic-source.md");
      const sourceText = "Legacy source text";
      const legacy = `<!-- qnalog-session:dynamic-source -->\n<!-- qnalog-segments-start:dynamic-source -->\n### Segment 1 (00:00–00:10) [[old.wav|00:00]]\n\n<!-- qnalog-transcribe-task:task-dynamic -->\n${sourceText}\n\n<!-- qnalog-segments-end:dynamic-source -->`;
      const vaultA = memoryVault([{ file, markdown: legacy }]);
      const vaultB = memoryVault([{ file, markdown: "# Target B\n\nTARGET B" }]);
      let activeVault = vaultA.vault;
      const host = unexpectedHost(vaultA.vault, DEFAULT_SETTINGS, {
        getFileFrontmatter: () => ({ qnalog_mode: "meeting", qnalog_time: "2026-09-14T11:00:00.000Z" }),
      });
      Object.defineProperty(host, "vault", { get: () => activeVault });
      const writer = new NoteWriter(host);
      let firstMetadata: { qnalog_mode: string; qnalog_time: string } | undefined;
      let reads = 0;
      host.getFileFrontmatter = () => {
        reads += 1;
        if (reads === 1) {
          firstMetadata = { qnalog_mode: "meeting", qnalog_time: "2026-09-14T11:00:00.000Z" };
          return firstMetadata;
        }
        firstMetadata!.qnalog_time = "2026-09-14T11:30:00.000Z";
        return { qnalog_mode: "seminar" };
      };
      const originalModify = vaultB.vault.modify;
      const originalRead = vaultA.vault.read;
      vaultA.vault.read = async () => {
        const content = await originalRead(file);
        activeVault = vaultB.vault;
        vaultB.vault.modify = async (target, contentToWrite) => {
          await originalModify(target, contentToWrite);
        };
        return content;
      };
      const result = await writer.readMergeSourceFromMarkdown(file, 0, 0);
      expect(await vaultA.vault.read(file)).toBe(legacy);
      expect(await vaultB.vault.read(file)).toContain("qnalog-transcript-data");
      expect(await vaultB.vault.read(file)).not.toContain("TARGET B");
      expect(result.frontmatter).toBe(firstMetadata);
      expect(result.mode).toBe("seminar");
      expect(result.startedAt).toBe("2026-09-14T11:30:00.000Z");
      expect(reads).toBe(2);
    } finally {
      setActiveUiLanguage(originalLanguage);
      if (previousWindow === undefined) vi.unstubAllGlobals();
      else vi.stubGlobal("window", previousWindow);
    }
  });
});

describe("NoteWriter merge confirmation literal preservation", () => {
  it.each(["en", "zh"] as const)("preserves source basenames literally in %s confirmation", async (language) => {
    const originalLanguage = getActiveUiLanguage();
    try {
      setActiveUiLanguage(matchUiLanguage(language)!);
      const titlePairs = [
        ["Source $& $` $' $$", "plain"],
        ["source", "Current $& $` $' $$"],
        ["Source {1}", "Current {0}"],
        ["source", "plain"],
      ] as const;
      const confirmations: Array<{ title: string; body: string; ctaText: string } | undefined> = [];
      const expectedConfirmations: Array<{ title: string; body: string; ctaText: string }> = [];
      for (const [previousTitle, currentTitle] of titlePairs) {
        const previousFile = new obsidian.TFile(`QnALog/Minutes/${previousTitle}.md`);
        const currentFile = new obsidian.TFile(`QnALog/Minutes/${currentTitle}.md`);
        const previousMarkdown = "PREVIOUS SOURCE BYTES";
        const currentMarkdown = "CURRENT SOURCE BYTES";
        const vault = memoryVault([
          { file: previousFile, markdown: previousMarkdown },
          { file: currentFile, markdown: currentMarkdown },
        ]);
        let confirmed: { title: string; body: string; ctaText: string } | undefined;
        const host = unexpectedHost(vault.vault, { ...DEFAULT_SETTINGS }, {
          getRecentNotes: () => [
            { file: currentFile, timestamp: 2 },
            { file: previousFile, timestamp: 1 },
          ],
          confirm: async (title, body, ctaText) => {
            confirmed = { title, body, ctaText };
            return false;
          },
        });
        const writer = new NoteWriter(host);
        await writer.mergeMarkdownFileWithPrevious(currentFile);
        const expectedBody = language === "en"
          ? "A new merged minutes note will be created; the source files will be kept.\n\nSources:\n1. "
            + previousFile.basename + "\n2. " + currentFile.basename + "\n\nContinue?"
          : "将生成一篇新的合并纪要，源文件会保留。\n\n来源：\n1. "
            + previousFile.basename + "\n2. " + currentFile.basename + "\n\n继续合并？";
        confirmations.push(confirmed);
        expectedConfirmations.push({
          title: language === "en" ? "Merge minutes" : "合并纪要",
          body: expectedBody,
          ctaText: language === "en" ? "Merge" : "合并",
        });
        expect([...vault.files.keys()]).toEqual([previousFile.path, currentFile.path]);
        expect(await vault.vault.read(previousFile)).toBe(previousMarkdown);
        expect(await vault.vault.read(currentFile)).toBe(currentMarkdown);
      }
      expect(confirmations).toEqual(expectedConfirmations);
    } finally {
      setActiveUiLanguage(originalLanguage);
    }
  });
});

describe("NoteWriter merge metadata literal preservation", () => {
  const sources = [
    { path: "Notes/Source $& $` $' $$.md", title: "Source $& $` $' $$", durationMs: 1000 },
    { path: "Notes/plain.md", title: "plain", durationMs: 2000 },
  ];
  const startMarker = "<!-- qnalog-merge -->";
  const endMarker = "\nqnalog-merge-end -->";
  const payloadFrom = (markdown: string) => {
    const start = markdown.indexOf(startMarker);
    const end = markdown.indexOf(endMarker, start + startMarker.length);
    if (start < 0 || end < 0) throw new Error("Missing merge metadata markers");
    return JSON.parse(markdown.slice(start + startMarker.length + 1, end));
  };
  const expectedBlock = (payload: unknown) =>
    `${startMarker}\n${JSON.stringify(payload, null, 2)}\nqnalog-merge-end -->`;
  type MergeFixture = {
    writer: NoteWriter;
    host: NoteWriterHost;
    vault: ReturnType<typeof memoryVault>;
    settings: NoteWriterSettings;
    sourceFiles: Array<{ file: File; content: string }>;
    targetPath: string;
    refreshed: File[];
    opened: File[];
  };
  async function withMergeFixture(run: (fixture: MergeFixture) => Promise<void>): Promise<void> {
    const originalLanguage = getActiveUiLanguage();
    const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const moment = (value: string | Date) => {
      const date = new Date(value);
      return {
        isValid: () => Number.isFinite(date.getTime()),
        toDate: () => date,
        format: (pattern: string) => pattern === "YYYY-MM-DD HHmm"
          ? "2026-10-08 1100"
          : pattern === "YYYYMMDD-HHmmss" ? "20261008-110000" : "2026-10-08 11:00:00",
      };
    };
    vi.stubGlobal("window", { moment });
    try {
      setActiveUiLanguage(matchUiLanguage("en")!);
      const sourceFiles = sources.map((source, index) => {
        const file = new obsidian.TFile(source.path);
        const text = index === 0 ? "Transcript A" : "Transcript B";
        const segment = attachTextTranscript({
          index: 0, startOffsetMs: 0, endOffsetMs: 1000, text, rawText: text, isFinal: true,
        }, index === 0 ? "metadata-source-a" : "metadata-source-b", "text-import");
        return {
          file,
          content: `---\nqnalog_mode: monologue\n---\n\n<!-- qnalog-segments-start:${segment.transcript!.sourceId} -->\n${serializeTranscriptBlock(segment, "### Text source 1", text)}\n<!-- qnalog-segments-end:${segment.transcript!.sourceId} -->`,
        };
      });
      const targetPath = "QnALog/Minutes/metadata-merged.md";
      const vault = memoryVault(sourceFiles.map(source => ({ file: source.file, markdown: source.content })));
      const refreshed: File[] = [];
      const opened: File[] = [];
      const settings: NoteWriterSettings = {
        ...DEFAULT_SETTINGS, autoRenameWithTitle: false, mdFolder: "QnALog/Minutes",
        llmModel: "metadata-test-model",
      };
      const host = unexpectedHost(vault.vault, settings, {
        ensureFolder: async () => undefined,
        findAvailableMarkdownPath: () => targetPath,
        getFileFrontmatter: (file) => ({
          qnalog_mode: "monologue",
          qnalog_time: file.path === sourceFiles[0].file.path
            ? "2026-10-08T11:00:00.000Z" : "2026-10-08T11:01:00.000Z",
        }),
        mergeAndPolish: async () => "---\ntitle: Metadata merge\n---\n\nMERGED BODY",
        clearCommittedBriefingCheckpoint: async () => undefined,
        noteIndex: { refreshNoteIndexSafely: async (file) => { refreshed.push(file); } },
        openFile: async (file) => { opened.push(file); },
      });
      const writer = new NoteWriter(host);
      await run({ writer, host, vault, settings, sourceFiles, targetPath, refreshed, opened });
    } finally {
      setActiveUiLanguage(originalLanguage);
      if (previousWindow === undefined) vi.unstubAllGlobals();
      else vi.stubGlobal("window", previousWindow);
      vi.useRealTimers();
    }
  }

  it("keeps merge side effects ordered and observes target content at each committed stage", async () => {
    await withMergeFixture(async ({ writer, host, vault, sourceFiles, targetPath, refreshed, opened }) => {
      const events: string[] = [];
      let modelMeta: unknown;
      const baseRead = vault.vault.read.bind(vault.vault);
      const baseCreate = vault.vault.create.bind(vault.vault);
      const baseModify = vault.vault.modify.bind(vault.vault);
      vault.vault.read = async (file) => {
        events.push(`read:${file.path}`);
        return baseRead(file);
      };
      vault.vault.create = async (path, content) => {
        events.push(`create:${path}:${content}`);
        return baseCreate(path, content);
      };
      vault.vault.modify = async (file, content) => {
        events.push(`modify:${file.path}`);
        return baseModify(file, content);
      };
      host.ensureFolder = async (path) => { events.push(`folder:${path}`); };
      host.findAvailableMarkdownPath = (path) => { events.push(`allocate:${path}`); return targetPath; };
      host.mergeAndPolish = async (_segments, _mode, meta) => {
        expect(vault.files.get(targetPath)?.markdown).toBe("");
        modelMeta = meta;
        events.push("model");
        return "MERGED BODY";
      };
      host.clearCommittedBriefingCheckpoint = async (meta) => {
        expect(meta).toBe(modelMeta);
        const content = vault.files.get(targetPath)?.markdown ?? "";
        expect(content).toContain("MERGED BODY");
        expect(content).not.toContain(startMarker);
        expect(readTranscriptBlocks(content).map(block => ({
          index: block.segment.index,
          sourceId: block.segment.transcript?.sourceId,
          rawText: getCurrentTranscript(block.segment.transcript!).rawText,
        }))).toEqual([
          { index: 0, sourceId: "metadata-source-a", rawText: "Transcript A" },
          { index: 1, sourceId: "metadata-source-b", rawText: "Transcript B" },
        ]);
        events.push("clear");
      };
      host.noteIndex = { refreshNoteIndexSafely: async (file) => {
        expect(await baseRead(file)).toContain(startMarker);
        events.push(`index:${file.path}`);
        refreshed.push(file);
      } };
      host.openFile = async (file) => { events.push(`open:${file.path}`); opened.push(file); };
      await writer.mergeMarkdownFilesAsNew(sourceFiles.map(source => source.file));
      expect(events.slice(0, 2)).toEqual(sourceFiles.map(source => `read:${source.file.path}`));
      expect(events.indexOf("model")).toBeLessThan(events.indexOf("clear"));
      expect(events.indexOf("clear")).toBeLessThan(events.findIndex(event => event.startsWith("index:")));
      expect(events.findIndex(event => event.startsWith("index:"))).toBeLessThan(events.findIndex(event => event.startsWith("open:")));
      expect(events).toContain(`create:${targetPath}:`);
      expect(refreshed[0]).toBe(opened[0]);
    });
  });
  it("reads naming settings after folder creation finishes", async () => {
    await withMergeFixture(async ({ writer, host, settings, sourceFiles }) => {
      let releaseFolder: (() => void) | undefined;
      let enteredFolder: (() => void) | undefined;
      const folderEntered = new Promise<void>((resolve) => { enteredFolder = resolve; });
      const folderGate = new Promise<void>((resolve) => { releaseFolder = resolve; });
      const ensureCalls: string[] = [];
      let allocated = "";
      host.ensureFolder = async (path) => {
        ensureCalls.push(path);
        enteredFolder?.();
        await folderGate;
      };
      host.findAvailableMarkdownPath = (path) => { allocated = path; return path; };
      const mergeGate = Promise.resolve("---\ntitle: Changed settings\n---\n\nMERGED BODY");
      host.mergeAndPolish = async () => mergeGate;
      const merge = writer.mergeMarkdownFilesAsNew(sourceFiles.map(source => source.file));
      await folderEntered;
      const changedSettings = { ...settings, mdFolder: "QnALog/ChangedMinutes", noteFileNameFormatNew: "CHANGED-FORMAT" };
      Object.defineProperty(host, "settings", { configurable: true, get: () => changedSettings });
      vi.stubGlobal("window", {
        moment: () => ({
          isValid: () => true,
          toDate: () => new Date("2026-10-08T11:00:00.000Z"),
          format: (pattern: string) => pattern === "CHANGED-FORMAT" ? "changed-stamp" : "20261008-110000",
        }),
      });
      releaseFolder?.();
      await merge;
      expect(ensureCalls).toEqual(["QnALog/Minutes"]);
      expect(allocated).toBe("QnALog/ChangedMinutes/changed-stamp · Merge.md");
    });
  });

  it("uses the current host after the model request is in flight", async () => {
    await withMergeFixture(async ({ writer, host, vault, settings, sourceFiles, targetPath }) => {
      let releaseModel: (() => void) | undefined;
      let enteredModel: (() => void) | undefined;
      const modelEntered = new Promise<void>((resolve) => { enteredModel = resolve; });
      const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
      host.mergeAndPolish = async () => {
        enteredModel?.();
        await modelGate;
        return "MERGED BODY";
      };
      const merge = writer.mergeMarkdownFilesAsNew(sourceFiles.map(source => source.file));
      await modelEntered;
      const vaultB = memoryVault([
        ...sourceFiles.map(source => ({ file: source.file, markdown: source.content })),
        { file: new obsidian.TFile(targetPath), markdown: "" },
      ]);
      const refreshedB: File[] = [];
      const openedB: File[] = [];
      const hostB = unexpectedHost(vaultB.vault, settings, {
        clearCommittedBriefingCheckpoint: async () => undefined,
        noteIndex: { refreshNoteIndexSafely: async (file) => { refreshedB.push(file); } },
        openFile: async (file) => { openedB.push(file); },
      });
      writer.host = hostB;
      releaseModel?.();
      await merge;
      expect(vault.files.get(targetPath)?.markdown).toBe("");
      const resultB = vaultB.files.get(targetPath)?.markdown ?? "";
      expect(resultB).toContain("MERGED BODY");
      expect(resultB).toContain(startMarker);
      expect(refreshedB.map(file => file.path)).toEqual([targetPath]);
      expect(openedB.map(file => file.path)).toEqual([targetPath]);
    });
  });
  it.each(["second-source-read", "path-allocation", "empty-path", "create", "model", "body-write", "checkpoint-clear", "metadata-write", "index"] as const)(
    "preserves merge state and propagates the original error at %s",
    async (failurePoint) => {
      await withMergeFixture(async ({ writer, host, vault, sourceFiles, targetPath }) => {
        const failure = new Error(`failure at ${failurePoint}`);
        let modifies = 0;
        let laterStage = false;
        const baseRead = vault.vault.read.bind(vault.vault);
        const baseCreate = vault.vault.create.bind(vault.vault);
        const baseModify = vault.vault.modify.bind(vault.vault);
        vault.vault.read = async (file) => {
          if (failurePoint === "second-source-read" && file.path === sourceFiles[1].file.path) throw failure;
          return baseRead(file);
        };
        host.findAvailableMarkdownPath = () => {
          if (failurePoint === "path-allocation") throw failure;
          return targetPath;
        };
        if (failurePoint === "empty-path") host.findAvailableMarkdownPath = () => "";
        vault.vault.create = async (path, markdown) => {
          if (failurePoint === "create") throw failure;
          return baseCreate(path, markdown);
        };
        host.mergeAndPolish = async () => {
          if (failurePoint === "model") throw failure;
          return "MERGED BODY";
        };
        host.clearCommittedBriefingCheckpoint = async () => {
          if (failurePoint === "checkpoint-clear") throw failure;
        };
        vault.vault.modify = async (file, markdown) => {
          modifies += 1;
          if (failurePoint === "body-write" && modifies === 1) throw failure;
          if (failurePoint === "metadata-write" && modifies === 2) throw failure;
          return baseModify(file, markdown);
        };
        host.noteIndex = { refreshNoteIndexSafely: async () => {
          laterStage = true;
          if (failurePoint === "index") throw failure;
        } };
        if (failurePoint === "empty-path") {
          await expect(writer.mergeMarkdownFilesAsNew(sourceFiles.map(source => source.file)))
            .rejects.toThrow("Failed to generate a path for the merged minutes file");
        } else {
          await expect(writer.mergeMarkdownFilesAsNew(sourceFiles.map(source => source.file))).rejects.toBe(failure);
        }
        expect(sourceFiles.map(({ file }) => vault.files.get(file.path)?.markdown))
          .toEqual(sourceFiles.map(source => source.content));
        const target = vault.files.get(targetPath)?.markdown;
        if (["second-source-read", "path-allocation", "empty-path", "create"].includes(failurePoint)) {
          expect(target).toBeUndefined();
        } else if (["model", "body-write"].includes(failurePoint)) {
          expect(target).toBe("");
        } else if (["checkpoint-clear", "metadata-write"].includes(failurePoint)) {
          expect(target).toContain("MERGED BODY");
          expect(target).not.toContain(startMarker);
        } else if (failurePoint === "index") {
          expect(target).toContain("MERGED BODY");
          expect(target).toContain(startMarker);
        }
        expect(laterStage).toBe(failurePoint === "index");
      });
    },
  );

  it("keeps open failure non-fatal and rejects insufficient inputs without model work", async () => {
    await withMergeFixture(async ({ writer, host, vault, sourceFiles, targetPath }) => {
      const originalNoticeCount = notices.length;
      host.openFile = async () => { throw new Error("open failed"); };
      await expect(writer.mergeMarkdownFilesAsNew(sourceFiles.map(source => source.file))).resolves.toBeUndefined();
      expect(vault.files.get(targetPath)?.markdown).toContain(startMarker);
      expect(notices.length).toBeGreaterThan(originalNoticeCount);
      let modelCalls = 0;
      host.mergeAndPolish = async () => { modelCalls += 1; return "UNEXPECTED"; };
      for (const input of [[], null, undefined, [sourceFiles[0].file]]) {
        await expect(writer.mergeMarkdownFilesAsNew(input)).resolves.toBeUndefined();
      }
      expect(modelCalls).toBe(0);
      expect(vault.files.get(targetPath)?.markdown).toContain("MERGED BODY");
    });
  });

  it("preserves source JSON and transcript bytes when appending and replacing metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    try {
      const segment = attachTextTranscript({
        index: 0, startOffsetMs: 0, endOffsetMs: 1000,
        text: "TRANSCRIPT $& $` $' $$", rawText: "TRANSCRIPT $& $` $' $$", isFinal: true,
      }, "metadata-preserve", "text-import");
      const ledger = serializeTranscriptBlock(segment, "### Transcript", segment.text);
      const prefix = `---\ntitle: metadata-literal\n---\n\n# KEEP BEFORE $&\n\n${ledger}`;
      const tail = "\n \t\r\n";
      const file = new obsidian.TFile("QnALog/Minutes/metadata-literal.md");
      const vault = memoryVault([{ file, markdown: prefix + tail }]);
      const writer = new NoteWriter(unexpectedHost(vault.vault, DEFAULT_SETTINGS));
      const expectedPayload = { mergedAt: "2026-10-08T12:00:00.000Z", sources };
      const oldPayload = {
        mergedAt: "2000-01-01T00:00:00.000Z",
        sources: [{ path: "Notes/old.md", title: "old", durationMs: 5 }],
      };
      const originalLedgerBlocks = readTranscriptBlocks(prefix);
      await writer.appendMergeMetadataBlock(file, sources);
      const appended = await vault.vault.read(file);
      expect(payloadFrom(appended)).toEqual(expectedPayload);
      const appendedExpected = `${prefix}\n\n${expectedBlock(expectedPayload)}\n`;
      expect(appended).toBe(appendedExpected);
      expect(readTranscriptBlocks(appended).map(block => ({
        visibleBlock: block.visibleBlock,
        sourceId: block.segment.transcript?.sourceId,
        rawText: getCurrentTranscript(block.segment.transcript!).rawText,
      }))).toEqual(originalLedgerBlocks.map(block => ({
        visibleBlock: block.visibleBlock,
        sourceId: block.segment.transcript?.sourceId,
        rawText: getCurrentTranscript(block.segment.transcript!).rawText,
      })));

      const oldBlock = expectedBlock(oldPayload);
      const suffix = "\n\nKEEP AFTER $' $$\r\n";
      await vault.vault.modify(file, `${prefix}\n\n${oldBlock}${suffix}`);
      await writer.appendMergeMetadataBlock(file, sources);
      const replaced = await vault.vault.read(file);
      expect(payloadFrom(replaced)).toEqual(expectedPayload);
      expect(replaced).toBe(`${prefix}\n\n${expectedBlock(expectedPayload)}${suffix}`);
      expect(readTranscriptBlocks(replaced).map(block => ({
        visibleBlock: block.visibleBlock,
        sourceId: block.segment.transcript?.sourceId,
        rawText: getCurrentTranscript(block.segment.transcript!).rawText,
      }))).toEqual(originalLedgerBlocks.map(block => ({
        visibleBlock: block.visibleBlock,
        sourceId: block.segment.transcript?.sourceId,
        rawText: getCurrentTranscript(block.segment.transcript!).rawText,
      })));
      await writer.appendMergeMetadataBlock(file, sources);
      expect(await vault.vault.read(file)).toBe(replaced);
    } finally {
      vi.useRealTimers();
    }
  });
  it("guards invalid targets before reading sources and writes an exact empty-source block", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    try {
      const file = new obsidian.TFile("Notes/target.bin");
      const initial = "# Body\n \t\r\n";
      const vault = memoryVault([{ file, markdown: initial }]);
      const read = vi.spyOn(vault.vault, "read");
      const modify = vi.spyOn(vault.vault, "modify");
      const writer = new NoteWriter(unexpectedHost(vault.vault, DEFAULT_SETTINGS));
      const sourceWithThrowingPath = Object.defineProperty({}, "path", {
        get: () => { throw new Error("sources must not be read for an invalid target"); },
      }) as NoteMergeSourceMetadata;

      for (const target of [null, undefined, { path: file.path }]) {
        await expect(writer.appendMergeMetadataBlock(target, [sourceWithThrowingPath])).resolves.toBeUndefined();
      }
      expect(read).not.toHaveBeenCalled();
      expect(modify).not.toHaveBeenCalled();

      const payload = { mergedAt: "2026-10-08T12:00:00.000Z", sources: [] };
      const expected = `# Body\n\n${expectedBlock(payload)}\n`;
      for (const emptySources of [null, undefined, []] as const) {
        const targetFile = new obsidian.TFile(`Notes/target-${String(emptySources)}.bin`);
        const targetVault = memoryVault([{ file: targetFile, markdown: initial }]);
        const targetWriter = new NoteWriter(unexpectedHost(targetVault.vault, DEFAULT_SETTINGS));
        await targetWriter.appendMergeMetadataBlock(targetFile, emptySources);
        expect(await targetVault.vault.read(targetFile)).toBe(expected);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves source order, raw strings, and JavaScript number serialization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    try {
      const file = new obsidian.TFile("Notes/source-conversion.md");
      const vault = memoryVault([{ file, markdown: "BODY" }]);
      const writer = new NoteWriter(unexpectedHost(vault.vault, DEFAULT_SETTINGS));
      const inputs = [
        { path: "", title: "", durationMs: 0 },
        {},
        { path: " A ", title: "Title $& $` $' $$", durationMs: "1250" },
        { path: "negative", title: "negative", durationMs: -20 },
        { path: "invalid", title: "invalid", durationMs: "not-a-number" },
        { path: "infinite", title: "infinite", durationMs: Infinity },
      ];
      const before = structuredClone(inputs);
      await writer.appendMergeMetadataBlock(file, inputs as unknown as NoteMergeSourceMetadata[]);
      expect(payloadFrom(await vault.vault.read(file))).toEqual({
        mergedAt: "2026-10-08T12:00:00.000Z",
        sources: [
          { path: "", title: "", durationMs: 0 },
          { path: "", title: "", durationMs: 0 },
          { path: " A ", title: "Title $& $` $' $$", durationMs: 1250 },
          { path: "negative", title: "negative", durationMs: -20 },
          { path: "invalid", title: "invalid", durationMs: 0 },
          { path: "infinite", title: "infinite", durationMs: null },
        ],
      });
      expect(inputs).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces only the first complete case-sensitive metadata block", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    try {
      const payload = { mergedAt: "2026-10-08T12:00:00.000Z", sources: [] };
      const replacement = expectedBlock(payload);
      const old = expectedBlock({ mergedAt: "2000-01-01T00:00:00.000Z", sources: [] });
      const cases = [
        {
          original: `LEFT\r\n${old}\r\nMID $&\r\n${old}\r\nRIGHT`,
          expected: `LEFT\r\n${replacement}\r\nMID $&\r\n${old}\r\nRIGHT`,
        },
        {
          original: `LEFT\n<!-- qnalog-merge -->\nunfinished $&`,
          expected: `LEFT\n<!-- qnalog-merge -->\nunfinished $&\n\n${replacement}\n`,
        },
        {
          original: `LEFT\n<!-- QNALOG-MERGE -->\nold\n<!-- QNALOG-MERGE-END -->\nRIGHT`,
          expected: `LEFT\n<!-- QNALOG-MERGE -->\nold\n<!-- QNALOG-MERGE-END -->\nRIGHT\n\n${replacement}\n`,
        },
      ];
      for (const [index, testCase] of cases.entries()) {
        const file = new obsidian.TFile(`Notes/match-${index}.md`);
        const vault = memoryVault([{ file, markdown: testCase.original }]);
        const writer = new NoteWriter(unexpectedHost(vault.vault, DEFAULT_SETTINGS));
        await writer.appendMergeMetadataBlock(file, []);
        expect(await vault.vault.read(file)).toBe(testCase.expected);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["vault getter", "replace"],
    ["vault getter", "append"],
    ["host replacement", "replace"],
    ["host replacement", "append"],
  ] as const)("uses execution-time host/vault with the read snapshot and frozen payload (%s, %s)", async (switchKind, layout) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const file = new obsidian.TFile(`Notes/dynamic-${switchKind}-${layout}.md`);
    const oldBlock = expectedBlock({ mergedAt: "2000-01-01T00:00:00.000Z", sources: [] });
    const snapshot = layout === "replace" ? `A BODY\n\n${oldBlock}\n` : "A BODY";
    const vaultA = memoryVault([{ file, markdown: snapshot }]);
    const vaultB = memoryVault([{ file, markdown: "B BODY" }]);
    let activeVault = vaultA.vault;
    let enteredRead!: () => void;
    let releaseRead!: () => void;
    const readEntered = new Promise<void>((resolve) => { enteredRead = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const baseReadA = vaultA.vault.read.bind(vaultA.vault);
    const baseModifyA = vaultA.vault.modify.bind(vaultA.vault);
    const baseModifyB = vaultB.vault.modify.bind(vaultB.vault);
    let modifiesA = 0;
    let modifiesB = 0;
    vaultA.vault.read = async (target) => {
      enteredRead();
      await readGate;
      return baseReadA(target);
    };
    vaultA.vault.modify = async (...args) => {
      modifiesA += 1;
      throw new Error("Vault A modify must not be used");
    };
    vaultB.vault.read = async () => { throw new Error("Vault B read must not be used"); };
    vaultB.vault.modify = async function (target, content) {
      expect(this).toBe(vaultB.vault);
      modifiesB += 1;
      return baseModifyB(target, content);
    };
    const hostA = unexpectedHost(vaultA.vault, DEFAULT_SETTINGS);
    if (switchKind === "vault getter") {
      Object.defineProperty(hostA, "vault", { get: () => activeVault });
    }
    const writer = new NoteWriter(hostA);
    const source = { path: "Notes/early.md", title: "Early", durationMs: 1250 };
    const input: NoteMergeSourceMetadata[] = [source];
    const operation = writer.appendMergeMetadataBlock(file, input);
    await readEntered;
    source.path = "Notes/late.md";
    source.title = "Late";
    source.durationMs = 2500;
    vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
    if (switchKind === "vault getter") {
      activeVault = vaultB.vault;
    } else {
      writer.host = unexpectedHost(vaultB.vault, DEFAULT_SETTINGS);
    }
    releaseRead();
    try {
      await operation;
      const expectedPayload = {
        mergedAt: "2026-10-08T12:00:00.000Z",
        sources: [{ path: "Notes/early.md", title: "Early", durationMs: 1250 }],
      };
      expect(modifiesA).toBe(0);
      expect(modifiesB).toBe(1);
      expect(vaultA.files.get(file.path)?.markdown).toBe(snapshot);
      const expectedContent = layout === "replace"
        ? `A BODY\n\n${expectedBlock(expectedPayload)}\n`
        : `A BODY\n\n${expectedBlock(expectedPayload)}\n`;
      expect(vaultB.files.get(file.path)?.markdown).toBe(expectedContent);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates payload and storage failures without additional writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    try {
      const payloadCases: Array<{ sources: NoteMergeSourceMetadata[]; error: Error; typeError?: boolean }> = [];
      const pathFailure = new Error("path getter failed");
      payloadCases.push({
        sources: [Object.defineProperty({}, "path", { get: () => { throw pathFailure; } }) as NoteMergeSourceMetadata],
        error: pathFailure,
      });
      const valueFailure = new Error("duration conversion failed");
      payloadCases.push({
        sources: [{ path: "path", title: "title", durationMs: { valueOf: () => { throw valueFailure; } } as unknown as number }],
        error: valueFailure,
      });
      const circular: { self?: unknown } = {};
      circular.self = circular;
      payloadCases.push({
        sources: [{ path: circular as unknown as string, title: "title", durationMs: 1 }],
        error: new TypeError(),
        typeError: true,
      });
      for (const [index, testCase] of payloadCases.entries()) {
        const file = new obsidian.TFile(`Notes/payload-failure-${index}.md`);
        const vault = memoryVault([{ file, markdown: "UNCHANGED" }]);
        const read = vi.spyOn(vault.vault, "read");
        const modify = vi.spyOn(vault.vault, "modify");
        const writer = new NoteWriter(unexpectedHost(vault.vault, DEFAULT_SETTINGS));
        if (testCase.typeError) {
          await expect(writer.appendMergeMetadataBlock(file, testCase.sources)).rejects.toBeInstanceOf(TypeError);
        } else {
          await expect(writer.appendMergeMetadataBlock(file, testCase.sources)).rejects.toBe(testCase.error);
        }
        expect(read).not.toHaveBeenCalled();
        expect(modify).not.toHaveBeenCalled();
        expect(await vault.vault.read(file)).toBe("UNCHANGED");
      }

      const readFailure = new Error("read failed");
      const readFile = new obsidian.TFile("Notes/read-failure.md");
      const readVault = memoryVault([{ file: readFile, markdown: "UNCHANGED" }]);
      readVault.vault.read = async () => { throw readFailure; };
      const readWriter = new NoteWriter(unexpectedHost(readVault.vault, DEFAULT_SETTINGS));
      await expect(readWriter.appendMergeMetadataBlock(readFile, [])).rejects.toBe(readFailure);
      expect(readVault.files.get(readFile.path)?.markdown).toBe("UNCHANGED");

      for (const [index, existing] of ["BODY", `BODY\n\n${expectedBlock({ mergedAt: "2000-01-01T00:00:00.000Z", sources: [] })}`].entries()) {
        const writeFailure = new Error(`modify failed ${index}`);
        const file = new obsidian.TFile(`Notes/write-failure-${index}.md`);
        const vault = memoryVault([{ file, markdown: existing }]);
        vault.vault.modify = async () => { throw writeFailure; };
        const writer = new NoteWriter(unexpectedHost(vault.vault, DEFAULT_SETTINGS));
        await expect(writer.appendMergeMetadataBlock(file, [])).rejects.toBe(writeFailure);
        expect(vault.files.get(file.path)?.markdown).toBe(existing);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["direct", "confirmed"] as const)("writes literal source metadata through the complete %s merge consumer", async (route) => {
    await withMergeFixture(async ({ writer, host, vault, sourceFiles, targetPath, refreshed, opened }) => {
      expect(sourceFiles.map(source => readTranscriptBlocks(source.content).length)).toEqual([1, 1]);
      if (route === "confirmed") {
        host.getRecentNotes = () => [
          { file: sourceFiles[1].file, timestamp: 2 },
          { file: sourceFiles[0].file, timestamp: 1 },
        ];
        host.confirm = async (title, body, ctaText) => {
          expect({ title, body, ctaText }).toEqual({
            title: "Merge minutes",
            body: "A new merged minutes note will be created; the source files will be kept.\n\nSources:\n1. "
              + sourceFiles[0].file.basename + "\n2. " + sourceFiles[1].file.basename + "\n\nContinue?",
            ctaText: "Merge",
          });
          return true;
        };
        await writer.mergeMarkdownFileWithPrevious(sourceFiles[1].file);
      } else {
        await writer.mergeMarkdownFilesAsNew(sourceFiles.map(source => source.file));
      }
      const merged = vault.files.get(targetPath);
      expect(merged).toBeDefined();
      const actual = await vault.vault.read(merged!.file);
      expect(payloadFrom(actual)).toEqual({
        mergedAt: "2026-10-08T12:00:00.000Z",
        sources: sourceFiles.map(({ file }) => ({
          path: file.path, title: file.basename, durationMs: 1000,
        })),
      });
      expect(actual).toContain("MERGED BODY");
      expect(readTranscriptBlocks(actual).map(block => ({
        index: block.segment.index,
        startOffsetMs: block.segment.startOffsetMs,
        endOffsetMs: block.segment.endOffsetMs,
        sourceId: block.segment.transcript?.sourceId,
        rawText: getCurrentTranscript(block.segment.transcript!).rawText,
      }))).toEqual([
        { index: 0, startOffsetMs: 0, endOffsetMs: 1000, sourceId: "metadata-source-a", rawText: "Transcript A" },
        { index: 1, startOffsetMs: 1000, endOffsetMs: 2000, sourceId: "metadata-source-b", rawText: "Transcript B" },
      ]);
      expect(sourceFiles.map(({ file }) => vault.files.get(file.path)?.markdown)).toEqual(sourceFiles.map(source => source.content));
      expect(refreshed).toEqual([merged!.file]);
      expect(opened).toEqual([merged!.file]);
    });
  });
  it("uses inferred source modes through the complete merge consumer and preserves source notes", async () => {
    await withMergeFixture(async ({ writer, host, vault, sourceFiles, targetPath, refreshed, opened }) => {
      const sourceIds = ["writer-source-a", "writer-source-b"];
      const rawTexts = ["Writer source A transcript remains intact.", "Writer source B transcript remains intact."];
      const sourceBytes = sourceFiles.map((source, index) => {
        const time = index === 0 ? "2026-10-08T11:00:00.000Z" : "2026-10-08T11:01:00.000Z";
        const segment = attachTextTranscript({
          index: 0, startOffsetMs: 0, endOffsetMs: 1000,
          text: rawTexts[index], rawText: rawTexts[index], isFinal: true,
        }, sourceIds[index], "text-import");
        const content = [
          "---", `qnalog_time: ${time}`, "---", "",
          `<!-- qnalog-segments-start:${sourceIds[index]} -->`,
          serializeTranscriptBlock(segment, "### Text source 1", rawTexts[index]),
          `<!-- qnalog-segments-end:${sourceIds[index]} -->`,
        ].join("\n");
        source.content = content;
        vault.files.get(source.file.path)!.markdown = content;
        return content;
      });
      const sourceCaches = new Map([
        [sourceFiles[0].file.path, {
          qnalog_mode: "cleanscript", tags: ["unknown", "qnalog/meeting"],
          qnalog_time: "2026-10-08T11:00:00.000Z",
        }],
        [sourceFiles[1].file.path, {
          qnalog_mode: "unknown", qnalog_type: "学习视频",
          qnalog_time: "2026-10-08T11:01:00.000Z",
        }],
      ]);
      host.getFileFrontmatter = file => sourceCaches.get(file.path);
      const first = await writer.readMergeSourceFromMarkdown(sourceFiles[0].file, 0, 0);
      const second = await writer.readMergeSourceFromMarkdown(sourceFiles[1].file, 1000, 1);
      expect([first.mode, second.mode]).toEqual(["meeting", "learning"]);
      await writer.mergeMarkdownFilesAsNew(sourceFiles.map(source => source.file));

      const mergedEntry = vault.files.get(targetPath);
      expect(mergedEntry).toBeDefined();
      const merged = await vault.vault.read(mergedEntry!.file);
      expect(merged).toContain("MERGED BODY");
      expect(merged.match(/^# .+ · Study notes$/m)?.[0]).toBeDefined();
      expect(payloadFrom(merged).sources).toEqual(sourceFiles.map(({ file }) => ({
        path: file.path, title: file.basename, durationMs: 1000,
      })));
      expect(readTranscriptBlocks(merged)
        .filter(block => sourceIds.includes(block.segment.transcript?.sourceId ?? ""))
        .map(block => ({
          sourceId: block.segment.transcript?.sourceId,
          rawText: getCurrentTranscript(block.segment.transcript!).rawText,
          startOffsetMs: block.segment.startOffsetMs,
          endOffsetMs: block.segment.endOffsetMs,
        }))).toEqual([
        { sourceId: "writer-source-a", rawText: rawTexts[0], startOffsetMs: 0, endOffsetMs: 1000 },
        { sourceId: "writer-source-b", rawText: rawTexts[1], startOffsetMs: 1000, endOffsetMs: 2000 },
      ]);
      expect(sourceFiles.map(source => vault.files.get(source.file.path)?.markdown)).toEqual(sourceBytes);
      expect(refreshed).toEqual([mergedEntry!.file]);
      expect(opened).toEqual([mergedEntry!.file]);
    });
  });
  it("selects the nearest strictly older recent note without mutating recents", () => {
    const currentFile = new obsidian.TFile("Notes\\current.md");
    const olderFile = new obsidian.TFile("Notes/older.md");
    const nearestFile = new obsidian.TFile("Notes/nearest.md");
    const equalFile = new obsidian.TFile("Notes/equal.md");
    const futureFile = new obsidian.TFile("Notes/future.md");
    const recents = [
      { file: futureFile, timestamp: 21 },
      { file: olderFile, timestamp: 10 },
      { file: new obsidian.TFile("Notes/current.md"), timestamp: 20 },
      { file: equalFile, timestamp: 20 },
      { file: nearestFile, timestamp: 19 },
    ];
    const originalOrder = [...recents];
    const writer = new NoteWriter(unexpectedHost(memoryVault().vault, DEFAULT_SETTINGS, {
      getRecentNotes: (limit) => {
        expect(limit).toBe(240);
        return recents;
      },
    }));
    expect(writer.findPreviousRecentNoteFile(currentFile)).toBe(nearestFile);
    expect(recents).toEqual(originalOrder);

    const noOlderWriter = new NoteWriter(unexpectedHost(memoryVault().vault, DEFAULT_SETTINGS, {
      getRecentNotes: () => [
        { file: currentFile, timestamp: 20 },
        { file: equalFile, timestamp: 20 },
        { file: futureFile, timestamp: 21 },
      ],
    }));
    expect(noOlderWriter.findPreviousRecentNoteFile(currentFile)).toBeNull();
    const absentWriter = new NoteWriter(unexpectedHost(memoryVault().vault, DEFAULT_SETTINGS, {
      getRecentNotes: () => [{ file: nearestFile, timestamp: 19 }],
    }));
    expect(absentWriter.findPreviousRecentNoteFile(currentFile)).toBeNull();
    const tiedWriter = new NoteWriter(unexpectedHost(memoryVault().vault, DEFAULT_SETTINGS, {
      getRecentNotes: () => [
        { file: currentFile, timestamp: 20 },
        { file: olderFile, timestamp: 19 },
        { file: nearestFile, timestamp: 19 },
      ],
    }));
    expect(tiedWriter.findPreviousRecentNoteFile(currentFile)).toBe(olderFile);
  });

  it("guards lookup, preserves winner validation order, and propagates lookup and confirmation failures", async () => {
    const currentFile = new obsidian.TFile("Notes/current.md");
    const previousFile = new obsidian.TFile("Notes/previous.md");
    const vault = memoryVault([
      { file: currentFile, markdown: "CURRENT BYTES" },
      { file: previousFile, markdown: "PREVIOUS BYTES" },
    ]);
    const getRecentNotes = vi.fn(() => [
      { file: currentFile, timestamp: 2 },
      { file: previousFile, timestamp: 1 },
    ]);
    const host = unexpectedHost(vault.vault, DEFAULT_SETTINGS, { getRecentNotes });
    const writer = new NoteWriter(host);
    expect(writer.findPreviousRecentNoteFile("not a file")).toBeNull();
    expect(getRecentNotes).not.toHaveBeenCalled();

    const invalidWinner = { path: "Notes/invalid.md" } as unknown as File;
    host.getRecentNotes = () => [
      { file: currentFile, timestamp: 3 },
      { file: previousFile, timestamp: 1 },
      { file: invalidWinner, timestamp: 2 },
    ];
    expect(writer.findPreviousRecentNoteFile(currentFile)).toBeNull();

    const lookupFailure = new Error("recent lookup failed");
    host.getRecentNotes = () => { throw lookupFailure; };
    expect(() => writer.findPreviousRecentNoteFile(currentFile)).toThrow(lookupFailure);
    await expect(writer.mergeMarkdownFileWithPrevious(currentFile)).rejects.toBe(lookupFailure);

    const confirmFailure = new Error("confirmation failed");
    host.getRecentNotes = () => [
      { file: currentFile, timestamp: 2 },
      { file: previousFile, timestamp: 1 },
    ];
    host.confirm = async () => { throw confirmFailure; };
    const oldNoticeCount = notices.length;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(writer.mergeMarkdownFileWithPrevious(currentFile)).rejects.toBe(confirmFailure);
      expect(notices.slice(oldNoticeCount)).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
      expect([...vault.files.keys()]).toEqual([currentFile.path, previousFile.path]);
      expect(await vault.vault.read(currentFile)).toBe("CURRENT BYTES");
      expect(await vault.vault.read(previousFile)).toBe("PREVIOUS BYTES");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does no merge work when there is no previous note", async () => {
    const currentFile = new obsidian.TFile("Notes/current.md");
    const vault = memoryVault([{ file: currentFile, markdown: "CURRENT BYTES" }]);
    const confirm = vi.fn(async () => true);
    const mergeAndPolish = vi.fn(async () => "UNEXPECTED MERGE");
    const writer = new NoteWriter(unexpectedHost(vault.vault, DEFAULT_SETTINGS, {
      getRecentNotes: () => [{ file: currentFile, timestamp: 2 }],
      confirm,
      mergeAndPolish,
    }));
    const oldNoticeCount = notices.length;
    await writer.mergeMarkdownFileWithPrevious(currentFile);
    expect(notices.slice(oldNoticeCount)).toEqual(["No most recent QnALog summary before this one was found."]);
    expect(confirm).not.toHaveBeenCalled();
    expect(mergeAndPolish).not.toHaveBeenCalled();
    expect([...vault.files.keys()]).toEqual([currentFile.path]);
    expect(await vault.vault.read(currentFile)).toBe("CURRENT BYTES");
  });

  it("uses the host selected after confirmation and treats any truthy confirmation as accepted", async () => {
    await withMergeFixture(async ({ writer, host, vault, sourceFiles, targetPath, refreshed, opened }) => {
      const otherVault = memoryVault(sourceFiles.map(source => ({ file: source.file, markdown: source.content })));
      let enterConfirm!: () => void;
      let releaseConfirm!: (value: unknown) => void;
      const entered = new Promise<void>(resolve => { enterConfirm = resolve; });
      const confirmation = new Promise<unknown>(resolve => { releaseConfirm = resolve; });
      const hostA = unexpectedHost(otherVault.vault, DEFAULT_SETTINGS, {
        getRecentNotes: () => [
          { file: sourceFiles[1].file, timestamp: 2 },
          { file: sourceFiles[0].file, timestamp: 1 },
        ],
        confirm: async () => {
          enterConfirm();
          return confirmation;
        },
      });
      writer.host = hostA;
      const mergePromise = writer.mergeMarkdownFileWithPrevious(sourceFiles[1].file);
      await entered;
      writer.host = host;
      releaseConfirm("accepted");
      await mergePromise;
      const merged = vault.files.get(targetPath);
      expect(merged).toBeDefined();
      expect(await vault.vault.read(merged!.file)).toContain("MERGED BODY");
      expect(payloadFrom(await vault.vault.read(merged!.file)).sources).toEqual(sourceFiles.map(({ file }) => ({
        path: file.path, title: file.basename, durationMs: 1000,
      })));
      expect(sourceFiles.map(({ file }) => vault.files.get(file.path)?.markdown)).toEqual(sourceFiles.map(source => source.content));
      expect(sourceFiles.map(({ file }) => otherVault.files.get(file.path)?.markdown)).toEqual(sourceFiles.map(source => source.content));
      expect(refreshed).toEqual([merged!.file]);
      expect(opened).toEqual([merged!.file]);
    });
    await withMergeFixture(async ({ writer, host, vault, sourceFiles, targetPath, refreshed, opened }) => {
      let releaseConfirm!: (value: unknown) => void;
      let enterConfirm!: () => void;
      const entered = new Promise<void>(resolve => { enterConfirm = resolve; });
      const confirmation = new Promise<unknown>(resolve => { releaseConfirm = resolve; });
      const originalConfirm = host.confirm;
      host.getRecentNotes = () => [
        { file: sourceFiles[1].file, timestamp: 2 },
        { file: sourceFiles[0].file, timestamp: 1 },
      ];
      host.confirm = async () => {
        enterConfirm();
        return confirmation;
      };
      const mergePromise = writer.mergeMarkdownFileWithPrevious(sourceFiles[1].file);
      await entered;
      releaseConfirm(false);
      await mergePromise;
      expect(vault.files.has(targetPath)).toBe(false);
      expect(refreshed).toEqual([]);
      expect(opened).toEqual([]);
      host.confirm = originalConfirm;
    });
  });

  it("keeps source notes and reports a post-confirmation merge failure", async () => {
    await withMergeFixture(async ({ writer, host, vault, sourceFiles, targetPath, refreshed, opened }) => {
      host.getRecentNotes = () => [
        { file: sourceFiles[1].file, timestamp: 2 },
        { file: sourceFiles[0].file, timestamp: 1 },
      ];
      host.confirm = async () => true;
      const failure = new Error("model unavailable");
      host.mergeAndPolish = async () => { throw failure; };
      const oldNoticeCount = notices.length;
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(writer.mergeMarkdownFileWithPrevious(sourceFiles[1].file)).resolves.toBeUndefined();
        expect(notices.slice(oldNoticeCount).at(-1)).toBe("Merging minutes failed: model unavailable");
        expect(errorSpy).toHaveBeenCalledWith("[QnALog] merge notes failed", failure);
        expect(vault.files.get(targetPath)?.markdown).toBe("");
        expect(sourceFiles.map(({ file }) => vault.files.get(file.path)?.markdown)).toEqual(sourceFiles.map(source => source.content));
        expect(refreshed).toEqual([]);
        expect(opened).toEqual([]);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
