import * as obsidian from "obsidian";
import type { RecordingSession, Segment } from "../shared/types";
import { readTranscriptBlocks, replaceTranscriptBlock } from "../transcript/transcript-markdown";
import { repairDuplicateTranscriptBlocksInNote } from "../transcript/repair-duplicate-transcript-blocks";
import { normalizeSegmentsForMergedNote } from "./note-source-metadata";
import { t } from "../shared/i18n";
import type { SourceIntegrity } from "../transcript/source-integrity";

export interface SessionTranscriptSourcePort {
  getVault(): Pick<obsidian.Vault, "getAbstractFileByPath" | "read" | "modify" | "process">;
  bindSegmentToAudio(segment: Segment, masterPath: string, audioName: string, integrity: SourceIntegrity | null): Segment;
  logDiagnostic(level: "warn" | "error", code: string, message: string, data: Record<string, unknown>): Promise<unknown>;
}

type BoundSegment = Segment & { transcript: NonNullable<Segment["transcript"]> };

/** 绑定只增加了完整性记录：转写修订、路径与名称都没变。 */
function isIntegrityOnlyChange(before: Segment, after: BoundSegment): boolean {
  const previous = before.transcript;
  return !!previous && after.transcript.revisions === previous.revisions
    && after.transcript.sourcePath === previous.sourcePath
    && after.transcript.sourceName === previous.sourceName
    && after.audioPath === before.audioPath && after.audioName === before.audioName;
}

export async function syncTranscriptAudioSource(port: SessionTranscriptSourcePort, session: RecordingSession): Promise<void> {
  const masterPath = String(session && session.masterAudioPath || "");
  if (!masterPath) return;
  const segments: Segment[] = Array.isArray(session.segments) ? session.segments : [];
  const integrity = session.masterAudioIntegrity || null;
  const updated: Segment[] = segments.map((segment) => port.bindSegmentToAudio(segment, masterPath, String(session.masterAudioName || masterPath.split("/").pop() || ""), integrity));
  const changed = updated.flatMap((segment, index) => segment !== segments[index] && segment.transcript
    ? [{ segment: segment as BoundSegment, integrityOnly: isIntegrityOnlyChange(segments[index], segment as BoundSegment) }]
    : []);
  if (!changed.length) return;
  // 只差完整性记录时，写笔记失败不得改变收尾结果：记日志后继续，内存中的分段仍带记录，供后续整理写入。
  if (changed.every((entry) => entry.integrityOnly)) {
    try {
      await writeBoundSegments(port, session, changed);
    } catch (error) {
      try {
        await port.logDiagnostic("warn", "audio.integrity_ledger_write_failed", t("Could not write the recording checksum into the transcript ledger."), {
          mdPath: session.mdPath,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch { /* diagnostics must not change finalization */ }
    }
    session.segments = updated;
    return;
  }
  await writeBoundSegments(port, session, changed);
  session.segments = updated;
}

async function writeBoundSegments(
  port: SessionTranscriptSourcePort,
  session: RecordingSession,
  changed: ReadonlyArray<{ segment: BoundSegment; integrityOnly: boolean }>,
): Promise<void> {
  const file = port.getVault().getAbstractFileByPath(session.mdPath);
  if (!(file instanceof obsidian.TFile)) throw new Error("Cannot bind transcript sources without the session note");
  const storedMarkdown = await port.getVault().read(file);
  const markdown = await repairDuplicateTranscriptBlocksInNote({
    process: (target, update) => port.getVault().process(target, update),
    logDiagnostic: (level, code, message, data) => port.logDiagnostic(level, code, message, data),
  }, file, storedMarkdown);
  const blocks = readTranscriptBlocks(markdown);
  const replacements = changed.flatMap(({ segment, integrityOnly }) => {
    const id = segment.transcript.id;
    const matches = blocks.filter((block) => block.segment.transcript?.id === id);
    // 只差完整性记录的分段在笔记中找不到唯一且未改动的块时跳过，保持原有收尾行为。
    if (integrityOnly && (matches.length !== 1 || matches[0].drifted)) return [];
    if (matches.length !== 1) throw new Error(`Expected one transcript block for source ${id}; found ${matches.length}`);
    if (matches[0].drifted) throw new Error(`Transcript block ${id} was edited before final audio binding`);
    return [{ block: matches[0], segment }];
  }).sort((left, right) => right.block.start - left.block.start);
  let next = markdown;
  for (const replacement of replacements) {
    next = replaceTranscriptBlock(next, replacement.block, replacement.segment, replacement.block.visibleBlock);
  }
  if (next !== markdown) await port.getVault().modify(file, next);
}

export function getSegmentsForFinalSession(session: RecordingSession): Segment[] {
  const base: Segment[] = Array.isArray(session && session.continuationBaseSegments) ? session.continuationBaseSegments || [] : [];
  const fresh: Segment[] = Array.isArray(session && session.segments) ? session.segments : [];
  if (!base.length) return fresh;
  return normalizeSegmentsForMergedNote([...base, ...fresh], 0, 0, null);
}
