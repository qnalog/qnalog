import * as obsidian from "obsidian";
import type { RecordingSession, Segment } from "../shared/types";
import { labelText } from "../shared/note-labels";
import { isTextImportSession } from "../briefing/note-layout-policy";
import {
  assembleRealtimeOutlineDetails,
  buildExternalAudioSourceDetails,
  buildMasterAudioDetails,
  buildMeetingWorkbenchDetails,
  buildPriorSessionBlocks,
  buildRecordingInfoDetails,
  buildRealtimeOutlineDetails,
  buildTextImportInfoDetails,
} from "./note-session-materials";
import { getAudioTimeLink } from "./audio-reference-text";
import { readTranscriptBlocks } from "../transcript/transcript-markdown";
import { buildRewriteSegmentBlock, buildTextImportSourceDetails } from "./note-transcript-materials";
import {
  appendPolishNoteContent,
  buildConsolidatedNoteContent,
  buildPolishAppendBlock,
  prepareNotePolishParts,
} from "./note-write-content";

type NotePolishMoment = (input: string) => { format(pattern: string): string };
type NotePolishWindow = { moment?: NotePolishMoment };

export interface NotePolishModeMeta {
  prefix: string;
  label?: string;
}

type NotePolishMomentResult = { format(pattern: string): string };

function invokeMoment(moment: NotePolishMoment | undefined, input: string): NotePolishMomentResult {
  if (!moment) throw new TypeError("moment is not a function");
  return moment(input);
}

function formatCurrentMoment(readInput: () => string): string | undefined {
  if (!(window as unknown as NotePolishWindow).moment) return undefined;
  const moment = (window as unknown as NotePolishWindow).moment;
  return invokeMoment(moment, readInput()).format("YYYY-MM-DD HH:mm:ss");
}

export type NotePolishVault = Pick<obsidian.Vault, "getAbstractFileByPath" | "read" | "modify">;

export interface NotePolishFlowHost {
  getVault(): NotePolishVault;
  getModeMeta(session: Pick<RecordingSession, "mode">): NotePolishModeMeta;
  getModePrefix(meta: NotePolishModeMeta): string;
  getModel(): string;
  getAudioSegmentListItem(segment: Segment, index: number): string;
  getSegmentAudioLinkOffsetMs(segment: Segment): number;
  buildEmptyBody(): string;
  formatFailureIssue(issue: unknown): string;
}

export async function rewriteConsolidatedFlow(
  host: NotePolishFlowHost,
  session: RecordingSession,
  polished: string,
  continuationSessionId = "",
): Promise<void> {
  const file = host.getVault().getAbstractFileByPath(session.mdPath);
  if (!(file instanceof obsidian.TFile)) return;
  const currentMarkdown = await host.getVault().read(file);
  readTranscriptBlocks(currentMarkdown);
  const meta = host.getModeMeta(session);
  const moment = (window as unknown as NotePolishWindow).moment;
  const startedAt = invokeMoment(moment, session.startedAt);
  const totalMs = session.segments.length ? session.segments[session.segments.length - 1].endOffsetMs : 0;
  const textImport = isTextImportSession(session);
  const externalAudioImport = !!session.externalAudioSource;
  const retainAudio = !textImport && !externalAudioImport;
  const momentFn = typeof window !== "undefined" ? (window as unknown as NotePolishWindow).moment : null;
  const formatRecordedAt = momentFn
    ? (recordedAt: string) => momentFn(recordedAt).format("YYYY-MM-DD HH:mm:ss")
    : undefined;
  const priorBlocks = buildPriorSessionBlocks(session, formatRecordedAt);
  const isContinuation = !!priorBlocks.recordingInfoAppendix || !!priorBlocks.outlineAppendix || !!priorBlocks.audioAppendix;
  const masterAudioBlock = retainAudio && !session.multiSourceAudio ? buildMasterAudioDetails(session, totalMs) : "";
  const audioRow = masterAudioBlock || session.segments.map((segment, index) => host.getAudioSegmentListItem(segment, index)).filter(Boolean).join("\n");
  const realtimeOutlineBlock = buildRealtimeOutlineDetails(session);
  const meetingWorkbenchBlock = buildMeetingWorkbenchDetails(session);
  const recordingInfoBlock = textImport ? buildTextImportInfoDetails(
    session,
    meta.prefix,
    host.getModel(),
    (readStartedAt) => formatCurrentMoment(readStartedAt),
  ) : buildRecordingInfoDetails({
    startedAt: session.startedAt,
    totalMs,
    modeLabel: host.getModePrefix(meta),
    segmentCount: session.segments.length,
    model: host.getModel(),
  }, (readStartedAt) => formatCurrentMoment(readStartedAt));
  const recordingInfoWithPrior = recordingInfoBlock && priorBlocks.recordingInfoAppendix
    ? recordingInfoBlock.replace(/<\/details>\s*$/, () => `${priorBlocks.recordingInfoAppendix}</details>`)
    : recordingInfoBlock;
  const realtimeOutlineWithPrior = assembleRealtimeOutlineDetails({
    liveBlock: realtimeOutlineBlock,
    liveText: session.realtimeOutline || "",
    priorText: session.continuationPriorOutline || "",
    appendix: priorBlocks.outlineAppendix,
  });
  const textImportSourceBlock = textImport ? buildTextImportSourceDetails(session) : "";
  const externalAudioSourceBlock = externalAudioImport ? buildExternalAudioSourceDetails(session) : "";
  const rawBlocks = textImport ? "" : session.segments.map((segment) => buildRewriteSegmentBlock(
    segment,
    getAudioTimeLink(segment.audioName, host.getSegmentAudioLinkOffsetMs(segment)),
  )).join("\n");
  const emptyBriefingFallback = host.buildEmptyBody();
  const polish = prepareNotePolishParts(polished, emptyBriefingFallback);
  const content = buildConsolidatedNoteContent({
    currentMarkdown,
    title: `# ${startedAt.format("YYYY-MM-DD HH:mm")} · ${host.getModePrefix(meta)}`,
    sessionId: session.id,
    continuationSessionId,
    totalMs,
    segmentCount: session.segments.length,
    textImport,
    retainAudio,
    isContinuation,
    masterAudioBlock,
    audioRow,
    priorAudioAppendix: priorBlocks.audioAppendix,
    rawBlocks,
    polish,
    materials: {
      recordingInfo: recordingInfoWithPrior,
      externalAudioSource: externalAudioSourceBlock,
      meetingWorkbench: meetingWorkbenchBlock,
      realtimeOutline: realtimeOutlineWithPrior,
      textImportSource: textImportSourceBlock,
    },
  });
  await host.getVault().modify(file, content);
}

