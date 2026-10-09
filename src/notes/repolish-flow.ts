import * as obsidian from "obsidian";
import { getCurrentTranscript } from "../transcript/session-transcript";
import { getSegmentsDurationMs } from "./audio-refs";
import { getSessionMetaDurationMs } from "../shared/util-text";
import { buildEmptyLlmOutputFallback } from "./note-write-content";
import { getTaskErrorMessage } from "../shared/task-activity";
import { getSourceIdFromMarkdown } from "./note-source-metadata";
import { ensureTranscriptBlocks, extractTranscriptSegments } from "./note-transcript-ledger";
import { getModeMeta } from "../shared/mode-meta";
import { readSessionKnowledge } from "../briefing/session-knowledge";
import { readNamespaceFrontmatter } from "../shared/namespace";
import { t } from "../shared/i18n";
import type { Segment } from "../shared/types";
import type { TaskActivity, TaskActivityInput } from "../shared/task-activity";
import type { VersionSaveInput } from "../versions/version-save-store";
import type { DerivedNoteVersion } from "../versions/derived-note-store";
import { splitVersionPayload } from "../versions/version-content";
import {
  applyRoleMappingToSegments, extractRoleMappingFromFrontmatter, flattenRoleMappedFrontmatter,
  type RoleMapping,
} from "./role-mapping";

const stringifyRepolishValue = String as (value: unknown) => string;
export type RepolishOptions = { label?: string } | null;
export type RepolishBusyContext = {
  kind: string;
  sourceFile: string;
  sourceFolder: string;
  durationMs: number;
  sourceModeLabel: string;
  targetModeLabel: string;
};
type ModeMetadata = ReturnType<typeof getModeMeta>;
type SessionMeta = Record<string, unknown>;

export interface RepolishTaskPort {
  setBusyLabel(label: string | null): void;
  setBusyContext(context: RepolishBusyContext | null): void;
  updateBusyStatus(): void;
  startTaskActivity(input: TaskActivityInput): unknown;
  patchTaskActivity(id: string, patch: Partial<TaskActivity>): unknown;
  completeTaskActivity(id: string, patch: Partial<TaskActivity>): unknown;
  failTaskActivity(id: string, error: unknown, patch: Partial<TaskActivity>): unknown;
  beginTaskMeter(): unknown;
  endTaskMeter(meter: unknown): unknown;
  logCompletedWork(label: string, path: string, meter: unknown): unknown;
}

export interface RepolishFlowBasePort {
  getVault(): Pick<obsidian.Vault, "read" | "modify">;
  getCachedFrontmatter(file: obsidian.TFile): Record<string, unknown> | null | undefined;
  getModeMeta(mode: string): ModeMetadata;
  detectNoteMode(file: obsidian.TFile, frontmatter: Record<string, unknown> | null): string | null | undefined;
  tasks: RepolishTaskPort;
  ensureOriginalVersionForSource(file: obsidian.TFile): Promise<unknown>;
  createDerivedNote(
    file: obsidian.TFile, content: string, version: DerivedNoteVersion,
    label: string, mode: string, style: string,
  ): Promise<obsidian.TFile | null>;
}

export interface RepolishFlowPort extends RepolishFlowBasePort {
  getModeDisplayName(mode: string): string;
  getModePrefix(meta: ModeMetadata): string;
  getInFlight(): Set<string>;
  mergeAndPolish(
    segments: Segment[], mode: string, sessionMeta: SessionMeta,
    originalFrontmatter: Record<string, unknown> | null, options: RepolishOptions,
  ): Promise<string>;
  stripModeSuggestionBlocks(text: string): string;
  clearCommittedBriefingCheckpoint(sessionMeta: unknown): Promise<void>;
  saveVersion(file: obsidian.TFile, content: string, segments: Segment[], input: VersionSaveInput): Promise<unknown>;
  requestOutlineRefresh(): void;
}

function buildUtteranceProjections(segments: Segment[], mapping: RoleMapping[]): Array<{
  utteranceId: string;
  normalizedText: string;
  speakerName: string | null;
}> {
  const orderedMapping = [...(mapping || [])].sort((left, right) => right.from.length - left.from.length);
  return (segments || []).flatMap((segment) => {
    if (!segment.transcript) return [];
    return getCurrentTranscript(segment.transcript).utterances.flatMap((utterance) => {
      let normalizedText = utterance.normalizedText;
      for (const item of orderedMapping) {
        if (item.from) normalizedText = normalizedText.split(item.from).join(item.to);
      }
      const speakerName = orderedMapping.find((item) => item.from === utterance.speakerName)?.to ?? utterance.speakerName;
      return normalizedText !== utterance.normalizedText || speakerName !== utterance.speakerName
        ? [{ utteranceId: utterance.id, normalizedText, speakerName: speakerName || null }]
        : [];
    });
  });
}

