import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/") }));
import { KnowledgeExtractionService } from "../src/indexing/knowledge-extraction-service";
import type { PluginSettings } from "../src/shared/types";

describe("knowledge extraction sources", () => {
  it("excludes dated errata files even when they are under the configured note root", () => {
    const source = { path: "QnALog/Notes/2026-10-14 meeting.md", stat: { mtime: 2 } };
    const errata = { path: "QnALog/勘误表/2026-10-14 meeting · 勘误.md", stat: { mtime: 1 } };
    const service = new KnowledgeExtractionService({
      app: { vault: { getMarkdownFiles: () => [source, errata] } },
      settings: { mdFolder: "QnALog", vocabularyFile: "", peopleDirectoryFolder: "" } as PluginSettings,
    });
    expect(service.getKnowledgeExtractionSourceFiles("vocabulary")).toEqual([source]);
  });
});
