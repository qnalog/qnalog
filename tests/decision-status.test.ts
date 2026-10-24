import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
  parseYaml: () => ({}),
  Notice: class Notice {},
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import { buildEvidenceLinksBlock } from "../src/briefing/evidence-links";
import {
  OWNER_DUE_MAX_CHARS,
  mergeSessionKnowledge,
  parseSessionKnowledgeResponse,
  readSessionKnowledge,
  serializeSessionKnowledge,
  type SessionKnowledge,
} from "../src/briefing/session-knowledge";
import { markSpeakerMentionsInOrganizedBody } from "../src/audio/speaker-mentions";
import { attachTranscriptResult, getCurrentTranscript, getTranscriptSourceRevision } from "../src/transcript/session-transcript";
import type { AsrTranscriptUnit } from "../src/asr/transcript-result";
import type { Segment } from "../src/shared/types";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

// 带状态的决定与待办：会话知识 v3 的解析、规范化、分部合并与原话出处区块的显示。

const AUDIO = "QnALog/Audio/status.webm";
const previousLanguage = getActiveUiLanguage();
beforeAll(() => setActiveUiLanguage(resolveUiLanguage("en", "en")));
afterAll(() => setActiveUiLanguage(previousLanguage));

function unit(text: string, second: number, speakerId: string, speakerName: string): AsrTranscriptUnit {
  return { rawText: text, normalizedText: text, speakerId, speakerName, startMs: second * 1000, endMs: second * 1000 + 1500, timing: "provider" };
}

function recorded(units: AsrTranscriptUnit[], sourceId = "status-session", index = 0): Segment {
  const text = units.map((item) => item.rawText).join(" ");
  return attachTranscriptResult({
    index, startOffsetMs: 0, endOffsetMs: 600_000, text, audioPath: AUDIO, audioName: "status.webm",
  }, sourceId, { text, rawText: null, providerId: "test-asr", units }, "asr");
}

const segment = recorded([
  unit("Let's ship on Friday.", 1, "spk-1", "Speaker 1"),
  unit("Agreed, Friday it is.", 3, "spk-2", "Speaker 2"),
  unit("Maybe we add dark mode too.", 5, "spk-1", "Speaker 1"),
  unit("I disagree, dark mode is too risky.", 7, "spk-2", "Speaker 2"),
  unit("Pricing we decide next week.", 9, "spk-1", "Speaker 1"),
  unit("Actually make it Monday, not Friday.", 11, "spk-1", "Speaker 1"),
  unit("Fine, Monday.", 13, "spk-2", "Speaker 2"),
  unit("Speaker 2, please write the release notes by Thursday.", 15, "spk-1", "Speaker 1"),
  unit("Sure, I'll take that.", 17, "spk-2", "Speaker 2"),
]);
const U = getCurrentTranscript(segment.transcript!).utterances.map((item) => item.id);

type Wire = Record<string, unknown>;
function context(segments: Segment[] = [segment], part = 1) {
  const utterances = segments.flatMap((entry) => getCurrentTranscript(entry.transcript!).utterances);
  const sources = segments.map((entry) => {
    const current = getCurrentTranscript(entry.transcript!);
    return { segmentId: entry.transcript!.id, revision: current.revision, normalizationRevision: current.normalizationRevision };
  });
  return { allowed: utterances, part, sources, sourceRevision: getTranscriptSourceRevision(segments) };
}
function parse(decisions: Wire[], actions: Wire[] = [], schemaVersion = 3, segments: Segment[] = [segment], part = 1): SessionKnowledge {
  const evidence = getCurrentTranscript(segments[0].transcript!).utterances[0].id;
  const wire = {
    schemaVersion,
    topics: [{ key: "t1", title: "Release", summary: "Release plan", evidence: [evidence] }],
    decisions: decisions.map((item) => ({ topics: ["t1"], ...item })),
    actions: actions.map((item) => ({ topics: ["t1"], ...item })),
    questions: [],
  };
  return parseSessionKnowledgeResponse(`Body\n<!-- qnalog-session-knowledge ${JSON.stringify(wire)} -->`, context(segments, part)).knowledge;
}
function reasons(knowledge: SessionKnowledge): string[] {
  return knowledge.issues.map((issue) => issue.reason);
}

