export interface RelatedNoteDocument {
  path: string;
  sourceId: string;
  title: string;
  timestamp: number;
  tags: string[];
  people: string[];
  topics: string[];
  summary: string;
  decisions: string[];
  actions: string[];
  questions: string[];
  bodyExcerpt: string;
  outLinks: string[];
  generatedOutLinks?: string[];
  inLinks: string[];
  inLinkOutDegrees?: Record<string, number>;
  unresolvedTargets: string[];
  precision: "full" | "body-only";
  hasIndexCard: boolean;
  sourcePath?: string;
  isMergeNote?: boolean;
}

export type RelatedNoteReason = "direct-link" | "shared-target" | "shared-unresolved" | "co-linked" | "lexical-overlap" | "link-only";

export interface RelatedNotesOptions {
  limit?: number;
  minScore?: number;
  relativeCutoff?: number;
}

export interface RelatedNoteMatch {
  path: string;
  score: number;
  matchedTerms: string[];
  reasons: RelatedNoteReason[];
}

export interface RelatedNoteCommonTerm {
  term: string;
  documentFrequency: number;
}

export const RELATED_NOTES_DEFAULT_LIMIT = 8;
// The 26-document read-only corpus retained candidates from 0.05 upward; the relative cutoff removes weaker tails.
export const RELATED_NOTES_DEFAULT_MIN_SCORE = 0.05;
export const RELATED_NOTES_DEFAULT_RELATIVE_CUTOFF = 0.4;
export const RELATED_NOTES_COMMON_TERM_RATIO = 0.35;
export const RELATED_NOTES_COMMON_TERM_MIN_CORPUS = 20;
export const RELATED_NOTE_MIN_BODY_CHARS = 80;
export const RELATED_NOTES_MAX_CO_LINK_OUT_DEGREE = 20;
export const RELATED_NOTES_K1 = 1.2;
export const RELATED_NOTES_B = 0.75;
export const RELATED_NOTES_MAX_TERM_LENGTH = 64;

const FIELD_BOOSTS = {
  title: 3.2,
  tags: 2.5,
  people: 2.2,
  topics: 2.4,
  summary: 1.8,
  decisions: 1.5,
  actions: 1.3,
  questions: 1.3,
  bodyExcerpt: 0.7,
} as const;

const STOP_BIGRAMS_TEXT = "然后 因为 所以 但是 如果 这个 那个 我们 你们 他们 一个 一些 进行 可以 需要 没有 不是 还是 就是 什么 怎么 如何 以及 或者 时候 现在 今天 明天 昨天 觉得 知道 问题 事情 工作 公司 大家 比较 非常 可能 应该 已经 目前 其实 其中 通过 关于 对于 个人 人笔 笔记 摘要 录音 会议 项目 进展 整理 本次 主要 包括 核心 记录 当前 使用 情况 梳理 围绕 涉及 针对 部分 过程 重点 目的 此外 同时 首先";
const STOP_BIGRAMS: Readonly<Record<string, true>> = Object.fromEntries(
  STOP_BIGRAMS_TEXT.split(" ").map((term) => [term, true]),
);

const FIELD_NAMES = Object.keys(FIELD_BOOSTS) as Array<keyof typeof FIELD_BOOSTS>;
const unique = <T>(items: T[]): T[] => [...new Set(items)];
const normalize = (value: string): string => value.normalize("NFKC").toLocaleLowerCase();
function canonicalTarget(target: string): string {
  return normalize(target).replace(/\\/g, "/").replace(/\.md$/i, "").replace(/^\/+|\/+$/g, "");
}
function overlap(left: string[], right: string[]): string[] {
  const targets = new Set(right.map(canonicalTarget).filter(Boolean));
  return unique(left.map(canonicalTarget).filter((target) => target && targets.has(target)));
}

