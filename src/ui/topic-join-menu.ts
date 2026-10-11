import type { Menu, MenuItem } from "obsidian";
import type { TopicSummary } from "./topics-ui-port";
import { topicJoinMenuEntries } from "./topics-ui-port";

/** Adds the topic submenu before its parent menu is shown. */
export function addTopicJoinSubmenu(
  menu: Menu,
  topics: readonly TopicSummary[],
  path: string,
  labels: { join: string; more: string },
  onJoin: (topicId: string) => void,
  onMore: () => void,
): void {
  const entries = topicJoinMenuEntries(topics, path);
  if (!entries.topics.length) return;
  menu.addItem((item) => {
    item.setTitle(labels.join).setIcon("layers");
    const submenu = (item as MenuItem & { setSubmenu(): Menu }).setSubmenu();
    for (const topic of entries.topics) submenu.addItem((entry) => entry.setTitle(topic.title).onClick(() => onJoin(topic.id)));
    if (entries.more) submenu.addItem((entry) => entry.setTitle(labels.more).onClick(onMore));
  });
}
