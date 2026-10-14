import * as obsidian from "obsidian";
import type { Editor, TFile } from "obsidian";
import { applyReplacements } from "./errata-apply";
import type { ErrataService } from "./errata-service";
import { t } from "../shared/i18n";
import { MIN_ERRATA_TERM_LENGTH } from "./errata-parser";
import { ErrataModal } from "./errata-modal";

export interface SelectionPrefill {
  wrongText: string;
  tooLong: boolean;
}

export function getCorrectionSelectionPrefill(selection: string): SelectionPrefill {
  const value = String(selection || "").trim();
  const tooLong = value.includes("\n") || value.includes("\r") || value.length > 60;
  return { wrongText: value && !tooLong ? value : "", tooLong };
}

export async function saveErrataReplacement(
  errata: Pick<ErrataService, "appendReplacement">,
  file: TFile,
  editor: Editor,
  wrongText: string,
  correctText: string,
): Promise<void> {
  const from = wrongText.trim();
  const to = correctText.trim();
  if (!from || from.length < MIN_ERRATA_TERM_LENGTH) {
    throw new Error(t("The wrong term must contain at least 2 characters."));
  }
  if (!to || from === to || from.length > 60 || to.length > 60) {
    throw new Error(t("Enter two different terms of at most 60 characters."));
  }
  await errata.appendReplacement(file, from, to);
  const current = editor.getValue();
  const updated = applyReplacements(current, [{ from, to }]);
  if (updated !== current) {
    let start = 0;
    while (start < current.length && start < updated.length && current[start] === updated[start]) start += 1;
    let oldEnd = current.length;
    let newEnd = updated.length;
    while (oldEnd > start && newEnd > start && current[oldEnd - 1] === updated[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
    editor.replaceRange(updated.slice(start, newEnd), editor.offsetToPos(start), editor.offsetToPos(oldEnd));
  }
}

export async function saveErrataNoise(
  errata: Pick<ErrataService, "appendNoise">,
  file: TFile,
  selectedText: string,
): Promise<void> {
  const text = String(selectedText || "").trim();
  if (!text) throw new Error(t("Select text first."));
  if (text.length > 2000) throw new Error(t("Selected text exceeds the 2000 character limit."));
  await errata.appendNoise(file, text);
}

export function openErrataCorrection(
  app: obsidian.App,
  errata: Pick<ErrataService, "appendReplacement">,
  file: TFile,
  editor: Editor,
): void {
  const prefill = getCorrectionSelectionPrefill(editor.getSelection());
  if (prefill.tooLong) new obsidian.Notice(t("Select a shorter word."), 5000);
  new ErrataModal(app, prefill.wrongText, (wrongText, correctText) =>
    saveErrataReplacement(errata, file, editor, wrongText, correctText)).open();
}

export async function markSelectionAsErrataNoise(
  errata: Pick<ErrataService, "appendNoise">,
  file: TFile,
  selectedText: string,
): Promise<void> {
  try {
    await saveErrataNoise(errata, file, selectedText);
    new obsidian.Notice(t("Added to the errata. It will apply to newly generated notes after reorganization."), 6000);
  } catch (error: unknown) {
    const detail = error instanceof Error && error.message ? error.message : t("Unknown error");
    new obsidian.Notice(`${t("Could not save the errata: ")}${detail}`, 8000);
  }
}
