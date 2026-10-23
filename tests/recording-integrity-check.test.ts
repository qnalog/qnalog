import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("obsidian", () => ({
  TFile: class TFile {},
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""),
}));

import { attachTranscriptResult } from "../src/transcript/session-transcript";
import { serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
import type { SourceIntegrity } from "../src/transcript/source-integrity";
import {
  INTEGRITY_CHECK_MAX_BYTES,
  IntegrityRecordAvailability,
  createAdapterIntegrityReadPort,
  formatIntegrityReport,
  listRecordedSources,
  runRecordingIntegrityCheck,
} from "../src/audio/recording-integrity";
import type { Segment } from "../src/shared/types";

const NOTE = "QnALog/Minutes/meeting.md";
const AUDIO = "QnALog/Audio/qnalog-20261023-100000.webm";
const AUDIO_BYTES = new TextEncoder().encode("the original recording bytes");

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function integrityOf(bytes: Uint8Array): SourceIntegrity {
  return { algo: "sha256", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, at: "2026-10-23T10:00:00.000Z" };
}

function segmentFor(index: number, path: string, integrity: SourceIntegrity | null): Segment {
  return attachTranscriptResult({
    index,
    startOffsetMs: index * 1000,
    endOffsetMs: (index + 1) * 1000,
    audioPath: path,
    audioName: path.split("/").pop(),
    text: `Line ${index}.`,
  }, "session-1", {
    text: `Line ${index}.`, rawText: `Line ${index}.`, providerId: "test",
    units: [{ rawText: `Line ${index}.`, normalizedText: `Line ${index}.`, speakerId: null, speakerName: null, startMs: null, endMs: null, timing: "unknown" }],
  } as never, "asr", integrity);
}

function noteWith(segments: Segment[]): string {
  return ["# Meeting", ...segments.map((segment, index) => serializeTranscriptBlock(segment, `### Segment ${index + 1}`, String(segment.text || "")))].join("\n\n");
}

/** Fake vault adapter: provides read methods and records every call, including write/delete methods that must never run. */
function makeAdapter(files: Map<string, Uint8Array | string>, options: { statSize?: number; readBinaryError?: boolean } = {}) {
  const calls: string[] = [];
  const forbidden = ["write", "writeBinary", "append", "process", "remove", "rmdir", "trashSystem", "trashLocal", "rename", "copy", "mkdir"];
  const adapter: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    read: async (path) => {
      calls.push(`read:${String(path)}`);
      const value = files.get(String(path));
      if (typeof value !== "string") throw new Error("missing note");
      return value;
    },
    stat: async (path) => {
      calls.push(`stat:${String(path)}`);
      const value = files.get(String(path));
      if (value === undefined) return null;
      return { type: "file", size: options.statSize ?? (typeof value === "string" ? value.length : value.byteLength), mtime: 1, ctime: 1 };
    },
    readBinary: async (path) => {
      calls.push(`readBinary:${String(path)}`);
      if (options.readBinaryError) throw new Error("io error");
      const value = files.get(String(path));
      if (!(value instanceof Uint8Array)) throw new Error("missing audio");
      return bufferOf(value);
    },
  };
  for (const name of forbidden) adapter[name] = async () => { calls.push(`FORBIDDEN:${name}`); };
  return { adapter, calls };
}

async function runCheck(files: Map<string, Uint8Array | string>, options: { statSize?: number; readBinaryError?: boolean } = {}) {
  const { adapter, calls } = makeAdapter(files, options);
  const snapshot = new Map([...files].map(([path, value]) => [path, typeof value === "string" ? value : value.slice()]));
  const messages: string[] = [];
  const items = await runRecordingIntegrityCheck({
    ...createAdapterIntegrityReadPort(adapter as never),
    notify: (message) => { messages.push(message); },
  }, NOTE);
  expect(calls.filter((call) => call.startsWith("FORBIDDEN"))).toEqual([]);
  expect([...files.keys()].sort()).toEqual([...snapshot.keys()].sort());
  for (const [path, value] of files) expect(value).toEqual(snapshot.get(path));
  return { items, messages, calls };
}

