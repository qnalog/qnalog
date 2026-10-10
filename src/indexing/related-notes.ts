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
  direction: "mutual" | "forward-only-link" | "reverse-only-link";
  forwardScore: number;
  reverseScore: number;
}

export interface RelatedNoteCommonTerm {
  term: string;
  documentFrequency: number;
}

export const RELATED_NOTES_DEFAULT_LIMIT = 8;
export const RELATED_NOTES_DEFAULT_MIN_SCORE = 0.05;
export const MIN_DIRECTIONAL_SCORE = 0.05;
export const RELATED_NOTES_DEFAULT_RELATIVE_CUTOFF = 0.45;
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
type FieldTokens = Record<FieldName, string[]>;
type FieldFrequencies = Record<FieldName, Map<string, number>>;
function fieldTokens(doc: RelatedNoteDocument): FieldTokens {
  const values = getFieldValues(doc);
  return Object.fromEntries(FIELD_NAMES.map((field) => [field, values[field].flatMap(tokenize)])) as FieldTokens;
}
function fieldFrequencies(fields: FieldTokens): FieldFrequencies {
  return Object.fromEntries(FIELD_NAMES.map((field) => {
    const frequencies = new Map<string, number>();
    for (const term of fields[field]) frequencies.set(term, (frequencies.get(term) || 0) + 1);
    return [field, frequencies];
  })) as FieldFrequencies;
}
function documentFrequencies(fieldsByDocument: FieldTokens[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const fields of fieldsByDocument) {
    for (const term of new Set(FIELD_NAMES.flatMap((field) => fields[field]))) {
      frequencies.set(term, (frequencies.get(term) || 0) + 1);
    }
  }
  return frequencies;
}
function eligibleDocuments(corpus: RelatedNoteDocument[]): RelatedNoteDocument[] {
  const collapsed = new Map<string, RelatedNoteDocument>();
  for (const doc of corpus) {
    if (doc.isMergeNote || (!doc.hasIndexCard && doc.bodyExcerpt.length < RELATED_NOTE_MIN_BODY_CHARS)) continue;
    const previous = collapsed.get(doc.sourceId);
    const preferCurrent = previous && Boolean(previous.sourcePath) && !doc.sourcePath;
    const sameOrigin = previous && Boolean(previous.sourcePath) === Boolean(doc.sourcePath);
    if (!previous || preferCurrent || (sameOrigin && doc.timestamp > previous.timestamp)) collapsed.set(doc.sourceId, doc);
  }
  return [...collapsed.values()];
}

function commonTerms(fieldsByDocument: FieldTokens[], knownFrequencies?: Map<string, number>): RelatedNoteCommonTerm[] {
  if (fieldsByDocument.length < RELATED_NOTES_COMMON_TERM_MIN_CORPUS) return [];
  const frequencies = knownFrequencies || documentFrequencies(fieldsByDocument);
  return [...frequencies].filter(([, frequency]) => frequency / fieldsByDocument.length > RELATED_NOTES_COMMON_TERM_RATIO)
    .map(([term, documentFrequency]) => ({ term, documentFrequency }))
    .sort((left, right) => right.documentFrequency - left.documentFrequency || left.term.localeCompare(right.term));
}

export function getCommonRelatedNoteTerms(corpus: RelatedNoteDocument[]): RelatedNoteCommonTerm[] {
  return commonTerms(eligibleDocuments(corpus).map(fieldTokens));
}


