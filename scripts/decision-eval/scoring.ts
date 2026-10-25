/**
 * Offline scoring for status-tagged decisions and actions (MAINTAINING §6.1, §7.2).
 *
 * Location: scripts/decision-eval/. Outside tsconfig "include" (src only), so neither the plugin
 * bundle nor the `tsc` build reads it. scripts/decision-eval.mjs bundles it with esbuild at run time.
 * No network and no API keys.
 *
 * Inputs:
 * - Answer key (hand-written from the synthetic dialogue; kept outside the repository):
 *   {
 *     "title": string,
 *     "decisions": [{ "id", "text", "status", "reference": [dialogue utterance text], "supersededBy"?: key decision id }],
 *     "actions": [{ "id", "text", "owner": [accepted names] | null, "due": string | null,
 *                   "acceptance": "accepted" | "assigned" | "volunteered", "reference": [dialogue utterance text] }]
 *   }
 * - Run output (scripts/decision-eval/runner.ts): { knowledge: SessionKnowledge, utterances: [{ id, speakerName, text }] }.
 * - Optional dialogue (the synthetic script, { utterances: [{ speaker, text }] }): lets a numbered owner
 *   such as "Speaker 2" count as the dialogue speaker whose lines that label carries.
 *
 * Matching: each produced item is compared with each key item. Similarity is
 * 0.6 × the best character-bigram overlap between the item's evidence utterances and the key's
 * reference lines (overlap coefficient, so a split or merged utterance still matches) plus
 * 0.4 × the bigram Dice similarity of the two item texts. Pairs are assigned one-to-one from the
 * highest similarity down; pairs below MATCH_THRESHOLD stay unmatched (missed / extra).
 */
import { normalizeChineseNumbers } from "../../src/shared/chinese-numerals";
import type { ActionAcceptance, DecisionStatus, KnowledgeItem, SessionKnowledge } from "../../src/briefing/session-knowledge";

export const MATCH_THRESHOLD = 0.35;
const EVIDENCE_WEIGHT = 0.6;
const STATUSES: readonly DecisionStatus[] = ["confirmed", "proposed", "disputed", "open", "superseded"];

export interface KeyDecision { id: string; text: string; status: DecisionStatus; reference: string[]; supersededBy?: string }
export interface KeyAction { id: string; text: string; owner: string[] | null; due: string | null; acceptance: ActionAcceptance; reference: string[] }
export interface AnswerKey { title: string; decisions: KeyDecision[]; actions: KeyAction[] }
export interface RunUtterance { id: string; speakerName: string | null; text: string }
export interface RunOutput { knowledge: SessionKnowledge; utterances: RunUtterance[] }
export interface Dialogue { utterances: Array<{ speaker: string; text: string }> }

export interface ItemMatch { keyId: string; keyText: string; producedId: string; producedText: string; similarity: number }
export interface DecisionReport {
  matched: Array<ItemMatch & { expected: DecisionStatus; produced: DecisionStatus | "(none)" }>;
  statusAccuracy: number | null;
  /** confusion[expected][produced] = count; produced includes "(none)" for items without status. */
  confusion: Record<string, Record<string, number>>;
  /** Matched items labelled confirmed whose key status is not confirmed. */
  wronglyConfirmed: number;
  /** Extra produced items (no key match) labelled confirmed. */
  extraConfirmed: number;
  superseded: { known: number; detected: number; recall: number | null; replacementCorrect: number };
  missed: Array<{ id: string; text: string; status: DecisionStatus }>;
  extra: Array<{ id: string; text: string; status: DecisionStatus | "(none)" }>;
}
export interface ActionReport {
  matched: Array<ItemMatch & { owner: boolean; due: boolean; acceptance: boolean; producedOwner: string; producedDue: string; producedAcceptance: string }>;
  ownerAccuracy: number | null;
  dueAccuracy: number | null;
  acceptanceAccuracy: number | null;
  missed: Array<{ id: string; text: string }>;
  extra: Array<{ id: string; text: string }>;
}
export interface DecisionEvalReport { title: string; knowledgeStatus: string; issues: string[]; decisions: DecisionReport; actions: ActionReport }

