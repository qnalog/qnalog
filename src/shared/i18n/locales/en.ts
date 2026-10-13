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
  "The note has derived versions: {0}": "The note has derived versions: {0}",
  " and {0} more": " and {0} more",
  "{0} related queue tasks will be removed as well.": "{0} related queue tasks will be removed as well.",
  "Also delete the corresponding recording files ({0})": "Also delete the corresponding recording files ({0})",
  "Delete source and keep the latest derived version": "Delete source and keep the latest derived version",
  "Delete source and all derived versions": "Delete source and all derived versions",
  "Could not inspect derived versions. The note was not deleted.": "Could not inspect derived versions. The note was not deleted.",
  "Derived versions changed while the dialog was open. Nothing was deleted; reopen the dialog.": "Derived versions changed while the dialog was open. Nothing was deleted; reopen the dialog.",
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
  "Selected {0} of {1}": "Selected {0} of {1}",
  "{0} topics": "{0} topics",
  "{0} member notes": "{0} member notes",
  "Updated {0}": "Updated {0}",
  "More actions": "More actions",
  "Generating preview": "Generating preview",
  "{0} notes": "{0} notes",
  "Basis: {0} · {1}": "Basis: {0} · {1}",
  "Batch {0}/{1}": "Batch {0}/{1}",
  "Processing…": "Processing…",
  "Elapsed {0} s": "Elapsed {0} s",
  "Finalized body is long and may take several minutes.": "Finalized body is long and may take several minutes.",
  "Generation failed": "Generation failed",
  "Your selection and title are kept. Retry, or go back to change the selection.": "Your selection and title are kept. Retry, or go back to change the selection.",
  "Back to candidates": "Back to candidates",
  "Reading the topic and note overviews. This usually takes a few dozen seconds.": "Reading the topic and note overviews. This usually takes a few dozen seconds.",
};
