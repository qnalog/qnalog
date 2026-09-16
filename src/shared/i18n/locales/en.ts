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

export const EN: MessageTable = {};
