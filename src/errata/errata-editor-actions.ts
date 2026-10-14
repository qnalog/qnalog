import type { Editor, TFile } from "obsidian";
import { applyReplacements } from "./errata-apply";
import type { ErrataService } from "./errata-service";
import { t } from "../shared/i18n";

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
  if (!from || !to || from === to || from.length > 60 || to.length > 60) {
    throw new Error(t("Enter two different terms of at most 60 characters."));
  }
  await errata.appendReplacement(file, from, to);
  const current = editor.getValue();
  const updated = applyReplacements(current, [{ from, to }]);
  if (updated !== current) editor.setValue(updated);
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
