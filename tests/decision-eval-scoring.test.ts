import { describe, expect, it } from "vitest";
import {
  compact,
  diceSimilarity,
  dueMatches,
  formatDecisionEvalReport,
  matchItems,
  overlapSimilarity,
  ownerMatches,
  scoreDecisionEval,
  speakerLabelMap,
  type AnswerKey,
  type RunOutput,
} from "../scripts/decision-eval/scoring";
import type { KnowledgeItem, SessionKnowledge } from "../src/briefing/session-knowledge";

// 小型自拟样例：一场三人短会，两处决定（其中一处被改口替代）、一个未定问题与两条待办。

const dialogue = {
  utterances: [
    { speaker: "Ann", text: "Let's launch on the third." },
    { speaker: "Ben", text: "The third clashes with the audit, move it to the fifth." },
    { speaker: "Ann", text: "Agreed, launch on the fifth." },
    { speaker: "Cai", text: "Pricing we will decide next week." },
    { speaker: "Ann", text: "Ben, please draft the release notes by Friday." },
    { speaker: "Ben", text: "Sure, I will." },
  ],
};

const key: AnswerKey = {
  title: "Fixture",
  decisions: [
    { id: "third", text: "Launch on the third", status: "superseded", supersededBy: "fifth", reference: [dialogue.utterances[0].text] },
    { id: "fifth", text: "Launch on the fifth", status: "confirmed", reference: [dialogue.utterances[1].text, dialogue.utterances[2].text] },
    { id: "pricing", text: "Decide pricing next week", status: "open", reference: [dialogue.utterances[3].text] },
  ],
  actions: [
    { id: "notes", text: "Draft the release notes", owner: ["Ben"], due: "by Friday", acceptance: "accepted", reference: [dialogue.utterances[4].text, dialogue.utterances[5].text] },
    { id: "audit", text: "Book the audit room", owner: ["Cai"], due: null, acceptance: "volunteered", reference: ["I will book the audit room."] },
  ],
};

// The transcript splits and re-labels lines the way a diarizing service does.
const utterances = [
  { id: "u1", speakerName: "Speaker 1", text: "Let's launch on the third" },
  { id: "u2", speakerName: "Speaker 2", text: "The third clashes with the audit," },
  { id: "u3", speakerName: "Speaker 2", text: "move it to the fifth." },
  { id: "u4", speakerName: "Speaker 1", text: "Agreed, launch on the fifth." },
  { id: "u5", speakerName: "Speaker 3", text: "Pricing we will decide next week." },
  { id: "u6", speakerName: "Speaker 1", text: "Ben, please draft the release notes by Friday." },
  { id: "u7", speakerName: "Speaker 2", text: "Sure, I will." },
];

function item(id: string, text: string, evidence: string[], extra: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return { id, text, evidence, topicIds: [], ...extra };
}

function run(decisions: KnowledgeItem[], actions: KnowledgeItem[]): RunOutput {
  const knowledge: SessionKnowledge = {
    schemaVersion: 3, id: "k", sourceRevision: "r", sources: [], status: "complete", issues: [{ part: 1, reason: "decision-confirm-downgraded" }],
    topics: [], decisions, actions, questions: [], projections: [],
  };
  return { knowledge, utterances };
}

