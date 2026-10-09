import { describe, expect, it, vi } from "vitest";

const audioMocks = vi.hoisted(() => ({ decode: vi.fn(), mono: vi.fn(), multichannel: vi.fn() }));
vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
  Notice: class Notice {},
  requestUrl: vi.fn(async () => ({ status: 200, text: "{}" })),
}));
vi.mock("../src/asr/transcribe", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/asr/transcribe")>(),
  decodeAudioBlob: audioMocks.decode,
  renderAudioBufferSliceToWav: audioMocks.mono,
}));
vi.mock("../src/asr/channel-transcription", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/asr/channel-transcription")>(),
  renderMultichannelAudioBufferSliceToWav: audioMocks.multichannel,
}));

import * as obsidian from "obsidian";
import { QueueRetryService } from "../src/queue/queue-retry-service";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { MAX_SPEAKER_CHANNELS } from "../src/audio/channel-speakers";
import { t } from "../src/shared/i18n";
import {
  readTaskAudioBlob,
  readVaultAudioBlob,
  recoverTaskAudioBlob,
  resolveRetrySourceFile,
  type TranscribeAudioSourcePort,
  type TranscribeAudioVault,
} from "../src/queue/transcribe-audio-source";

interface TestAudioFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
}

function makeFile(path: string, extension: string): TestAudioFile {
  const name = path.split("/").pop() || "";
  return Object.assign(new obsidian.TFile(), { path, name, basename: name.replace(/\.[^.]+$/, ""), extension });
}
function setup() {
  const files = new Map<string, TestAudioFile>();
  let currentVault: TranscribeAudioVault;
  let audioFolder: string | undefined = "Audio";
  let audioChannelMode: "stereo" | "mono" = "stereo";
  const vault = {
    getAbstractFileByPath: (path: string) => files.get(path) || null,
    readBinary: vi.fn(async () => new ArrayBuffer(4)),
    getFiles: vi.fn(() => [...files.values()]),
    adapter: { exists: vi.fn(async (path: string) => path === ".cache/clip.wav" || files.has(path)), readBinary: vi.fn(async () => new ArrayBuffer(4)) },
  };
  currentVault = vault as unknown as TranscribeAudioVault;
  const diagnostics = { logDiagnostic: vi.fn(async () => undefined) };
  const port: TranscribeAudioSourcePort = {
    getVault: () => currentVault,
    getAudioFolder: () => audioFolder,
    getAudioChannelMode: () => audioChannelMode,
    decodeAudioBlob: audioMocks.decode,
    renderMonoSlice: audioMocks.mono,
    renderMultichannelSlice: audioMocks.multichannel,
    logDiagnostic: diagnostics.logDiagnostic,
  };
  const service = new QueueRetryService({ app: { vault }, settings: { audioFolder, audioChannelMode }, diagnostics } as never);
  const add = (path: string, extension = path.split(".").pop() || "") => {
    const entry = makeFile(path, extension);
    files.set(path, entry);
    return entry;
  };
  audioMocks.decode.mockReset().mockResolvedValue({ numberOfChannels: 2 });
  audioMocks.mono.mockReset().mockResolvedValue(new Blob(["mono"], { type: "audio/wav" }));
  audioMocks.multichannel.mockReset().mockReturnValue(new Blob(["multi"], { type: "audio/wav" }));
  return {
    service, files, vault, diagnostics, port, add,
    replaceVault: (next: TranscribeAudioVault) => { currentVault = next; },
    setAudioFolder: (next: string | undefined) => { audioFolder = next; },
    setAudioChannelMode: (next: "stereo" | "mono") => { audioChannelMode = next; },
  };
}

