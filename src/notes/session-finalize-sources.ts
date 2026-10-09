import * as obsidian from "obsidian";
import type { RecordingSession, Segment } from "../shared/types";
import { readTranscriptBlocks, replaceTranscriptBlock } from "../transcript/transcript-markdown";
import { normalizeSegmentsForMergedNote } from "./note-source-metadata";

export interface SessionTranscriptSourcePort {
  getVault(): Pick<obsidian.Vault, "getAbstractFileByPath" | "read" | "modify">;
  bindSegmentToAudio(segment: Segment, masterPath: string, audioName: string): Segment;
}

export async function syncTranscriptAudioSource(port: SessionTranscriptSourcePort, session: RecordingSession): Promise<void> {
  const masterPath = String(session && session.masterAudioPath || "");
  if (!masterPath) return;
  const segments: Segment[] = Array.isArray(session.segments) ? session.segments : [];
  const updated: Segment[] = segments.map((segment) => port.bindSegmentToAudio(segment, masterPath, String(session.masterAudioName || masterPath.split("/").pop() || "")));
  const changed = updated.filter((segment, index): segment is Segment & { transcript: NonNullable<Segment["transcript"]> } => segment !== segments[index] && !!segment.transcript);
  if (!changed.length) return;
  const file = port.getVault().getAbstractFileByPath(session.mdPath);
  if (!(file instanceof obsidian.TFile)) throw new Error("Cannot bind transcript sources without the session note");
  const markdown = await port.getVault().read(file);
  const blocks = readTranscriptBlocks(markdown);
  const replacements = changed.map((segment) => {
    const id = segment.transcript.id;
    const matches = blocks.filter((block) => block.segment.transcript?.id === id);
    if (matches.length !== 1) throw new Error(`Expected one transcript block for source ${id}; found ${matches.length}`);
    if (matches[0].drifted) throw new Error(`Transcript block ${id} was edited before final audio binding`);
    return { block: matches[0], segment };
  }).sort((left, right) => right.block.start - left.block.start);
  let next = markdown;
  for (const replacement of replacements) {
    next = replaceTranscriptBlock(next, replacement.block, replacement.segment, replacement.block.visibleBlock);
  }
  if (next !== markdown) await port.getVault().modify(file, next);
  session.segments = updated;
}

export function getSegmentsForFinalSession(session: RecordingSession): Segment[] {
  const base: Segment[] = Array.isArray(session && session.continuationBaseSegments) ? session.continuationBaseSegments || [] : [];
  const fresh: Segment[] = Array.isArray(session && session.segments) ? session.segments : [];
  if (!base.length) return fresh;
  return normalizeSegmentsForMergedNote([...base, ...fresh], 0, 0, null);
}
