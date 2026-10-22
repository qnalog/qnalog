import { afterEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({
  TFile: class TFile {},
  TFolder: class TFolder {},
  Notice: class Notice { constructor(message: string) { notices.push(String(message)); } },
  normalizePath: (path: string) => path.replace(/\\/g, "/"),
}));

import { InboxWatcherService, isOutsideVaultPath } from "../src/imports/inbox-watcher-service";

function makeService(inboxFolder: string, inboxAutoImport = true) {
  const imports = { importAudioFiles: vi.fn(async () => undefined), importTextFiles: vi.fn(async () => undefined) };
  const app = { vault: { getAbstractFileByPath: vi.fn(() => null) } };
  const service = new InboxWatcherService({ app, imports, settings: { inboxFolder, inboxAutoImport } } as never);
  return { service, imports, app };
}

afterEach(() => { notices.length = 0; });

describe("watched folder is vault-only", () => {
  it("recognizes absolute paths on Windows, UNC and POSIX as outside the vault", () => {
    expect(isOutsideVaultPath("C:\\Users\\pat\\Recordings")).toBe(true);
    expect(isOutsideVaultPath("\\\\server\\share\\audio")).toBe(true);
    expect(isOutsideVaultPath("/Users/pat/Recordings")).toBe(true);
    expect(isOutsideVaultPath("QnALog/Recordings/inbox")).toBe(false);
    expect(isOutsideVaultPath("")).toBe(false);
  });

  it("warns at startup when auto-import points outside the vault", () => {
    makeService("/Users/pat/Recordings").service.warnIfWatchedFolderOutsideVault();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("outside the vault");
  });

  it("stays quiet at startup for a vault folder or when auto-import is off", () => {
    makeService("QnALog/inbox").service.warnIfWatchedFolderOutsideVault();
    makeService("/Users/pat/Recordings", false).service.warnIfWatchedFolderOutsideVault();
    expect(notices).toEqual([]);
  });

  it("does not import anything when a manual scan targets a folder outside the vault", async () => {
    const { service, imports, app } = makeService("/Users/pat/Recordings");
    await service.scanInboxFolder();
    expect(imports.importAudioFiles).not.toHaveBeenCalled();
    expect(app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
    expect(notices[0]).toContain("outside the vault");
  });
});
