import * as obsidian from "obsidian";
import { t } from "../shared/i18n";

export type NotePolishEditor = Pick<
  obsidian.Editor,
  "getSelection" | "getValue" | "replaceSelection" | "setValue"
>;

export interface NoteEditorPolishFlowHost {
  getMode(): string;
  polishTranscript(raw: string, mode: string): Promise<string>;
}

export async function polishEditorFlow(
  host: NoteEditorPolishFlowHost,
  editor: NotePolishEditor,
): Promise<void> {
  const sel = editor.getSelection();
  const raw = sel || editor.getValue();
  if (!raw || !raw.trim()) {
    new obsidian.Notice(t("Nothing to polish"));
    return;
  }
  new obsidian.Notice(t("AI polishing..."));
  try {
    const mode = host.getMode();
    const polished = await host.polishTranscript(raw, mode);
    if (sel) editor.replaceSelection(polished);
    else editor.setValue(polished);
    new obsidian.Notice(t("Polishing complete"));
  } catch (error: unknown) {
    console.error(error);
    const failure = ((error && (error as { message?: unknown }).message) || error) as string;
    new obsidian.Notice(`${t("Polish failed: ")}${failure}`);
  }
}