/** Text for comparison: numerals as digits, lower case, no whitespace or punctuation. */
export function compact(value: string): string {
  return normalizeChineseNumbers(String(value || "")).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(value: string): string[] {
  const chars = Array.from(compact(value));
  if (chars.length < 2) return chars;
  const grams: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1) grams.push(chars[index] + chars[index + 1]);
  return grams;
}

function intersection(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const gram of b) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let shared = 0;
  for (const gram of a) {
    const left = counts.get(gram) ?? 0;
    if (left > 0) { shared += 1; counts.set(gram, left - 1); }
  }
  return shared;
}

/** Bigram Dice similarity in [0, 1]. */
export function diceSimilarity(a: string, b: string): number {
  const left = bigrams(a); const right = bigrams(b);
  if (!left.length || !right.length) return 0;
  return (2 * intersection(left, right)) / (left.length + right.length);
}

/** Bigram overlap coefficient in [0, 1]: shared bigrams over the shorter text's bigrams. */
export function overlapSimilarity(a: string, b: string): number {
  const left = bigrams(a); const right = bigrams(b);
  if (!left.length || !right.length) return 0;
  return intersection(left, right) / Math.min(left.length, right.length);
}

export function itemSimilarity(item: KnowledgeItem, evidenceTexts: readonly string[], keyText: string, reference: readonly string[]): number {
  let evidence = 0;
  for (const said of evidenceTexts) for (const line of reference) evidence = Math.max(evidence, overlapSimilarity(said, line));
  return EVIDENCE_WEIGHT * evidence + (1 - EVIDENCE_WEIGHT) * diceSimilarity(item.text, keyText);
}

/** One-to-one assignment, highest similarity first. */
export function matchItems<K extends { id: string; text: string; reference: string[] }>(
  produced: readonly KnowledgeItem[],
  keys: readonly K[],
  utteranceText: ReadonlyMap<string, string>,
  threshold = MATCH_THRESHOLD,
): { pairs: Array<{ item: KnowledgeItem; key: K; similarity: number }>; missed: K[]; extra: KnowledgeItem[] } {
  const candidates: Array<{ item: KnowledgeItem; key: K; similarity: number }> = [];
  for (const item of produced) {
    const evidence = item.evidence.map((id) => utteranceText.get(id) ?? "").filter(Boolean);
    for (const key of keys) {
      const similarity = itemSimilarity(item, evidence, key.text, key.reference);
      if (similarity >= threshold) candidates.push({ item, key, similarity });
    }
  }
  candidates.sort((a, b) => b.similarity - a.similarity);
  const usedItems = new Set<KnowledgeItem>();
  const usedKeys = new Set<K>();
  const pairs: Array<{ item: KnowledgeItem; key: K; similarity: number }> = [];
  for (const candidate of candidates) {
    if (usedItems.has(candidate.item) || usedKeys.has(candidate.key)) continue;
    usedItems.add(candidate.item); usedKeys.add(candidate.key);
    pairs.push(candidate);
  }
  return { pairs, missed: keys.filter((key) => !usedKeys.has(key)), extra: produced.filter((item) => !usedItems.has(item)) };
}

/**
 * Numbered speaker label → dialogue speaker, by majority over the label's utterances
 * (each matched to the dialogue line it overlaps most).
 */
