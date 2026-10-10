import { Notice } from "obsidian";
import type { TopicsUiPort } from "./topics-ui-port";

export function renderTopicPromptRow(
  parent: HTMLElement,
  path: string,
  port: TopicsUiPort,
  onIntegrate: (topicId: string) => void,
  onChanged: () => void,
): void {
  if (!port.isSourceNote(path)) return;
  const prompts = port.getPrompts(path);
  if (!prompts.length) return;
  const visible = prompts.slice(0, 2);
  const row = parent.createDiv({ cls: "qnalog-topics-prompt-row" });
  visible.forEach((prompt, index) => {
    row.createSpan({ cls: "qnalog-topics-prompt-text", text: port.text("May belong to topic “{0}”").replace("{0}", prompt.title) });
    const integrate = row.createEl("button", { text: port.text("Integrate"), attr: { type: "button" } });
    integrate.addEventListener("click", (event) => {
      event.stopPropagation();
      onIntegrate(prompt.topicId);
    });
    const ignore = row.createEl("button", { text: port.text("Ignore"), attr: { type: "button" } });
    ignore.addEventListener("click", (event) => {
      event.stopPropagation();
      void port.ignoreNote(prompt.topicId, path).then(() => {
        port.removePrompt(path, prompt.topicId);
        onChanged();
        if (port.getPrompts(path).length === 0) row.remove();
        else { row.remove(); renderTopicPromptRow(parent, path, port, onIntegrate, onChanged); }
      }).catch((error: unknown) => {
        new Notice(error instanceof Error ? error.message : "Could not ignore this topic prompt.", 8000);
      });
    });
    if (index < visible.length - 1) row.createSpan({ cls: "qnalog-topics-prompt-separator", text: " · " });
  });
  if (prompts.length > visible.length) row.createSpan({ cls: "qnalog-topics-prompt-more", text: `+${prompts.length - visible.length}` });
}
