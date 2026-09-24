/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：笔记版本块：清单读写、版本文件落盘、派生笔记、版本切换

import * as obsidian from "obsidian";
import type { PluginSettings } from "../shared/types";
import { NoteIndexService } from "../notes/note-index-service";
import { sanitizeFilename } from "../shared/util-common";
import { applyVersionTitle, buildVersionPayload, foldRawTranscriptSection, normalizeTitleDatetime, replaceLeadingFrontmatter, splitLeadingFrontmatter, splitVersionPayload, stripVersionBookkeepingFrontmatter } from "../version-content";
import { getModeMeta, getModePrefix, isKnownPolishMode } from "../shared/mode-meta";
import { buildEmptyLlmOutputFallback } from "../prompts/briefing-prompts";
import { getSegmentsHash } from "../notes/audio-refs";
import { buildSegmentStatusList, getSourceIdFromMarkdown, getVersionStoreFolder, normalizeVersionId, replaceActiveVersionBlock } from "../notes/note-markdown";
import { ensureVaultFolder, findAvailableMarkdownPath } from "../shared/util-vault";
import { NS_TYPE_DERIVED, NS_TYPE_VERSION_CACHE } from "../shared/namespace";

import { t } from "../shared/i18n";
/** VersionStore 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface VersionStoreHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  /** 笔记索引与当日概要服务。 */
  noteIndex: NoteIndexService;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
}

export class VersionStore {
  declare host: VersionStoreHost;
  constructor(host) {
    this.host = host;
  }

  async readVersionManifest(folder) {
    const manifestPath = obsidian.normalizePath(`${folder}/manifest.json`);
    const f = this.host.app.vault.getAbstractFileByPath(manifestPath);
    if (!(f instanceof obsidian.TFile)) return { version: 1, activeVersionId: "", versions: [] };
    try {
      const parsed = JSON.parse(await this.host.app.vault.read(f));
      return Object.assign({ version: 1, activeVersionId: "", versions: [] }, parsed || {});
    } catch (e) {
      console.warn("[QnALog] version manifest parse failed", e);
      return { version: 1, activeVersionId: "", versions: [] };
    }
  }

  async writeVersionManifest(folder, manifest) {
    await ensureVaultFolder(this.host.app, folder);
    const manifestPath = obsidian.normalizePath(`${folder}/manifest.json`);
    const payload = JSON.stringify(Object.assign({ version: 1 }, manifest || {}), null, 2);
    const f = this.host.app.vault.getAbstractFileByPath(manifestPath);
    if (f instanceof obsidian.TFile) {
      await this.host.app.vault.modify(f, payload);
      return;
    }
    try {
      await this.host.app.vault.create(manifestPath, payload);
    } catch (error) {
      // 旧版本重复任务可能同时首次创建 manifest。create 发生竞争时，
      // 转为更新已经由另一个任务创建的文件，不把整理结果判为失败。
      const raced = this.host.app.vault.getAbstractFileByPath(manifestPath);
      if (!(raced instanceof obsidian.TFile)) throw error;
      await this.host.app.vault.modify(raced, payload);
    }
  }

  async writeVersionFile(folder, fileName, content) {
    await ensureVaultFolder(this.host.app, folder);
    const path = obsidian.normalizePath(`${folder}/${fileName}`);
    const existing = this.host.app.vault.getAbstractFileByPath(path);
    if (existing instanceof obsidian.TFile) {
      await this.host.app.vault.modify(existing, content);
      return existing;
    }
    try {
      return await this.host.app.vault.create(path, content);
    } catch (error) {
      // 版本缓存按 source + version id 幂等写入。并发 create 竞争时，
      // 使用已经落盘的文件继续完成本轮，而不是显示 File already exists。
      const raced = this.host.app.vault.getAbstractFileByPath(path);
      if (!(raced instanceof obsidian.TFile)) throw error;
      await this.host.app.vault.modify(raced, content);
      return raced;
    }
  }