/** Tokenize text into lowercase ASCII words and contiguous Han-script bigrams. */
export function tokenize(text: string): string[] {
  const normalized = normalize(text);
  const tokens: string[] = [];
  let latin = "";
  let han = "";
  const flushLatin = () => {
    if (latin) tokens.push(latin.slice(0, RELATED_NOTES_MAX_TERM_LENGTH));
    latin = "";
  };
  const flushHan = () => {
    const chars = Array.from(han);
    for (let i = 0; i + 1 < chars.length; i++) {
      const bigram = chars[i] + chars[i + 1];
      if (STOP_BIGRAMS[bigram] !== true) tokens.push(bigram);
    }
    han = "";
  };
  for (const char of normalized) {
    if (/^[\p{Script=Han}]$/u.test(char)) {
      flushLatin();
      han += char;
    } else if (/^[a-z0-9]$/i.test(char)) {
      flushHan();
      latin += char;
    } else {
      flushLatin();
      flushHan();
    }
  }
  flushLatin();
  flushHan();
  return tokens;
}

/** Query fields follow the index card and frontmatter, not the source-body excerpt. */
export function buildQueryFromDocument(doc: RelatedNoteDocument): string {
  const title = doc.title.replace(/\b\d{4}-\d{1,2}-\d{1,2}(?:\s+\d{3,4})?\b/g, " ");
  return [title, ...doc.topics, ...doc.people, ...doc.decisions, doc.summary].filter(Boolean).join(" ").trim();
}

type FieldName = keyof typeof FIELD_BOOSTS;
type FieldValues = Record<FieldName, string[]>;
function getFieldValues(doc: RelatedNoteDocument): FieldValues {
  return {
    title: [doc.title], tags: doc.tags, people: doc.people, topics: doc.topics,
    summary: [doc.summary], decisions: doc.decisions, actions: doc.actions,
    questions: doc.questions, bodyExcerpt: [doc.bodyExcerpt],
  };
}
function fieldTokens(doc: RelatedNoteDocument): Record<FieldName, string[]> {
  const values = getFieldValues(doc);
  return Object.fromEntries(FIELD_NAMES.map((field) => [field, values[field].flatMap(tokenize)])) as Record<FieldName, string[]>;
}

function eligibleDocuments(corpus: RelatedNoteDocument[]): RelatedNoteDocument[] {
  const collapsed = new Map<string, RelatedNoteDocument>();
  for (const doc of corpus) {
    if (doc.isMergeNote || (!doc.hasIndexCard && doc.bodyExcerpt.length < RELATED_NOTE_MIN_BODY_CHARS)) continue;
    const previous = collapsed.get(doc.sourceId);
    if (!previous || doc.timestamp > previous.timestamp) collapsed.set(doc.sourceId, doc);
  }
  return [...collapsed.values()];
}

function commonTerms(fieldsByDocument: Array<Record<FieldName, string[]>>): RelatedNoteCommonTerm[] {
  if (fieldsByDocument.length < RELATED_NOTES_COMMON_TERM_MIN_CORPUS) return [];
  const frequencies = new Map<string, number>();
  for (const fields of fieldsByDocument) {
    for (const term of new Set(FIELD_NAMES.flatMap((field) => fields[field]))) {
      frequencies.set(term, (frequencies.get(term) || 0) + 1);
    }
  }
  return [...frequencies].filter(([, frequency]) => frequency / fieldsByDocument.length > RELATED_NOTES_COMMON_TERM_RATIO)
    .map(([term, documentFrequency]) => ({ term, documentFrequency }))
    .sort((left, right) => right.documentFrequency - left.documentFrequency || left.term.localeCompare(right.term));
}

export function getCommonRelatedNoteTerms(corpus: RelatedNoteDocument[]): RelatedNoteCommonTerm[] {
  return commonTerms(eligibleDocuments(corpus).map(fieldTokens));
}

function mappedOutDegree(doc: RelatedNoteDocument, source: string): number | undefined {
  for (const [path, degree] of Object.entries(doc.inLinkOutDegrees || {})) {
    if (canonicalTarget(path) === source) return degree;
  }
  return undefined;
}

