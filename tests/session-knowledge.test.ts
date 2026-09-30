import { describe, expect, it } from "vitest";
import { attachTextTranscript, getCurrentTranscript, getTranscriptSourceRevision } from "../src/transcript/session-transcript";
import type { Segment } from "../src/shared/types";
import { mergeSessionKnowledge, parseSessionKnowledgeResponse, readSessionKnowledge, resolveKnowledgeEvidence, serializeSessionKnowledge, stripSessionKnowledgeBlocks, type SessionKnowledge } from "../src/briefing/session-knowledge";

function source(text: string, sourceId = "source-a"): Segment {
  return attachTextTranscript({ index: 1, startOffsetMs: 0, endOffsetMs: 1000, text }, sourceId, "text-import");
}
function wire(evidence = "u1", overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 2, topics: [{ key: "t1", title: "Planning", summary: "Plan release", evidence: [evidence] }], decisions: [{ text: "Ship a pilot", topics: ["t1"], evidence: [evidence] }], actions: [], questions: [], ...overrides }).replace(/-->/g, "--\\u003e");
}
function knowledgeFor(segment: Segment): SessionKnowledge {
  const utterance = getCurrentTranscript(segment.transcript!).utterances[0];
  return parseSessionKnowledgeResponse(`Notes\n<!-- qnalog-session-knowledge ${wire(utterance.id)} -->`, {
    allowed: [utterance], part: 1, sources: [{ segmentId: segment.transcript!.id, revision: 1, normalizationRevision: 1 }], sourceRevision: "source-rev",
  }).knowledge;
}

