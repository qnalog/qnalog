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
import { encodeAudioTimeLinkPath } from "../src/notes/audio-time-source";

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

function service(files: Array<{ path: string; name: string; basename: string; extension: string }> = [source, latest], sourceContent = "ledger", cacheFolder = "QnALog/.cache/segments", adapterPath = "QnALog/.cache/segments/hidden.wav") {
  const adapterBytes = new Uint8Array([82, 73, 70, 70]);
  const adapter = {
    exists: vi.fn(async (path: string) => path === adapterPath),
    readBinary: vi.fn(async (path: string) => path === adapterPath ? adapterBytes.buffer : new ArrayBuffer(0)),
  };
  const vault = {
    getAbstractFileByPath: (path: string) => files.find(file => file.path === path) || null,
    cachedRead: vi.fn(async () => sourceContent),
    getFiles: () => files,
    adapter,
  };
  const app = {
    vault,
    metadataCache: { getFirstLinkpathDest: (target: string) => files.find(file => file.path === target) || null },
    workspace: { getLeavesOfType: () => [{ view: { seekInlineAudio: mocks.seek } }] },
  };
  return { instance: new AudioTimeLinkService({ app, settings: { audioFolder: "Recordings", segmentCacheFolder: cacheFolder } } as never), vault, adapter, app };
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

  it("opens the exact hidden cache path through the adapter playback source", async () => {
    const { instance, adapter, app } = service([source]);
    mocks.segments = [ledgerSegment("QnALog/.cache/segments/hidden.wav", 60000, 0)];
    const context = await instance.resolveAudioTimeLinkContext("QnALog/.cache/segments/hidden.wav", "00:00", source.path);

    expect(context).toMatchObject({ file: null, playbackSource: { kind: "adapter", path: "QnALog/.cache/segments/hidden.wav" }, localMs: 0, globalMs: 60000 });
    await expect(context?.playbackSource?.kind === "adapter" ? context.playbackSource.readBinary() : Promise.reject()).resolves.toEqual(new Uint8Array([82, 73, 70, 70]).buffer);
    expect(adapter.exists).toHaveBeenCalledExactlyOnceWith("QnALog/.cache/segments/hidden.wav");
    expect(adapter.readBinary).toHaveBeenCalledExactlyOnceWith("QnALog/.cache/segments/hidden.wav");

    await instance.openAudioTimeLink("QnALog/.cache/segments/hidden.wav", "00:00", source.path);
    const modalSource = mocks.modalOpen.mock.calls.find(call => call[0] === "constructed")?.[2];
    expect(modalSource).toMatchObject({ kind: "adapter", path: "QnALog/.cache/segments/hidden.wav" });
    expect(mocks.seek).not.toHaveBeenCalled();
    expect(app).toBeDefined();
  });

  it("uses the default segment cache folder when the setting is empty", async () => {
    const { instance, adapter } = service([source], "ledger", "");
    const context = await instance.resolveAudioTimeLinkContext("QnALog/.cache/segments/hidden.wav", "00:00", source.path);
    expect(context?.playbackSource).toMatchObject({ kind: "adapter", path: "QnALog/.cache/segments/hidden.wav" });
    expect(adapter.exists).toHaveBeenCalledExactlyOnceWith("QnALog/.cache/segments/hidden.wav");
  });

  it("resolves encoded cache paths containing spaces, hash, and percent characters exactly once", async () => {
    const path = "QnALog/.cache/validation # %/segment 10%.wav";
    const { instance, adapter } = service([source], "ledger", "QnALog/.cache/validation # %", path);
    mocks.segments = [ledgerSegment(path, 60000, 0)];
    const context = await instance.resolveAudioTimeLinkContext(encodeAudioTimeLinkPath(path), "00:00", source.path);
    expect(context).toMatchObject({ file: null, playbackSource: { kind: "adapter", path }, globalMs: 60000 });
    expect(adapter.exists).toHaveBeenCalledExactlyOnceWith(path);
  });

  it("keeps indexed audio links with a time fragment working", async () => {
    const { instance } = service();
    expect(await instance.resolveAudioTimeLinkContext("latest.webm#t=10", "00:10", source.path))
      .toMatchObject({ file: latest, localMs: 10000 });
  });

  it.each([
    "/QnALog/.cache/segments/hidden.wav",
    "../QnALog/.cache/segments/hidden.wav",
    "QnALog/.cache/segments/%2e%2e/out.wav",
    "https://example.test/hidden.wav",
    "file:///QnALog/.cache/segments/hidden.wav",
  ])("rejects an unsafe audio-time path before adapter access: %s", async path => {
    const { instance, adapter } = service([source, latest]);
    expect(await instance.resolveAudioTimeLinkContext(path, "00:00", source.path)).toBeNull();
    expect(adapter.exists).not.toHaveBeenCalled();
  });
});
