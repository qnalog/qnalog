import * as obsidian from "obsidian";
import { buildEmptyLlmOutputFallback } from "./note-write-content";
import { splitLeadingFrontmatter } from "./note-document";
import { readRepolishInput } from "./repolish-input";
import { getTaskErrorMessage } from "../shared/task-activity";
import { t } from "../shared/i18n";
import type { Segment } from "../shared/types";
import type { TaskActivity, TaskActivityInput } from "../shared/task-activity";
import type { VersionSaveInput } from "../versions/version-save-store";
import { buildVersionPayload } from "../versions/version-content";
import { NS_FM } from "../shared/namespace";
import { normalizeSessionKnowledgeMarkers } from "../briefing/session-knowledge";

export interface ReorganizeInPlacePort {
  getVault(): Pick<obsidian.Vault, "read" | "process">;
  getCachedFrontmatter(file: obsidian.TFile): Record<string, unknown> | null | undefined;
  getDefaultMode(): string;
  getModeDisplayName(mode: string): string;
  getInFlight(): Set<string>;
  mergeAndPolish(segments: Segment[], mode: string, sessionMeta: Record<string, unknown>, frontmatter: Record<string, unknown> | null): Promise<string>;
  stripModeSuggestionBlocks(text: string): string;
  ensureOriginalVersionForSource(file: obsidian.TFile): Promise<unknown>;
  saveVersion(file: obsidian.TFile, content: string, segments: Segment[], input: VersionSaveInput): Promise<unknown>;
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

export function buildReorganizedNote(snapshot: string, generated: string, stripModeSuggestions: (text: string) => string): string {
  const current = splitLeadingFrontmatter(snapshot);
  const generatedParts = splitLeadingFrontmatter(stripModeSuggestions(generated || buildEmptyLlmOutputFallback()).trim());
  const boundary = findOriginalMaterialBoundary(current.body);
  const retainedTitle = current.body.match(/^\s*(#\s+[^\r\n]+)(?:\r?\n|$)/)?.[1] || "";
  const rewrittenBody = [retainedTitle, generatedParts.body.trim() || buildEmptyLlmOutputFallback()]
    .filter(Boolean).join("\n\n");
  const frontmatter = mergeFrontmatter(current.frontmatter, generatedParts.frontmatter);
  return normalizeSessionKnowledgeMarkers(`${frontmatter}${rewrittenBody}\n\n${current.body.slice(boundary.index)}`);
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
    const snapshot = await port.getVault().read(file);
    const input = readRepolishInput(snapshot, port.getCachedFrontmatter(file) || null);
    if (!input.segments.length) throw new Error(t("No QnALog original transcript found. Use this on a note Markdown that contains \"Segmented raw transcript\" or recording segments."));
    const mode = port.getDefaultMode();
    port.tasks.startTaskActivity({
      id: taskId, kind: "repolish", title: t("Reorganize note in place"), subject: file.path,
      status: "running", stage: "preparing", stageLabel: t("Preparing"),
      detail: t("Reading the original transcript"), progress: 3, actions: [],
    });
    taskStarted = true;
    port.tasks.patchTaskActivity(taskId, { stage: "llm", stageLabel: t("AI reorganizing"), detail: t("Generating a new note body"), progress: 10 });
    const generated = await port.mergeAndPolish(input.segments, mode, input.sessionMeta, input.originalFrontmatter);
    const next = buildReorganizedNote(snapshot, generated, (text) => port.stripModeSuggestionBlocks(text));
    const previousParts = splitLeadingFrontmatter(snapshot);
    const previousBody = buildVersionPayload(previousParts.frontmatter, extractOrganizedBody(snapshot));
    port.tasks.patchTaskActivity(taskId, { stage: "writing", stageLabel: t("Writing"), detail: t("Saving a recoverable version before replacing the note body"), progress: 78 });
    await port.ensureOriginalVersionForSource(file);
    await port.saveVersion(file, snapshot, input.segments, {
      kind: "pre-reorganize", label: t("Before reorganization"), mode,
      idLabel: "pre-reorganize", body: previousBody, activate: false,
    });
    let changed = false;
    await port.getVault().process(file, (latest) => {
      if (latest !== snapshot) {
        changed = true;
        return latest;
      }
      return next;
    });
    if (changed) throw new Error(t("The note changed while reorganizing; the result was not written. Review the note and try again."));
    port.tasks.patchTaskActivity(taskId, { stage: "postprocess", stageLabel: t("Updating index"), detail: t("Refreshing the note index"), progress: 94 });
    await port.refreshNoteIndex(file, { reason: "reorganize" });
    new obsidian.Notice(t("Note reorganized in place; the previous body is available in note versions."), 7000);
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
