import { extractIndexSource, readNoteIndex, type QnALogNoteIndexCard } from "./note-index";
import { extractSessionId } from "../notes/note-document";
import { readSelectedSessionKnowledge } from "../briefing/session-knowledge";
import { NS_MERGE_BLOCK_RE, NS_ROOT, NS_TYPE_PERSON, NS_TYPE_PERSON_MERGED, NS_TYPE_TODO_CARD, NS_TYPE_VERSION_CACHE, isDerivedVersionType, nsRe, readNamespaceFrontmatter } from "../shared/namespace";
import { isPathUnderRecentNoteRoots, normalizeRecentNoteRoots } from "../recent/recent-note-paths";
import { AUDIO_EXT as AUDIO_FILE_EXTENSIONS } from "../shared/catalog-import";
import { RELATED_NOTE_MIN_BODY_CHARS, type RelatedNoteDocument } from "./related-notes";
export interface RelatedNotesCorpusPort {
  /** Adapter supplies getMarkdownFilesUnderRecentRoots() results; no vault enumeration here. */
  listNoteFiles(): Array<{ path: string; basename: string; mtime: number }>;
  getFrontmatter(path: string): unknown;
  readText(path: string): Promise<string>;
  getResolvedLinks(): Record<string, Record<string, number>>;
  getUnresolvedLinks(): Record<string, Record<string, number>>;
  now(): number;
}

export interface RelatedNotesCorpusOptions { roots: string[]; bodyExcerptChars?: number }
export interface RelatedNotesCorpusStats { excludedDerived: number; excludedMerge: number; tooShort: number; noiseLinks: number; noOutgoingLinks: number }
export interface RelatedNotesCorpusResult { documents: RelatedNoteDocument[]; stats: RelatedNotesCorpusStats; excludedTooShortPaths: string[] }

export const RELATED_NOTE_AUDIO_EXTENSIONS: ReadonlySet<string> = AUDIO_FILE_EXTENSIONS;
export const RELATED_NOTE_NOISE_PATH_SEGMENTS = [".versions", "diagnostics", "queue", "cache"] as const;
const DEFAULT_BODY_EXCERPT_CHARS = 1200;

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string") result.push(item);
    else if (item !== null && typeof item === "object") {
      const text: unknown = Reflect.get(item, "text");
      if (typeof text === "string") result.push(text);
    }
  }
  return result;
}
function normPath(value: string): string { return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""); }
function isNoisePath(value: string): boolean {
  const normalized = normPath(value).toLowerCase();
  return normalized.split("/").some((part) => RELATED_NOTE_NOISE_PATH_SEGMENTS.includes(part as typeof RELATED_NOTE_NOISE_PATH_SEGMENTS[number]))
    || normalized.startsWith(`${NS_ROOT.toLowerCase()}/.versions/`);
}
function isGeneratedLinkTarget(port: RelatedNotesCorpusPort, path: string): boolean {
  const fm = (port.getFrontmatter(path) || {}) as Record<string, unknown>;
  const type = readNamespaceFrontmatter(fm, "type");
  return type === NS_TYPE_PERSON || type === NS_TYPE_PERSON_MERGED || type === NS_TYPE_TODO_CARD;
}
function isDerivedLinkTarget(port: RelatedNotesCorpusPort, path: string): boolean {
  const fm = (port.getFrontmatter(path) || {}) as Record<string, unknown>;
  const type = readNamespaceFrontmatter(fm, "type");
  const sourcePath = readNamespaceFrontmatter(fm, "sourcePath");
  return type === NS_TYPE_VERSION_CACHE || isDerivedVersionType(type)
    || readNamespaceFrontmatter(fm, "containsRaw") === false
    || (typeof sourcePath === "string" && sourcePath.trim().length > 0);
}
function linkTargetName(value: string): string { return value.split("#")[0].split("|")[0].trim().toLocaleLowerCase(); }
function isAudioPath(value: string): boolean { return RELATED_NOTE_AUDIO_EXTENSIONS.has((value.split("#")[0].split(".").pop() || "").toLowerCase()); }
function isMergeNote(title: string, markdown: string): boolean {
  return /(?:·|\s)merge\s*$/i.test(title) || NS_MERGE_BLOCK_RE.test(markdown);
}
function sourceId(fm: Record<string, unknown>, path: string, markdown: string): string {
  const source = fm.source_id ?? fm.qnalog_source_id;
  if (typeof source === "string" && source.trim()) return source.trim();
  const sessionId = extractSessionId(markdown, "");
  if (sessionId) return sessionId;
  const sourcePath = readNamespaceFrontmatter(fm, "sourcePath");
  return typeof sourcePath === "string" && sourcePath ? `source:${normPath(sourcePath)}` : `path:${normPath(path)}`;
}
function timestamp(fm: Record<string, unknown>, fallback: number): number {
  const raw = readNamespaceFrontmatter(fm, "time") ?? fm.date ?? fm.created;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") { const value = Date.parse(raw); if (Number.isFinite(value)) return value; }
  return fallback;
}
function topicStrings(index: QnALogNoteIndexCard | null): string[] {
  return index ? index.topics.map((topic) => topic.title) : [];
}

