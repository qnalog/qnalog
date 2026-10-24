import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 桩模型跑一遍「分部整理 → 汇总会话知识 → 写出正文」，确认原话出处区块
// 落在整理正文末尾、折叠的机器数据之前，并在原地重新整理时整块替换、不重复。

const state = vi.hoisted(() => ({ decision: "Ship the pilot on Friday", calls: 0, second: "Speaker 2" }));
vi.mock("../src/llm/core", () => ({
  callBriefingMergeLlm: vi.fn(async (_plugin: unknown, _system: string, prompt: string) => {
    state.calls += 1;
    const ids = [...prompt.matchAll(/===UTTERANCE ("[^"]+")/g)].map((match) => JSON.parse(match[1]) as string);
    const body = `## Release plan\n\nThe team agreed to ship the pilot on Friday, and ${state.second} will prepare the checklist(today).`;
    if (!prompt.includes("qnalog-session-knowledge") || !ids.length) return { text: body, finishReason: "stop", truncated: false, usage: {} };
    const wire = {
      schemaVersion: 2,
      topics: [{ key: "t1", title: "Release", summary: "Pilot release", evidence: [ids[0]] }],
      decisions: [{ text: state.decision, topics: ["t1"], evidence: [ids[0]] }],
      actions: [{ text: "Prepare the checklist", topics: ["t1"], evidence: [ids[1] || ids[0]] }],
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
import { replaceSpeakerDisplayName } from "../src/audio/channel-speakers";
import { readEvidenceLinkBlockIdentities } from "../src/briefing/evidence-links";
import { readSelectedSessionKnowledge } from "../src/briefing/session-knowledge";
import { foldNoteMachineData } from "../src/indexing/note-index";
import { buildReorganizedNote } from "../src/notes/reorganize-in-place-flow";
import { splitLeadingFrontmatter } from "../src/notes/note-document";
import { sanitizeActiveVersionBody } from "../src/versions/version-content";
import { replaceActiveVersionBlock } from "../src/versions/active-version-block";
import { attachTranscriptResult } from "../src/transcript/session-transcript";
import { serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
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

const AUDIO = "QnALog/Audio/pilot.webm";
const text = "We ship the pilot on Friday. I will prepare the checklist.";
const segment = attachTranscriptResult({
  index: 0, startOffsetMs: 0, endOffsetMs: 60_000, text, audioPath: AUDIO, audioName: "pilot.webm",
}, "pilot-session", {
  text, rawText: null, providerId: "stub-asr", units: [
    { rawText: "We ship the pilot on Friday.", normalizedText: "We ship the pilot on Friday.", speakerId: "spk-1", speakerName: "Speaker 1", startMs: 4_000, endMs: 6_000, timing: "provider" },
    { rawText: "I will prepare the checklist.", normalizedText: "I will prepare the checklist.", speakerId: "spk-2", speakerName: "Speaker 2", startMs: 42_000, endMs: 44_000, timing: "audio-span" },
  ],
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

async function organize(frontmatter: Record<string, unknown> | null = null): Promise<string> {
  const result = await mergeAndPolish(makePlugin(), [segment], "meeting", { duration: "01:00", _freshBriefing: true }, frontmatter, null);
  if (typeof result !== "string") throw new Error("pipeline produced no body");
  return result;
}

function blockCount(markdown: string): number {
  return readEvidenceLinkBlockIdentities(markdown).length;
}

describe("evidence links in the organizing pipeline", () => {
  it("places the block after the organized body and before folded machine data, then replaces it on re-organize", async () => {
    state.decision = "Ship the pilot on Friday";
    const first = await organize();
    expect(state.calls).toBeGreaterThan(0);
    const firstKnowledge = readSelectedSessionKnowledge(first);
    expect(firstKnowledge?.status).toBe("complete");
    expect(blockCount(first)).toBe(1);
    expect(readEvidenceLinkBlockIdentities(first)[0].knowledgeId).toBe(firstKnowledge?.id);
    expect(first).toContain(`— [Speaker 1] [[${AUDIO}|00:04]] “We ship the pilot on Friday.”`);
    expect(first).toContain(`— [Speaker 2] [[${AUDIO}|00:42]]`);
    expect(first).toContain("and [Speaker 2] will prepare the checklist(today).");
    expect(first).toContain(`[[${AUDIO}|00:42]] (approx.) “I will prepare the checklist.”`);
    expect(first.indexOf("The team agreed")).toBeLessThan(first.indexOf("## Where decisions and actions were said"));
    expect(first.indexOf("evidence-links-end")).toBeLessThan(first.indexOf("qnalog-session-knowledge"));

    const note = foldNoteMachineData([
      "---", "qnalog_mode: meeting", "---", "", "# Pilot", "", splitLeadingFrontmatter(first).body.trim(), "", "---", "", "## Original material", "",
      "<details>", "<summary>Segmented raw transcript (1 segments)</summary>",
      serializeTranscriptBlock(segment, "### Segment 1", text),
      "</details>", "",
    ].join("\n"));
    expect(blockCount(note)).toBe(1);
    // 可见正文不留机器注释：会话知识等注释已收进「索引数据」折叠块。
    expect(note.slice(0, note.indexOf("## Original material"))).not.toContain("<!--");
    const indexData = note.indexOf("<summary>Index data</summary>");
    expect(indexData).toBeGreaterThan(0);
    expect(note.indexOf("evidence-links-end")).toBeLessThan(note.indexOf("## Original material"));
    expect(note.indexOf("evidence-links-end")).toBeLessThan(indexData);

    state.decision = "Ship the pilot next Monday";
    const second = await organize();
    const secondKnowledge = readSelectedSessionKnowledge(second);
    expect(secondKnowledge?.id).not.toBe(firstKnowledge?.id);
    const reorganized = foldNoteMachineData(buildReorganizedNote(note, second, (value) => value));
    expect(blockCount(reorganized)).toBe(1);
    expect(readEvidenceLinkBlockIdentities(reorganized)[0].knowledgeId).toBe(secondKnowledge?.id);
    expect(reorganized).toContain("Ship the pilot next Monday");
    expect(reorganized).not.toContain("Ship the pilot on Friday —");
    expect(readSelectedSessionKnowledge(reorganized)?.id).toBe(secondKnowledge?.id);
    expect(reorganized.indexOf("evidence-links-end")).toBeLessThan(reorganized.indexOf("<summary>Index data</summary>"));
    expect(foldNoteMachineData(reorganized)).toBe(reorganized);

    // 另存为新版本与版本切换：版本正文自带区块，切换进母本后仍只有一个。
    const versionBody = sanitizeActiveVersionBody(note);
    expect(blockCount(versionBody)).toBe(1);
    const switched = replaceActiveVersionBlock(reorganized, { label: "Saved version" }, versionBody);
    expect(blockCount(switched)).toBe(1);
    expect(readEvidenceLinkBlockIdentities(switched)[0].knowledgeId).toBe(firstKnowledge?.id);
    const switchedBack = replaceActiveVersionBlock(switched, { label: "Current" }, sanitizeActiveVersionBody(reorganized));
    expect(blockCount(switchedBack)).toBe(1);
    expect(readEvidenceLinkBlockIdentities(switchedBack)[0].knowledgeId).toBe(secondKnowledge?.id);
  });

  it("re-organizing after naming writes marked names and does not repeat old prose", async () => {
    state.decision = "Ship the pilot on Friday";
    state.second = "Speaker 2";
    const first = await organize();
    const note = foldNoteMachineData([
      "---", "qnalog_mode: meeting", "---", "", "# Pilot", "", splitLeadingFrontmatter(first).body.trim(), "", "---", "", "## Original material", "",
      "<details>", "<summary>Segmented raw transcript (1 segments)</summary>",
      serializeTranscriptBlock(segment, "### Segment 1", text),
      "</details>", "",
    ].join("\n"));
    const named = replaceSpeakerDisplayName(note, "spk-2", "Alice").markdown;
    const prose = named.slice(0, named.indexOf("## Original material"));
    expect(prose).toContain("and [Alice] will prepare the checklist(today).");
    expect(prose).toContain(`— [Alice] [[${AUDIO}|00:42]]`);
    expect(prose).not.toContain("<!--");

    state.second = "Alice";
    const second = await organize({ qnalog_speakers: { "spk-2": { label: "说话人2", personName: "Alice" } } });
    const reorganized = foldNoteMachineData(buildReorganizedNote(named, second, (value) => value));
    const body = reorganized.slice(0, reorganized.indexOf("## Original material"));
    expect(body.match(/The team agreed/g)).toHaveLength(1);
    expect(body).toContain("and [Alice] will prepare the checklist(today).");
    expect(body).toContain("— [Speaker 1] [[");
    expect(body).not.toContain("<!--");
    expect(blockCount(reorganized)).toBe(1);
  });
});