function coLinkedWeight(source: string, current: RelatedNoteDocument, candidate: RelatedNoteDocument, corpus: RelatedNoteDocument[]): number {
  const outDegree = mappedOutDegree(current, source) ?? mappedOutDegree(candidate, source)
    ?? corpus.find((doc) => canonicalTarget(doc.path) === source)?.outLinks.length;
  if (outDegree === undefined || outDegree > RELATED_NOTES_MAX_CO_LINK_OUT_DEGREE) return 0;
  const population = Math.max(1, corpus.length);
  const frequencyFactor = Math.max(0, Math.log((population + 1) / (outDegree + 1)) / Math.log(population + 1));
  return LINK_WEIGHTS.coLinked * frequencyFactor;
}
function idf(term: string, fieldsByDocument: Array<Record<FieldName, string[]>>): number {
  const df = fieldsByDocument.reduce((count, fields) => count + (FIELD_NAMES.some((field) => fields[field].includes(term)) ? 1 : 0), 0);
  return Math.log(1 + (fieldsByDocument.length - df + 0.5) / (df + 0.5));
}
function averageFieldLengths(fieldsByDocument: Array<Record<FieldName, string[]>>): Record<FieldName, number> {
  return Object.fromEntries(FIELD_NAMES.map((field) => [
    field,
    Math.max(1, fieldsByDocument.reduce((sum, fields) => sum + fields[field].length, 0) / Math.max(1, fieldsByDocument.length)),
  ])) as Record<FieldName, number>;
}

function bm25FieldScore(term: string, fields: Record<FieldName, string[]>, averageLengths: Record<FieldName, number>): number {
  let total = 0;
  for (const field of FIELD_NAMES) {
    const tokens = fields[field];
    const frequency = tokens.filter((token) => token === term).length;
    if (!frequency) continue;
    const lengthNorm = (1 - RELATED_NOTES_B) + RELATED_NOTES_B * (tokens.length / averageLengths[field]);
    total += FIELD_BOOSTS[field] * (frequency * (RELATED_NOTES_K1 + 1)) / (frequency + RELATED_NOTES_K1 * lengthNorm);
  }
  return total;
}
const LINK_WEIGHTS = {
  directLink: 2.4,
  sharedTarget: 0.75,
  generatedSharedTarget: 0.28,
  sharedUnresolved: 12,
  coLinked: 0.65,
} as const;
function graphTargetIdf(target: string, current: RelatedNoteDocument, corpus: RelatedNoteDocument[], field: "outLinks" | "unresolvedTargets"): number {
  const hasCurrent = corpus.some((doc) => doc.path === current.path);
  const population = corpus.length + (hasCurrent ? 0 : 1);
  const documentFrequency = corpus.filter((doc) => doc[field].some((link) => canonicalTarget(link) === target)).length
    + (!hasCurrent && current[field].some((link) => canonicalTarget(link) === target) ? 1 : 0);
  return Math.log((population + 1) / (documentFrequency + 1));
}
function linkFeatures(current: RelatedNoteDocument, candidate: RelatedNoteDocument, corpus: RelatedNoteDocument[]): { score: number; reasons: RelatedNoteReason[] } {
  let score = 0;
  const reasons: RelatedNoteReason[] = [];
  const direct = current.outLinks.some((link) => canonicalTarget(link) === canonicalTarget(candidate.path))
    || candidate.outLinks.some((link) => canonicalTarget(link) === canonicalTarget(current.path));
  if (direct) { score += LINK_WEIGHTS.directLink; reasons.push("direct-link"); }
  const shared = overlap(current.outLinks, candidate.outLinks);
  if (shared.length) {
    score += shared.reduce((total, target) => {
      const generated = current.generatedOutLinks?.some((link) => canonicalTarget(link) === target)
        || candidate.generatedOutLinks?.some((link) => canonicalTarget(link) === target);
      const weight = generated ? LINK_WEIGHTS.generatedSharedTarget : LINK_WEIGHTS.sharedTarget;
      return total + weight * graphTargetIdf(target, current, corpus, "outLinks");
    }, 0);
    reasons.push("shared-target");
  }
  const unresolved = overlap(current.unresolvedTargets, candidate.unresolvedTargets);
  if (unresolved.length) {
    score += unresolved.reduce((total, target) => total + LINK_WEIGHTS.sharedUnresolved * graphTargetIdf(target, current, corpus, "unresolvedTargets"), 0);
    reasons.push("shared-unresolved");
  }
  const coLinked = overlap(current.inLinks, candidate.inLinks);
  const coLinkedScore = coLinked.reduce((total, source) => total + coLinkedWeight(source, current, candidate, corpus), 0);
  if (coLinkedScore > 0) { score += coLinkedScore; reasons.push("co-linked"); }
  return { score, reasons };
}

