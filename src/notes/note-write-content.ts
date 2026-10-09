import { formatElapsed } from "../shared/util-common";
import { NS_CONTINUATION_COMMITTED_MARKER, nsMarker, nsRe } from "../shared/namespace";
import { labelText } from "../shared/note-labels";
import { splitLeadingFrontmatter } from "./note-document";
import { splitOutSedimentBlock } from "../sediment/text-blocks";

export function buildEmptyLlmOutputFallback(): string {
  return "> [!warning] AI 整理未完成\n> 未获得可用的整理正文；原始转写仍保留在当前笔记中，可以稍后从处理进度中重试。";
}

export interface NotePolishParts {
  frontmatter: string;
  body: string;
  sedimentBlock: string;
}

export function prepareNotePolishParts(markdown: string, emptyFallback: string): NotePolishParts {
  const parts = splitLeadingFrontmatter(markdown || emptyFallback);
  const frontmatter = parts.frontmatter ? parts.frontmatter.trimEnd() : "";
  const sediment = splitOutSedimentBlock(parts.body);
  return { frontmatter, body: sediment.body.trim() || emptyFallback, sedimentBlock: sediment.block };
}


export interface NoteMaterialBlocks {
  recordingInfo: string;
  externalAudioSource: string;
  meetingWorkbench: string;
  realtimeOutline: string;
  textImportSource: string;
}

export interface ConsolidatedNoteContentInput {
  currentMarkdown: string;
  title: string;
  sessionId: string;
  continuationSessionId: string;
  totalMs: number;
  segmentCount: number;
  textImport: boolean;
  retainAudio: boolean;
  isContinuation: boolean;
  masterAudioBlock: string;
  audioRow: string;
  priorAudioAppendix: string;
  rawBlocks: string;
  polish: NotePolishParts;
  materials: NoteMaterialBlocks;
}

export interface PolishAppendBlockInput {
  modelAndModeLabel: string;
  textImport: boolean;
  masterAudioBlock: string;
  hasMergeError: boolean;
  failureText: string;
  polish: NotePolishParts;
  materials: NoteMaterialBlocks;
}

export interface PolishAppendContentInput {
  currentMarkdown: string;
  block: string;
  polishedFrontmatter: string;
  hasMergeError: boolean;
  textImport: boolean;
  totalMs: number;
  continuationSessionId: string;
}

export function buildConsolidatedNoteContent(input: ConsolidatedNoteContentInput): string {
  return [
    input.polish.frontmatter || null,
    input.title,
    "",
    input.polish.body,
    "",
    "---",
    "",
    `## ${labelText("originalMaterial")}`,
    "",
    input.materials.recordingInfo || null,
    input.materials.recordingInfo ? "" : null,
    input.materials.externalAudioSource || null,
    input.materials.externalAudioSource ? "" : null,
    input.materials.meetingWorkbench || null,
    input.materials.meetingWorkbench ? "" : null,
    input.materials.realtimeOutline || null,
    input.materials.realtimeOutline ? "" : null,
    input.textImport ? input.materials.textImportSource || null : null,
    input.textImport ? (input.materials.textImportSource ? "" : null) : null,
    input.retainAudio ? (input.masterAudioBlock ? null : "<details>") : null,
    input.retainAudio ? (input.masterAudioBlock ? null : `<summary>${input.isContinuation ? labelText("originalAudioSegmentsContinuation", input.segmentCount, formatElapsed(input.totalMs)) : labelText("originalAudioSegments", input.segmentCount, formatElapsed(input.totalMs))}</summary>`) : null,
    input.retainAudio ? "" : null,
    input.retainAudio && input.isContinuation && !input.masterAudioBlock && input.priorAudioAppendix ? input.priorAudioAppendix : null,
    input.retainAudio && input.isContinuation && !input.masterAudioBlock && input.priorAudioAppendix ? "" : null,
    input.retainAudio ? input.audioRow : null,
    input.retainAudio ? "" : null,
    input.retainAudio ? (input.masterAudioBlock ? null : "</details>") : null,
    input.retainAudio ? "" : null,
    input.textImport ? null : "<details>",
    input.textImport ? null : `<summary>${labelText("segmentedRawTranscript", input.segmentCount)}</summary>`,
    input.textImport ? null : "",
    input.textImport ? null : nsMarker("segments-start", input.sessionId),
    input.textImport ? null : "",
    input.textImport ? null : input.rawBlocks,
    input.textImport ? null : nsMarker("segments-end", input.sessionId),
    input.textImport ? null : "</details>",
    input.textImport ? null : "",
    nsMarker("session", input.sessionId),
    "",
    input.polish.sedimentBlock || null,
    input.polish.sedimentBlock ? "" : null,
    ...new Set([
      ...[...input.currentMarkdown.matchAll(new RegExp(`<!--\\s*${nsRe(NS_CONTINUATION_COMMITTED_MARKER)}:[^>\\s]+\\s*-->`, "g"))].map(match => match[0]),
      ...(input.continuationSessionId ? [nsMarker(NS_CONTINUATION_COMMITTED_MARKER, input.continuationSessionId)] : []),
    ]),
  ].filter(value => value !== null).join("\n");
}

export function buildPolishAppendBlock(input: PolishAppendBlockInput): string {
  return [
    "",
    `## ${labelText("mergedVersionAt", input.modelAndModeLabel)}`,
    "",
    input.hasMergeError ? input.failureText : input.polish.body,
    "",
    input.materials.recordingInfo || null,
    input.materials.recordingInfo ? "" : null,
    input.materials.externalAudioSource || null,
    input.materials.externalAudioSource ? "" : null,
    input.textImport ? input.materials.textImportSource || null : input.masterAudioBlock || null,
    input.textImport ? (input.materials.textImportSource ? "" : null) : (input.masterAudioBlock ? "" : null),
    input.materials.meetingWorkbench || null,
    input.materials.meetingWorkbench ? "" : null,
    input.materials.realtimeOutline || null,
    input.materials.realtimeOutline ? "" : null,
    "---",
    "",
    input.polish.sedimentBlock || null,
    input.polish.sedimentBlock ? "" : null,
  ].filter(value => value !== null).join("\n");
}

export function appendPolishNoteContent(input: PolishAppendContentInput): string {
  let currentMarkdown = input.currentMarkdown;
  if (input.polishedFrontmatter && !input.hasMergeError) {
    const currentParts = splitLeadingFrontmatter(currentMarkdown);
    currentMarkdown = input.polishedFrontmatter + "\n" + currentParts.body.replace(/^\n+/, "");
  }
  const separator = currentMarkdown.endsWith("\n") ? "" : "\n";
  let next = currentMarkdown + separator + input.block;
  if (!input.textImport) {
    next = next.replace(/([\uFF08(])?(?:录音中|recording)…[)\uFF09]?/g, (_match, open: string | undefined) => {
      const prefix = open || "";
      return `${prefix}${formatElapsed(input.totalMs)}${open === "(" ? ")" : String.fromCharCode(0xff09)}`;
    });
  }
  if (input.continuationSessionId) next = `${next.replace(/\s*$/, "")}\n${nsMarker(NS_CONTINUATION_COMMITTED_MARKER, input.continuationSessionId)}\n`;
  return next;
}