describe("queue retry audio source", () => {
  it("reads TFiles and adapter-only files, and returns null for missing paths", async () => {
    const { service, port, vault, add, replaceVault } = setup();
    const source = add("Audio/clip.MP3", "mp3");
    const direct = await service.readVaultAudioBlob(source.path, "fallback.wav");
    expect(direct).toMatchObject({ sourcePath: source.path, sourceName: source.name, recovered: false, blob: { type: "audio/mpeg" } });
    expect(vault.readBinary).toHaveBeenCalledWith(source);
    expect(await readVaultAudioBlob(port, source.path, "fallback.wav")).toMatchObject({ sourcePath: source.path, sourceName: source.name, recovered: false });
    const adapter = await service.readVaultAudioBlob(".cache/clip.wav", "chosen.wav");
    expect(adapter).toMatchObject({ sourcePath: ".cache/clip.wav", sourceName: "chosen.wav", recovered: false });
    expect(vault.adapter.readBinary).toHaveBeenCalledWith(".cache/clip.wav");
    expect(await service.readVaultAudioBlob(".cache/clip.wav", undefined)).toMatchObject({
      sourcePath: ".cache/clip.wav",
      sourceName: "clip.wav",
    });
    expect(await service.readVaultAudioBlob("", "empty")).toBeNull();
    vault.adapter.exists.mockResolvedValueOnce(false);
    expect(await service.readVaultAudioBlob("missing.wav", "missing.wav")).toBeNull();
    replaceVault({ getAbstractFileByPath: () => null, readBinary: async () => new ArrayBuffer(0), adapter: null });
    expect(await readVaultAudioBlob(port, "adapter-unavailable.wav", "adapter-unavailable.wav")).toBeNull();
  });

  it("tries explicit source paths before segment-name candidates and fallback files", () => {
    const { port, add } = setup();
    const preferred = add("Audio/preferred.wav", "wav");
    const master = add("Audio/master.m4a", "m4a");
    const task = { type: "transcribe", audioName: "qnalog-20261001-123456-seg1.wav", sourceAudioPath: "Audio/preferred.wav", masterAudioPath: "Audio/master.m4a" };
    expect(resolveRetrySourceFile(port, task as never)).toBe(preferred);
    const segment = add("Audio/qnalog-20261001-123456.m4a", "m4a");
    expect(resolveRetrySourceFile(port, { ...task, sourceAudioPath: "absent.wav" } as never)).toBe(master);
    expect(resolveRetrySourceFile(port, { ...task, sourceAudioPath: "absent.wav", masterAudioPath: "absent2.wav" } as never)).toBe(segment);
    expect(resolveRetrySourceFile(port, { type: "transcribe", audioName: "ordinary.wav" } as never)).toBeNull();
  });

  it("uses getFiles fallback for valid segment names and rejects unsupported source extensions", () => {
    const { port, add } = setup();
    const unsupported = add("Audio/bad.mp3", "txt");
    const validFallback = add("Audio/archive/qnalog-20261001-123456.m4a", "m4a");
    expect(resolveRetrySourceFile(port, { type: "transcribe", sourceAudioPath: unsupported.path, audioName: "qnalog-20261001-123456-seg2.wav" } as never)).toBe(validFallback);
    expect(resolveRetrySourceFile(port, { type: "transcribe", audioName: "qnalog-20261001-123456-seg2.wav" } as never)).toBe(validFallback);
    const defaultFolder = setup();
    defaultFolder.setAudioFolder("");
    const defaultAudio = defaultFolder.add(`${DEFAULT_SETTINGS.audioFolder}/qnalog-20261001-123456.m4a`, "m4a");
    expect(resolveRetrySourceFile(defaultFolder.port, { type: "transcribe", audioName: "qnalog-20261001-123456-seg1.wav" } as never)).toBe(defaultAudio);
    const noFiles = setup();
    noFiles.replaceVault({ getAbstractFileByPath: () => null, readBinary: async () => new ArrayBuffer(0) });
    expect(resolveRetrySourceFile(noFiles.port, { type: "transcribe", audioName: "qnalog-20261001-123456-seg1.wav" } as never)).toBeNull();
  });

  it("re-slices with offset precedence and channel policy, wrapping decode failures", async () => {
    const { port, add } = setup();
    add("Audio/qnalog-20261001-123456.m4a", "m4a");
    const base = { type: "transcribe", audioName: "qnalog-20261001-123456-seg1.wav", startOffsetMs: 10, endOffsetMs: 20, audioStartOffsetMs: 30, audioEndOffsetMs: 60, captureMode: "mic", audioChannelCount: 2, audioChannelRuntimeMode: "stereo" };
    const recovered = await recoverTaskAudioBlob(port, base as never);
    expect(recovered).toMatchObject({ recovered: true, sourceName: "qnalog-20261001-123456.m4a" });
    expect(audioMocks.multichannel).toHaveBeenCalledWith(expect.anything(), 30, 60, MAX_SPEAKER_CHANNELS);
    expect(await recoverTaskAudioBlob(port, { ...base, audioEndOffsetMs: 30 } as never)).toBeNull();
    expect(await recoverTaskAudioBlob(port, { ...base, startOffsetMs: Number.NaN, audioStartOffsetMs: undefined } as never)).toBeNull();
    
    audioMocks.decode.mockRejectedValueOnce(new Error("decode failed"));
    await expect(recoverTaskAudioBlob(port, base as never)).rejects.toThrow("decode failed");
  });

  it("returns direct audio without diagnostics, reports recovered audio, and throws for missing audio", async () => {
    const { port, diagnostics, add, replaceVault, vault } = setup();
    const clip = add("Audio/clip.wav", "wav");
    const direct = await readTaskAudioBlob(port, { type: "transcribe", audioPath: clip.path, audioName: clip.name } as never);
    expect(direct).toMatchObject({ sourcePath: clip.path, recovered: false });
    expect(diagnostics.logDiagnostic).not.toHaveBeenCalled();

    add("Audio/qnalog-20261001-123456.m4a", "m4a");
    const recovered = await readTaskAudioBlob(port, {
      type: "transcribe", audioPath: "Audio/temporary.wav", audioName: "qnalog-20261001-123456-seg1.wav", startOffsetMs: 0, endOffsetMs: 1000,
    } as never);
    expect(recovered.recovered).toBe(true);
    expect(diagnostics.logDiagnostic).toHaveBeenCalledWith(
      "warn",
      "queue.transcribe_audio_recovered",
      t("Transcription retry recovered a temporary clip from the full recording"),
      { audioName: "qnalog-20261001-123456-seg1.wav", sourceAudioName: "qnalog-20261001-123456.m4a", startOffsetMs: 0, endOffsetMs: 1000 },
    );
    const emptyVault = { ...vault, getAbstractFileByPath: () => null, getFiles: () => [] } as unknown as TranscribeAudioVault;
    replaceVault(emptyVault);
    await expect(readTaskAudioBlob(port, { type: "transcribe", audioPath: "missing.wav", audioName: "missing.wav" } as never)).rejects.toThrow("Audio missing: missing.wav");
  });

  it("reads the current vault and settings on each call through the port and retained service entry", async () => {
    const { service, port, add, replaceVault, setAudioFolder, setAudioChannelMode } = setup();
    const firstFile = add("Audio/clip.wav", "wav");
    expect((await service.readVaultAudioBlob(firstFile.path, ""))?.sourcePath).toBe(firstFile.path);
    const secondFile = add("Other/qnalog-20261001-123456.m4a", "m4a");
    replaceVault({
      getAbstractFileByPath: path => path === secondFile.path ? secondFile as never : null,
      readBinary: async () => new ArrayBuffer(1),
      getFiles: () => [secondFile as never],
      adapter: null,
    });
    setAudioFolder("Other");
    setAudioChannelMode("mono");
    expect((await service.readVaultAudioBlob(secondFile.path, ""))?.sourcePath).toBe(secondFile.path);
    expect(resolveRetrySourceFile(port, { type: "transcribe", audioName: "qnalog-20261001-123456-seg1.wav" } as never)).toBe(secondFile);
    expect(await recoverTaskAudioBlob(port, {
      type: "transcribe", audioName: "qnalog-20261001-123456-seg1.wav", startOffsetMs: 0, endOffsetMs: 1000, captureMode: "mic", audioChannelCount: 2,
    } as never)).toMatchObject({ recovered: true });
    expect(audioMocks.mono).toHaveBeenCalledWith(expect.anything(), 0, 1000);
  });
});
