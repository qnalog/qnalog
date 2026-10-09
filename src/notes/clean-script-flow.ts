import * as obsidian from "obsidian";
import { getSegmentsDurationMs } from "./audio-refs";
import { getTaskErrorMessage } from "../shared/task-activity";
import { readNamespaceFrontmatter, isDerivedVersionType } from "../shared/namespace";
import { t } from "../shared/i18n";
import type { Segment } from "../shared/types";
import type { DerivedNoteVersion } from "../versions/derived-note-store";
import { getSourceIdFromMarkdown } from "./note-source-metadata";
import { extractTranscriptSegments } from "./note-transcript-ledger";
import type { RepolishFlowBasePort } from "./repolish-flow";

export interface CleanScriptFlowPort extends RepolishFlowBasePort {
  getVault(): Pick<obsidian.Vault, "read" | "modify" | "getAbstractFileByPath">;
  getCleanInFlight(): Set<string>;
  findDerivedNoteForSource(file: obsidian.TFile, sourceId: string, kind: string): obsidian.TFile | null;
  switchVersion(file: obsidian.TFile, fallbackSourcePath: string): Promise<void>;
  getLearnedOutputCeiling(): number;
  cleanTranscript(segments: Segment[], ceiling: number): Promise<{ text: string; truncated: boolean }>;
}

export async function findCleanCopy(port: CleanScriptFlowPort, sourceFile: unknown): Promise<obsidian.TFile | null> {
  if (!(sourceFile instanceof obsidian.TFile) || sourceFile.extension !== "md") return null;
  const content = await port.getVault().read(sourceFile);
  const sourceId = getSourceIdFromMarkdown(content, sourceFile);
  return port.findDerivedNoteForSource(sourceFile, sourceId, "clean");
}

