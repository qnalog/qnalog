import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  segments: [] as Array<Record<string, unknown>>,
  notice: vi.fn(),
  modalOpen: vi.fn(),
  seek: vi.fn(),
}));

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  TFile: class TFile {
    path: string;
    extension: string;
    name: string;
    basename: string;
    constructor(path: string) {
      this.path = path;
      this.extension = path.split(".").pop() || "";
      this.name = path.split("/").pop() || path;
      this.basename = this.name.replace(/\.[^.]+$/, "");
    }
  },
  Notice: class Notice { constructor(...args: unknown[]) { mocks.notice(...args); } },
}));
vi.mock("../src/ui/modals", () => ({ AudioTimeModal: class AudioTimeModal {
  constructor(...args: unknown[]) { mocks.modalOpen("constructed", ...args); }
  open() { mocks.modalOpen("open"); }
} }));
vi.mock("../src/notes/realtime-outline", () => ({ VIEW_TYPE_OUTLINE: "outline" }));
vi.mock("../src/notes/note-markdown", () => ({ isTimeLabel: (label: string) => /^\d{2}:\d{2}(?::\d{2})?$/.test(label) }));
vi.mock("../src/transcript/transcript-markdown", () => ({
  readTranscriptBlocks: () => mocks.segments.map(segment => ({ segment })),
}));
vi.mock("../src/shared/i18n", () => ({ t: (key: string) => key }));

import * as obsidian from "obsidian";
import { AudioTimeLinkService } from "../src/notes/audio-time-link-service";

const source = new obsidian.TFile("Notes/session.md");
const latest = new obsidian.TFile("Recordings/latest.webm");

function ledgerSegment(audioPath = latest.path, noteStart = 148418, localStart = 0) {
  return {
    index: 0,
    text: "transcript",
    audioPath,
    audioName: "latest.webm",
    startOffsetMs: noteStart,
    endOffsetMs: noteStart + 30000,
    audioStartOffsetMs: localStart,
    audioEndOffsetMs: localStart + 30000,
  };
}

function service(files: Array<{ path: string; name: string; basename: string; extension: string }> = [source, latest], sourceContent = "ledger") {
  const vault = {
    getAbstractFileByPath: (path: string) => files.find(file => file.path === path) || null,
    cachedRead: vi.fn(async () => sourceContent),
    getFiles: () => files,
  };
  const app = {
    vault,
    metadataCache: { getFirstLinkpathDest: (target: string) => files.find(file => file.path === target) || null },
    workspace: { getLeavesOfType: () => [{ view: { seekInlineAudio: mocks.seek } }] },
  };
  return { instance: new AudioTimeLinkService({ app, settings: { audioFolder: "Recordings" } } as never), vault };
}

beforeEach(() => {
  mocks.segments = [ledgerSegment()];
  mocks.notice.mockClear();
  mocks.modalOpen.mockClear();
  mocks.seek.mockReset().mockReturnValue(false);
});

describe("audio time-link consumer behavior", () => {
  it("keeps the wiki label local and maps through the exact source ledger for cumulative time", async () => {
    const { instance } = service();
    const context = await instance.resolveAudioTimeLinkContext("latest.webm", "00:10", source.path);
    expect(context).toMatchObject({ file: latest, localMs: 10000, globalMs: 158418, label: "00:10" });

    const onTimeLink = vi.fn(() => true);
    await instance.openAudioTimeLink("latest.webm", "00:10", source.path, { onTimeLink });
    expect(onTimeLink).toHaveBeenCalledWith(expect.objectContaining({ file: latest, localMs: 10000, globalMs: 158418 }));
    expect(mocks.seek).not.toHaveBeenCalled();
  });

  it("leaves cumulative time unknown when ledger source is absent or local time is ambiguous", async () => {
    const absent = service([latest]);
    expect(await absent.instance.resolveAudioTimeLinkContext("latest.webm", "00:10", source.path))
      .toMatchObject({ localMs: 10000, globalMs: null });

    mocks.segments = [ledgerSegment(latest.path, 0, 0), ledgerSegment(latest.path, 60000, 0)];
    const ambiguous = service();
    expect(await ambiguous.instance.resolveAudioTimeLinkContext("latest.webm", "00:10", source.path))
      .toMatchObject({ localMs: 10000, globalMs: null });
  });

  it("does not forward a missing-media link as a successful seek payload", async () => {
    const missing = service([source]);
    const onTimeLink = vi.fn(() => true);
    await missing.instance.openAudioTimeLink("deleted.webm", "00:10", source.path, { onTimeLink });
    expect(onTimeLink).not.toHaveBeenCalled();
    expect(mocks.seek).not.toHaveBeenCalled();
    expect(mocks.notice).toHaveBeenCalledOnce();
  });
});
