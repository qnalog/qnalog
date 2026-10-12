import type { TopicCandidate } from "../topics/topic-candidates";
import { cleanTopicOverviewExcerpt } from "../topics/topic-overview-display";
import { formatTopicCandidateReasons } from "./topics-ui-port";
import { suppressRowActivation } from "./topic-row-activation";

export interface TopicCandidateRowPort {
  text(key: string): string;
}

export function renderTopicCandidateGroupHeading(parent: HTMLElement, text: string): HTMLDivElement {
  return parent.createDiv({ cls: "qnalog-topics-preview-heading is-section", text });
}

export function renderTopicCandidateRow(
  parent: HTMLElement,
  candidate: TopicCandidate,
  selected: boolean,
  topicTitles: ReadonlyMap<string, string>,
  port: TopicCandidateRowPort,
  onSelectionChange: (checked: boolean) => void,
): HTMLLabelElement {
  const row = parent.createEl("label", {
    cls: candidate.cancellable ? "qnalog-topics-candidate" : "qnalog-topics-candidate is-disabled",
    attr: candidate.cancellable ? {} : { "aria-disabled": "true" },
  });
  const checkbox = row.createEl("input", { attr: { type: "checkbox", "aria-label": candidate.title } });
  checkbox.checked = selected;
  checkbox.disabled = !candidate.cancellable;
  row.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (suppressRowActivation({
      onCheckbox: target === checkbox,
      onInteractive: !!target?.closest("button, a"),
      selectedText: window.getSelection()?.toString() ?? "",
      disabled: checkbox.disabled,
    })) event.preventDefault();
  });
  checkbox.addEventListener("change", () => onSelectionChange(checkbox.checked));

  const details = row.createDiv({ cls: "qnalog-topics-candidate-details" });
  details.createDiv({ cls: "qnalog-topics-candidate-title", text: `${candidate.date ? `${candidate.date} · ` : ""}${candidate.title}` });
  const cleanOverview = cleanTopicOverviewExcerpt(candidate.overview);
  const summary = details.createDiv({ cls: "qnalog-topics-candidate-summary", text: cleanOverview.slice(0, 120) });
  if (candidate.overview.length > 120) {
    const more = details.createEl("button", { text: port.text("Show more"), attr: { type: "button" } });
    more.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      summary.setText(cleanOverview);
      more.remove();
    });
  }

  const metadata = details.createDiv({ cls: "qnalog-topics-candidate-meta" });
  for (const reason of formatTopicCandidateReasons(candidate, (key) => port.text(key))) {
    metadata.createSpan({ cls: "qnalog-topics-reason", text: reason });
  }
  for (const topicId of candidate.alreadyInTopics) {
    metadata.createSpan({ cls: "qnalog-topics-membership", text: `${port.text("Already in topic")} “${topicTitles.get(topicId) || topicId}”` });
  }
  if (candidate.missingOverview) metadata.createSpan({ cls: "qnalog-topics-missing", text: port.text("Overview missing") });
  return row;
}
