import * as obsidian from "obsidian";
import { buildEmptyLlmOutputFallback } from "./note-write-content";
import { AI_FAILURE_PLACEHOLDER_RE, findActiveVersionBlock, splitLeadingFrontmatter } from "./note-document";
import { readRepolishInput } from "./repolish-input";
import { extractTranscriptSegments } from "./note-transcript-ledger";
import { getTaskErrorMessage } from "../shared/task-activity";
import { t } from "../shared/i18n";
import type { Segment } from "../shared/types";
import type { TaskActivity, TaskActivityInput } from "../shared/task-activity";
import type { OriginalSnapshotBodyUpdate } from "../versions/original-snapshot-store";
import { buildVersionPayload } from "../versions/version-content";
import { NS_FM } from "../shared/namespace";
import { normalizeSessionKnowledgeMarkers } from "../briefing/session-knowledge";
import type { ErrataRules } from "../errata/errata-apply";

export interface ReorganizeInPlacePort {
  getVault(): Pick<obsidian.Vault, "read" | "process">;
  getCachedFrontmatter(file: obsidian.TFile): Record<string, unknown> | null | undefined;
  loadErrata(file: obsidian.TFile): Promise<ErrataRules | null>;
  getDefaultMode(): string;
  getModeDisplayName(mode: string): string;
  getInFlight(): Set<string>;
  mergeAndPolish(segments: Segment[], mode: string, sessionMeta: Record<string, unknown>, frontmatter: Record<string, unknown> | null): Promise<string>;
  clearCommittedBriefingCheckpoint(sessionMeta: Record<string, unknown>): Promise<void>;
  /** 笔记里没有原始转写时，询问并用对应录音重新转写写回；返回是否已写回。 */
  recoverOriginalTranscript(file: obsidian.TFile): Promise<boolean>;
  stripModeSuggestionBlocks(text: string): string;
  validateOriginalVersionForReorganization(file: obsidian.TFile): Promise<void>;
  replaceOriginalVersionBody(file: obsidian.TFile, payload: string): Promise<OriginalSnapshotBodyUpdate | null>;
  restoreOriginalVersionBody(file: obsidian.TFile, update: OriginalSnapshotBodyUpdate): Promise<void>;
  switchVersion(versionPath: string, sourcePath: string): Promise<void>;
  refreshNoteIndex(file: obsidian.TFile, options: { reason: string }): Promise<unknown>;
  tasks: {
    startTaskActivity(input: TaskActivityInput): unknown;
    patchTaskActivity(id: string, patch: Partial<TaskActivity>): unknown;
    completeTaskActivity(id: string, patch: Partial<TaskActivity>): unknown;
    failTaskActivity(id: string, error: unknown, patch: Partial<TaskActivity>): unknown;
  };
}

const GENERATED_FRONTMATTER_KEYS = new Set<string>([
  "title", "aliases", "tags", NS_FM.people, NS_FM.topic, NS_FM.source, NS_FM.language,
  NS_FM.coreQuestion, NS_FM.participants, NS_FM.interviewee, NS_FM.interviewer,
  NS_FM.seminarSubject, NS_FM.decisionMaker, NS_FM.advisors,
]);