function stripTranscriptLedger(markdown: string): string {
  const pattern = new RegExp(`<!--\\s*${nsRe("transcript-start")}:[^>]*-->[\\s\\S]*?<!--\\s*${nsRe("transcript-end")}:[^>]*-->`, "gi");
  return markdown.replace(pattern, "");
}

export async function buildRelatedNotesCorpus(port: RelatedNotesCorpusPort, options: RelatedNotesCorpusOptions): Promise<RelatedNotesCorpusResult> {
  const roots = normalizeRecentNoteRoots(options.roots);
  const candidates = port.listNoteFiles().filter((file) => file.path.toLowerCase().endsWith(".md")
    && isPathUnderRecentNoteRoots(file.path, roots) && !isNoisePath(file.path));
  const resolved = port.getResolvedLinks();
  const unresolved = port.getUnresolvedLinks();
  const excludedDerivedPaths = new Set<string>();
  for (const file of candidates) {
    const fm = (port.getFrontmatter(file.path) || {}) as Record<string, unknown>;
    const type = readNamespaceFrontmatter(fm, "type");
    const sourcePath = readNamespaceFrontmatter(fm, "sourcePath");
    if (type === NS_TYPE_VERSION_CACHE || isDerivedVersionType(type) || readNamespaceFrontmatter(fm, "containsRaw") === false
      || (typeof sourcePath === "string" && sourcePath.trim().length > 0)) {
      excludedDerivedPaths.add(normPath(file.path));
    }
  }
  const documents: RelatedNoteDocument[] = [];
  const notePaths = new Set(candidates.map(({ path }) => normPath(path)));
  const excludedMergePaths = new Set<string>();
  const excludedTooShortSet = new Set<string>();
  const excludedTooShortPaths: string[] = [];
  let excludedDerived = excludedDerivedPaths.size;
  let excludedMerge = 0;
  let tooShort = 0;
  let noiseLinks = 0;
  let noOutgoingLinks = 0;
  const rawLinks = new Map<string, string[]>();
  for (const file of candidates) {
    const path = normPath(file.path);
    if (excludedDerivedPaths.has(path) || isNoisePath(path)) continue;
    const fm = ((port.getFrontmatter(file.path) || {}) as Record<string, unknown>);
    if (roots.length && !isPathUnderRecentNoteRoots(file.path, roots)) continue;
    const markdown = await port.readText(file.path);
    if (isMergeNote(file.basename, markdown)) { excludedMerge++; excludedMergePaths.add(path); continue; }
    const index = readNoteIndex(markdown);
    const effectiveBody = extractIndexSource(stripTranscriptLedger(markdown));
    if (!index && effectiveBody.length < RELATED_NOTE_MIN_BODY_CHARS) {
      tooShort++;
      excludedTooShortSet.add(path);
      excludedTooShortPaths.push(path);
      continue;
    }
    const knowledge = readSelectedSessionKnowledge(markdown);
    const frontmatterTags = stringValues(fm.tags ?? fm.tag);
    const people = [
      ...stringValues(readNamespaceFrontmatter(fm, "people")),
      ...stringValues(readNamespaceFrontmatter(fm, "participants")),
      ...stringValues(readNamespaceFrontmatter(fm, "interviewee")),
    ];
    const topics = [...stringValues(readNamespaceFrontmatter(fm, "topic")), ...topicStrings(index), ...(knowledge?.topics.map((topic) => topic.title) || [])];
    const resolvedTargets = Object.keys(resolved[file.path] || {}).map(normPath);
    const unresolvedTargets = Object.keys(unresolved[file.path] || {}).map(linkTargetName).filter((target) => {
      const exclude = target === path.toLocaleLowerCase() || isAudioPath(target) || isNoisePath(target);
      if (exclude) noiseLinks++;
      return !exclude;
    });
    const outgoing = resolvedTargets.filter((target) => {
      const exclude = target === path || isAudioPath(target) || isNoisePath(target)
        || excludedDerivedPaths.has(target) || isDerivedLinkTarget(port, target);
      if (exclude) noiseLinks++;
      return !exclude;
    });
    const generatedOutLinks = outgoing.filter((target) => isGeneratedLinkTarget(port, target));
    const storedSourcePath = readNamespaceFrontmatter(fm, "sourcePath");
    const sourcePathValue = typeof storedSourcePath === "string" ? normPath(storedSourcePath) : undefined;
    const sourceIdValue = sourceId(fm, file.path, markdown);
    rawLinks.set(path, outgoing);
    const title = index?.core.title || file.basename.replace(/\.md$/i, "");
    const summary = index?.core.summary || knowledge?.topics.map((topic) => topic.summary).join(" ") || "";
    const bodyExcerpt = effectiveBody.slice(0, options.bodyExcerptChars ?? DEFAULT_BODY_EXCERPT_CHARS);
    documents.push({
      path, sourceId: sourceIdValue, sourcePath: sourcePathValue,
      title, timestamp: timestamp(fm, file.mtime || port.now()), tags: frontmatterTags,
      people, topics, summary,
      decisions: knowledge?.decisions.map((item) => item.text) || index?.knowledge.decisions || [],
      actions: knowledge?.actions.map((item) => item.text) || index?.knowledge.actions || [],
      questions: knowledge?.questions.map((item) => item.text) || index?.knowledge.questions || [],
      bodyExcerpt, outLinks: outgoing, generatedOutLinks, inLinks: [], unresolvedTargets,
      precision: index || knowledge ? "full" : "body-only",
      hasIndexCard: index !== null,
    });
  }
  for (const doc of documents) {
    const outgoing = doc.outLinks.filter((target) => {
      const exclude = excludedMergePaths.has(target) || excludedTooShortSet.has(target);
      if (exclude) noiseLinks++;
      return !exclude;
    });
    doc.outLinks = outgoing;
    doc.generatedOutLinks = doc.generatedOutLinks?.filter((target) => !excludedMergePaths.has(target) && !excludedTooShortSet.has(target));
    rawLinks.set(doc.path, outgoing);
    if (!outgoing.length) noOutgoingLinks++;
  }
  const reverseLinks = new Map<string, string[]>();
  for (const [source, targets] of rawLinks) for (const target of targets) {
    if (!notePaths.has(target) || excludedDerivedPaths.has(target) || excludedTooShortSet.has(target) || excludedMergePaths.has(target)) continue;
    const sources = reverseLinks.get(target) || [];
    sources.push(source); reverseLinks.set(target, sources);
  }
  for (const doc of documents) {
    doc.inLinks = reverseLinks.get(doc.path) || [];
    doc.inLinkOutDegrees = Object.fromEntries(doc.inLinks.map((source) => [source, Object.keys(resolved[source] || {}).length]));
  }
  // Derived outgoing links are omitted so they cannot change source backlink or co-link evidence.
  return { documents, stats: { excludedDerived, excludedMerge, tooShort, noiseLinks, noOutgoingLinks }, excludedTooShortPaths };
}

export class RelatedNotesCorpusCache {
  private documents: RelatedNoteDocument[] | null = null;
  private readonly mtimes = new Map<string, number>();
  constructor(
    private readonly load: () => Promise<RelatedNoteDocument[]>,
    private readonly getMtime: (path: string) => number | null,
    private readonly listPaths: () => string[],
  ) {}
  async get(): Promise<RelatedNoteDocument[]> {
    const paths = [...new Set(this.listPaths())].sort();
    const unchanged = this.documents !== null && paths.length === this.mtimes.size
      && paths.every((path) => this.mtimes.get(path) === (this.getMtime(path) ?? -1));
    if (unchanged) return this.documents || [];
    this.documents = await this.load();
    this.mtimes.clear();
    for (const path of paths) this.mtimes.set(path, this.getMtime(path) ?? -1);
    return this.documents;
  }
  invalidate(path?: string): void {
    if (path === undefined) { this.documents = null; this.mtimes.clear(); return; }
    this.documents = null;
    this.mtimes.delete(path);
  }
  rebuild(): Promise<RelatedNoteDocument[]> { this.invalidate(); return this.get(); }
}
