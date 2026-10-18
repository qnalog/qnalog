import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ TFile: class TFile { path = ""; } }));

import * as obsidian from "obsidian";
import { syncTranscriptAudioSource, type SessionTranscriptSourcePort } from "../src/notes/session-finalize-sources";
import { readTranscriptBlocks } from "../src/transcript/transcript-markdown";

describe("final audio binding with duplicated transcript blocks", () => {
  it("repairs the duplicated note through process, then binds the single remaining block", async () => {
    const file = Object.assign(new obsidian.TFile(), { path: "Notes/dup.md" });
    let stored = readFileSync(new URL("./fixtures/duplicate-transcript-blocks.md", import.meta.url), "utf8");
    const modify = vi.fn(async (_file: unknown, next: string) => { stored = next; });
    const process = vi.fn(async (_file: unknown, update: (text: string) => string) => { stored = update(stored); return stored; });
    const logDiagnostic = vi.fn(async () => undefined);
    const port: SessionTranscriptSourcePort = {
      getVault: () => ({
        getAbstractFileByPath: () => file,
        read: async () => stored,
        modify,
        process,
      }) as never,
      bindSegmentToAudio: (segment) => ({ ...segment }),
      logDiagnostic,
    };
    const sourceSegment = readTranscriptBlocks(stored)[0].segment;
    const session = {
      id: "qnalog-mvcjgw9z-b3kio1", mdPath: file.path, masterAudioPath: "QnALog/录音/master.m4a", masterAudioName: "master.m4a",
      segments: [sourceSegment],
    };

    await syncTranscriptAudioSource(port, session as never);

    expect(process).toHaveBeenCalledOnce();
    expect(readTranscriptBlocks(stored)).toHaveLength(1);
    expect(logDiagnostic).toHaveBeenCalledWith("warn", "transcript.duplicate_block_repaired", expect.any(String), expect.objectContaining({ ids: ["seg:qnalog-mvcjgw9z-b3kio1:0"] }));
  });
});
