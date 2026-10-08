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
import { buildEmptyLlmOutputFallback } from "../src/prompts/briefing-prompts";
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

  it("polishes only the selected editor range and reports a rejected request without changing text", async () => {
    const vault = memoryVault();
    const settings: NoteWriterSettings = { ...DEFAULT_SETTINGS, polishMode: "meeting" };
    const host = unexpectedHost(vault.vault, settings, {
      polishTranscript: async (raw) => {
        if (raw === "reject me") throw new Error("service unavailable");
        return `organized ${raw}`;
      },
    });
    const writer = new NoteWriter(host);
    let replacement = "";
    const editor = {
      getSelection: () => "selected text",
      getValue: () => "whole document",
      replaceSelection: (value: string) => { replacement = value; },
      setValue: () => { throw new Error("unexpected full-document replacement"); },
    };
    await writer.polishEditor(editor as never);
    expect(replacement).toBe("organized selected text");
    let fullText = "";
    const emptySelectionEditor = {
      getSelection: () => "",
      getValue: () => "standalone transcript",
      replaceSelection: () => { throw new Error("empty selection must use full-document replacement"); },
      setValue: (value: string) => { fullText = value; },
    };
    await writer.polishEditor(emptySelectionEditor as never);
    expect(fullText).toBe("organized standalone transcript");


    const before = notices.length;
    const rejectedEditor = {
      getSelection: () => "reject me",
      getValue: () => "whole document",
      replaceSelection: () => { throw new Error("rejected result must not be written"); },
      setValue: () => { throw new Error("rejected result must not be written"); },
    };
    await writer.polishEditor(rejectedEditor as never);
    expect(notices.slice(before)).toContain("Polish failed: service unavailable");
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
