import * as obsidian from "obsidian";
import type { RecordingSession, Segment } from "../shared/types";
import type { SessionSpeakerPreparation } from "./session-finalize-run-flow";
import { NS_FM_SPEAKERS } from "../shared/namespace";
import { normalizeSpeakerMappings, readSpeakerMappings, replaceSpeakerDisplayName } from "../audio/channel-speakers";
import type { SpeakerId } from "../audio/channel-speakers";
import { applySpeakerNamesForLlm, collectSpeakerCandidates } from "../asr/speaker-mapping";
import { getCurrentTranscript } from "../transcript/session-transcript";
import { normalizeTranscriptLayout } from "../transcript/transcript-markdown";
import { diagnosticError } from "../shared/util-key-diag";
import { t } from "../shared/i18n";

export interface SpeakerConfirmationPort {
  getVault(): Pick<obsidian.Vault, "getAbstractFileByPath" | "read" | "modify">;
  readFrontmatter(file: obsidian.TFile): Promise<Record<string, unknown> | null | undefined>;
  writeSpeakerFrontmatter(file: obsidian.TFile, mappings: ReturnType<typeof normalizeSpeakerMappings>): Promise<unknown>;
  resetNotePanelCache(): void;
  logDiagnostic(level: string, code: string, message: string, data: unknown): Promise<unknown>;
}

/**
 * Applies speaker names that are already known before organizing: note properties and hardware channel mappings.
 * It never waits for user input; unnamed speakers stay numbered.
 */
export async function applyKnownSpeakerNames(port: SpeakerConfirmationPort, session: RecordingSession, segments: Segment[]): Promise<SessionSpeakerPreparation> {
  const joined = (segments || []).map((segment) => String(segment && segment.text || "")).join("\n");
  const candidates = collectSpeakerCandidates(joined);
  if (candidates.length < 2) return { segments, frontmatter: null };

  const file = port.getVault().getAbstractFileByPath(session.mdPath);
  if (!(file instanceof obsidian.TFile)) return { segments, frontmatter: null };
  const frontmatter = await port.readFrontmatter(file) || {};
  const ids = candidates.map((candidate) => candidate.id);
  const initialMappings = normalizeSpeakerMappings(
    Object.assign({}, session.speakerChannels || {}, readSpeakerMappings(frontmatter) || {}),
    ids,
  );
  // Names already confirmed (note properties, hardware channels) are applied below.
  // Unnamed speakers keep their session numbers; naming them later is a separate step (speaker-naming.ts).
  const mappings = initialMappings;

  const hasConfirmedName = Object.values(mappings).some((mapping) => String(mapping && mapping.personName || "").trim());
  if (hasConfirmedName) {
    await port.writeSpeakerFrontmatter(file, mappings);
    session.speakerChannels = mappings;
    let persistedReplacements = 0;
    let namesPersisted = false;
    try {
      let markdown = await port.getVault().read(file);
      for (const [speakerId, mapping] of Object.entries(mappings) as [SpeakerId, { personName?: string }][]) {
        const personName = String(mapping && mapping.personName || "").trim();
        if (!personName) continue;
        const updated = replaceSpeakerDisplayName(markdown, speakerId, personName);
        markdown = updated.markdown;
        persistedReplacements += updated.replacements;
      }
      if (persistedReplacements > 0) {
        markdown = normalizeTranscriptLayout(markdown);
        await port.getVault().modify(file, markdown);
        port.resetNotePanelCache();
      }
      namesPersisted = true;
    } catch (error) {
      try {
        await port.logDiagnostic("warn", "speaker.names_persist_failed", t("Speaker names were saved to properties, but updating the note body failed"), {
          mdPath: file.path,
          error: diagnosticError(error),
        });
      } catch { /* diagnostics must not change finalization behavior */ }
      new obsidian.Notice(t("Speaker names were saved, but the display names in the original transcript could not be updated; you can save again from the outline."), 8000);
    }
    if (namesPersisted) {
      try {
        await port.logDiagnostic("info", "speaker.names_persisted", t("Speaker names have been written into the original transcript"), {
          mdPath: file.path,
          confirmedCount: Object.values(mappings).filter((mapping) => String(mapping && mapping.personName || "").trim()).length,
          replacements: persistedReplacements,
        });
      } catch { /* diagnostics must not change finalization behavior */ }
    }
  }
  const llmSegments = hasConfirmedName
    ? segments.map((segment) => ({ ...segment, text: applySpeakerNamesForLlm(segment.text, mappings) }))
    : segments;
  const utteranceProjections = hasConfirmedName
    ? segments.flatMap((segment) => {
      if (!segment.transcript) return [];
      return getCurrentTranscript(segment.transcript).utterances.flatMap((utterance) => {
        const normalizedText = applySpeakerNamesForLlm(utterance.normalizedText, mappings);
        const channel = Number(utterance.speakerId?.match(/(?:channel|speaker|spk)[:-]?(\d+)$/)?.[1]) || 0;
        const speakerName = String(mappings[`spk-${channel}`]?.personName || utterance.speakerName || "").trim() || null;
        return normalizedText !== utterance.normalizedText || speakerName !== utterance.speakerName
          ? [{ utteranceId: utterance.id, normalizedText, speakerName }]
          : [];
      });
    })
    : [];
  return {
    segments: llmSegments,
    frontmatter: hasConfirmedName ? Object.assign({}, frontmatter, { [NS_FM_SPEAKERS]: mappings }) : null,
    utteranceProjections,
  };
}