const ALL_FIVE: Wire[] = [
  { key: "d-friday", text: "Ship on Friday", status: "superseded", supersededBy: "d-monday", evidence: [U[0], U[1]] },
  { key: "d-dark", text: "Add dark mode", status: "disputed", evidence: [U[2], U[3]] },
  { key: "d-pricing", text: "Decide pricing", status: "open", evidence: [U[4]] },
  { key: "d-monday", text: "Ship on Monday", status: "confirmed", evidence: [U[5], U[6]] },
  { key: "d-proposal", text: "Consider dark mode", status: "proposed", evidence: [U[2]] },
];

describe("status-tagged decisions: parsing and normalization", () => {
  it("keeps each of the five statuses and resolves supersededBy to the replacing decision's id", () => {
    const knowledge = parse(ALL_FIVE);
    expect(knowledge.schemaVersion).toBe(3);
    expect(knowledge.status).toBe("complete");
    expect(knowledge.issues).toEqual([]);
    expect(knowledge.decisions.map((item) => item.status)).toEqual(["superseded", "disputed", "open", "confirmed", "proposed"]);
    const monday = knowledge.decisions.find((item) => item.text === "Ship on Monday")!;
    expect(knowledge.decisions[0].supersededBy).toBe(monday.id);
    expect(readSessionKnowledge(serializeSessionKnowledge(knowledge))).toEqual(knowledge);
  });

  it.each([[undefined], ["maybe"], [42]])("turns a missing or invalid status (%s) into proposed and logs it without making the knowledge partial", (status) => {
    const knowledge = parse([{ text: "Ship", status, evidence: [U[0], U[1]] }]);
    expect(knowledge.decisions[0].status).toBe("proposed");
    expect(reasons(knowledge)).toEqual(["decision-status-defaulted"]);
    expect(knowledge.status).toBe("complete");
  });

  it("turns superseded without a valid target into proposed", () => {
    const knowledge = parse([
      { key: "a", text: "No target", status: "superseded", evidence: [U[0], U[1]] },
      { key: "b", text: "Unknown target", status: "superseded", supersededBy: "missing", evidence: [U[0], U[1]] },
      { key: "c", text: "Self target", status: "superseded", supersededBy: "c", evidence: [U[0], U[1]] },
    ]);
    expect(knowledge.decisions.map((item) => item.status)).toEqual(["proposed", "proposed", "proposed"]);
    expect(knowledge.decisions.every((item) => item.supersededBy === undefined)).toBe(true);
    expect(reasons(knowledge)).toEqual(["decision-supersede-unresolved"]);
    expect(knowledge.status).toBe("complete");
  });

  it("downgrades a confirmed decision backed by one utterance to proposed and keeps the item", () => {
    const knowledge = parse([
      { text: "Single", status: "confirmed", evidence: [U[0]] },
      { text: "Repeated id", status: "confirmed", evidence: [U[0], U[0]] },
      { text: "Two utterances", status: "confirmed", evidence: [U[0], U[1]] },
    ]);
    expect(knowledge.decisions.map((item) => [item.text, item.status])).toEqual([
      ["Single", "proposed"], ["Repeated id", "proposed"], ["Two utterances", "confirmed"],
    ]);
    expect(reasons(knowledge)).toEqual(["decision-confirm-downgraded"]);
    expect(knowledge.status).toBe("complete");
  });

  it("defaults acceptance to assigned and keeps owner and due verbatim after trimming", () => {
    const knowledge = parse([], [
      { text: "Write notes", owner: "  Speaker 2 ", due: " by\nThursday ", acceptance: "volunteered", evidence: [U[7], U[8]] },
      { text: "No acceptance", owner: "", evidence: [U[7]] },
      { text: "Bad acceptance", acceptance: "yes", due: "next Friday 3pm", evidence: [U[7]] },
    ]);
    expect(knowledge.actions[0]).toMatchObject({ owner: "Speaker 2", due: "by Thursday", acceptance: "volunteered" });
    expect(knowledge.actions[1].acceptance).toBe("assigned");
    expect(knowledge.actions[1].owner).toBeUndefined();
    expect(knowledge.actions[2]).toMatchObject({ acceptance: "assigned", due: "next Friday 3pm" });
    expect(reasons(knowledge)).toEqual(["action-acceptance-defaulted"]);
    expect(knowledge.status).toBe("complete");
  });

  it("drops an over-long or non-string owner or due instead of cutting it", () => {
    const long = "x".repeat(OWNER_DUE_MAX_CHARS + 1);
    const knowledge = parse([], [{ text: "Do it", owner: long, due: 5, acceptance: "accepted", evidence: [U[7]] }]);
    expect(knowledge.actions[0].owner).toBeUndefined();
    expect(knowledge.actions[0].due).toBeUndefined();
    expect(knowledge.actions[0].acceptance).toBe("accepted");
    expect(reasons(knowledge)).toEqual(["action-field-dropped"]);
    const exact = parse([], [{ text: "Do it", owner: "y".repeat(OWNER_DUE_MAX_CHARS), acceptance: "accepted", evidence: [U[7]] }]);
    expect(exact.actions[0].owner).toHaveLength(OWNER_DUE_MAX_CHARS);
  });

  it("still marks the knowledge partial for invalid items alongside normalized fields", () => {
    const knowledge = parse([{ text: "Ship", evidence: [U[0]] }, { text: "", evidence: [U[0]] }]);
    expect(reasons(knowledge)).toEqual(["invalid-item", "decision-status-defaulted"]);
    expect(knowledge.status).toBe("partial");
  });

  it("keeps items whose topics are missing or unknown, without topics, and stays complete", () => {
    // Real model output (qwen3.8-max, 2026-10-25) omitted topics on decisions and actions; every item was dropped.
    const evidence = getCurrentTranscript(segment.transcript!).utterances[0].id;
    const wire = {
      schemaVersion: 3,
      topics: [{ key: "t1", title: "Release", summary: "Release plan", evidence: [evidence] }],
      decisions: [
        { key: "d1", text: "Ship on Monday", status: "confirmed", evidence: [U[5], U[6]] },
        { key: "d2", text: "Add dark mode", status: "open", topics: ["missing"], evidence: [U[2]] },
      ],
      actions: [{ text: "Write notes", acceptance: "accepted", evidence: [U[7]] }],
      questions: [],
    };
    const knowledge = parseSessionKnowledgeResponse(`Body\n<!-- qnalog-session-knowledge ${JSON.stringify(wire)} -->`, context()).knowledge;
    expect(knowledge.decisions.map((item) => [item.text, item.status, item.topicIds])).toEqual([
      ["Ship on Monday", "confirmed", []],
      ["Add dark mode", "open", []],
    ]);
    expect(knowledge.actions.map((item) => item.text)).toEqual(["Write notes"]);
    expect(reasons(knowledge)).toEqual(["item-topics-defaulted"]);
    expect(knowledge.status).toBe("complete");
  });

  it("reads stored v2 knowledge unchanged and rejects invalid stored status values", () => {
    const v3 = parse([{ text: "Ship", status: "proposed", evidence: [U[0]] }], [{ text: "Notes", acceptance: "accepted", evidence: [U[7]] }]);
    const stored: SessionKnowledge = {
      ...v3,
      schemaVersion: 2,
      decisions: v3.decisions.map(({ id, text, evidence, topicIds }) => ({ id, text, evidence, topicIds })),
      actions: v3.actions.map(({ id, text, evidence, topicIds }) => ({ id, text, evidence, topicIds })),
    };
    const read = readSessionKnowledge(serializeSessionKnowledge(stored));
    expect(read).toEqual(stored);
    expect(read?.decisions[0].status).toBeUndefined();
    const broken = { ...v3, decisions: [{ ...v3.decisions[0], status: "final" }] };
    expect(readSessionKnowledge(`<!-- qnalog-session-knowledge ${JSON.stringify(broken)} -->`)).toBeNull();
  });

  it("accepts a model reply that still says schemaVersion 2 and normalizes it to version 3", () => {
    const knowledge = parse([{ text: "Ship", evidence: [U[0]] }], [{ text: "Notes", evidence: [U[7]] }], 2);
    expect(knowledge.schemaVersion).toBe(3);
    expect(knowledge.decisions[0].status).toBe("proposed");
    expect(knowledge.actions[0].acceptance).toBe("assigned");
    expect(knowledge.status).toBe("complete");
  });
});