  async saveVersion(sourceFile, sourceContent, segments, versionInput) {
    const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
    const sourceHash = getSegmentsHash(segments);
    const folder = getVersionStoreFolder(this.host.settings, sourceId);
    const createdAt = window.moment ? window.moment().format("YYYY-MM-DD HH:mm:ss") : new Date().toISOString();
    const id = normalizeVersionId(versionInput.idLabel || versionInput.label || versionInput.kind || "version");
    const fileStem = sanitizeFilename(`${id}`) || id;
    const fileName = `${fileStem}.md`;
    const versionParts = splitVersionPayload(versionInput.body);
    const body = versionParts.body.trim() || buildEmptyLlmOutputFallback();
    const frontmatter = versionParts.frontmatter;
    const meta = {
      id,
      kind: versionInput.kind || "",
      label: versionInput.label || versionInput.kind || "版本",
      mode: versionInput.mode || "",
      style: versionInput.style || "",
      sourcePath: sourceFile.path,
      sourceId,
      sourceHash,
      fileName,
      createdAt,
      containsRaw: false,
      containsFrontmatter: Boolean(frontmatter),
    };
    const payload = buildVersionPayload(frontmatter, body);
    const versionFileBody = [
      "---",
      `类型: ${NS_TYPE_VERSION_CACHE}`,
      "payload_format: 2",
      `version_id: "${id}"`,
      `variant_kind: "${meta.kind}"`,
      `variant_label: "${meta.label}"`,
      meta.mode ? `variant_mode: "${meta.mode}"` : "",
      meta.style ? `variant_style: "${meta.style}"` : "",
      `source_path: "${sourceFile.path}"`,
      `source_id: "${sourceId}"`,
      `source_segments_hash: "${sourceHash}"`,
      "contains_raw: false",
      `contains_frontmatter: ${frontmatter ? "true" : "false"}`,
      `created: ${createdAt}`,
      "---",
      "",
      payload,
      "",
    ].filter(v => v !== "").join("\n");
    await this.writeVersionFile(folder, fileName, versionFileBody);
    const manifest = await this.readVersionManifest(folder);
    const versions = Array.isArray(manifest.versions) ? manifest.versions.filter(v => v && v.id !== id) : [];
    versions.push(meta);
    Object.assign(manifest, {
      version: 1,
      sourcePath: sourceFile.path,
      sourceId,
      sourceHash,
      segments: buildSegmentStatusList(segments),
      // 派生文件不改变母本当前显示版本；清稿/历史版本仍可显式激活。
      activeVersionId: versionInput.activate === false ? (manifest.activeVersionId || "") : id,
      updatedAt: createdAt,
      versions,
    });
    await this.writeVersionManifest(folder, manifest);
    return { folder, manifest, meta, body, frontmatter };
  }

  async createDerivedNote(sourceFile, sourceContent, version, label, mode, style = "") {
    if (!(sourceFile instanceof obsidian.TFile)) throw new Error("找不到原始纪要");
    const sourceDir = sourceFile.parent && sourceFile.parent.path ? sourceFile.parent.path : "";
    const prefix = String(label || "综合纪要").trim() || "综合纪要";
    const stem = `【${prefix}】${sourceFile.basename}`;
    const stableTarget = obsidian.normalizePath(
      sourceDir ? `${sourceDir}/${stem}.md` : `${stem}.md`,
    );
    // 同一来源和同一模式重做时更新这份派生文件；只有目标被用户占用为
    // 其他内容时才生成 -2，避免每次点击都制造一份重复纪要。
    const stableExisting = this.host.app.vault.getAbstractFileByPath(stableTarget);
    const target = stableExisting instanceof obsidian.TFile
      ? stableTarget
      : findAvailableMarkdownPath(this.host.app, stableTarget);
    if (!target) throw new Error("无法生成派生纪要文件路径");

    const sourceFm = ((this.host.app.metadataCache.getFileCache(sourceFile) || {}).frontmatter) || {};
    const versionFm = version && version.frontmatter
      ? (() => { try { return obsidian.parseYaml(splitLeadingFrontmatter(version.frontmatter).frontmatter.replace(/^---\n|\n---\n?$/g, "")) || {}; } catch { return {}; } })()
      : {};
    const derivedFm = Object.assign({}, sourceFm, versionFm, {
      "类型": NS_TYPE_DERIVED,
      variant_kind: "minutes",
      variant_label: prefix,
      variant_mode: mode || "",
      variant_style: style || "",
      source_path: sourceFile.path,
      source_id: version && version.meta ? version.meta.sourceId : "",
      contains_raw: false,
      created: version && version.meta ? version.meta.createdAt : new Date().toISOString(),
    });
    const yaml = obsidian.stringifyYaml(derivedFm);
    const body = String(version && version.body || buildEmptyLlmOutputFallback()).trim() || buildEmptyLlmOutputFallback();
    const heading = /^#\s/m.test(body) ? "" : `# ${prefix} · ${sourceFile.basename}\n\n`;
    const backlink = `> [!info] 基于原始转写重新生成 · 原始纪要：[[${sourceFile.basename}]]`;
    const content = `---\n${yaml.trimEnd()}\n---\n\n${heading}${backlink}\n\n${body}\n`;
    let existing = this.host.app.vault.getAbstractFileByPath(target);
    if (existing instanceof obsidian.TFile) await this.host.app.vault.modify(existing, content);
    else {
      try {
        existing = await this.host.app.vault.create(target, content);
      } catch (error) {
        const raced = this.host.app.vault.getAbstractFileByPath(target);
        if (!(raced instanceof obsidian.TFile)) throw error;
        await this.host.app.vault.modify(raced, content);
        existing = raced;
      }
    }
    if (existing instanceof obsidian.TFile) {
      await this.host.noteIndex.refreshNoteIndexSafely(existing, {
        meetingDate: derivedFm.time || derivedFm["日期"] || derivedFm.date || "",
        reason: "derived-note",
      });
    }
    return existing instanceof obsidian.TFile ? existing : null;
  }

