import type * as obsidian from "obsidian";
import { t } from "../shared/i18n";
import { dedupeTranscriptBlocks, type DuplicateTranscriptBlockResult } from "./dedupe-transcript-blocks";

export interface DuplicateTranscriptRepairPort {
  process(file: obsidian.TFile, update: (latest: string) => string): Promise<string>;
  logDiagnostic(level: "warn" | "error", code: string, message: string, data: Record<string, unknown>): Promise<unknown>;
}

/**
 * Repairs duplicate transcript blocks in one note when a reader meets them.
 * Writes only through `process`, so the repair is computed from the latest note text.
 * Returns the markdown the caller should continue with. Ambiguous notes are returned unchanged.
 */
export async function repairDuplicateTranscriptBlocksInNote(port: DuplicateTranscriptRepairPort, file: obsidian.TFile, markdown: string): Promise<string> {
  const first = dedupeTranscriptBlocks(markdown);
  if (first.status === "unchanged") return markdown;
  if (first.status === "ambiguous") {
    await logAmbiguous(port, first);
    return markdown;
  }
  const applied: { result: DuplicateTranscriptBlockResult | null } = { result: null };
  const latest = await port.process(file, (current) => {
    const result = dedupeTranscriptBlocks(current);
    applied.result = result;
    return result.markdown;
  });
  const outcome = applied.result;
  if (!outcome || outcome.status === "unchanged") return latest;
  if (outcome.status === "ambiguous") {
    await logAmbiguous(port, outcome);
    return latest;
  }
  await port.logDiagnostic("warn", "transcript.duplicate_block_repaired", t("Duplicate transcript blocks were merged so the note can be read; the transcript text was kept."), {
    ids: outcome.repairs.map((repair) => repair.id),
    blockCounts: outcome.repairs.map((repair) => repair.blocks),
    removedCounts: outcome.repairs.map((repair) => repair.removed),
  });
  return latest;
}

async function logAmbiguous(port: DuplicateTranscriptRepairPort, result: { ids: string[] }): Promise<void> {
  await port.logDiagnostic("warn", "transcript.duplicate_block_ambiguous", t("Duplicate transcript blocks have different text and were left unchanged."), {
    ids: result.ids,
  });
}
