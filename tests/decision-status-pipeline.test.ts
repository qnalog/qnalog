import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 桩模型跑一遍整理流程：模型按 v3 协议返回五种决定状态与待办的负责人、期限、接下情况，
// 确认会话知识保存为 v3、状态只出现在原话出处区块、负责人名字带说话人提及标记。

const state = vi.hoisted(() => ({ prompts: [] as string[] }));
vi.mock("../src/llm/core", () => ({
  callBriefingMergeLlm: vi.fn(async (_plugin: unknown, _system: string, prompt: string) => {
    state.prompts.push(prompt);
    const ids = [...prompt.matchAll(/===UTTERANCE ("[^"]+")/g)].map((match) => JSON.parse(match[1]) as string);
    const body = "## Release\n\nThe team moved the release from Friday to Monday; Alice will write the release notes.";
    if (!prompt.includes("qnalog-session-knowledge") || ids.length < 9) return { text: body, finishReason: "stop", truncated: false, usage: {} };
    const wire = {
      schemaVersion: 3,
      topics: [{ key: "t1", title: "Release", summary: "Release date", evidence: [ids[0]] }],
      decisions: [
        { key: "fri", text: "Ship on Friday", status: "superseded", supersededBy: "mon", topics: ["t1"], evidence: [ids[0], ids[1]] },
        { key: "dark", text: "Add dark mode", status: "disputed", topics: ["t1"], evidence: [ids[2], ids[3]] },
        { key: "price", text: "Decide pricing", status: "open", topics: ["t1"], evidence: [ids[4]] },
        { key: "mon", text: "Ship on Monday", status: "confirmed", topics: ["t1"], evidence: [ids[5], ids[6]] },
        { key: "beta", text: "Run a beta", status: "proposed", topics: ["t1"], evidence: [ids[2]] },
      ],
      actions: [{ text: "Write the release notes", owner: "Alice", due: "by Thursday", acceptance: "assigned", topics: ["t1"], evidence: [ids[7]] }],
      questions: [],
    };
    return { text: `${body}\n<!-- qnalog-session-knowledge ${JSON.stringify(wire)} -->`, finishReason: "stop", truncated: false, usage: {} };
  }),
  stripModeSuggestionBlocks: (text: string) => text,
  callLlm: vi.fn(async () => ""),
  logLlmRequestDiagnostic: vi.fn(async () => undefined),
}));
vi.mock("../src/people", () => ({
  buildPeopleContextForLlm: vi.fn(async () => ""),
  getPeopleNameHotwordTerms: vi.fn(() => []),
  loadPeopleDirectory: vi.fn(async () => []),
}));
vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  parseYaml: () => ({}),
  stringifyYaml: () => "",
  Notice: class Notice {},
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import { mergeAndPolish } from "../src/briefing/merge-pipeline";
import { readSelectedSessionKnowledge } from "../src/briefing/session-knowledge";
import { attachTranscriptResult } from "../src/transcript/session-transcript";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

const previousLanguage = getActiveUiLanguage();
beforeAll(() => {
  setActiveUiLanguage(resolveUiLanguage("en", "en"));
  vi.stubGlobal("window", { moment: undefined });
});
afterAll(() => {
  setActiveUiLanguage(previousLanguage);
  vi.unstubAllGlobals();
});

const AUDIO = "QnALog/Audio/release.webm";
const lines = [
  ["Let's ship on Friday.", "spk-1", "Bob"],
  ["Agreed, Friday.", "spk-2", "Alice"],
  ["Maybe dark mode too.", "spk-1", "Bob"],
  ["No, dark mode is risky.", "spk-2", "Alice"],
  ["Pricing we decide next week.", "spk-1", "Bob"],
  ["Actually make it Monday.", "spk-1", "Bob"],
  ["Fine, Monday.", "spk-2", "Alice"],
  ["Alice, write the release notes by Thursday.", "spk-1", "Bob"],
  ["Noted.", "spk-2", "Alice"],
] as const;
const text = lines.map(([line]) => line).join(" ");
const segment = attachTranscriptResult({
  index: 0, startOffsetMs: 0, endOffsetMs: 60_000, text, audioPath: AUDIO, audioName: "release.webm",
}, "release-session", {
  text, rawText: null, providerId: "stub-asr",
  units: lines.map(([line, speakerId, speakerName], index) => ({
    rawText: line, normalizedText: line, speakerId, speakerName, startMs: (index + 1) * 2000, endMs: (index + 1) * 2000 + 1500, timing: "provider" as const,
  })),
}, "asr");

function makePlugin() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const adapter = {
    exists: async (path: string) => files.has(path) || folders.has(path),
    mkdir: async (path: string) => { folders.add(path); },
    write: async (path: string, value: string) => { files.set(path, value); },
    read: async (path: string) => { const value = files.get(path); if (value === undefined) throw new Error("missing"); return value; },
    remove: async (path: string) => { files.delete(path); },
    rename: async () => undefined,
  };
  return {
    settings: { llmModel: "stub-model", briefingStructureLevel: "balanced", briefingTranslationMode: "off", activeTemplateByMode: {}, promptTemplates: {} },
    manifest: { id: "qnalog" },
    app: { vault: { adapter, configDir: ".obsidian" } },
    getCurrentSession: () => null,
  };
}

describe("status-tagged decisions in the organizing pipeline", () => {
  it("asks for schemaVersion 3, stores all five statuses, and shows them only in the evidence block", async () => {
    const result = await mergeAndPolish(makePlugin(), [segment], "meeting", { duration: "01:00", _freshBriefing: true }, null, null);
    if (typeof result !== "string") throw new Error("pipeline produced no body");
    const protocolPrompt = state.prompts.find((prompt) => prompt.includes("qnalog-session-knowledge")) || "";
    expect(protocolPrompt).toContain("schemaVersion:3");
    expect(protocolPrompt).toContain("superseded=");
    expect(protocolPrompt).toContain("volunteered=");

    const knowledge = readSelectedSessionKnowledge(result);
    expect(knowledge?.schemaVersion).toBe(3);
    expect(knowledge?.status).toBe("complete");
    expect(knowledge?.issues).toEqual([]);
    expect(knowledge?.decisions.map((item) => item.status).sort()).toEqual(["confirmed", "disputed", "open", "proposed", "superseded"]);
    const monday = knowledge?.decisions.find((item) => item.text === "Ship on Monday");
    expect(knowledge?.decisions.find((item) => item.status === "superseded")?.supersededBy).toBe(monday?.id);

    const heading = result.indexOf("## Where decisions and actions were said");
    expect(heading).toBeGreaterThan(0);
    const prose = result.slice(0, heading);
    expect(prose).not.toMatch(/confirmed|superseded|disputed/);
    const rows = result.slice(heading).split("\n").filter((line) => line.startsWith("- **"));
    expect(rows.map((row) => /^- \*\*([^*]+)\*\*/.exec(row)?.[1])).toEqual([
      "Decision (confirmed)", "Decision (proposed)", "Decision (disputed)", "Decision (open)", "Decision (superseded)", "Action item",
    ]);
    expect(rows[4]).toContain("Ship on Friday → see: Ship on Monday — [Bob]");
    expect(rows[5]).toContain("Write the release notes · Owner: [Alice] · Due: by Thursday · not explicitly accepted — [Bob]");
  });
});
