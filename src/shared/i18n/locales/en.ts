/**
 * 英文词条表——**本文件是源语言，故意为空**。
 *
 * 代码里写的字符串字面量就是英文原文，直接作为键使用；
 * `translateInto` 查不到译文时返回该键本身，因此英文无需再抄一份映射。
 * 这与 Obsidian 官方翻译仓库的做法一致（English is the source of truth）。
 *
 * 新增文案时**不需要动本文件**：在代码里写好英文，再往其它语言表补译文即可。
 */
import type { MessageTable } from "../../i18n";

export const EN: MessageTable = {
  "Paused recovery entries": "Paused recovery entries",
  "Queue entry {0}": "Queue entry {0}",
  "Invalid queue entry": "Invalid queue entry",
  "Unsupported task type": "Unsupported task type",
  "Invalid task field: {0}": "Invalid task field: {0}",
  "Duplicate task ID": "Duplicate task ID",
  "Recovery is paused. The original queue data and its material references are kept. Update QnALog for an unsupported task type; for damaged task data, keep a backup and use View log to share a diagnostic report with the maintainer. Related tasks stay paused until recovery data is repaired.": "Recovery is paused. The original queue data and its material references are kept. Update QnALog for an unsupported task type; for damaged task data, keep a backup and use View log to share a diagnostic report with the maintainer. Related tasks stay paused until recovery data is repaired.",
  "QnALog: {0} queue entries could not be restored; their original data was kept. Open Pending Queue for details.": "QnALog: {0} queue entries could not be restored; their original data was kept. Open Pending Queue for details.",
  "Queue recovery entries were paused": "Queue recovery entries were paused",
  "Similar tag spelling: ": "Similar tag spelling: ",
  "Shared project identifier tag": "Shared project identifier tag",
  "Shared topic tags": "Shared topic tags",
  "Starting note": "Starting note",
  "Similar content": "Similar content",
  "Completed {0}/{1} batches": "Completed {0}/{1} batches",
};
