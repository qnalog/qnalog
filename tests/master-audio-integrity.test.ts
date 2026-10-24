import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const notices = vi.hoisted(() => [] as string[]);
const integrityControl = vi.hoisted(() => ({ fail: false, calls: 0 }));

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
  Notice: class Notice { constructor(message: unknown) { notices.push(String(message)); } },
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

vi.mock("../src/transcript/source-integrity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/transcript/source-integrity")>();
  return {
    ...actual,
    computeSourceIntegrity: async (buffer: ArrayBuffer) => {
      integrityControl.calls++;
      if (integrityControl.fail) throw new Error("hash exploded");
      return actual.computeSourceIntegrity(buffer);
    },
  };
});

import { TFile, TFolder } from "obsidian";
import { LiveAsrPipelineService } from "../src/asr/live-asr-pipeline-service";
import type { LiveAsrPipelineHost } from "../src/asr/live-asr-pipeline-service";

const PAYLOAD = "recorded speech for integrity";

function makeService(options: { corruptReadback?: boolean } = {}) {
  const files = new Map<string, ArrayBuffer>();
  const diagnostics = { logDiagnostic: vi.fn().mockResolvedValue(undefined) };
  const discardMasterPartials = vi.fn().mockResolvedValue(undefined);
  const host = {
    getSettings: () => ({ audioFolder: "QnALog/Audio", segmentCacheFolder: "QnALog/.cache/segments" }),
    vault: {
      adapter: {
        exists: vi.fn().mockResolvedValue(false),
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeBinary: vi.fn().mockResolvedValue(undefined),
        readBinary: vi.fn(async (path: string) => {
          const data = files.get(path);
          if (!data) throw new Error(`missing ${path}`);
          const copy = new Uint8Array(data.slice(0));
          if (options.corruptReadback) copy[0] ^= 0xff;
          return copy.buffer;
        }),
        remove: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
        stat: vi.fn().mockResolvedValue(null),
      },
      createBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
        files.set(path, data.slice(0));
        return Object.assign(new TFile(), { path });
      }),
      getAbstractFileByPath: vi.fn(() => null),
      createFolder: vi.fn().mockResolvedValue(new TFolder()),
    },
    fileManager: { trashFile: vi.fn().mockResolvedValue(undefined) },
    diagnostics,
    discardMasterPartials,
  } as unknown as LiveAsrPipelineHost;
  return { service: new LiveAsrPipelineService(host), host, files, diagnostics, discardMasterPartials };
}

function makeSession() {
  return {
    id: "session-integrity",
    sessionStamp: "20261023-100000",
    mdPath: "QnALog/Minutes/a.md",
    masterAudioPath: "",
    masterAudioName: "",
    segments: [{ segmentAudioPath: "QnALog/.cache/segments/s1.webm", audioName: "s1.webm" }],
  } as Record<string, unknown> & { segments: Array<Record<string, unknown>> };
}

async function save(service: LiveAsrPipelineService, session: ReturnType<typeof makeSession>) {
  await service.saveMasterAudio(session as never, {
    masterBlob: new Blob([PAYLOAD], { type: "audio/webm" }),
    masterMime: "audio/webm",
    masterExt: "webm",
  } as never);
}

describe("saveMasterAudio integrity record", () => {
  beforeEach(() => {
    notices.length = 0;
    integrityControl.fail = false;
    integrityControl.calls = 0;
  });

  it("records SHA-256 and byte count of the read-back master recording", async () => {
    const { service, discardMasterPartials } = makeService();
    const session = makeSession();
    await save(service, session);
    const masterPath = "QnALog/Audio/qnalog-20261023-100000.webm";
    expect(session.masterAudioPath).toBe(masterPath);
    expect(discardMasterPartials).toHaveBeenCalledWith("session-integrity", masterPath, PAYLOAD.length);
    expect(session.masterAudioIntegrity).toMatchObject({
      algo: "sha256",
      sha256: createHash("sha256").update(PAYLOAD).digest("hex"),
      bytes: PAYLOAD.length,
    });
  });

  it("still saves the master, cleans partials and sets masterAudioPath when hashing throws", async () => {
    integrityControl.fail = true;
    const { service, files, diagnostics, discardMasterPartials } = makeService();
    const session = makeSession();
    await save(service, session);
    const masterPath = "QnALog/Audio/qnalog-20261023-100000.webm";
    expect(integrityControl.calls).toBe(1);
    expect(files.has(masterPath)).toBe(true);
    expect(new TextDecoder().decode(files.get(masterPath))).toBe(PAYLOAD);
    expect(discardMasterPartials).toHaveBeenCalledWith("session-integrity", masterPath, PAYLOAD.length);
    expect(session.masterAudioPath).toBe(masterPath);
    expect(session.segments[0].audioPath).toBe(masterPath);
    expect(session).not.toHaveProperty("masterAudioIntegrity");
    expect(diagnostics.logDiagnostic).toHaveBeenCalledWith("warn", "audio.integrity_record_failed", expect.any(String), expect.objectContaining({ audioPath: masterPath }));
    expect(notices.some((message) => /Failed to write the full recording/.test(message))).toBe(false);
  });

  it("still saves the master when the diagnostic log also fails", async () => {
    integrityControl.fail = true;
    const { service, diagnostics, discardMasterPartials } = makeService();
    diagnostics.logDiagnostic.mockRejectedValue(new Error("log down"));
    const session = makeSession();
    await save(service, session);
    expect(discardMasterPartials).toHaveBeenCalledOnce();
    expect(session.masterAudioPath).toBe("QnALog/Audio/qnalog-20261023-100000.webm");
  });

  it("does not hash and keeps partials when the read-back comparison fails", async () => {
    const { service, discardMasterPartials } = makeService({ corruptReadback: true });
    const session = makeSession();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await save(service, session);
    consoleError.mockRestore();
    expect(integrityControl.calls).toBe(0);
    expect(discardMasterPartials).not.toHaveBeenCalled();
    expect(session.masterAudioPath).toBe("");
    expect(session).not.toHaveProperty("masterAudioIntegrity");
  });
});