/** Rank corpus notes by lexical similarity and explicit graph evidence. */
export function findRelatedNotes(
  corpus: RelatedNoteDocument[],
  current: RelatedNoteDocument,
  options: RelatedNotesOptions = {},
): RelatedNoteMatch[] {
  const limit = Math.max(0, Math.floor(options.limit ?? RELATED_NOTES_DEFAULT_LIMIT));
  const minScore = options.minScore ?? RELATED_NOTES_DEFAULT_MIN_SCORE;
  const relativeCutoff = options.relativeCutoff ?? RELATED_NOTES_DEFAULT_RELATIVE_CUTOFF;
  if (!limit || !Number.isFinite(minScore) || !Number.isFinite(relativeCutoff)) return [];
  const docs = eligibleDocuments(corpus);
  if (!current.hasIndexCard && current.bodyExcerpt.length < RELATED_NOTE_MIN_BODY_CHARS) return [];
  const queryTerms = unique(tokenize(buildQueryFromDocument(current)));
  if (!queryTerms.length) return [];
  const indexedDocs = docs.map((doc) => ({ doc, fields: fieldTokens(doc) }));
  const fieldsByDocument = indexedDocs.map(({ fields }) => fields);
  const common = new Set(commonTerms(fieldsByDocument).map(({ term }) => term));
  const scoredQueryTerms = queryTerms.filter((term) => !common.has(term));
  const averageLengths = averageFieldLengths(fieldsByDocument);
  const currentFields = fieldTokens(current);
  const queryScale = current.precision === "full" ? 1 : 0.65;
  const selfScore = scoredQueryTerms.reduce((sum, term) => sum + idf(term, fieldsByDocument) * bm25FieldScore(term, currentFields, averageLengths), 0) * queryScale;
  if (!(selfScore > 0)) return [];
  const timestampByPath = new Map(docs.map((doc) => [doc.path, doc.timestamp]));
  const results: RelatedNoteMatch[] = [];
  for (const { doc: candidate, fields: candidateFields } of indexedDocs) {
    if (candidate.path === current.path || candidate.sourceId === current.sourceId
      || candidate.sourcePath === current.path || current.sourcePath === candidate.path) continue;
    const allMatchedTerms = queryTerms.filter((term) => FIELD_NAMES.some((field) => candidateFields[field].includes(term)));
    const scoredTerms = allMatchedTerms.filter((term) => !common.has(term));
    const lexicalScore = scoredTerms.reduce((sum, term) => sum + idf(term, fieldsByDocument) * bm25FieldScore(term, candidateFields, averageLengths), 0)
      * queryScale;
    const links = linkFeatures(current, candidate, docs);
    const rawScore = lexicalScore + links.score;
    if (!(rawScore > 0)) continue;
    const score = Math.min(1, rawScore / selfScore);
    const matchedTerms = allMatchedTerms.map((term) => common.has(term) ? `common:${term}` : term);
    const reasons = [...links.reasons];
    if (scoredTerms.length) reasons.push("lexical-overlap");
    else if (links.reasons.length) reasons.push("link-only");
    results.push({ path: candidate.path, score, matchedTerms, reasons });
  }
  if (!results.length) return [];
  const topScore = Math.max(...results.map(({ score }) => score));
  return results.filter(({ score }) => score >= minScore && score >= topScore * Math.max(0, Math.min(1, relativeCutoff)))
    .sort((a, b) => b.score - a.score
      || (timestampByPath.get(b.path) ?? 0) - (timestampByPath.get(a.path) ?? 0)
      || a.path.localeCompare(b.path)).slice(0, limit);
}