export function speakerLabelMap(utterances: readonly RunUtterance[], dialogue: Dialogue | null): Map<string, string> {
  const votes = new Map<string, Map<string, number>>();
  if (!dialogue) return new Map();
  for (const utterance of utterances) {
    if (!utterance.speakerName) continue;
    let best = ""; let score = 0;
    for (const line of dialogue.utterances) {
      const similarity = overlapSimilarity(utterance.text, line.text);
      if (similarity > score) { score = similarity; best = line.speaker; }
    }
    if (!best || score < 0.5) continue;
    const tally = votes.get(utterance.speakerName) ?? new Map<string, number>();
    tally.set(best, (tally.get(best) ?? 0) + 1);
    votes.set(utterance.speakerName, tally);
  }
  const map = new Map<string, string>();
  for (const [label, tally] of votes) {
    const [winner] = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    if (winner) map.set(label, winner[0]);
  }
  return map;
}

/** Owner matches when the produced name (or the dialogue speaker behind a numbered label) contains or is contained in an accepted name. */
export function ownerMatches(produced: string | undefined, accepted: readonly string[] | null, labels: ReadonlyMap<string, string>): boolean {
  const value = compact(produced ?? "");
  if (!accepted || !accepted.length) return !value;
  if (!value) return false;
  const names = [value];
  const mapped = labels.get(String(produced ?? "").trim());
  if (mapped) names.push(compact(mapped));
  return accepted.some((name) => {
    const target = compact(name);
    return !!target && names.some((candidate) => candidate.includes(target) || target.includes(candidate));
  });
}

/** Due matches when both are absent, or one contains the other after compacting (numerals as digits). */
export function dueMatches(produced: string | undefined, expected: string | null): boolean {
  const value = compact(produced ?? "");
  const target = compact(expected ?? "");
  if (!target) return !value;
  return !!value && (value.includes(target) || target.includes(value));
}

function rate(hits: number, total: number): number | null {
  return total ? hits / total : null;
}

