import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class TFile {
    path: string; name: string; basename: string; extension: string;
    constructor(path: string) {
      this.path = path; this.name = path.split("/").pop() || path;
      const dot = this.name.lastIndexOf(".");
      this.basename = this.name.slice(0, dot); this.extension = this.name.slice(dot + 1);
    }
  },
  Notice: class Notice {},
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import * as obsidian from "obsidian";
import {
  findRecoveryAudioCandidates, insertRecoveredTranscript, recoverOriginalTranscript,
  type TranscriptRecoveryPort,
} from "../src/notes/transcript-recovery-flow";
import { extractTranscriptSegments } from "../src/notes/note-transcript-ledger";

const f = (path: string) => new obsidian.TFile(path);

describe("findRecoveryAudioCandidates", () => {
  const files = [f("QnALog/录音/qnalog-20261013-232149.m4a"), f("QnALog/录音/qnalog-20261013-232149-seg01.webm"), f("QnALog/录音/qnalog-20261013-184137.webm"), f("notes/a.md")];
  it("matches the recording by start time and skips segment clips", () => {
    const found = findRecoveryAudioCandidates({ qnalog_time: "2026-10-13T23:21:49" }, files);
    expect(found.map((x) => x.path)).toEqual(["QnALog/录音/qnalog-20261013-232149.m4a"]);
  });
  it("prefers the audio path recorded in frontmatter", () => {
    const found = findRecoveryAudioCandidates({ qnalog_time: "2026-10-13T23:21:49", qnalog_audio: "QnALog/录音/qnalog-20261013-184137.webm" }, files);
    expect(found.map((x) => x.path)).toEqual(["QnALog/录音/qnalog-20261013-184137.webm"]);
  });
  it("returns nothing without a usable time", () => {
    expect(findRecoveryAudioCandidates({}, files)).toEqual([]);
  });
});

describe("recoverOriginalTranscript", () => {
  const noteText = ["---", "qnalog_time: 2026-10-13T23:21:49", "---", "# T", "", "Body", "", "---", "", "## 原始材料", ""].join("\n");
  function setup(confirms: boolean[]) {
    const note = f("QnALog/转写纪要/note.md");
    const audio = f("QnALog/录音/qnalog-20261013-232149.m4a");
    const state = { text: noteText, backups: new Map<string, string>() };
    const confirm = vi.fn(async () => confirms.shift() ?? false);
    const port: TranscriptRecoveryPort = {
      getVault: () => ({
        read: async () => state.text,
        process: async (_file: unknown, fn: (latest: string) => string) => { state.text = fn(state.text); return state.text; },
      } as never),
      getCachedFrontmatter: () => ({ qnalog_time: "2026-10-13T23:21:49" }),
      getAudioFiles: () => [audio],
      pickAudioFile: vi.fn(async () => null),
      confirm,
      readAudio: vi.fn(async () => new Blob(["x"])),
      transcribeWhole: vi.fn(async () => ({
        text: "今天确认项目下周启动。", rawText: "今天确认项目下周启动。", providerId: "p",
        units: [{ rawText: "今天确认项目下周启动。", normalizedText: "今天确认项目下周启动。", speakerId: null, speakerName: null, startMs: 0, endMs: 5000, timing: "provider" as const }],
      })),
      refreshNoteIndex: vi.fn(async () => undefined),
      getBackupFolder: () => "QnALog/资料库/归档/原始转写备份",
      createBackupFile: vi.fn(async (path: string, content: string) => { state.backups.set(path, content); return f(path); }),
    };
    return { port, note, state, confirm };
  }

  it("saves a backup file first and writes the transcript back only after confirmation", async () => {
    const { port, note, state } = setup([true, true]);
    expect(await recoverOriginalTranscript(port, note)).toBe(true);
    const [[path, content]] = [...state.backups.entries()];
    expect(path).toContain("原始转写备份/");
    expect(content).toContain("[[QnALog/转写纪要/note|note]]");
    expect(state.text).toContain(`[[${path.replace(/\.md$/, "")}|`);
    expect(extractTranscriptSegments(state.text).map((s) => s.text)).toEqual(["今天确认项目下周启动。"]);
    expect(state.text).toContain("Body");
  });

  it("keeps the note unchanged when the backup is not accepted", async () => {
    const { port, note, state } = setup([true, false]);
    expect(await recoverOriginalTranscript(port, note)).toBe(false);
    expect(state.backups.size).toBe(1);
    expect(state.text).toBe(noteText);
  });

  it("does not transcribe when the first confirmation is declined", async () => {
    const { port, note, state } = setup([false]);
    expect(await recoverOriginalTranscript(port, note)).toBe(false);
    expect(port.transcribeWhole).not.toHaveBeenCalled();
    expect(state.backups.size).toBe(0);
  });
});

describe("insertRecoveredTranscript", () => {
  it("appends the heading when the note has none", () => {
    expect(insertRecoveredTranscript("# T\n\nBody", "BLOCK")).toContain("BLOCK");
  });
});
