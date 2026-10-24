import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  parseYaml: () => ({}),
  Notice: class Notice {},
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import {
  buildEvidenceLinksBlock,
  placeEvidenceLinkBlock,
  readEvidenceLinkBlockIdentities,
  stripEvidenceLinkBlocks,
} from "../src/briefing/evidence-links";
import { mergeSessionKnowledge, parseSessionKnowledgeResponse, type SessionKnowledge } from "../src/briefing/session-knowledge";
import { attachTextTranscript, attachTranscriptResult, getCurrentTranscript, getTranscriptSourceRevision } from "../src/transcript/session-transcript";
import type { AsrTranscriptUnit } from "../src/asr/transcript-result";
import type { Segment } from "../src/shared/types";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { isTimeLabel } from "../src/notes/note-markdown";
import { replaceSpeakerDisplayName } from "../src/audio/channel-speakers";

const AUDIO = "QnALog/Audio/session-a.webm";
const previousLanguage = getActiveUiLanguage();
beforeAll(() => setActiveUiLanguage(resolveUiLanguage("en", "en")));
afterAll(() => setActiveUiLanguage(previousLanguage));

function unit(text: string, startMs: number | null, timing: AsrTranscriptUnit["timing"], speaker = "Speaker 1"): AsrTranscriptUnit {
  return {
    rawText: text, normalizedText: text, speakerId: speaker ? "spk-1" : null, speakerName: speaker || null,
    startMs, endMs: startMs === null ? null : startMs + 1500, timing,
  };
}

/** A recorded segment whose clip is the whole session audio, so ledger times are audio-local. */
function recorded(units: AsrTranscriptUnit[], index = 0, sourceId = "session-a", extra: Partial<Segment> = {}): Segment {
  const text = units.map((item) => item.rawText).join(" ");
  return attachTranscriptResult({
    index, startOffsetMs: 0, endOffsetMs: 600_000, text, audioPath: AUDIO, audioName: "session-a.webm", ...extra,
  }, sourceId, { text, rawText: null, providerId: "test-asr", units }, "asr");
}

type WireItem = { text: string; evidence: string[] };
function knowledgeFor(segments: Segment[], decisions: WireItem[], actions: WireItem[] = [], part = 1): SessionKnowledge {
  const utterances = segments.flatMap((segment) => getCurrentTranscript(segment.transcript!).utterances);
  const sources = segments.map((segment) => {
    const current = getCurrentTranscript(segment.transcript!);
    return { segmentId: segment.transcript!.id, revision: current.revision, normalizationRevision: current.normalizationRevision };
  });
  const evidence = utterances[0].id;
  const wire = {
    schemaVersion: 2,
    topics: [{ key: "t1", title: "Release", summary: "Release plan", evidence: [evidence] }],
    decisions: decisions.map((item) => ({ ...item, topics: ["t1"] })),
    actions: actions.map((item) => ({ ...item, topics: ["t1"] })),
    questions: [],
  };
  return parseSessionKnowledgeResponse(`Body\n<!-- qnalog-session-knowledge ${JSON.stringify(wire)} -->`, {
    allowed: utterances, part, sources, sourceRevision: getTranscriptSourceRevision(segments),
  }).knowledge;
}
/** The same knowledge as an old note stores it (schemaVersion 2: no statuses, owners or acceptance). */
function v2(knowledge: SessionKnowledge): SessionKnowledge {
  const strip = ({ status: _status, supersededBy: _by, owner: _owner, due: _due, acceptance: _acceptance, ...item }: SessionKnowledge["decisions"][number]) => item;
  return { ...knowledge, schemaVersion: 2, decisions: knowledge.decisions.map(strip), actions: knowledge.actions.map(strip), questions: knowledge.questions.map(strip) };
}
function ids(segment: Segment): string[] {
  return getCurrentTranscript(segment.transcript!).utterances.map((item) => item.id);
}
function linkLabels(block: string): string[] {
  return [...block.matchAll(/\[\[[^\]|]+\|([^\]]+)\]\]/g)].map((match) => match[1]);
}