export function scoreDecisionEval(key: AnswerKey, run: RunOutput, dialogue: Dialogue | null = null): DecisionEvalReport {
  const utteranceText = new Map(run.utterances.map((utterance) => [utterance.id, utterance.text]));
  const knowledge = run.knowledge;

  const decisionMatch = matchItems(knowledge.decisions, key.decisions, utteranceText);
  const confusion: Record<string, Record<string, number>> = {};
  for (const status of STATUSES) confusion[status] = {};
  const producedByKey = new Map<string, KnowledgeItem>();
  const decisionsMatched = decisionMatch.pairs.map(({ item, key: entry, similarity }) => {
    producedByKey.set(entry.id, item);
    const produced = item.status ?? "(none)";
    confusion[entry.status][produced] = (confusion[entry.status][produced] ?? 0) + 1;
    return { keyId: entry.id, keyText: entry.text, producedId: item.id, producedText: item.text, similarity, expected: entry.status, produced };
  });
  const knownRevisions = key.decisions.filter((entry) => entry.status === "superseded");
  let detected = 0; let replacementCorrect = 0;
  for (const revision of knownRevisions) {
    const produced = producedByKey.get(revision.id);
    if (produced?.status !== "superseded") continue;
    detected += 1;
    const replacement = revision.supersededBy ? producedByKey.get(revision.supersededBy) : undefined;
    if (replacement && produced.supersededBy === replacement.id) replacementCorrect += 1;
  }
  const decisions: DecisionReport = {
    matched: decisionsMatched,
    statusAccuracy: rate(decisionsMatched.filter((row) => row.expected === row.produced).length, decisionsMatched.length),
    confusion,
    wronglyConfirmed: decisionsMatched.filter((row) => row.produced === "confirmed" && row.expected !== "confirmed").length,
    extraConfirmed: decisionMatch.extra.filter((item) => item.status === "confirmed").length,
    superseded: { known: knownRevisions.length, detected, recall: rate(detected, knownRevisions.length), replacementCorrect },
    missed: decisionMatch.missed.map((entry) => ({ id: entry.id, text: entry.text, status: entry.status })),
    extra: decisionMatch.extra.map((item) => ({ id: item.id, text: item.text, status: item.status ?? "(none)" })),
  };

  const labels = speakerLabelMap(run.utterances, dialogue);
  const actionMatch = matchItems(knowledge.actions, key.actions, utteranceText);
  const actionsMatched = actionMatch.pairs.map(({ item, key: entry, similarity }) => ({
    keyId: entry.id, keyText: entry.text, producedId: item.id, producedText: item.text, similarity,
    owner: ownerMatches(item.owner, entry.owner, labels),
    due: dueMatches(item.due, entry.due),
    acceptance: item.acceptance === entry.acceptance,
    producedOwner: item.owner ?? "", producedDue: item.due ?? "", producedAcceptance: item.acceptance ?? "(none)",
  }));
  const actions: ActionReport = {
    matched: actionsMatched,
    ownerAccuracy: rate(actionsMatched.filter((row) => row.owner).length, actionsMatched.length),
    dueAccuracy: rate(actionsMatched.filter((row) => row.due).length, actionsMatched.length),
    acceptanceAccuracy: rate(actionsMatched.filter((row) => row.acceptance).length, actionsMatched.length),
    missed: actionMatch.missed.map((entry) => ({ id: entry.id, text: entry.text })),
    extra: actionMatch.extra.map((item) => ({ id: item.id, text: item.text })),
  };
  return { title: key.title, knowledgeStatus: knowledge.status, issues: [...new Set(knowledge.issues.map((issue) => issue.reason))], decisions, actions };
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function formatDecisionEvalReport(report: DecisionEvalReport): string {
  const d = report.decisions; const a = report.actions;
  const produced = [...STATUSES, "(none)"];
  const lines = [
    `# ${report.title}`,
    `knowledge status: ${report.knowledgeStatus}; issues: ${report.issues.join(", ") || "none"}`,
    "",
    "## Decisions",
    `matched ${d.matched.length}, missed ${d.missed.length}, extra ${d.extra.length}`,
    `status accuracy: ${percent(d.statusAccuracy)}`,
    `wrongly labelled confirmed: ${d.wronglyConfirmed} matched + ${d.extraConfirmed} extra`,
    `superseded detection: ${d.superseded.detected}/${d.superseded.known} (recall ${percent(d.superseded.recall)}), replacement correct ${d.superseded.replacementCorrect}`,
    "",
    "confusion (rows = key, columns = produced):",
    `| key \\ produced | ${produced.join(" | ")} |`,
    `|---|${produced.map(() => "---").join("|")}|`,
    ...STATUSES.map((status) => `| ${status} | ${produced.map((column) => String(d.confusion[status][column] ?? 0)).join(" | ")} |`),
    "",
    ...d.matched.map((row) => `- ${row.expected === row.produced ? "ok " : "BAD"} ${row.keyId} [${row.expected} → ${row.produced}] ${row.keyText} ⇐ ${row.producedText} (${row.similarity.toFixed(2)})`),
    ...d.missed.map((row) => `- MISSED ${row.id} [${row.status}] ${row.text}`),
    ...d.extra.map((row) => `- EXTRA [${row.status}] ${row.text}`),
    "",
    "## Actions",
    `matched ${a.matched.length}, missed ${a.missed.length}, extra ${a.extra.length}`,
    `owner accuracy: ${percent(a.ownerAccuracy)}; due accuracy: ${percent(a.dueAccuracy)}; acceptance accuracy: ${percent(a.acceptanceAccuracy)}`,
    "",
    ...a.matched.map((row) => `- ${row.keyId} owner ${row.owner ? "ok" : "BAD"}(${row.producedOwner || "-"}) due ${row.due ? "ok" : "BAD"}(${row.producedDue || "-"}) acceptance ${row.acceptance ? "ok" : "BAD"}(${row.producedAcceptance}) ${row.keyText} ⇐ ${row.producedText}`),
    ...a.missed.map((row) => `- MISSED ${row.id} ${row.text}`),
    ...a.extra.map((row) => `- EXTRA ${row.text}`),
  ];
  return lines.join("\n");
}