export async function appendPolishBlockFlow(
  host: NotePolishFlowHost,
  session: RecordingSession,
  polished: string,
  mergeError: unknown,
  nonRetryableMergeError = false,
  continuationSessionId = "",
  initialMarkdown: string | null = null,
): Promise<void> {
  const file = host.getVault().getAbstractFileByPath(session.mdPath);
  if (!(file instanceof obsidian.TFile)) return;
  const totalMs = session.segments.length ? session.segments[session.segments.length - 1].endOffsetMs : 0;
  const meta = host.getModeMeta(session);
  const emptyBriefingFallback = host.buildEmptyBody();
  const polish = prepareNotePolishParts(polished, emptyBriefingFallback);
  const textImport = isTextImportSession(session);
  const externalAudioImport = !!session.externalAudioSource;
  const retainAudio = !textImport && !externalAudioImport;
  const realtimeOutlineBlock = buildRealtimeOutlineDetails(session);
  const recordingInfoBlock = textImport ? buildTextImportInfoDetails(
    session,
    meta.prefix,
    host.getModel(),
    (readStartedAt) => formatCurrentMoment(readStartedAt),
  ) : buildRecordingInfoDetails({
    startedAt: session.startedAt,
    totalMs,
    modeLabel: host.getModePrefix(meta),
    segmentCount: session.segments.length,
    model: host.getModel(),
  }, (readStartedAt) => formatCurrentMoment(readStartedAt));
  const textImportSourceBlock = textImport ? buildTextImportSourceDetails(session) : "";
  const externalAudioSourceBlock = externalAudioImport ? buildExternalAudioSourceDetails(session) : "";
  const masterAudioBlock = retainAudio && !session.multiSourceAudio ? buildMasterAudioDetails(session, totalMs) : "";
  const meetingWorkbenchBlock = buildMeetingWorkbenchDetails(session);
  const hasMergeError = !!mergeError;
  const mergeErrorMessage = mergeError && (typeof mergeError === "object" || typeof mergeError === "function") && "message" in mergeError
    ? mergeError.message || mergeError
    : mergeError;
  const failureText = mergeError
    ? (nonRetryableMergeError
      ? `_[${labelText("aiOrganizingFailed", host.formatFailureIssue(mergeErrorMessage))}]_`
      : `_[${labelText("mergeFailedQueued", mergeErrorMessage as string | number)}]_`)
    : "";
  const block = buildPolishAppendBlock({
    modelAndModeLabel: `${host.getModel()} · ${host.getModePrefix(meta)}`,
    textImport,
    masterAudioBlock,
    hasMergeError,
    failureText,
    polish,
    materials: {
      recordingInfo: recordingInfoBlock,
      externalAudioSource: externalAudioSourceBlock,
      meetingWorkbench: meetingWorkbenchBlock,
      realtimeOutline: realtimeOutlineBlock,
      textImportSource: textImportSourceBlock,
    },
  });
  const cur = initialMarkdown ?? await host.getVault().read(file);
  const next = appendPolishNoteContent({
    currentMarkdown: cur,
    block,
    polishedFrontmatter: polish.frontmatter,
    hasMergeError,
    textImport,
    totalMs,
    continuationSessionId,
  });
  await host.getVault().modify(file, next);
}