export async function generateCleanScript(
  port: CleanScriptFlowPort, file: unknown, options: { regenerateExisting?: boolean } = {},
): Promise<void> {
  if (!(file instanceof obsidian.TFile) || file.extension !== "md") return;
  let taskMeter: unknown = null;
  let taskId = `clean:${file.path}`;
  let taskStarted = false;
  let cleanLockKey = "";
  let cleanLockAcquired = false;
  try {
    let sourceFile = file;
    let content = await port.getVault().read(file);
    const fm = port.getCachedFrontmatter(file) || {};
    if (isDerivedVersionType(readNamespaceFrontmatter(fm, "type"))
      || readNamespaceFrontmatter(fm, "containsRaw") === false) {
      const sourcePath = readNamespaceFrontmatter(fm, "sourcePath");
      const srcPath = typeof sourcePath === "string" && sourcePath ? obsidian.normalizePath(sourcePath) : "";
      const resolved = srcPath ? port.getVault().getAbstractFileByPath(srcPath) : null;
      if (resolved instanceof obsidian.TFile) {
        sourceFile = resolved;
        content = await port.getVault().read(resolved);
      } else {
        new obsidian.Notice(t("This is a derived version, but the source note has been renamed or moved. Generate the clean transcript in the original recording note."), 8000);
        return;
      }
    }
    const sourceId = getSourceIdFromMarkdown(content, sourceFile);
    cleanLockKey = `clean:${sourceId || sourceFile.path}`;
    const inFlight = port.getCleanInFlight();
    if (inFlight.has(cleanLockKey)) {
      new obsidian.Notice(t("A clean transcript is already being generated."), 5000);
      return;
    }
    inFlight.add(cleanLockKey);
    cleanLockAcquired = true;
    taskId = cleanLockKey;
    if (sourceFile.path === file.path && !options.regenerateExisting) {
      const existingClean = port.findDerivedNoteForSource(sourceFile, sourceId, "clean");
      if (existingClean instanceof obsidian.TFile) {
        await port.switchVersion(existingClean, sourceFile.path);
        return;
      }
    }
    await port.ensureOriginalVersionForSource(sourceFile);
    const segments = extractTranscriptSegments(content);
    if (!segments.length) {
      new obsidian.Notice(t("No original transcript (verbatim transcript) found. Generate the clean transcript on a recording source note that contains \"Segmented raw transcript\"."), 8000);
      return;
    }
    port.tasks.setBusyLabel(t("Generating the clean transcript…"));
    const sourceFm = port.getCachedFrontmatter(sourceFile) || {};
    const sourceMode = port.detectNoteMode(sourceFile, sourceFm);
    port.tasks.setBusyContext({
      kind: t("Generate clean transcript"), sourceFile: sourceFile.basename,
      sourceFolder: sourceFile.parent && sourceFile.parent.path ? sourceFile.parent.path : t("Vault root"),
      durationMs: getSegmentsDurationMs(segments),
      sourceModeLabel: sourceMode && sourceMode !== "off"
        ? (port.getModeMeta(sourceMode).label || sourceMode)
        : t("Unlabeled"),
      targetModeLabel: t("Clean transcript"),
    });
    taskStarted = true;
    port.tasks.startTaskActivity({
      id: taskId, kind: "clean-transcript", title: t("Generate clean transcript"), subject: sourceFile.path,
      status: "running", stage: "llm", stageLabel: t("Organize verbatim transcript"),
      detail: t("The clean transcript is shown in the source note; generation does not replace the source transcript"),
      progress: null, actions: [],
    });
    port.tasks.updateBusyStatus();
    new obsidian.Notice(t("QnALog: Generating the clean transcript from the source transcript..."));
    taskMeter = port.tasks.beginTaskMeter();
    const { text: cleaned, truncated } = await port.cleanTranscript(segments, port.getLearnedOutputCeiling());
    if (!cleaned) throw new Error(t("The model did not return a usable clean transcript"));
    const warn = truncated
      ? "> [!warning] 清稿可能被截断：部分内容或因模型输出上限未完整。建议换更大输出上限的模型后重新生成。\n\n"
      : "";
    const noteBody = `> [!note] ${t("A readable transcript cleaned from the source transcript; not minutes or a summary.")}\n\n${warn}${cleaned}`;
    const version: DerivedNoteVersion = {
      meta: { sourceId, kind: "clean", createdAt: new Date().toISOString() },
      frontmatter: "", body: noteBody,
    };
    const cleanFile = await port.createDerivedNote(sourceFile, content, version, t("Clean transcript"), "cleanscript", "");
    if (!(cleanFile instanceof obsidian.TFile)) throw new Error(t("Failed to create the clean transcript note"));
    await port.switchVersion(cleanFile, sourceFile.path);
    new obsidian.Notice(t("QnALog: Clean transcript generated and set as the current displayed version"), 6000);
    const completedTaskMeter = taskMeter ? port.tasks.endTaskMeter(taskMeter) : null;
    taskMeter = null;
    try { port.tasks.logCompletedWork(t("Generate clean transcript"), cleanFile.path || "", completedTaskMeter); } catch { /* intentionally empty */ }
    port.tasks.completeTaskActivity(taskId, {
      stage: "done", stageLabel: t("Clean transcript generated"), detail: cleanFile.path, subject: sourceFile.path,
      actions: [
        { id: "open-task-note", label: t("Open minutes"), primary: true },
        { id: "dismiss-task", label: t("Close Recording") },
      ],
    });
  } catch (error: unknown) {
    console.error("[QnALog] generate clean script failed", error);
    if (taskStarted) {
      port.tasks.failTaskActivity(taskId, error, {
        stage: "failed", stageLabel: t("Clean transcript not generated"), detail: getTaskErrorMessage(error),
        actions: [
          { id: "open-task-note", label: t("Open source note"), primary: true },
          { id: "dismiss-task", label: t("Close Recording") },
        ],
      });
    }
    const message = (error && typeof error === "object" && "message" in error && error.message ? error.message : error) as string;
    new obsidian.Notice(`${t("Clean copy generation failed: ")}${message}`, 8000);
  } finally {
    if (taskMeter) port.tasks.endTaskMeter(taskMeter);
    if (cleanLockAcquired) {
      port.getCleanInFlight().delete(cleanLockKey);
      port.tasks.setBusyLabel(null);
      port.tasks.setBusyContext(null);
      port.tasks.updateBusyStatus();
    }
  }
}
