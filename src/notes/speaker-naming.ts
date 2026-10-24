import * as obsidian from "obsidian";
import { extractSpeakerIdsFromMarkdown, normalizeSpeakerMappings, readSpeakerMappings, replaceSpeakerDisplayName } from "../audio/channel-speakers";
import type { SpeakerId, SpeakerMapping } from "../audio/channel-speakers";
import { noteBodyMentionBrackets, wrapSpeakerMentions } from "../audio/speaker-mentions";
import { buildConfirmedSpeakerMappings, collectSpeakerCandidates } from "../asr/speaker-mapping";
import type { SpeakerCandidate } from "../asr/speaker-mapping";
import { normalizeTranscriptLayout } from "../transcript/transcript-markdown";
import { diagnosticError } from "../shared/util-key-diag";
import { getErrorMessage } from "../shared/util-common";
import { t } from "../shared/i18n";

/**
 * Naming speakers after a note has been organized with session numbers (Speaker 1, Speaker 2).
 *
 * A name is written to three places: the note properties (`qnalog_speakers`), the display names in the
 * original transcript, and the organized body. Speaker IDs and the ASR text in the transcript ledger are
 * not changed (`replaceSpeakerDisplayName` only rewrites display projections). Audio files and other notes
 * are not touched. The rewrite replaces display names only and can be undone by naming again, so it does
 * not save a version snapshot (MAINTAINING §15 lists the actions that do).
 */
export interface SpeakerNamingPort {
  getVault(): Pick<obsidian.Vault, "getAbstractFileByPath" | "read" | "modify">;
  readFrontmatter(file: obsidian.TFile): Promise<Record<string, unknown> | null | undefined>;
  writeSpeakerFrontmatter(file: obsidian.TFile, mappings: Record<SpeakerId, SpeakerMapping>): Promise<unknown>;
  promptSpeakerNames(candidates: SpeakerCandidate[], initialMappings: Record<SpeakerId, SpeakerMapping>, options: { unstableAcrossSegments: boolean }): Promise<Record<string, string> | null>;
  /** Shows a message with one action button; the action runs only when the user presses it. */
  showPrompt(message: string, actionLabel: string, onAction: () => void): void;
  notify(message: string, timeoutMs?: number): void;
  resetNotePanelCache(): void;
  requestOutlineRefresh(): void;
  logDiagnostic(level: string, code: string, message: string, data: unknown): Promise<unknown>;
}

export interface SpeakerNameInput {
  personName: string;
  personPath?: string;
}

export interface SpeakerNamingResult {
  /** Speakers whose name was written to the properties. */
  named: number;
  /** Number of display names replaced in the note text. */
  replacements: number;
  bodyUpdated: boolean;
  /** Set when the properties were saved but the note text could not be rewritten. */
  bodyError?: string;
}

function isSpeakerId(value: string): value is SpeakerId {
  return /^spk-\d+$/.test(value);
}

/** Speakers found in the note text that have no name in the note properties. */
export function findUnnamedSpeakerIds(markdown: string, frontmatter: Record<string, unknown> | null | undefined): SpeakerId[] {
  const ids = extractSpeakerIdsFromMarkdown(markdown);
  const mappings = normalizeSpeakerMappings(readSpeakerMappings(frontmatter), ids);
  return ids.filter((id) => !mappings[id]?.personName);
}

/**
 * Writes the names to the properties, then rewrites the transcript display names and the organized body.
 * Failures before anything is written are thrown. If the properties are saved and the body rewrite fails,
 * the result carries `bodyError`, the user is told, and naming again repeats the body rewrite.
 */
