import { describe, expect, it } from "vitest";
import {
  normalizeAsrConcurrency,
  normalizeAudioInputMode,
  normalizeKnowledgeExtractionHistory,
  normalizeLlmProfiles,
  normalizePeopleContextMode,
  normalizePeopleSuggestionCache,
  normalizePeopleSuggestionIgnores,
} from "../src/shared/settings-runtime-deps";

describe("settings runtime normalizers", () => {
  it("migrates legacy audio modes and bounds ASR concurrency", () => {
    expect(normalizeAudioInputMode("mix")).toBe("mix-virtual");
    expect(normalizeAudioInputMode("system")).toBe("virtualCable");
    expect(normalizeAudioInputMode("unknown")).toBe("mic");
    expect(normalizeAsrConcurrency("8")).toBe(3);
    expect(normalizeAsrConcurrency(0)).toBe(1);
  });

  it("normalizes LLM profiles without accepting malformed entries", () => {
    expect(normalizeLlmProfiles([
      { id: "a", name: "", endpoint: " https://example.com ", apiKey: "key", model: "m" },
      { id: "a", name: "duplicate" },
      { id: 1, name: "invalid" },
      { id: "b", name: "B", endpoint: "", apiKey: "", model: "m2", asr: { providerId: "openai" } },
    ])).toEqual([
      { id: "a", name: "未命名配置", endpoint: "https://example.com", apiKey: "key", model: "m" },
      {
        id: "b",
        name: "B",
        endpoint: "",
        apiKey: "",
        model: "m2",
        asr: { providerId: "openai", endpoint: "", apiKey: "", model: "", language: "" },
      },
    ]);
  });

  it("keeps bounded people caches and safe context values", () => {
    expect(normalizePeopleContextMode("localFull")).toBe("localFull");
    expect(normalizePeopleContextMode("other")).toBe("privacy");
    expect(normalizePeopleSuggestionIgnores(["name", null, { key: "a" }])).toEqual(["name", { key: "a" }]);
    expect(normalizePeopleSuggestionCache({ pending: [null, { key: "a" }] })).toEqual({ pending: [{ key: "a" }] });
  });

  it("normalizes extraction history and legacy numeric records", () => {
    expect(normalizeKnowledgeExtractionHistory({
      vocabulary: { "folder\\note.md": { mtime: "12", size: 3, scannedAt: "now" } },
      people: { "people/person.md": 9 },
    })).toEqual({
      vocabulary: { "folder/note.md": { mtime: 12, size: 3, scannedAt: "now" } },
      people: { "people/person.md": { mtime: 9, size: 0, scannedAt: "" } },
    });
  });
});