describe("status-tagged decisions: merging parts", () => {
  const first = recorded([unit("Ship on Friday.", 1, "spk-1", "Speaker 1"), unit("Yes.", 2, "spk-2", "Speaker 2")], "part-a", 0);
  const second = recorded([unit("Make it Monday.", 3, "spk-1", "Speaker 1"), unit("Agreed.", 4, "spk-2", "Speaker 2")], "part-b", 1);
  const segments = [first, second];
  const a = getCurrentTranscript(first.transcript!).utterances.map((item) => item.id);
  const b = getCurrentTranscript(second.transcript!).utterances.map((item) => item.id);

  it("keeps statuses, lets a later part win for the same decision text, and remaps supersededBy across merged ids", () => {
    const partOne = parse([
      { key: "fri", text: "Ship on Friday", status: "confirmed", evidence: [a[0], a[1]] },
      { key: "old", text: "Old plan", status: "superseded", supersededBy: "fri", evidence: [a[0], a[1]] },
    ], [{ text: "Tell support", owner: "Speaker 2", acceptance: "accepted", evidence: [a[1]] }], 3, segments, 1);
    const partTwo = parse([
      { key: "fri", text: " Ship  on Friday ", status: "superseded", supersededBy: "mon", evidence: [b[0]] },
      { key: "mon", text: "Ship on Monday", status: "confirmed", evidence: [b[0], b[1]] },
    ], [], 3, segments, 2);
    // A replayed copy of part one collapses into the same merged ids; its supersededBy must follow.
    const replay: SessionKnowledge = { ...partOne, decisions: partOne.decisions.map((item) => ({ ...item, id: `${item.id}:replay`, supersededBy: item.supersededBy ? `${item.supersededBy}:replay` : undefined })) };
    const merged = mergeSessionKnowledge([partOne, replay, partTwo], segments);
    expect(merged.schemaVersion).toBe(3);
    expect(merged.status).toBe("complete");
    const byText = (text: string) => merged.decisions.filter((item) => item.text.trim().replace(/\s+/g, " ") === text);
    expect(merged.decisions).toHaveLength(4);
    const monday = byText("Ship on Monday")[0];
    expect(monday.status).toBe("confirmed");
    expect(byText("Ship on Friday").map((item) => item.status)).toEqual(["superseded", "superseded"]);
    expect(byText("Ship on Friday").every((item) => item.supersededBy === monday.id)).toBe(true);
    const oldPlan = byText("Old plan")[0];
    expect(oldPlan.supersededBy).toBe(byText("Ship on Friday")[0].id);
    expect(merged.actions[0]).toMatchObject({ owner: "Speaker 2", acceptance: "accepted" });
  });

  it("turns a superseded decision whose target is gone after merging into proposed and logs it", () => {
    const part = parse([
      { key: "x", text: "Old", status: "superseded", supersededBy: "y", evidence: [a[0], a[1]] },
      { key: "y", text: "New", status: "confirmed", evidence: [a[0], a[1]] },
    ], [], 3, segments, 1);
    const withoutTarget: SessionKnowledge = { ...part, decisions: [part.decisions[0]] };
    const merged = mergeSessionKnowledge([withoutTarget], segments);
    expect(merged.decisions[0].status).toBe("proposed");
    expect(merged.decisions[0].supersededBy).toBeUndefined();
    expect(merged.issues).toContainEqual({ part: 0, reason: "decision-supersede-unresolved" });
    expect(merged.status).toBe("complete");
  });

  it("keeps a v2 checkpoint part without inventing statuses", () => {
    const part = parse([{ text: "Legacy", status: "open", evidence: [a[0]] }], [], 3, segments, 1);
    const legacy: SessionKnowledge = { ...part, schemaVersion: 2, issues: [], decisions: part.decisions.map(({ id, text, evidence, topicIds }) => ({ id, text, evidence, topicIds })) };
    const merged = mergeSessionKnowledge([legacy], segments);
    expect(merged.decisions[0].status).toBeUndefined();
  });
});