function parseFrontmatter(frontmatter: string): Record<string, unknown> {
  if (!frontmatter) return {};
  try {
    const value: unknown = obsidian.parseYaml(frontmatter.replace(/^---\s*\n?/, "").replace(/\n?---\s*$/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    throw new Error(t("Could not read the note frontmatter; the note was not changed."));
  }
}

function mergeFrontmatter(current: string, generated: string): string {
  const currentFields = parseFrontmatter(current);
  const generatedFields = parseFrontmatter(generated);
  const merged = { ...currentFields };
  for (const [key, value] of Object.entries(generatedFields)) {
    if (GENERATED_FRONTMATTER_KEYS.has(key)) merged[key] = value;
  }
  if (!Object.keys(merged).length) return "";
  return `---\n${obsidian.stringifyYaml(merged).trimEnd()}\n---\n`;
}

const ORIGINAL_MATERIAL_HEADING = /^---\s*\r?\n+##\s+(?:📁\s*)?(?:原始材料|原始转写|逐字稿|录音原文|回听时间轴|录音中实时大纲|Original material|Raw transcript|Verbatim transcript|Recording transcript|Playback timeline|Live outline while recording)\s*$/m;

function findOriginalMaterialBoundary(body: string): RegExpExecArray {
  const boundary = ORIGINAL_MATERIAL_HEADING.exec(body);
  if (!boundary || boundary.index === undefined) {
    throw new Error(t("Could not locate the original material section; the note was not changed."));
  }
  return boundary;
}

function extractOrganizedBody(snapshot: string): string {
  const current = splitLeadingFrontmatter(snapshot);
  return current.body.slice(0, findOriginalMaterialBoundary(current.body).index).trim();
}

/**
 * 标题「原始材料」之前、版本块之后可能还留有原始转写块（索引更新把标题挪到了转写之后）。
 * 这段内容不属于整理正文，重写时原样保留在标题之前。
 */
function extractRawTailBeforeBoundary(preBoundary: string): string {
  const active = findActiveVersionBlock(preBoundary);
  const from = active ? active.end : (preBoundary.match(/^\s*#\s+[^\r\n]+(?:\r?\n|$)/)?.[0].length ?? 0);
  const tail = preBoundary.slice(from);
  const anchor = tail.search(/<details\b|<!--\s*qnalog-|<span\s+hidden\b/i);
  if (anchor < 0) return "";
  return tail.slice(anchor).replace(/(?:\r?\n)+\s*---\s*$/, "").trim();
}

/**
 * 去掉整合版标题下只剩一行 AI 整理失败占位的旧失败块（标题与占位行之间、前后的空行一并去掉）。
 * 占位行之后紧跟的不是小节边界（HTML 块、`---`、`##` 标题或文件末尾）时不匹配，原样保留。
 */
const ORGANIZED_FAILURE_SECTION_RE = new RegExp(
  /^##[ \t]+(?:✨[ \t]*)?(?:整合版|Merged version)[^\n]*\n(?:[ \t]*\n)*[ \t]*/.source
    + AI_FAILURE_PLACEHOLDER_RE.source
    + /[ \t]*(?:\n|$)(?:[ \t]*\n)*(?=<|---|## |(?![\s\S]))/.source,
  "gm",
);

export function removeOrganizedFailureSections(text: string): string {
  return text.replace(ORGANIZED_FAILURE_SECTION_RE, "");
}

export function buildReorganizedNote(snapshot: string, generated: string, stripModeSuggestions: (text: string) => string): string {
  const current = splitLeadingFrontmatter(snapshot);
  const generatedParts = splitLeadingFrontmatter(stripModeSuggestions(generated || buildEmptyLlmOutputFallback()).trim());
  const boundary = findOriginalMaterialBoundary(current.body);
  const retainedTitle = current.body.match(/^\s*(#\s+[^\r\n]+)(?:\r?\n|$)/)?.[1] || "";
  const rewrittenBody = [retainedTitle, generatedParts.body.trim() || buildEmptyLlmOutputFallback()]
    .filter(Boolean).join("\n\n");
  const frontmatter = mergeFrontmatter(current.frontmatter, generatedParts.frontmatter);
  const rawTail = removeOrganizedFailureSections(extractRawTailBeforeBoundary(current.body.slice(0, boundary.index)));
  const preservedRaw = rawTail ? `---\n\n${rawTail}\n\n` : "";
  const keptTail = removeOrganizedFailureSections(current.body.slice(boundary.index));
  return normalizeSessionKnowledgeMarkers(`${frontmatter}${rewrittenBody}\n\n${preservedRaw}${keptTail}`);
}

export async function reorganizeNoteInPlace(port: ReorganizeInPlacePort, file: unknown): Promise<void> {
  if (!(file instanceof obsidian.TFile) || file.extension !== "md") return;
  const lock = `repolish:${file.path}`;
  const inFlight = port.getInFlight();
  if (inFlight.has(lock)) {
    new obsidian.Notice(t("This note is being reorganized; please wait for the current task to finish."), 6000);
    return;
  }
  inFlight.add(lock);
  const taskId = `reorganize-in-place:${file.path}`;
  let taskStarted = false;
  try {
    let snapshot = await port.getVault().read(file);
    await port.validateOriginalVersionForReorganization(file);
    const errata = await port.loadErrata(file);
    let input = readRepolishInput(snapshot, port.getCachedFrontmatter(file) || null, errata);
    if (!input.segments.length && await port.recoverOriginalTranscript(file)) {
      snapshot = await port.getVault().read(file);
      input = readRepolishInput(snapshot, port.getCachedFrontmatter(file) || null, errata);
    }
    if (!input.segments.length) throw new Error(t("No QnALog original transcript found. Use this on a note Markdown that contains \"Segmented raw transcript\" or recording segments."));
    const mode = port.getDefaultMode();
    port.tasks.startTaskActivity({
      id: taskId, kind: "repolish", title: t("Reorganize note in place"), subject: file.path,
      status: "running", stage: "preparing", stageLabel: t("Preparing"),
      detail: t("Reading the original transcript"), progress: 3, actions: [],
    });
    taskStarted = true;
    port.tasks.patchTaskActivity(taskId, { stage: "llm", stageLabel: t("AI reorganizing"), detail: t("Generating a new note body"), progress: 10 });
    const sessionMeta = { ...input.sessionMeta, _freshBriefing: true };
    const generated = await port.mergeAndPolish(input.segments, mode, sessionMeta, input.originalFrontmatter);
    const next = buildReorganizedNote(snapshot, generated, (text) => port.stripModeSuggestionBlocks(text));
    if (extractTranscriptSegments(next).length < input.segments.length) {
      throw new Error(t("The reorganized note would lose original transcript segments; the note was not changed."));
    }
    port.tasks.patchTaskActivity(taskId, { stage: "writing", stageLabel: t("Writing"), detail: t("Replacing the organized note body"), progress: 78 });
    if (await port.getVault().read(file) !== snapshot) {
      throw new Error(t("The note changed while reorganizing; the result was not written. Review the note and try again."));
    }
    let changed = false;
    await port.getVault().process(file, (latest) => {
      if (latest !== snapshot) {
        changed = true;
        return latest;
      }
      return next;
    });
    if (changed) throw new Error(t("The note changed while reorganizing; the result was not written. Review the note and try again."));
    let snapshotUpdate: OriginalSnapshotBodyUpdate | null = null;
    try {
      const updatedParts = splitLeadingFrontmatter(next);
      const updatedBody = extractOrganizedBody(next).replace(/^#\s+[^\n]*(?:\n+|$)/, "").trim();
      const originalPayload = buildVersionPayload(updatedParts.frontmatter, updatedBody);
      snapshotUpdate = await port.replaceOriginalVersionBody(file, originalPayload);
      if (findActiveVersionBlock(snapshot) && snapshotUpdate?.path) {
        await port.switchVersion(snapshotUpdate.path, file.path);
      } else if (findActiveVersionBlock(snapshot)) {
        throw new Error(t("Could not read version metadata"));
      }
    } catch (error) {
      await port.getVault().process(file, (latest) => latest === next ? snapshot : latest);
      if (snapshotUpdate) await port.restoreOriginalVersionBody(file, snapshotUpdate);
      throw error;
    }
    await port.clearCommittedBriefingCheckpoint(sessionMeta);
    port.tasks.patchTaskActivity(taskId, { stage: "postprocess", stageLabel: t("Updating index"), detail: t("Refreshing the note index"), progress: 94 });
    await port.refreshNoteIndex(file, { reason: "reorganize" });
    new obsidian.Notice(t("Note body reorganized"), 7000);
    port.tasks.completeTaskActivity(taskId, { stage: "done", stageLabel: t("Reorganize completed"), detail: file.path, subject: file.path, progress: 100 });
  } catch (error) {
    if (taskStarted) port.tasks.failTaskActivity(taskId, error, {
      stage: "failed", stageLabel: t("Reorganize not completed"), detail: getTaskErrorMessage(error), subject: file.path,
    });
    new obsidian.Notice(`${t("Reorganize failed: ")}${getTaskErrorMessage(error)}`, 8000);
  } finally {
    inFlight.delete(lock);
  }
}