describe("session knowledge protocol", () => {
  it("strips protocol and preserves body while binding valid evidence to the allowed part", () => {
    const segment = source("We will ship a pilot.");
    const utterance = getCurrentTranscript(segment.transcript!).utterances[0];
    const result = parseSessionKnowledgeResponse(`Body\n<!-- qnalog-session-knowledge ${wire(utterance.id)} -->`, {
      allowed: [utterance], part: 2, sources: [{ segmentId: segment.transcript!.id, revision: 1, normalizationRevision: 1 }], sourceRevision: "r1",
    });
    expect(result.body).toBe("Body");
    expect(result.knowledge.status).toBe("complete");
    expect(result.knowledge.decisions[0].evidence).toEqual([utterance.id]);
    expect(result.knowledge.topics).toHaveLength(1);
  });
  it("preserves content after complete blocks and drops malformed protocol tails", () => {
    const complete = stripSessionKnowledgeBlocks("Before\n<!-- qnalog-session-knowledge {\"ok\":true} -->\nAfter");
    expect(complete).toContain("Before");
    expect(complete).toContain("After");
    expect(stripSessionKnowledgeBlocks("Before\n<!-- qnalog-session-knowledge {invalid")).toBe("Before");
  });

  it("rejects unknown IDs as a whole item and distinguishes malformed or absent blocks", () => {
    const segment = source("One utterance.");
    const utterance = getCurrentTranscript(segment.transcript!).utterances[0];
    const context = { allowed: [utterance], part: 1, sources: [], sourceRevision: "r" };
    const invalid = parseSessionKnowledgeResponse(`Body<!-- qnalog-session-knowledge ${wire(utterance.id, { decisions: [{ text: "Bad", topics: ["t1"], evidence: [utterance.id, "outside"] }] })} -->`, context);
    expect(invalid.body).toBe("Body");
    expect(invalid.knowledge.decisions).toEqual([]);
    expect(invalid.knowledge.issues).toContainEqual({ part: 1, reason: "unknown-evidence" });
    const malformed = parseSessionKnowledgeResponse("Visible\n<!-- qnalog-session-knowledge {bad -->", context);
    expect(malformed.body).toBe("Visible");
    expect(malformed.knowledge.issues).toContainEqual({ part: 1, reason: "invalid-json" });
    const absent = parseSessionKnowledgeResponse("Visible", context);
    expect(absent.knowledge.status).toBe("unavailable");
    expect(absent.knowledge.issues).toContainEqual({ part: 1, reason: "missing-block" });
  });

  it("validates stable IDs, exact source identity, and safe one-line serialization", () => {
    const segment = source("Evidence --> `tag` <x>");
    const utterance = getCurrentTranscript(segment.transcript!).utterances[0];
    const context = { allowed: [utterance], part: 1, sources: [{ segmentId: segment.transcript!.id, revision: 1, normalizationRevision: 1 }], sourceRevision: "r1" };
    const first = parseSessionKnowledgeResponse(`<!-- qnalog-session-knowledge ${wire(utterance.id, { topics: [{ key: "t1", title: "Plan --> `release`", summary: "Plan release", evidence: [utterance.id] }] })} -->`, context).knowledge;
    const response = `<!-- qnalog-session-knowledge ${wire(utterance.id, { topics: [{ key: "t1", title: "Plan --> `release`", summary: "Plan release", evidence: [utterance.id] }] })} -->`;
    const second = parseSessionKnowledgeResponse(response, { ...context, previous: first }).knowledge;
    expect(second.decisions[0].id).toBe(first.decisions[0].id);
    const unrelatedRevision = parseSessionKnowledgeResponse(response, { ...context, sourceRevision: "r2", previous: first }).knowledge;
    expect(unrelatedRevision.decisions[0].id).toBe(first.decisions[0].id);
    const changedSegment = attachTextTranscript({ ...segment, text: "Evidence changed.", rawText: undefined }, segment.transcript!.sourceId, "edited-transcript");
    const changedUnit = getCurrentTranscript(changedSegment.transcript!).utterances[0];
    const changedSources = [{ segmentId: changedSegment.transcript!.id, revision: 2, normalizationRevision: 1 }];
    const changed = parseSessionKnowledgeResponse(`<!-- qnalog-session-knowledge ${wire(changedUnit.id)} -->`, {
      allowed: [changedUnit], part: 1, sources: changedSources, sourceRevision: getTranscriptSourceRevision([changedSegment]), previous: first,
    }).knowledge;
    expect(changed.decisions[0].id).not.toBe(first.decisions[0].id);
    const serialized = serializeSessionKnowledge(first);
    expect(serialized).toContain("\\u002d\\u002d");
    expect(serialized).toContain("\\u0060");
    expect(readSessionKnowledge(serialized)).toEqual(first);
    expect(readSessionKnowledge("<!-- qnalog-session-knowledge {bad} -->")).toBeNull();
  });

  it("resolves only matching current ledger evidence and returns stale or missing otherwise", () => {
    const segment = source("A real statement.");
    const knowledge = knowledgeFor(segment);
    const item = knowledge.decisions[0];
    // Use the real source snapshot so resolution checks exact revision metadata, not a fabricated hash.
    const matching = { ...knowledge, sourceRevision: getTranscriptSourceRevision([segment]), sources: [{ segmentId: segment.transcript!.id, revision: 1, normalizationRevision: 1 }] };
    expect(resolveKnowledgeEvidence(matching, item.id, [segment]).status).toBe("resolved");
    expect(resolveKnowledgeEvidence(matching, "unknown", [segment])).toEqual({ status: "missing", utterances: [] });
    const edited = source("A changed statement.");
    expect(resolveKnowledgeEvidence(matching, item.id, [edited]).status).toBe("stale");
  });

  it("merges only exact object matches without collapsing conflicting conclusions", () => {
    const segment = source("The team discussed two options.");
    const knowledge = knowledgeFor(segment);
    const another = { ...knowledge, id: "other", decisions: [{ ...knowledge.decisions[0], id: "decision:other", text: "Do not ship a pilot" }] };
    const merged = mergeSessionKnowledge([knowledge, another], [segment]);
    expect(merged.decisions).toHaveLength(2);
    expect(merged.decisions.map((item) => item.text)).toEqual(["Ship a pilot", "Do not ship a pilot"]);
  });
});