  async applyVersionToSource(sourceFile, versionMeta, body, frontmatter = "") {
    const cur = await this.host.app.vault.read(sourceFile);
    const withFrontmatter = replaceLeadingFrontmatter(cur, frontmatter);
    // 标题跟随当前显示版本；回退日期优先取本次内容的 time，再取版本创建时间。
    const fmTime = (String(frontmatter || "").match(/^time:\s*(.+)$/m) || [])[1] || "";
    const fallbackDatetime = normalizeTitleDatetime(fmTime) || normalizeTitleDatetime(String(versionMeta && versionMeta.createdAt || ""));
    // 标题模式段与改名文件名同源（getModePrefix，随界面语言）；清稿等未知模式回退到版本标签。
    const modeKey = String((versionMeta && versionMeta.mode) || "");
    const labelFallback = String((versionMeta && (versionMeta.label || versionMeta.kind)) || "当前版本").split(" · ")[0].trim() || "当前版本";
    const titleSuffix = isKnownPolishMode(this.host.settings, modeKey)
      ? getModePrefix(getModeMeta(this.host.settings, modeKey))
      : labelFallback;
    const withTitle = applyVersionTitle(withFrontmatter, titleSuffix, fallbackDatetime);
    // 原始转写区规范化：未收尾的母本首次激活时把裸露分段折叠并补「原始材料」标题。
    const next = foldRawTranscriptSection(replaceActiveVersionBlock(withTitle, versionMeta, body));
    if (next !== cur) await this.host.app.vault.modify(sourceFile, next);
    await this.host.noteIndex.refreshNoteIndexSafely(sourceFile, { reason: "version-switch" });
  }

  async switchVersion(versionFile, fallbackSourcePath) {
    if (!(versionFile instanceof obsidian.TFile)) return;
    const content = await this.host.app.vault.read(versionFile);
    const fm = ((this.host.app.metadataCache.getFileCache(versionFile) || {}).frontmatter) || {};
    const sourcePath = obsidian.normalizePath(String(fm.source_path || fallbackSourcePath || ""));
    const sourceFile = sourcePath ? this.host.app.vault.getAbstractFileByPath(sourcePath) : null;
    if (!(sourceFile instanceof obsidian.TFile)) {
      new obsidian.Notice(t("Master copy not found; cannot switch versions."), 6000);
      return;
    }
    const parts = splitLeadingFrontmatter(content);
    const versionParts = splitVersionPayload(parts.body);
    const body = versionParts.body.trim() || "_[版本内容为空]_";
    const meta = {
      id: String(fm.version_id || versionFile.basename),
      kind: String(fm.variant_kind || ""),
      label: String(fm.variant_label || fm.variant_kind || "版本"),
      mode: String(fm.variant_mode || ""),
      style: String(fm.variant_style || ""),
      sourceHash: String(fm.source_segments_hash || ""),
      createdAt: String(fm.created || ""),
    };
    // 缓存文件：载荷标记里的内容 YAML；派生笔记：文件头 YAML 剥掉记账字段。
    // 之前派生路径恒传空串，母本 frontmatter 因此一直补不上。
    const contentFrontmatter = versionParts.frontmatter || stripVersionBookkeepingFrontmatter(parts.frontmatter);
    await this.applyVersionToSource(sourceFile, meta, body, contentFrontmatter);
    const sourceContent = await this.host.app.vault.read(sourceFile);
    const sourceId = getSourceIdFromMarkdown(sourceContent, sourceFile);
    const folder = getVersionStoreFolder(this.host.settings, sourceId);
    const manifest = await this.readVersionManifest(folder);
    manifest.activeVersionId = meta.id;
    manifest.updatedAt = window.moment ? window.moment().format("YYYY-MM-DD HH:mm:ss") : new Date().toISOString();
    await this.writeVersionManifest(folder, manifest);
    try { await this.host.app.workspace.getLeaf(false).openFile(sourceFile); } catch { /* intentionally empty */ }
    new obsidian.Notice(`${t("Switched to version: ")}${meta.label}`, 3000);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
