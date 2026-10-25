// Note fixtures for the to-do summary tests: a meeting note with task lines, a transcript ledger and
// session knowledge v3, built with the production writers so the reader sees what the plugin writes.
import { parseSessionKnowledgeResponse, serializeSessionKnowledge, type SessionKnowledge } from "../../src/briefing/session-knowledge";
import { attachTranscriptResult, getCurrentTranscript, getTranscriptSourceRevision } from "../../src/transcript/session-transcript";
import { serializeTranscriptBlock } from "../../src/transcript/transcript-markdown";
import type { Segment } from "../../src/shared/types";

export const AUDIO = "QnALog/Audio/pilot.webm";
const transcriptText = "We ship the pilot on Friday. I will prepare the launch checklist. Bob sends the invite.";

export const segment: Segment = attachTranscriptResult({
  index: 0, startOffsetMs: 0, endOffsetMs: 60_000, text: transcriptText, audioPath: AUDIO, audioName: "pilot.webm",
}, "pilot-session", {
  text: transcriptText, rawText: null, providerId: "stub-asr", units: [
    { rawText: "We ship the pilot on Friday.", normalizedText: "We ship the pilot on Friday.", speakerId: "spk-1", speakerName: "Speaker 1", startMs: 4_000, endMs: 6_000, timing: "provider" },
    { rawText: "I will prepare the launch checklist.", normalizedText: "I will prepare the launch checklist.", speakerId: "spk-2", speakerName: "Speaker 2", startMs: 42_000, endMs: 44_000, timing: "audio-span" },
    { rawText: "Bob sends the invite.", normalizedText: "Bob sends the invite.", speakerId: "spk-1", speakerName: "Speaker 1", startMs: 50_000, endMs: 52_000, timing: "provider" },
  ],
}, "asr");

export const utteranceIds = getCurrentTranscript(segment.transcript!).utterances.map((item) => item.id);

export type WireAction = { text: string; evidence: string[]; owner?: string; due?: string; acceptance?: string };

export function knowledgeWith(actions: WireAction[], schemaVersion: 2 | 3 = 3): SessionKnowledge {
  const utterances = getCurrentTranscript(segment.transcript!).utterances;
  const current = getCurrentTranscript(segment.transcript!);
  const wire = {
    schemaVersion,
    topics: [{ key: "t1", title: "Pilot", summary: "Pilot launch", evidence: [utteranceIds[0]] }],
    decisions: [{ text: "Ship the pilot on Friday", evidence: [utteranceIds[0]], topics: ["t1"], status: "confirmed" }],
    actions: actions.map((item) => ({ ...item, topics: ["t1"] })),
    questions: [],
  };
  const knowledge = parseSessionKnowledgeResponse(`Body\n<!-- qnalog-session-knowledge ${JSON.stringify(wire)} -->`, {
    allowed: utterances,
    part: 1,
    sources: [{ segmentId: segment.transcript!.id, revision: current.revision, normalizationRevision: current.normalizationRevision }],
    sourceRevision: getTranscriptSourceRevision([segment]),
  }).knowledge;
  if (schemaVersion === 3) return knowledge;
  // The same knowledge as an old note stores it: schemaVersion 2 has no statuses, owners, dues or acceptance.
  const strip = ({ status: _status, supersededBy: _by, owner: _owner, due: _due, acceptance: _acceptance, ...item }: SessionKnowledge["actions"][number]) => item;
  return { ...knowledge, schemaVersion: 2, decisions: knowledge.decisions.map(strip), actions: knowledge.actions.map(strip), questions: knowledge.questions.map(strip) };
}

export const DEFAULT_ACTIONS: WireAction[] = [
  { text: "Prepare the launch checklist", evidence: [utteranceIds[1]], owner: "Speaker 2", due: "by Friday", acceptance: "assigned" },
  { text: "Send the pilot invite to the partners", evidence: [utteranceIds[2]], owner: "Bob", acceptance: "accepted" },
  { text: "Call the vendor about pricing", evidence: [utteranceIds[0]] },
];

/** Visible body lines; the tests look lines up by their text. */
export const BODY_LINES = [
  "# Pilot",
  "",
  "The team agreed to ship the pilot on Friday.",
  "",
  "- [ ] Prepare the launch checklist",
  "* [x] Send the pilot invite to the partners",
  "1. [ ] Book the review room",
  "   - [ ] Draft the review agenda",
  "> - [ ] Call the vendor about pricing",
  "- plain list item",
  "",
  "```md",
  "- [ ] Example task inside a code fence",
  "```",
  "",
  "<span data-qnalog=\"evidence-links-start\" data-qnalog-knowledge=\"k\" data-qnalog-source-revision=\"r\"></span>",
  "## Where decisions and actions were said",
  "- [ ] Task inside the evidence block",
  "<span data-qnalog=\"evidence-links-end\"></span>",
];

export function buildNote(options: { knowledge?: SessionKnowledge | null; body?: string[]; frontmatter?: string[] } = {}): string {
  const knowledge = options.knowledge === undefined ? knowledgeWith(DEFAULT_ACTIONS) : options.knowledge;
  return [
    "---",
    ...(options.frontmatter ?? ["qnalog_mode: meeting"]),
    "---",
    ...(options.body ?? BODY_LINES),
    "",
    "<!-- comment line",
    "- [ ] Task inside an HTML comment",
    "-->",
    "",
    "---",
    "",
    "## Original material",
    "",
    "<details>",
    "<summary>Segmented raw transcript (1 segments)</summary>",
    "- [ ] Task inside raw material",
    serializeTranscriptBlock(segment, "### Segment 1", transcriptText),
    "</details>",
    "",
    "- [ ] Task after the original material heading",
    "",
    knowledge ? `<details><summary>Index data</summary>${serializeSessionKnowledge(knowledge)}</details>` : "",
    "",
  ].join("\n");
}

export function lineOf(note: string, text: string): number {
  const index = note.split("\n").findIndex((line) => line.includes(text));
  if (index < 0) throw new Error(`fixture line not found: ${text}`);
  return index;
}
