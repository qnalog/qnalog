import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  TFile: class TFile { path = ""; },
}));

import * as obsidian from "obsidian";
import { ErrataService } from "../src/errata/errata-service";
import { ErrataStore, type ErrataStorePort } from "../src/errata/errata-store";

describe("errata service source resolution", () => {
  it("logs a diagnostic without errata content when a derived note source is missing", async () => {
    const file = Object.assign(new obsidian.TFile(), { path: "QnALog/Derived/copy.md" });
    const storePort: ErrataStorePort = {
      read: vi.fn(async () => ""), listErrataFiles: () => [], getByPath: () => null,
      getLinks: () => [], resolveLink: () => null, ensureFolder: vi.fn(async () => undefined),
      create: vi.fn(async () => { throw new Error("not reached"); }), process: vi.fn(async () => undefined),
    };
    const logDiagnostic = vi.fn(async () => undefined);
    const service = new ErrataService(new ErrataStore(storePort), {
      getFrontmatter: () => ({ qnalog_type: "QnALog派生版本", qnalog_source_path: "QnALog/Missing/source.md" }),
      getByPath: () => null,
      logDiagnostic,
      notify: vi.fn(),
    });

    expect(await service.loadForFile(file)).toBeNull();
    expect(logDiagnostic).toHaveBeenCalledWith(
      "warn",
      "errata.source_missing",
      expect.any(String),
      { filePath: file.path, sourcePath: "QnALog/Missing/source.md" },
    );
    expect(storePort.read).not.toHaveBeenCalled();
  });
});
