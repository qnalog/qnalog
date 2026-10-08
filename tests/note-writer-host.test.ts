import { getActiveUiLanguage, matchUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { labelText } from "../src/shared/note-labels";
import { nsMarker } from "../src/shared/namespace";
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
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
}));
import * as obsidian from "obsidian";
import { NoteWriter } from "../src/notes/note-writer";
import type { NoteWriterHost, NoteWriterSettings, NoteWriterVault } from "../src/notes/note-writer";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { attachTextTranscript } from "../src/transcript/session-transcript";
import { readTranscriptBlocks, serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
import { splitLeadingFrontmatter } from "../src/notes/note-document";
import type { RecordingSession, Segment } from "../src/shared/types";
import { buildEmptyLlmOutputFallback } from "../src/prompts/briefing-prompts";

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