export async function repolishMarkdownFile(
  port: RepolishFlowPort, file: unknown, mode: string, repolishOptions: RepolishOptions = null,
): Promise<void> {
  if (!(file instanceof obsidian.TFile) || file.extension !== "md") return;
  const meta = port.getModeMeta(mode);
  const modeDisplayName = port.getModeDisplayName(mode);
  let taskMeter: unknown = null;
  let taskId = `repolish:${file.path}`;
  let taskStarted = false;
  let repolishLockAcquired = false;
  try {
    let content = await port.getVault().read(file);
    const sourceId = getSourceIdFromMarkdown(content, file);
    taskId = `repolish:${sourceId || file.path}`;
    const reconciled = ensureTranscriptBlocks(content, sourceId);
    if (reconciled !== content) {
      await port.getVault().modify(file, reconciled);
      content = reconciled;
    }
    let segments = extractTranscriptSegments(content);
    if (!segments.length) {
      new obsidian.Notice(t("No QnALog original transcript found. Use this on a minutes Markdown that contains \"Segmented raw transcript\" or recording segments."), 8000);
      return;
    }

    const fmCache = port.getCachedFrontmatter(file) || null;
    const roleMapping = extractRoleMappingFromFrontmatter(fmCache);
    if (roleMapping.length) segments = applyRoleMappingToSegments(segments, roleMapping);

    let sessionMeta: SessionMeta | null = null;
    if (fmCache) {
      const fullTimeStr = readNamespaceFrontmatter(fmCache, "time") || "";
      const durationValue = readNamespaceFrontmatter(fmCache, "duration");
      const durationStr = typeof durationValue === "string" ? durationValue : "";
      if (fullTimeStr) {
        const m = window.moment ? window.moment(fullTimeStr, [window.moment.ISO_8601, "YYYY-MM-DDTHH:mm:ss", "YYYY-MM-DD HH:mm:ss"], true) : null;
        if (m && m.isValid && m.isValid()) {
          sessionMeta = { startedAt: m.toDate().toISOString(), duration: durationStr.trim() };
        }
      } else {
        const dateStr = fmCache["日期"] || fmCache.date || "";
        const timeStr = fmCache["时间"] || "";
        if (dateStr) {
          const composed = stringifyRepolishValue(dateStr).trim() + (timeStr ? "T" + stringifyRepolishValue(timeStr).trim() : "");
          const m = window.moment ? window.moment(composed, ["YYYY-MM-DDTHH:mm", "YYYY-MM-DD", "YYYY-MM-DDTHH:mm:ss"], true) : null;
          if (m && m.isValid && m.isValid()) {
            sessionMeta = { startedAt: m.toDate().toISOString(), duration: durationStr.trim() };
          }
        }
      }
    }
    sessionMeta = Object.assign({}, sessionMeta || {}, {
      _previousKnowledge: readSessionKnowledge(content),
      _utteranceProjections: buildUtteranceProjections(segments, roleMapping),
    });

    const inFlight = port.getInFlight();
    if (inFlight.has(taskId)) {
      new obsidian.Notice(t("This minutes note is being reorganized; please wait for the current task to finish."), 5000);
      return;
    }
    inFlight.add(taskId);
    repolishLockAcquired = true;

    const preferenceLabel = repolishOptions && repolishOptions.label ? ` · ${repolishOptions.label}` : "";
    const mapNotice = roleMapping.length
      ? t("QnALog: re-organizing via {1} mode{2}… after applying {0} role mappings…")
        .replace("{0}", String(roleMapping.length)).replace("{1}", modeDisplayName).replace("{2}", preferenceLabel)
      : t("QnALog: re-organizing via {0} mode{1}…").replace("{0}", modeDisplayName).replace("{1}", preferenceLabel);
    new obsidian.Notice(mapNotice);
    const originalFmForRegen = fmCache ? flattenRoleMappedFrontmatter(fmCache, roleMapping) : null;
    port.tasks.setBusyLabel(t("Re-organizing ({0})…").replace("{0}", modeDisplayName));
    const sourceMode = port.detectNoteMode(file, fmCache);
    const sourceModeLabel = sourceMode && sourceMode !== "off" ? port.getModeDisplayName(sourceMode) : t("Unlabeled");
    port.tasks.setBusyContext({
      kind: t("Re-organize"), sourceFile: file.basename,
      sourceFolder: file.parent && file.parent.path ? file.parent.path : t("Vault root"),
      durationMs: getSegmentsDurationMs(segments) || getSessionMetaDurationMs(sessionMeta),
      sourceModeLabel,
      targetModeLabel: [modeDisplayName, repolishOptions && repolishOptions.label].filter(Boolean).join(" · "),
    });
    taskStarted = true;
    port.tasks.startTaskActivity({
      id: taskId, kind: "repolish", title: `${t("Re-organize · ")}${modeDisplayName}`,
      subject: file.path, status: "running", stage: "llm", stageLabel: t("AI reorganizing"),
      detail: preferenceLabel
        ? t("Preparing the original transcript · {0}").replace("{0}", preferenceLabel.replace(/^\s*·\s*/, ""))
        : t("Preparing the original transcript"),
      progress: 3, actions: [],
    });
    port.tasks.updateBusyStatus();
    taskMeter = port.tasks.beginTaskMeter();
    sessionMeta = Object.assign({}, sessionMeta || {}, { _taskActivityId: taskId, _taskMeter: taskMeter });
    const polished = await port.mergeAndPolish(segments, mode, sessionMeta, originalFmForRegen, repolishOptions);
    port.tasks.patchTaskActivity(taskId, {
      stage: "writing", stageLabel: t("Generating new version"),
      detail: t("The AI draft is complete; writing the Markdown"), progress: 94, deadlineAt: 0,
    });

    const dailyTargetFile = file;
    const latestSourceContent = await port.getVault().read(dailyTargetFile);
    const outputPrefix = meta.custom ? meta.prefix : port.getModePrefix(meta);
    const versionLabel = `${outputPrefix}${preferenceLabel}`;
    const versionStyle = repolishOptions && repolishOptions.label ? repolishOptions.label : "";
    const versionBody = port.stripModeSuggestionBlocks(polished || buildEmptyLlmOutputFallback()).trim();
    const versionParts = splitVersionPayload(versionBody);
    const fallbackVersion: DerivedNoteVersion = {
      body: versionParts.body.trim() || buildEmptyLlmOutputFallback(),
      frontmatter: versionParts.frontmatter || "",
      meta: {
        sourceId: getSourceIdFromMarkdown(latestSourceContent, dailyTargetFile),
        createdAt: window.moment ? window.moment().format("YYYY-MM-DD HH:mm:ss") : new Date().toISOString(),
      },
    };

    await port.ensureOriginalVersionForSource(dailyTargetFile);
    const derivedFile = await port.createDerivedNote(dailyTargetFile, latestSourceContent, fallbackVersion, versionLabel, mode, versionStyle);
    port.tasks.patchTaskActivity(taskId, {
      stage: "postprocess", stageLabel: t("Finishing file processing"),
      detail: derivedFile instanceof obsidian.TFile ? derivedFile.path : t("The new version has been written"),
      progress: 98, deadlineAt: 0,
    });
    await port.clearCommittedBriefingCheckpoint(sessionMeta);
    let versionCacheError = "";
    try {
      await port.saveVersion(dailyTargetFile, latestSourceContent, segments, {
        kind: "minutes", label: versionLabel, mode, style: versionStyle,
        idLabel: `${outputPrefix}${versionStyle ? "-" + versionStyle : ""}`,
        body: versionBody, activate: false,
      });
    } catch (cacheError) {
      versionCacheError = getTaskErrorMessage(cacheError);
      console.warn("[QnALog] derived note created but version cache update failed", cacheError);
    }
    try { port.requestOutlineRefresh(); } catch { /* generation must not fail because the sidebar is unavailable */ }
    const outputPath = derivedFile instanceof obsidian.TFile ? derivedFile.path : dailyTargetFile.path;
    new obsidian.Notice(`${t("QnALog: generated ")}${modeDisplayName}${t(" derived minutes")}${preferenceLabel}${roleMapping.length ? t(" ({0} role mappings applied)").replace("{0}", String(roleMapping.length)) : ""}${versionCacheError ? t("(the version index can be rebuilt later)") : ""}`);
    const completedTaskMeter = taskMeter ? port.tasks.endTaskMeter(taskMeter) : null;
    taskMeter = null;
    try { port.tasks.logCompletedWork(t("Re-organize completed · {0}").replace("{0}", modeDisplayName), file.path || "", completedTaskMeter); } catch { /* intentionally empty */ }
    port.tasks.completeTaskActivity(taskId, {
      stage: "done", stageLabel: t("New version generated"),
      detail: versionCacheError ? `${outputPath} · ${t("Version index not synced: {0}").replace("{0}", versionCacheError)}` : outputPath,
      subject: outputPath, progress: 100,
      actions: [
        { id: "open-task-note", label: t("Open minutes"), primary: true },
        { id: "dismiss-task", label: t("Close Recording") },
      ],
    });
  } catch (error: unknown) {
    console.error("[QnALog] repolish markdown failed", error);
    if (taskStarted) {
      port.tasks.failTaskActivity(taskId, error, {
        stage: "failed", stageLabel: t("Reorganize not completed"), detail: getTaskErrorMessage(error),
        subject: file.path,
        actions: [
          { id: "open-task-note", label: t("Open original material"), primary: true },
          { id: "dismiss-task", label: t("Close Recording") },
        ],
      });
    }
    const message = (error && typeof error === "object" && "message" in error && error.message ? error.message : error) as string;
    new obsidian.Notice(`${t("Re-organize failed: ")}${message}`, 8000);
  } finally {
    if (repolishLockAcquired) port.getInFlight().delete(taskId);
    if (taskMeter) port.tasks.endTaskMeter(taskMeter);
    port.tasks.setBusyLabel(null);
    port.tasks.setBusyContext(null);
    port.tasks.updateBusyStatus();
  }
}