describe("decision evaluation scoring", () => {
  it("compares text after removing punctuation and writing numerals as digits", () => {
    expect(compact("十一月 五号，周五！")).toBe("11月5号周5");
    expect(diceSimilarity("launch on the fifth", "launch on the fifth")).toBe(1);
    expect(overlapSimilarity("move it to the fifth.", "The third clashes with the audit, move it to the fifth.")).toBe(1);
    expect(diceSimilarity("", "x")).toBe(0);
  });

  it("matches items one-to-one by evidence overlap and text, leaving weak pairs unmatched", () => {
    const produced = [
      item("p-fifth", "Ship on the 5th", ["u3", "u4"], { status: "confirmed" }),
      item("p-noise", "Unrelated coffee order", ["u7"], { status: "proposed" }),
    ];
    const text = new Map(utterances.map((entry) => [entry.id, entry.text]));
    const result = matchItems(produced, key.decisions, text);
    expect(result.pairs.map((pair) => [pair.item.id, pair.key.id])).toEqual([["p-fifth", "fifth"]]);
    expect(result.extra.map((entry) => entry.id)).toEqual(["p-noise"]);
    expect(result.missed.map((entry) => entry.id)).toEqual(["third", "pricing"]);
  });

  it("maps numbered speaker labels to dialogue speakers by majority", () => {
    const labels = speakerLabelMap(utterances, dialogue);
    expect(labels.get("Speaker 1")).toBe("Ann");
    expect(labels.get("Speaker 2")).toBe("Ben");
    expect(labels.get("Speaker 3")).toBe("Cai");
    expect(speakerLabelMap(utterances, null).size).toBe(0);
  });

  it("accepts owner aliases and numbered labels, and due strings by containment", () => {
    const labels = new Map([["Speaker 2", "Ben"]]);
    expect(ownerMatches("Ben Li", ["Ben"], labels)).toBe(true);
    expect(ownerMatches("Speaker 2", ["Ben"], labels)).toBe(true);
    expect(ownerMatches("Speaker 1", ["Ben"], labels)).toBe(false);
    expect(ownerMatches(undefined, null, labels)).toBe(true);
    expect(ownerMatches("Ann", null, labels)).toBe(false);
    expect(dueMatches("Friday", "by Friday")).toBe(true);
    expect(dueMatches("周二上午", "周二上午")).toBe(true);
    expect(dueMatches("十一月七号之前", "11月7号之前")).toBe(true);
    expect(dueMatches(undefined, null)).toBe(true);
    expect(dueMatches("Monday", "by Friday")).toBe(false);
    expect(dueMatches(undefined, "by Friday")).toBe(false);
  });

  it("reports status accuracy, the confusion table, wrong confirmations, superseded recall, action fields and missed or extra items", () => {
    const produced = run([
      item("p-third", "Launch on the third", ["u1"], { status: "superseded", supersededBy: "p-fifth" }),
      item("p-fifth", "Launch on the fifth", ["u3", "u4"], { status: "confirmed" }),
      item("p-pricing", "Pricing next week", ["u5"], { status: "confirmed" }),
      item("p-extra", "Order more coffee", ["u7"], { status: "confirmed" }),
    ], [
      item("a-notes", "Draft the release notes", ["u6", "u7"], { owner: "Speaker 2", due: "Friday", acceptance: "assigned" }),
    ]);
    const report = scoreDecisionEval(key, produced, dialogue);
    const d = report.decisions;
    expect(d.matched).toHaveLength(3);
    expect(d.statusAccuracy).toBeCloseTo(2 / 3);
    expect(d.confusion.open.confirmed).toBe(1);
    expect(d.confusion.confirmed.confirmed).toBe(1);
    expect(d.confusion.superseded.superseded).toBe(1);
    expect(d.wronglyConfirmed).toBe(1);
    expect(d.extraConfirmed).toBe(1);
    expect(d.superseded).toEqual({ known: 1, detected: 1, recall: 1, replacementCorrect: 1 });
    expect(d.missed).toEqual([]);
    expect(d.extra.map((entry) => entry.text)).toEqual(["Order more coffee"]);

    const a = report.actions;
    expect(a.matched).toHaveLength(1);
    expect(a.ownerAccuracy).toBe(1);
    expect(a.dueAccuracy).toBe(1);
    expect(a.acceptanceAccuracy).toBe(0);
    expect(a.missed.map((entry) => entry.id)).toEqual(["audit"]);
    expect(report.issues).toEqual(["decision-confirm-downgraded"]);

    const text = formatDecisionEvalReport(report);
    expect(text).toContain("status accuracy: 66.7%");
    expect(text).toContain("wrongly labelled confirmed: 1 matched + 1 extra");
    expect(text).toContain("superseded detection: 1/1 (recall 100.0%), replacement correct 1");
    expect(text).toContain("| open | 1 | 0 | 0 | 0 | 0 | 0 |");
    expect(text).toContain("- MISSED audit Book the audit room");
  });

  it("counts a revision as missed when the replaced decision is not marked superseded, and v2 items as (none)", () => {
    const produced = run([
      item("p-third", "Launch on the third", ["u1"]),
      item("p-fifth", "Launch on the fifth", ["u3", "u4"], { status: "confirmed" }),
    ], []);
    const report = scoreDecisionEval(key, produced);
    expect(report.decisions.superseded).toEqual({ known: 1, detected: 0, recall: 0, replacementCorrect: 0 });
    expect(report.decisions.confusion.superseded["(none)"]).toBe(1);
    expect(report.actions.ownerAccuracy).toBeNull();
  });
});