export async function applySpeakerNames(port: SpeakerNamingPort, file: obsidian.TFile, names: Record<string, SpeakerNameInput>): Promise<SpeakerNamingResult> {
  const entries: Array<[SpeakerId, SpeakerNameInput]> = [];
  for (const [id, input] of Object.entries(names)) {
    const personName = String(input?.personName || "").trim();
    if (isSpeakerId(id) && personName) entries.push([id, { personName, personPath: input.personPath }]);
  }
  if (!entries.length) return { named: 0, replacements: 0, bodyUpdated: false };

  const original = await port.getVault().read(file);
  const frontmatter = await port.readFrontmatter(file);
  const ids = [...new Set<SpeakerId>([...extractSpeakerIdsFromMarkdown(original), ...entries.map(([id]) => id)])];
  const mappings = normalizeSpeakerMappings(readSpeakerMappings(frontmatter), ids);
  // Names before this change: the body marks speakers only by visible name, so the old names come from the mapping.
  const previousNames = new Map(entries.map(([id]) => [id, String(mappings[id]?.personName || "").trim()]));
  for (const [id, input] of entries) {
    const current = mappings[id];
    mappings[id] = {
      id: current.id,
      channel: current.channel,
      label: current.label,
      personName: input.personName,
      ...(input.personPath ? { personPath: input.personPath } : {}),
    };
  }
  // Properties first: the names stay saved even if the body rewrite below fails.
  await port.writeSpeakerFrontmatter(file, mappings);

  let replacements = 0;
  try {
    let markdown = await port.getVault().read(file);
    for (const [id, input] of entries) {
      const previous = previousNames.get(id);
      const updated = replaceSpeakerDisplayName(markdown, id, input.personName, previous ? [previous] : []);
      markdown = updated.markdown;
      replacements += updated.replacements;
    }
    // Other named speakers written without a marker (bodies organized before markers existed).
    const allNames = Object.values(mappings).map((mapping) => String(mapping.personName || "")).filter(Boolean);
    const marked = wrapSpeakerMentions(markdown, allNames, noteBodyMentionBrackets(markdown));
    if (marked !== markdown) { markdown = marked; replacements += 1; }
    if (replacements > 0) {
      await port.getVault().modify(file, normalizeTranscriptLayout(markdown));
      port.resetNotePanelCache();
    }
  } catch (error) {
    try {
      await port.logDiagnostic("warn", "speaker.names_persist_failed", t("Speaker names were saved to properties, but updating the note body failed"), {
        mdPath: file.path,
        error: diagnosticError(error),
      });
    } catch { /* diagnostics must not hide the user-facing report */ }
    port.notify(t("Speaker names were saved to the properties, but the note text could not be updated. Name the speakers again to retry."), 10000);
    port.requestOutlineRefresh();
    return { named: entries.length, replacements: 0, bodyUpdated: false, bodyError: getErrorMessage(error) };
  }
  try {
    await port.logDiagnostic("info", "speaker.names_persisted", t("Speaker names have been written into the original transcript"), {
      mdPath: file.path,
      confirmedCount: entries.length,
      replacements,
    });
  } catch { /* diagnostics must not change the result */ }
  port.requestOutlineRefresh();
  return { named: entries.length, replacements, bodyUpdated: replacements > 0 };
}

/**
 * Opens the naming modal for a note. Returns null when there is nothing to name or the user cancels;
 * in both cases the note is not changed.
 */
export async function promptAndApplySpeakerNames(port: SpeakerNamingPort, file: obsidian.TFile): Promise<SpeakerNamingResult | null> {
  const markdown = await port.getVault().read(file);
  const frontmatter = await port.readFrontmatter(file);
  const ids = extractSpeakerIdsFromMarkdown(markdown);
  if (!ids.length) {
    port.notify(t("No speakers were found in this note."));
    return null;
  }
  const samples = new Map(collectSpeakerCandidates(markdown).map((candidate) => [candidate.id, candidate]));
  const candidates: SpeakerCandidate[] = ids.map((id) => samples.get(id) ?? { id, label: `${t("Speaker ")}${id.slice(4)}`, samples: [] });
  const initialMappings = normalizeSpeakerMappings(readSpeakerMappings(frontmatter), ids);
  const answered = await port.promptSpeakerNames(candidates, initialMappings, { unstableAcrossSegments: false });
  if (!answered) return null;
  const confirmed = buildConfirmedSpeakerMappings(candidates, answered, initialMappings);
  const names: Record<string, SpeakerNameInput> = {};
  for (const id of ids) {
    const name = String(confirmed[id]?.personName || "").trim();
    if (!name || name === String(initialMappings[id]?.personName || "")) continue;
    names[id] = { personName: name, personPath: confirmed[id]?.personPath };
  }
  const result = await applySpeakerNames(port, file, names);
  if (result.named > 0 && !result.bodyError) {
    port.notify(t("Speaker names updated: {0}").replace("{0}", String(result.named)));
  }
  return result;
}

/**
 * After a note is written: when at least two speakers still have no name, shows a prompt that opens the
 * naming modal. Does not open the modal itself. Returns whether the prompt was shown.
 */
export async function offerSpeakerNaming(port: SpeakerNamingPort, path: string): Promise<boolean> {
  const file = port.getVault().getAbstractFileByPath(path);
  if (!(file instanceof obsidian.TFile)) return false;
  const markdown = await port.getVault().read(file);
  const frontmatter = await port.readFrontmatter(file);
  const unnamed = findUnnamedSpeakerIds(markdown, frontmatter);
  if (unnamed.length < 2) return false;
  port.showPrompt(
    t("The note uses speaker numbers for {0} speakers. You can name them now or later from the command palette.").replace("{0}", String(unnamed.length)),
    t("Name speakers"),
    () => {
      void promptAndApplySpeakerNames(port, file).catch((error: unknown) => {
        port.notify(t("Naming speakers failed: {0}").replace("{0}", getErrorMessage(error)), 10000);
      });
    },
  );
  return true;
}
