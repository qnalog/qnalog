import { describe, expect, it } from "vitest";
import {
  ExternalInboxScanner,
  createExternalInboxLedger,
  isAbsoluteExternalInboxPath,
  makeExternalInboxFingerprint,
  normalizeExternalInboxLedger,
  pruneExternalInboxLedger,
  shouldImportExternalInboxFile,
  type ExternalInboxDirectoryEntry,
  type ExternalInboxFileSystem,
} from "../src/audio/external-inbox";

function makeFileSystem(files: Record<string, { size: number; mtimeMs: number }>): ExternalInboxFileSystem {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  return {
    join: (...parts) => normalize(parts.join("/")),
    async readdir(folderPath) {
      const folder = normalize(folderPath);
      const names = new Map<string, ExternalInboxDirectoryEntry>();
      for (const rawPath of Object.keys(files)) {
        const path = normalize(rawPath);
        if (!path.startsWith(folder + "/")) continue;
        const remainder = path.slice(folder.length + 1);
        const [name, ...rest] = remainder.split("/");
        if (!name) continue;
        names.set(name, {
          name,
          isFile: rest.length === 0,
          isDirectory: rest.length > 0,
        });
      }
      return Array.from(names.values());
    },
    async stat(filePath) {
      const file = files[normalize(filePath)];
      if (!file) throw new Error("missing");
      return { ...file, isFile: true };
    },
  };
}

describe("external inbox", () => {
  it("recognizes desktop absolute paths but not vault-relative paths", () => {
    expect(isAbsoluteExternalInboxPath("C:\\Users\\Lynn\\Nutstore\\Recordings")).toBe(true);
    expect(isAbsoluteExternalInboxPath("\\\\server\\share\\audio")).toBe(true);
    expect(isAbsoluteExternalInboxPath("/Users/lynn/Recordings")).toBe(true);
    expect(isAbsoluteExternalInboxPath("LexVoice/录音/inbox")).toBe(false);
  });

  it("keeps a stable fingerprint for the same source and separates different folders", () => {
    const left = makeExternalInboxFingerprint("C:/Nutstore/watch-001.m4a", 1024, 1000);
    const right = makeExternalInboxFingerprint("C:/Nutstore/watch-001.m4a", 1024, 1000);
    expect(left).toBe(right);
    expect(makeExternalInboxFingerprint("C:/Nutstore/archive/watch-001.m4a", 1024, 1000)).not.toBe(left);
    expect(makeExternalInboxFingerprint("C:/Nutstore/watch-001.m4a", 2048, 1000)).not.toBe(left);
  });

  it("finds supported audio recursively and ignores files still changing", async () => {
    const scanner = new ExternalInboxScanner();
    const fs = makeFileSystem({
      "C:/Nutstore/today.m4a": { size: 200, mtimeMs: 9_500 },
      "C:/Nutstore/archive/old.wav": { size: 300, mtimeMs: 1_000 },
      "C:/Nutstore/readme.txt": { size: 10, mtimeMs: 1_000 },
    });
    const first = await scanner.scan(fs, "C:/Nutstore", new Set(["m4a", "wav"]), {
      now: 10_000,
      quietMs: 1_000,
    });
    expect(first.ready).toEqual([]);
    expect(first.waiting.map((file) => file.name)).toEqual(["old.wav", "today.m4a"]);

    const second = await scanner.scan(fs, "C:/Nutstore", new Set(["m4a", "wav"]), {
      now: 11_000,
      quietMs: 1_000,
    });
    expect(second.ready.map((file) => file.name)).toEqual(["old.wav", "today.m4a"]);
  });

  it("does not re-import a completed fingerprint and permits manual retry", () => {
    const file = {
      fullPath: "C:/Nutstore/a.m4a",
      name: "a.m4a",
      extension: "m4a",
      size: 100,
      mtimeMs: 1000,
      fingerprint: makeExternalInboxFingerprint("a.m4a", 100, 1000),
    };
    const ledger = createExternalInboxLedger();
    expect(shouldImportExternalInboxFile(file, ledger)).toBe(true);
    ledger.entries[file.fingerprint] = {
      fingerprint: file.fingerprint,
      fullPath: file.fullPath,
      name: file.name,
      size: file.size,
      mtimeMs: file.mtimeMs,
      status: "waiting",
      attempts: 0,
      firstSeenAt: 1000,
      updatedAt: 1000,
      nextRetryAt: 5000,
      notePath: "",
      error: "",
    };
    expect(shouldImportExternalInboxFile(file, ledger, { now: 3000 })).toBe(false);
    expect(shouldImportExternalInboxFile(file, ledger, { now: 5000 })).toBe(true);
    ledger.entries[file.fingerprint] = {
      fingerprint: file.fingerprint,
      fullPath: file.fullPath,
      name: file.name,
      size: file.size,
      mtimeMs: file.mtimeMs,
      status: "imported",
      attempts: 1,
      firstSeenAt: 1000,
      updatedAt: 2000,
      nextRetryAt: 0,
      notePath: "LexVoice/转写纪要/a.md",
      error: "",
    };
    expect(shouldImportExternalInboxFile(file, ledger)).toBe(false);
    ledger.entries[file.fingerprint].status = "failed";
    ledger.entries[file.fingerprint].attempts = 3;
    expect(shouldImportExternalInboxFile(file, ledger, { now: 3000, maxAttempts: 3 })).toBe(false);
    expect(shouldImportExternalInboxFile(file, ledger, { now: 3000, maxAttempts: 3, manual: true })).toBe(true);
  });

  it("normalizes and prunes persisted ledger data", () => {
    const normalized = normalizeExternalInboxLedger({
      entries: {
        a: { fingerprint: "a", status: "imported", updatedAt: 100, name: "a.m4a" },
        broken: "value",
      },
    });
    expect(Object.keys(normalized.entries)).toEqual(["a"]);
    const pruned = pruneExternalInboxLedger(normalized, {
      now: 2 * 24 * 60 * 60 * 1000,
      maxAgeMs: 24 * 60 * 60 * 1000,
    });
    expect(pruned.entries).toEqual({});
  });
});