function averageFieldLengths(fieldsByDocument: FieldTokens[]): Record<FieldName, number> {
  return Object.fromEntries(FIELD_NAMES.map((field) => [
    field,
    Math.max(1, fieldsByDocument.reduce((sum, fields) => sum + fields[field].length, 0) / Math.max(1, fieldsByDocument.length)),
  ])) as Record<FieldName, number>;
}
function idfWeight(term: string, documentFrequencies: Map<string, number>, documentCount: number): number {
  const frequency = documentFrequencies.get(term) || 0;
  return Math.log(1 + (documentCount - frequency + 0.5) / (frequency + 0.5));
}
function bm25FieldScore(term: string, fields: FieldTokens, frequencies: FieldFrequencies, averageLengths: Record<FieldName, number>): number {
  let total = 0;
  for (const field of FIELD_NAMES) {
    const frequency = frequencies[field].get(term) || 0;
    if (!frequency) continue;
    const lengthNorm = (1 - RELATED_NOTES_B) + RELATED_NOTES_B * (fields[field].length / averageLengths[field]);
    total += FIELD_BOOSTS[field] * (frequency * (RELATED_NOTES_K1 + 1)) / (frequency + RELATED_NOTES_K1 * lengthNorm);
  }
  return total;
}
function scoreTerms(
  terms: string[],
  fields: FieldTokens,
  frequencies: FieldFrequencies,
  documentFrequencies: Map<string, number>,
  documentCount: number,
  averageLengths: Record<FieldName, number>,
): number {
  let total = 0;
  for (const term of terms) total += idfWeight(term, documentFrequencies, documentCount) * bm25FieldScore(term, fields, frequencies, averageLengths);
  return total;
}
interface IndexedRelatedNote {
  doc: RelatedNoteDocument;
  fields: FieldTokens;
  frequencies: FieldFrequencies;
  terms: Set<string>;
  queryTerms: string[];
  scoredQueryTerms: string[];
  queryScale: number;
  selfScore: number;
}
function canonicalDegrees(doc: RelatedNoteDocument): Map<string, number> {
  return new Map(Object.entries(doc.inLinkOutDegrees || {}).map(([source, degree]) => [canonicalTarget(source), degree]));
}
function indexRelatedNote(
  doc: RelatedNoteDocument,
  fields: FieldTokens,
  common: Set<string>,
  documentFrequencies: Map<string, number>,
  documentCount: number,
  averageLengths: Record<FieldName, number>,
): IndexedRelatedNote {
  const frequencies = fieldFrequencies(fields);
  const terms = new Set(FIELD_NAMES.flatMap((field) => fields[field]));
  const bodyQueryFallback = doc.precision === "body-only" ? doc.bodyExcerpt.slice(0, 320) : "";
  const queryTerms = unique(tokenize(`${buildQueryFromDocument(doc)} ${bodyQueryFallback}`));
  const scoredQueryTerms = queryTerms.filter((term) => !common.has(term));
  const queryScale = doc.precision === "full" ? 1 : 0.65;
  const selfScore = scoreTerms(scoredQueryTerms, fields, frequencies, documentFrequencies, documentCount, averageLengths) * queryScale;
  return { doc, fields, frequencies, terms, queryTerms, scoredQueryTerms, queryScale, selfScore };
}
const LINK_WEIGHTS = {
  directLink: 2.4,
  sharedTarget: 0.75,
  generatedSharedTarget: 0.28,
  sharedUnresolved: 12,
  coLinked: 0.65,
} as const;
interface LinkScoringContext {
  population: number;
  outgoingFrequency: Map<string, number>;
  unresolvedFrequency: Map<string, number>;
  outDegreeByPath: Map<string, number>;
  degreeByDocPath: Map<string, Map<string, number>>;
}
function targetFrequencies(docs: RelatedNoteDocument[], field: "outLinks" | "unresolvedTargets"): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const doc of docs) {
    for (const target of new Set(doc[field].map(canonicalTarget).filter(Boolean))) {
      frequencies.set(target, (frequencies.get(target) || 0) + 1);
    }
  }
  return frequencies;
}
function createLinkScoringContext(corpus: RelatedNoteDocument[], current: RelatedNoteDocument): LinkScoringContext {
  const includesCurrent = corpus.some((doc) => doc.path === current.path);
  const documents = includesCurrent ? corpus : [...corpus, current];
  return {
    population: documents.length,
    outgoingFrequency: targetFrequencies(documents, "outLinks"),
    unresolvedFrequency: targetFrequencies(documents, "unresolvedTargets"),
    outDegreeByPath: new Map(documents.map((doc) => [
      canonicalTarget(doc.path),
      unique(doc.outLinks.map(canonicalTarget).filter(Boolean)).length,
    ])),
    degreeByDocPath: new Map(documents.map((doc) => [canonicalTarget(doc.path), canonicalDegrees(doc)])),
  };
}
function graphTargetIdf(target: string, context: LinkScoringContext, field: "outLinks" | "unresolvedTargets"): number {
  const frequencies = field === "outLinks" ? context.outgoingFrequency : context.unresolvedFrequency;
  return Math.log((context.population + 1) / ((frequencies.get(target) || 0) + 1));
}
function coLinkedWeight(source: string, current: RelatedNoteDocument, candidate: RelatedNoteDocument, context: LinkScoringContext): number {
  const currentDegrees = context.degreeByDocPath.get(canonicalTarget(current.path));
  const candidateDegrees = context.degreeByDocPath.get(canonicalTarget(candidate.path));
  const outDegree = currentDegrees?.get(source) ?? candidateDegrees?.get(source) ?? context.outDegreeByPath.get(source);
  if (outDegree === undefined || outDegree > RELATED_NOTES_MAX_CO_LINK_OUT_DEGREE) return 0;
  const frequencyFactor = Math.max(0, Math.log((context.population + 1) / (outDegree + 1)) / Math.log(context.population + 1));
  return LINK_WEIGHTS.coLinked * frequencyFactor;
}
function linkFeatures(current: RelatedNoteDocument, candidate: RelatedNoteDocument, context: LinkScoringContext): { score: number; reasons: RelatedNoteReason[] } {
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
      return total + weight * graphTargetIdf(target, context, "outLinks");
    }, 0);
    reasons.push("shared-target");
  }
  const unresolved = overlap(current.unresolvedTargets, candidate.unresolvedTargets);
  if (unresolved.length) {
    score += unresolved.reduce((total, target) => total + LINK_WEIGHTS.sharedUnresolved * graphTargetIdf(target, context, "unresolvedTargets"), 0);
    reasons.push("shared-unresolved");
  }
  const coLinked = overlap(current.inLinks, candidate.inLinks);
  const coLinkedScore = coLinked.reduce((total, source) => total + coLinkedWeight(source, current, candidate, context), 0);
  if (coLinkedScore > 0) { score += coLinkedScore; reasons.push("co-linked"); }
  return { score, reasons };
}

