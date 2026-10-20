import { Modal, Notice, type App } from "obsidian";
import type { TopicListEntry, TopicsUiPort } from "./topics-ui-port";
import { qnalogConfirm } from "./helpers";

/** 成员笔记的显示名：优先取主题里 [[路径|显示名]] 的显示名，否则取文件名。 */
export function topicMemberDisplayTitle(page: TopicListEntry["page"], path: string): string {
  const stem = path.replace(/\.md$/i, "");
  const link = page.memberLinks.find((entry) => entry.match(/^\[\[([^|\]]+)/)?.[1]?.replace(/\.md$/i, "") === stem);
  return link?.match(/\|([^\]]+)\]\]$/)?.[1] || stem.split("/").pop() || path;
}

/** 勾选要移出主题的笔记。只负责选择，不碰主题内容。 */
export class TopicMemberPickModal extends Modal {
  private readonly selected = new Set<string>();

  constructor(
    app: App,
    private readonly port: Pick<TopicsUiPort, "text">,
    private readonly members: ReadonlyArray<{ path: string; title: string }>,
    private readonly onSubmit: (paths: string[]) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.port.text("QnALog · Topics"));
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "qnalog-topics-dialog-heading", text: this.port.text("Choose notes to remove from this topic") });
    const list = this.contentEl.createDiv({ cls: "qnalog-topics-scroll" });
    const footer = this.contentEl.createDiv({ cls: "qnalog-topics-modal-footer" });
    const actions = footer.createDiv({ cls: "qnalog-topics-modal-actions" });
    const cancel = actions.createEl("button", { text: this.port.text("Cancel"), attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { cls: "mod-warning", text: this.port.text("Remove selected"), attr: { type: "button" } });
    submit.disabled = true;
    submit.addEventListener("click", () => {
      const paths = [...this.selected];
      this.close();
      this.onSubmit(paths);
    });
    for (const member of this.members) {
      const row = list.createEl("label", { cls: "qnalog-topics-preview-item" });
      const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
      row.createSpan({ text: member.title });
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selected.add(member.path); else this.selected.delete(member.path);
        submit.disabled = this.selected.size === 0;
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * 把笔记移出主题：这些笔记融入的内容一并移除，不再逐条询问。
 * 只被这些笔记引用的要点整条删除；还被其他笔记引用的要点保留，仅去掉对这些笔记的引用。
 */
export async function removeMembersFromTopic(app: App, port: TopicsUiPort, topicId: string, memberPaths: readonly string[], refresh: () => void): Promise<void> {
  try {
    const preview = await port.previewRemoveMembers(topicId, memberPaths);
    const points = preview.items.filter((item) => item.type === "remove_block").length;
    const confirmed = await qnalogConfirm(
      app,
      port.text("Remove from topic"),
      port.text("Remove {0} note(s) and the {1} point(s) only they support? Points that other notes also support stay.").replace("{0}", String(memberPaths.length)).replace("{1}", String(points)),
      port.text("Remove"),
      port.text("QnALog · Topics"),
    );
    if (!confirmed) { port.cancel(topicId); return; }
    const result = await port.apply(preview, preview.items.map((item) => item.id));
    if (result.skipped?.length) new Notice(port.text("Some revisions were skipped because their blocks changed: {0}").replace("{0}", result.skipped.map((item) => item.id).join(", ")), 8000);
    new Notice(port.text("Removed from the topic."));
    refresh();
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error), 8000);
  }
}