describe("status-tagged decisions: evidence block", () => {
  function lines(block: string): string[] {
    return block.split("\n").filter((line) => line.startsWith("- **"));
  }

  it("orders decisions by status, labels them in English, and writes the replacement for superseded ones", () => {
    const knowledge = parse(ALL_FIVE, [{ text: "Write the release notes", owner: "Speaker 2", due: "by Thursday", acceptance: "assigned", evidence: [U[7]] }]);
    const rows = lines(buildEvidenceLinksBlock(knowledge, [segment]));
    expect(rows.map((row) => /^- \*\*([^*]+)\*\*/.exec(row)?.[1])).toEqual([
      "Decision (confirmed)", "Decision (proposed)", "Decision (disputed)", "Decision (open)", "Decision (superseded)", "Action item",
    ]);
    expect(rows[4]).toContain("**Decision (superseded)**: Ship on Friday → see: Ship on Monday — Speaker 1");
    expect(rows[5]).toContain("**Action item**: Write the release notes · Owner: Speaker 2 · Due: by Thursday · not explicitly accepted — Speaker 1");
  });

  it("uses Chinese labels, truncates the replacement, omits 未明确接下 for accepted or volunteered, and marks speaker owners", () => {
    setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
    try {
      const zh = recorded([
        unit("周五上线。", 1, "spk-1", "说话人1"),
        unit("同意。", 2, "spk-2", "王五"),
        unit("改成下周一，并且所有客户都提前一周邮件通知，再加一轮回归测试和灰度发布。", 3, "spk-1", "说话人1"),
        unit("好，就这么定。", 4, "spk-2", "王五"),
        unit("王五写发布说明，周四前。", 5, "spk-1", "说话人1"),
        unit("我来。", 6, "spk-2", "王五"),
      ], "zh-session");
      const z = getCurrentTranscript(zh.transcript!).utterances.map((item) => item.id);
      const longText = "改成下周一，并且所有客户都提前一周邮件通知，再加一轮回归测试和灰度发布，发布当天值班人员全部到岗";
      const knowledge = parse([
        { key: "a", text: "周五上线", status: "superseded", supersededBy: "b", evidence: [z[0], z[1]] },
        { key: "b", text: longText, status: "confirmed", evidence: [z[2], z[3]] },
      ], [
        { text: "写发布说明", owner: "王五", due: "周四前", acceptance: "volunteered", evidence: [z[4], z[5]] },
        { text: "通知客户", owner: "说话人1", acceptance: "accepted", evidence: [z[2]] },
        { text: "补回归测试", evidence: [z[2]] },
      ], 3, [zh]);
      const block = buildEvidenceLinksBlock(knowledge, [zh]);
      const rows = lines(block);
      expect(rows[0]).toMatch(/^- \*\*决定（已确认）\*\*：改成下周一/);
      const clipped = `${Array.from(longText).slice(0, 39).join("")}…`;
      expect(rows[1]).toContain(`- **决定（已被替代）**：周五上线 → 见：${clipped} — 说话人1`);
      expect(rows[2]).toContain("- **待办**：写发布说明 · 负责人：王五 · 期限：周四前 — ");
      expect(rows[3]).toContain("- **待办**：通知客户 · 负责人：说话人1 — ");
      expect(rows[4]).toContain("- **待办**：补回归测试 · 未明确接下 — ");
      expect(block).not.toContain("未明确接下 · ");
      const marked = markSpeakerMentionsInOrganizedBody(block, [zh], null);
      expect(marked).toContain("· 负责人：『王五』 · 期限：周四前 — 『说话人1』");
      expect(marked).toContain("· 负责人：『说话人1』 — 『说话人1』");
    } finally {
      setActiveUiLanguage(resolveUiLanguage("en", "en"));
    }
  });

  it("shows no status label or action suffix for v2 items", () => {
    const v3 = parse([{ text: "Ship", status: "confirmed", evidence: [U[0], U[1]] }], [{ text: "Notes", owner: "Speaker 2", acceptance: "assigned", evidence: [U[7]] }]);
    const v2: SessionKnowledge = {
      ...v3,
      schemaVersion: 2,
      decisions: v3.decisions.map(({ id, text, evidence, topicIds }) => ({ id, text, evidence, topicIds })),
      actions: v3.actions.map(({ id, text, evidence, topicIds }) => ({ id, text, evidence, topicIds })),
    };
    const rows = lines(buildEvidenceLinksBlock(v2, [segment]));
    expect(rows[0]).toMatch(/^- \*\*Decision\*\*: Ship — Speaker 1/);
    expect(rows[1]).toMatch(/^- \*\*Action item\*\*: Notes — Speaker 1/);
  });
});