/** Rank corpus notes by symmetric reciprocal relevance, with explicit direct-link exceptions. */
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
  const fieldsByDocument = docs.map(fieldTokens);
  const documentFrequenciesByTerm = documentFrequencies(fieldsByDocument);
  const common = new Set(commonTerms(fieldsByDocument, documentFrequenciesByTerm).map(({ term }) => term));
  const averageLengths = averageFieldLengths(fieldsByDocument);
  const indexedDocs = docs.map((doc, index) => indexRelatedNote(
    doc, fieldsByDocument[index], common, documentFrequenciesByTerm, docs.length, averageLengths,
  ));
  const indexedByPath = new Map(indexedDocs.map((profile) => [profile.doc.path, profile]));
  const currentProfile = indexedByPath.get(current.path) || indexRelatedNote(
    current, fieldTokens(current), common, documentFrequenciesByTerm, docs.length, averageLengths,
  );
  const linkContext = createLinkScoringContext(docs, current);
  const timestampByPath = new Map(docs.map((doc) => [doc.path, doc.timestamp]));
  const results: RelatedNoteMatch[] = [];

  for (const candidateProfile of indexedDocs) {
    const candidate = candidateProfile.doc;
    if (candidate.path === current.path || candidate.sourceId === current.sourceId
      || candidate.sourcePath === current.path || current.sourcePath === candidate.path) continue;
    const links = linkFeatures(current, candidate, linkContext);
    const screenedByLexicalOverlap = [...currentProfile.terms].some((term) => candidateProfile.terms.has(term));
    if (!screenedByLexicalOverlap && links.score <= 0) continue;
    const forwardMatchedTerms = currentProfile.queryTerms.filter((term) => candidateProfile.terms.has(term));

    const forwardScoredTerms = currentProfile.scoredQueryTerms.filter((term) => candidateProfile.terms.has(term));
    const forwardLexicalScore = scoreTerms(
      forwardScoredTerms, candidateProfile.fields, candidateProfile.frequencies,
      documentFrequenciesByTerm, docs.length, averageLengths,
    ) * currentProfile.queryScale;
    const forwardScore = currentProfile.selfScore > 0
      ? Math.min(1, (forwardLexicalScore + links.score) / currentProfile.selfScore)
      : 0;

    const reverseMatchedTerms = candidateProfile.queryTerms.filter((term) => currentProfile.terms.has(term));
    const reverseScoredTerms = candidateProfile.scoredQueryTerms.filter((term) => currentProfile.terms.has(term));
    const reverseLexicalScore = scoreTerms(
      reverseScoredTerms, currentProfile.fields, currentProfile.frequencies,
      documentFrequenciesByTerm, docs.length, averageLengths,
    ) * candidateProfile.queryScale;
    const reverseScore = candidateProfile.selfScore > 0
      ? Math.min(1, (reverseLexicalScore + links.score) / candidateProfile.selfScore)
      : 0;
    const hasLinkException = links.reasons.includes("direct-link") || links.reasons.includes("shared-unresolved");
    const mutuallyRelevant = forwardScore >= MIN_DIRECTIONAL_SCORE && reverseScore >= MIN_DIRECTIONAL_SCORE;
    if (!mutuallyRelevant && !hasLinkException) continue;
    let score: number;
    if (forwardScore > 0 && reverseScore > 0) score = Math.sqrt(forwardScore * reverseScore);
    else if (hasLinkException) {
      const positiveSelfScores = [currentProfile.selfScore, candidateProfile.selfScore].filter((value) => value > 0);
      const denominator = positiveSelfScores.length ? Math.min(...positiveSelfScores) : links.score;
      const linkFallback = links.score > 0 ? Math.min(1, links.score / denominator) : 0;
      score = Math.max(forwardScore, reverseScore, linkFallback);
    } else continue;
    if (!(score > 0)) continue;
    const direction = mutuallyRelevant
      ? "mutual"
      : forwardScore >= reverseScore ? "forward-only-link" : "reverse-only-link";
    const matchedTerms = unique([...forwardMatchedTerms, ...reverseMatchedTerms])
      .map((term) => common.has(term) ? `common:${term}` : term);
    const reasons = [...links.reasons];
    if (forwardScoredTerms.length || reverseScoredTerms.length) reasons.push("lexical-overlap");
    else if (links.reasons.length) reasons.push("link-only");
    results.push({ path: candidate.path, score, forwardScore, reverseScore, matchedTerms, reasons: unique(reasons), direction });
  }
  if (!results.length) return [];
  const topScore = Math.max(...results.map(({ score }) => score));
  return results.filter(({ score }) => score >= minScore && score >= topScore * Math.max(0, Math.min(1, relativeCutoff)))
    .sort((a, b) => b.score - a.score
      || (timestampByPath.get(b.path) ?? 0) - (timestampByPath.get(a.path) ?? 0)
      || a.path.localeCompare(b.path)).slice(0, limit);
}