describe("decision and action evidence links", () => {
  it("links provider-timed evidence to the audio-local second without a precision suffix", () => {
    const segment = recorded([unit("We will ship the pilot on Friday.", 12_400, "provider"), unit("Fine.", 30_000, "provider", "Speaker 2")]);
    const [first] = ids(segment);
    const block = buildEvidenceLinksBlock(v2(knowledgeFor([segment], [{ text: "Ship the pilot on Friday", evidence: [first] }])), [segment]);
    expect(block).toContain("## Where decisions and actions were said");
    expect(block).toContain("The AI model chose these sources from the transcript. Click a time to listen and check.");
    const line = block.split("\n").find((entry) => entry.startsWith("- **Decision**"));
    expect(line).toBe(`- **Decision**: Ship the pilot on Friday — Speaker 1 [[${AUDIO}|00:12]] “We will ship the pilot on Friday.”`);
    expect(linkLabels(block).every((label) => isTimeLabel(label))).toBe(true);
  });

  it("marks audio-span and segment precision outside the link and omits links for unknown time", () => {
    const span = recorded([unit("Roughly here.", 65_000, "audio-span")]);
    const segmentTimed = recorded([unit("Somewhere in this part.", null, "unknown")], 0, "session-b", { audioStartOffsetMs: 120_000, audioEndOffsetMs: 180_000 });
    const textOnly = attachTextTranscript({ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "Typed note." }, "typed", "text-import");

    const spanBlock = buildEvidenceLinksBlock(knowledgeFor([span], [{ text: "Span", evidence: ids(span) }]), [span]);
    expect(spanBlock).toContain(`[[${AUDIO}|01:05]] (approx.) “Roughly here.”`);

    expect(getCurrentTranscript(segmentTimed.transcript!).utterances[0].audioRef?.precision).toBe("segment");
    const segmentBlock = buildEvidenceLinksBlock(knowledgeFor([segmentTimed], [{ text: "Segment", evidence: ids(segmentTimed) }]), [segmentTimed]);
    expect(segmentBlock).toContain(`[[${AUDIO}|02:00]] (approximately in this segment) “Somewhere in this part.”`);

    expect(getCurrentTranscript(textOnly.transcript!).utterances[0].audioRef).toBeNull();
    const unknownBlock = buildEvidenceLinksBlock(v2(knowledgeFor([textOnly], [], [{ text: "Write it down", evidence: ids(textOnly) }])), [textOnly]);
    expect(unknownBlock).toContain("- **Action item**: Write it down — (time unknown) “Typed note.”");
    expect(unknownBlock).not.toContain("[[");
  });

  it("renders nothing for knowledge that is not complete, stale against the ledger, or empty", () => {
    const segment = recorded([unit("Decide now.", 1000, "provider")]);
    const knowledge = knowledgeFor([segment], [{ text: "Decide", evidence: ids(segment) }]);
    expect(buildEvidenceLinksBlock(knowledge, [segment])).not.toBe("");
    for (const status of ["partial", "unavailable", "stale"] as const) {
      expect(buildEvidenceLinksBlock({ ...knowledge, status }, [segment])).toBe("");
    }
    expect(buildEvidenceLinksBlock(null, [segment])).toBe("");
    const edited = attachTextTranscript({ ...segment, text: "Edited text.", rawText: undefined }, segment.transcript!.sourceId, "edited-transcript");
    expect(buildEvidenceLinksBlock(knowledge, [edited])).toBe("");
    expect(buildEvidenceLinksBlock({ ...knowledge, decisions: [], actions: [] }, [segment])).toBe("");
  });

  it("renders nothing for an old note whose segments have no utterance ledger", () => {
    const segment = recorded([unit("Decide now.", 1000, "provider")]);
    const knowledge = knowledgeFor([segment], [{ text: "Decide", evidence: ids(segment) }]);
    const legacy: Segment = { index: 0, startOffsetMs: 0, endOffsetMs: 1000, text: "Decide now.", audioPath: AUDIO };
    expect(buildEvidenceLinksBlock({ ...knowledge, sources: [], sourceRevision: getTranscriptSourceRevision([legacy]) }, [legacy])).toBe("");
  });

  it("shows at most three sources per item and counts the rest", () => {
    const segment = recorded([0, 10, 20, 30, 40].map((second) => unit(`Point at ${second}.`, second * 1000, "provider")));
    const block = buildEvidenceLinksBlock(knowledgeFor([segment], [{ text: "Many sources", evidence: ids(segment) }]), [segment]);
    expect(linkLabels(block)).toEqual(["00:00", "00:10", "00:20"]);
    expect(block).toMatch(/· \+2 more$/m);
  });

  it("merges items with identical text from different parts into one line", () => {
    const first = recorded([unit("Ship it.", 5000, "provider")], 0, "part-1");
    const second = recorded([unit("Yes, ship it.", 7000, "provider", "Speaker 2")], 1, "part-2");
    const segments = [first, second];
    const partOne = v2(knowledgeFor(segments, [{ text: "Ship it", evidence: ids(first) }], [], 1));
    const partTwo = v2(knowledgeFor(segments, [{ text: " Ship  it ", evidence: ids(second) }], [], 2));
    const merged = mergeSessionKnowledge([partOne, partTwo], segments);
    expect(merged.status).toBe("complete");
    expect(merged.decisions).toHaveLength(2);
    const block = buildEvidenceLinksBlock(merged, segments);
    const lines = block.split("\n").filter((line) => line.startsWith("- **Decision**"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("“Ship it.”");
    expect(lines[0]).toContain("“Yes, ship it.”");
  });

  it("clips quotes to forty characters and keeps transcript text from opening links or comments", () => {
    const long = "This sentence is deliberately long so that it needs clipping in the block [[x]] --> end.";
    const segment = recorded([unit(long, 2000, "provider")]);
    const block = buildEvidenceLinksBlock(knowledgeFor([segment], [{ text: "Clip [[target]]", evidence: ids(segment) }]), [segment]);
    const quote = /“([^”]*)”/.exec(block)?.[1] || "";
    expect(Array.from(quote)).toHaveLength(40);
    expect(quote.endsWith("…")).toBe(true);
    expect(block).not.toContain("[[target]]");
    expect(block).not.toContain("<!--");
    expect(block).not.toContain("-->");
  });

  it("uses Chinese labels and writes numbered speakers as plain text that the rename path rewrites", () => {
    setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
    try {
      const segment = recorded([unit("那就周五上线。", 3000, "audio-span", "说话人2")]);
      const block = buildEvidenceLinksBlock(v2(knowledgeFor([segment], [{ text: "周五上线", evidence: ids(segment) }])), [segment]);
      expect(block).toContain("## 决定与待办的原话出处");
      expect(block).toContain(`- **决定**：周五上线 — 说话人2 [[${AUDIO}|00:03]]（约） 「那就周五上线。」`);
      const renamed = replaceSpeakerDisplayName(`# Note\n\n${block}\n`, "spk-2", "王五");
      expect(renamed.markdown).toContain(`— 『王五』 [[${AUDIO}|00:03]]（约）`);
      expect(renamed.markdown).not.toContain("<!--");
      expect(renamed.markdown).not.toContain("说话人2");
    } finally {
      setActiveUiLanguage(resolveUiLanguage("en", "en"));
    }
  });

  it("identifies blocks by knowledge id and replaces or removes them as a whole", () => {
    const segment = recorded([unit("Decide now.", 1000, "provider")]);
    const oldKnowledge = knowledgeFor([segment], [{ text: "Old", evidence: ids(segment) }]);
    const newKnowledge = knowledgeFor([segment], [{ text: "New", evidence: ids(segment) }]);
    const oldBlock = buildEvidenceLinksBlock(oldKnowledge, [segment]);
    const newBlock = buildEvidenceLinksBlock(newKnowledge, [segment]);
    expect(readEvidenceLinkBlockIdentities(oldBlock)).toEqual([{ knowledgeId: oldKnowledge.id, sourceRevision: oldKnowledge.sourceRevision }]);

    const body = placeEvidenceLinkBlock("## Notes\n\nBody text.", oldBlock);
    const replaced = placeEvidenceLinkBlock(body, newBlock);
    expect(readEvidenceLinkBlockIdentities(replaced).map((item) => item.knowledgeId)).toEqual([newKnowledge.id]);
    expect(replaced.startsWith("## Notes\n\nBody text.\n\n")).toBe(true);
    expect(placeEvidenceLinkBlock(replaced, "")).toBe("## Notes\n\nBody text.");
    expect(placeEvidenceLinkBlock("Body\n\n\n\nkept spacing\n", "")).toBe("Body\n\n\n\nkept spacing\n");

    const doubled = `${newBlock}\n\nMiddle\n\n${oldBlock}\n`;
    expect(stripEvidenceLinkBlocks(doubled).trim()).toBe("Middle");
  });
});