describe("recording integrity check", () => {
  it("reports a match when the file is unchanged", async () => {
    const files = new Map<string, Uint8Array | string>([[NOTE, noteWith([segmentFor(0, AUDIO, integrityOf(AUDIO_BYTES))])], [AUDIO, AUDIO_BYTES]]);
    const { items, messages } = await runCheck(files);
    expect(items.map((item) => item.status)).toEqual(["match"]);
    expect(messages.at(-1)).toContain("matches the record");
    expect(messages.at(-1)).toContain("No files were changed.");
  });

  it("reports a difference when the content changed but the size did not", async () => {
    const changed = AUDIO_BYTES.slice();
    changed[3] ^= 0x01;
    const files = new Map<string, Uint8Array | string>([[NOTE, noteWith([segmentFor(0, AUDIO, integrityOf(AUDIO_BYTES))])], [AUDIO, changed]]);
    const { items, messages, calls } = await runCheck(files);
    expect(items.map((item) => item.status)).toEqual(["differs"]);
    expect(calls).toContain(`readBinary:${AUDIO}`);
    expect(messages.at(-1)).toContain("the file differs from when it was recorded");
    expect(messages.join("\n")).not.toMatch(/tamper/i);
  });

  it("reports a difference from the size alone without reading the file", async () => {
    const files = new Map<string, Uint8Array | string>([[NOTE, noteWith([segmentFor(0, AUDIO, integrityOf(AUDIO_BYTES))])], [AUDIO, new Uint8Array(5)]]);
    const { items, calls } = await runCheck(files);
    expect(items.map((item) => item.status)).toEqual(["differs"]);
    expect(calls).not.toContain(`readBinary:${AUDIO}`);
  });

  it("reports a missing file", async () => {
    const files = new Map<string, Uint8Array | string>([[NOTE, noteWith([segmentFor(0, AUDIO, integrityOf(AUDIO_BYTES))])]]);
    const { items, messages } = await runCheck(files);
    expect(items.map((item) => item.status)).toEqual(["missing"]);
    expect(messages.at(-1)).toContain("file not found");
  });

  it("does not read files larger than 256 MiB", async () => {
    const files = new Map<string, Uint8Array | string>([[NOTE, noteWith([segmentFor(0, AUDIO, integrityOf(AUDIO_BYTES))])], [AUDIO, AUDIO_BYTES]]);
    const { items, calls, messages } = await runCheck(files, { statSize: INTEGRITY_CHECK_MAX_BYTES + 1 });
    expect(items.map((item) => item.status)).toEqual(["too-large"]);
    expect(calls).not.toContain(`readBinary:${AUDIO}`);
    expect(messages.at(-1)).toContain("not checked");
  });

  it("reports a read failure", async () => {
    const files = new Map<string, Uint8Array | string>([[NOTE, noteWith([segmentFor(0, AUDIO, integrityOf(AUDIO_BYTES))])], [AUDIO, AUDIO_BYTES]]);
    const { items } = await runCheck(files, { readBinaryError: true });
    expect(items.map((item) => item.status)).toEqual(["read-failed"]);
  });

  it("reports no record for an old note", async () => {
    const files = new Map<string, Uint8Array | string>([[NOTE, noteWith([segmentFor(0, AUDIO, null)])], [AUDIO, AUDIO_BYTES]]);
    const { items, messages, calls } = await runCheck(files);
    expect(items).toEqual([]);
    expect(messages.at(-1)).toBe("This note has no recording checksum record.");
    expect(calls).toEqual([`read:${NOTE}`]);
  });

  it("reports when the note itself cannot be read", async () => {
    const { items, messages } = await runCheck(new Map());
    expect(items).toEqual([]);
    expect(messages.at(-1)).toContain("recording integrity was not checked");
  });

  it("lists each recorded file once and checks several files in one note", async () => {
    const second = "QnALog/Import/clip.wav";
    const secondBytes = new Uint8Array([9, 8, 7]);
    const markdown = noteWith([
      segmentFor(0, AUDIO, integrityOf(AUDIO_BYTES)),
      segmentFor(1, AUDIO, integrityOf(AUDIO_BYTES)),
      segmentFor(2, second, integrityOf(secondBytes)),
    ]);
    expect(listRecordedSources(markdown).map((source) => source.path)).toEqual([AUDIO, second]);
    const files = new Map<string, Uint8Array | string>([[NOTE, markdown], [AUDIO, AUDIO_BYTES]]);
    const { items } = await runCheck(files);
    expect(items.map((item) => [item.path, item.status])).toEqual([[AUDIO, "match"], [second, "missing"]]);
  });

  it("formats an empty report as no record", () => {
    expect(formatIntegrityReport([])).toBe("This note has no recording checksum record.");
  });
});

describe("IntegrityRecordAvailability", () => {
  it("returns unknown until refreshed, then caches by modification time", async () => {
    const readNote = vi.fn(async () => noteWith([segmentFor(0, AUDIO, integrityOf(AUDIO_BYTES))]));
    const availability = new IntegrityRecordAvailability(readNote);
    expect(availability.get(NOTE, 1)).toBeUndefined();
    expect(availability.availableNow(NOTE, 1)).toBe(false);
    await vi.waitFor(() => expect(availability.get(NOTE, 1)).toBe(true));
    expect(availability.availableNow(NOTE, 1)).toBe(true);
    expect(availability.get(NOTE, 2)).toBeUndefined();
    expect(readNote).toHaveBeenCalledOnce();
  });

  it("treats notes without a record or unreadable notes as unavailable", async () => {
    const availability = new IntegrityRecordAvailability(async (path) => {
      if (path === "broken.md") throw new Error("io");
      return noteWith([segmentFor(0, AUDIO, null)]);
    });
    expect(await availability.refresh("old.md", 1)).toBe(false);
    expect(await availability.refresh("broken.md", 1)).toBe(false);
  });

  it("keeps at most the configured number of entries", async () => {
    const availability = new IntegrityRecordAvailability(async () => "", 2);
    await availability.refresh("a.md", 1);
    await availability.refresh("b.md", 1);
    await availability.refresh("c.md", 1);
    expect(availability.get("a.md", 1)).toBeUndefined();
    expect(availability.get("c.md", 1)).toBe(false);
  });
});
