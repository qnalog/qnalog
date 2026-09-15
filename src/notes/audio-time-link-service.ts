/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：回听时间轴：正文时间链接的识别与跳转、内联播放

import * as obsidian from "obsidian";
import { AudioTimeModal } from "../ui/modals";
import { parseElapsedMsToken } from "../shared/util-text";
import type { PluginSettings } from "../shared/types";
import { AUDIO_EXT } from "../shared/catalog-import";
import { VIEW_TYPE_OUTLINE } from "../notes/realtime-outline";
import { extractAudioSegmentOffsets, getAudioExtFromLinkPath, getAudioLinkCandidates, getAudioLinkTarget } from "../notes/audio-refs";
import { isTimeLabel } from "../notes/note-markdown";

/** AudioTimeLinkService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface AudioTimeLinkHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
}

/** 回听链接元素：除标准锚属性外，还挂一个自定义点击处理器用于去重绑定。 */
type AudioTimeLinkElement = HTMLAnchorElement & { __qnalogTimeHandler?: (evt: Event) => void };

export class AudioTimeLinkService {
  declare host: AudioTimeLinkHost;
  constructor(host) {
    this.host = host;
  }


  enhanceAudioTimeLinks(el: HTMLElement, ctx: { sourcePath?: string; onTimeLink?: (payload: unknown) => void } = {}) {
    // el 是 HTMLElement，querySelectorAll 的返回元素类型由类型参数指定；
    // 内容是 Obsidian 正文里的内部链接，取回后按带自定义标记的锚元素处理。
    const links = Array.from(el.querySelectorAll<AudioTimeLinkElement>("a.internal-link"));
    for (const link of links) {
      const label = (link.textContent || "").trim();
      const linkPath = link.getAttribute("data-href") || link.getAttribute("href") || "";
      if (!isTimeLabel(label) || !getAudioExtFromLinkPath(linkPath)) continue;
      link.classList.add("qnalog-time-link");
      link.setAttribute("aria-label", `Q&A Log 回听 ${label}`);
      // 锚元素上挂自定义处理器，用于重复调用时先解绑上一次（避免叠加多个 click）。
      const anyLink = link;
      if (anyLink.__qnalogTimeHandler) {
        link.removeEventListener("click", anyLink.__qnalogTimeHandler, true);
      }
      const handler = (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (typeof evt.stopImmediatePropagation === "function") evt.stopImmediatePropagation();
        this.openAudioTimeLink(linkPath, label, ctx && ctx.sourcePath, ctx).catch((e) => {
          console.error("[QnALog] open audio time link failed", e);
          new obsidian.Notice(`Q&A Log 回听失败：${(e && e.message) || e}`);
        });
      };
      anyLink.__qnalogTimeHandler = handler;
      link.addEventListener("click", handler, true);
    }
  }

  resolveAudioLinkFile(linkPath, sourcePath) {
    const candidates = getAudioLinkCandidates(linkPath);
    if (!candidates.length) return null;
    const isAudioFile = (file) => file instanceof obsidian.TFile && AUDIO_EXT.has((file.extension || "").toLowerCase());
    for (const target of candidates) {
      const direct = this.host.app.metadataCache.getFirstLinkpathDest(target, sourcePath || "");
      if (isAudioFile(direct)) return direct;
      const exact = this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(target));
      if (isAudioFile(exact)) return exact;
      const scoped = this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(`${this.host.settings.audioFolder}/${target.split("/").pop() || target}`));
      if (isAudioFile(scoped)) return scoped;
    }
    const names = candidates.map((target) => (target.split("/").pop() || target).trim()).filter(Boolean);
    const lowerNames = names.map((name) => name.toLowerCase());
    const stems = names
      .map((name) => name.replace(/\.[^.]+$/i, "").toLowerCase())
      .filter(Boolean);
    return this.host.app.vault.getFiles().find((f) => {
      if (!AUDIO_EXT.has((f.extension || "").toLowerCase())) return false;
      const fname = (f.name || "").toLowerCase();
      const fbase = (f.basename || "").toLowerCase();
      if (lowerNames.includes(fname)) return true;
      return stems.some((stem) => fbase === stem || fbase.startsWith(stem + "-"));
    }) || null;
  }

  async resolveAudioTimeLinkContext(linkPath, label, sourcePath) {
    const file = this.resolveAudioLinkFile(linkPath, sourcePath);
    if (!(file instanceof obsidian.TFile)) {
      return null;
    }
    const globalMs = parseElapsedMsToken(label);
    let localMs = globalMs;
    if (sourcePath) {
      const sourceFile = this.host.app.vault.getAbstractFileByPath(sourcePath);
      if (sourceFile instanceof obsidian.TFile) {
        try {
          const content = await this.host.app.vault.cachedRead(sourceFile);
          const offsets = extractAudioSegmentOffsets(content);
          const target = getAudioLinkTarget(linkPath);
          const name = (target.split("/").pop() || target).trim();
          const offset = offsets.get(file.path) ?? offsets.get(obsidian.normalizePath(target)) ?? offsets.get(name) ?? offsets.get(file.name);
          if (Number.isFinite(offset)) localMs = Math.max(0, globalMs - offset);
        } catch (e) {
          console.warn("[QnALog] read source note for audio offset failed", e);
        }
      }
    }
    return { file, globalMs, localMs, label, linkPath, sourcePath };
  }

  async openAudioTimeLink(linkPath, label, sourcePath, opts) {
    const payload = await this.resolveAudioTimeLinkContext(linkPath, label, sourcePath);
    if (!payload) {
      const globalMs = parseElapsedMsToken(label);
      const fallbackPayload = { file: null, globalMs, localMs: globalMs, label, linkPath, sourcePath };
      if (opts && typeof opts.onTimeLink === "function") {
        try {
          if (opts.onTimeLink(fallbackPayload) === true) return;
        } catch (e) {
          console.warn("[QnALog] inline time link fallback failed", e);
        }
      }
      if (this.seekOutlineInlineAudio(fallbackPayload)) return;
      new obsidian.Notice("Q&A Log：找不到对应音频文件，可能已被移动或删除。", 6000);
      return;
    }
    if (opts && typeof opts.onTimeLink === "function") {
      try {
        if (opts.onTimeLink(payload) === true) return;
      } catch (e) {
        console.warn("[QnALog] inline time link handler failed", e);
      }
    }
    if (this.seekOutlineInlineAudio(payload)) return;
    new AudioTimeModal(this.host.app, payload.file, payload.localMs, label).open();
  }

  seekOutlineInlineAudio(payload) {
    const leaves = this.host.app.workspace.getLeavesOfType(VIEW_TYPE_OUTLINE);
    for (const leaf of leaves) {
      const view = leaf && leaf.view as obsidian.View & { seekInlineAudio?: (payload: unknown) => boolean };
      if (view && typeof view.seekInlineAudio === "function") {
        try {
          if (view.seekInlineAudio(payload) === true) return true;
        } catch (e) {
          console.warn("[QnALog] outline inline seek failed", e);
        }
      }
    }
    return false;
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
