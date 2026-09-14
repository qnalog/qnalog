/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// @ts-nocheck
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：人员库：档案合并、建议缓存与忽略、库内扫描与落地

import * as obsidian from "obsidian";
import { PeopleDirectorySuggestionModal } from "../ui/modals";
import { getFrontmatterTags, readFileFrontmatter, upsertFrontmatterInMarkdown } from "../shared/util-note";
import { PEOPLE_SUGGESTION_CACHE_LIMIT, splitPersonFieldValue, normalizePersonLookupText, loadPeopleDirectory, ensurePeopleNoteRelatedBaseSection, formatPeopleBaseYaml, formatPeopleNoteMarkdown, mergeUniqueStrings, normalizePeopleSuggestion, normalizePeopleSuggestionIgnores, isPeopleSuggestionIgnored, addPeopleSuggestionIgnore, removePeopleSuggestionIgnores, getPeopleSuggestionCacheKey, normalizePeopleSuggestionCache, makePeopleSuggestionCacheRecord, isPeopleSuggestionCacheRecordCurrent, peopleSuggestionRecordToSuggestion, peopleSuggestionIgnoreRecordToSuggestion, findMatchingPersonEntry, arePeopleSuggestionsRelated, mergePeopleSuggestions, mergeSourceNoteRelatedPeopleFrontmatter, mergePersonFrontmatter, generatePeopleDirectorySuggestions, personEntryFromFrontmatter } from "../people";
import { DEFAULT_LIBRARY_PATHS, DEFAULT_SETTINGS } from "../shared/defaults";
import type { LexVoiceSettings } from "../shared/types";
import { sanitizeFilename, escapeRegExp } from "../shared/util-common";
import { makeFileWikiLink } from "../shared/util-markdown";
import { canOmitServiceApiKey } from "../shared/util-llm-endpoint";
import { KNOWLEDGE_EXTRACTION_BATCH_LIMIT } from "../shared/limits";
import { ensureVaultFolder, findAvailableVaultPath } from "../shared/util-vault";

/** PeopleDirectoryService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface PeopleDirectoryHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  getKnowledgeExtractionSourceFiles(kind: string): Promise<obsidian.TFile[]>;
  markKnowledgeExtractionSource(kind: string, file: obsidian.TFile): void;
  saveSettings(): Promise<void>;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: LexVoiceSettings;
}

export class PeopleDirectoryService {
  declare host: PeopleDirectoryHost;
  /** 人员目录缓存：按文件夹与修改时间戳命中，避免重复解析全库。 */
  declare _peopleDirectoryCache;

  constructor(host) {
    this.host = host;
    this._peopleDirectoryCache = null;
  }


  async ensurePeopleDirectoryFiles(opts) {
    const overwrite = !!(opts && opts.overwrite);
    const folder = obsidian.normalizePath(this.host.settings.peopleDirectoryFolder || DEFAULT_SETTINGS.peopleDirectoryFolder);
    const basePath = obsidian.normalizePath(this.host.settings.peopleBaseFile || DEFAULT_SETTINGS.peopleBaseFile);
    if (folder) await ensureVaultFolder(this.host.app, folder);
    const baseFolder = basePath.includes("/") ? basePath.slice(0, basePath.lastIndexOf("/")) : "";
    if (baseFolder) await ensureVaultFolder(this.host.app, baseFolder);
    const yaml = formatPeopleBaseYaml();
    let file = this.host.app.vault.getAbstractFileByPath(basePath);
    if (file instanceof obsidian.TFile) {
      if (overwrite) await this.host.app.vault.modify(file, yaml);
    } else {
      file = await this.host.app.vault.create(basePath, yaml);
    }
    return file;
  }

  async createPeopleDirectoryNote(name) {
    const folder = obsidian.normalizePath(this.host.settings.peopleDirectoryFolder || DEFAULT_SETTINGS.peopleDirectoryFolder);
    if (folder) await ensureVaultFolder(this.host.app, folder);
    const safeName = sanitizeFilename(String(name || "").trim()) || "未命名人员";
    const exactPath = obsidian.normalizePath(`${folder}/${safeName}.md`);
    const exact = this.host.app.vault.getAbstractFileByPath(exactPath);
    if (exact instanceof obsidian.TFile) return exact;
    const people = await loadPeopleDirectory(this, { force: true });
    const matched = findMatchingPersonEntry(people, { name: name || safeName, aliases: [] });
    if (matched && matched.path) {
      const file = this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(matched.path));
      if (file instanceof obsidian.TFile) return file;
    }
    return await this.host.app.vault.create(exactPath, formatPeopleNoteMarkdown(name || safeName, this.host.settings.mdFolder));
  }

  choosePrimaryPeopleRecord(records) {
    const scoreRecord = (record) => {
      const file = record && record.file;
      const entry = record && record.entry;
      const basename = String(file && file.basename || "").trim();
      const name = String(entry && entry.name || "").trim();
      const cleanName = sanitizeFilename(name);
      const numericSuffix = /-\d+$/.test(basename);
      if (cleanName && basename === cleanName) return 0;
      if (!numericSuffix) return 10;
      return 20;
    };
    return (records || []).slice().sort((a, b) => {
      const scoreDiff = scoreRecord(a) - scoreRecord(b);
      if (scoreDiff) return scoreDiff;
      return String(a.file && a.file.path || "").length - String(b.file && b.file.path || "").length;
    })[0] || null;
  }

  mergeDuplicatePeopleFrontmatter(primaryFm, duplicateFm, duplicateEntry, duplicateFile) {
    const next = Object.assign({}, primaryFm || {});
    const dup = Object.assign({}, duplicateFm || {});
    const canonicalName = String(next["姓名"] || next.name || "").trim();
    const duplicateName = String(duplicateEntry && duplicateEntry.name || dup["姓名"] || dup.name || "").trim();
    if (!canonicalName && duplicateName) next["姓名"] = duplicateName;
    for (const key of ["角色", "组织", "邮箱"]) {
      if (!String(next[key] || "").trim() && String(dup[key] || "").trim()) next[key] = dup[key];
    }
    const aliasCandidates = [];
    aliasCandidates.push(...splitPersonFieldValue(next["常用称呼"] || next.aliases || []));
    aliasCandidates.push(...splitPersonFieldValue(dup["常用称呼"] || dup.aliases || []));
    if (duplicateName && normalizePersonLookupText(duplicateName) !== normalizePersonLookupText(next["姓名"] || canonicalName)) aliasCandidates.push(duplicateName);
    const aliases = mergeUniqueStrings([], aliasCandidates)
      .filter(item => !/-\d+$/.test(String(item || "").trim()));
    if (aliases.length) next["常用称呼"] = aliases;
    const sources = mergeUniqueStrings(next["来源"] || next.sources || [], dup["来源"] || dup.sources || []);
    if (sources.length) next["来源"] = sources;
    const notes = [];
    for (const value of [next["备注"] || next.note, dup["备注"] || dup.note]) {
      const text = String(value || "").trim();
      if (text && !notes.includes(text)) notes.push(text);
    }
    const duplicateLabel = duplicateFile instanceof obsidian.TFile ? duplicateFile.basename : "";
    if (duplicateLabel) notes.push(`合并历史重复人员页：${duplicateLabel}`);
    if (notes.length) next["备注"] = notes.join("\n\n");
    next.type = "lexvoice-person";
    next["最近更新"] = new Date().toISOString().slice(0, 10);
    next.tags = mergeUniqueStrings(getFrontmatterTags(next), ["lexvoice/person"]);
    delete next.name;
    delete next.aliases;
    delete next.sources;
    delete next.note;
    return next;
  }

  formatMergedPeopleArchiveMarkdown(duplicateFile, primaryFile, duplicateFm) {
    const fm = Object.assign({}, duplicateFm || {});
    fm.type = "lexvoice-person-merged";
    fm["已合并到"] = makeFileWikiLink(primaryFile);
    fm["合并日期"] = new Date().toISOString().slice(0, 10);
    fm.tags = mergeUniqueStrings(getFrontmatterTags(fm).filter(tag => tag !== "lexvoice/person"), ["lexvoice/person-merged"]);
    delete fm.name;
    delete fm.aliases;
    const title = duplicateFile instanceof obsidian.TFile ? duplicateFile.basename : "已合并人员";
    const target = makeFileWikiLink(primaryFile);
    return upsertFrontmatterInMarkdown(`# ${title}\n\n此人员档案已合并到 ${target}。\n\n保留此归档页用于回溯，QnALog 不再把它作为人员资料读取。\n`, fm);
  }

  replacePeopleWikiLinksInText(text, replacements) {
    let next = String(text || "");
    for (const item of replacements || []) {
      const fromFile = item && item.fromFile;
      const toFile = item && item.toFile;
      if (!(fromFile instanceof obsidian.TFile) || !(toFile instanceof obsidian.TFile)) continue;
      const targets = Array.from(new Set([
        obsidian.normalizePath(fromFile.path || "").replace(/\.md$/i, ""),
        fromFile.basename,
      ].filter(Boolean)));
      const toTarget = obsidian.normalizePath(toFile.path || "").replace(/\.md$/i, "");
      const toLabel = toFile.basename;
      for (const target of targets) {
        const re = new RegExp(`\\[\\[${escapeRegExp(target)}(?:\\|([^\\]]+))?\\]\\]`, "g");
        next = next.replace(re, (_match, label) => {
          const rawLabel = String(label || "").trim();
          const display = rawLabel && !/-\d+$/.test(rawLabel) ? rawLabel : toLabel;
          return `[[${toTarget}|${display}]]`;
        });
      }
    }
    return next;
  }

  async mergeDuplicatePeopleDirectory() {
    await this.ensurePeopleDirectoryFiles({ overwrite: false });
    const folder = obsidian.normalizePath(this.host.settings.peopleDirectoryFolder || DEFAULT_SETTINGS.peopleDirectoryFolder);
    const prefix = folder ? folder + "/" : "";
    const files = this.host.app.vault.getMarkdownFiles()
      .filter(file => {
        const path = obsidian.normalizePath(file.path || "");
        return folder && path.startsWith(prefix);
      });
    const groups = new Map();
    for (const file of files) {
      const fm = await readFileFrontmatter(this, file);
      const entry = personEntryFromFrontmatter(fm, file);
      const key = normalizePersonLookupText(entry && entry.name);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ file, fm: fm || {}, entry });
    }
    const duplicateGroups = Array.from(groups.values()).filter(group => group.length > 1);
    if (!duplicateGroups.length) return { groups: 0, merged: 0, updatedLinks: 0 };

    const archiveFolder = obsidian.normalizePath(DEFAULT_LIBRARY_PATHS.duplicatePeopleArchiveFolder);
    await ensureVaultFolder(this.host.app, archiveFolder);
    const replacements = [];
    let merged = 0;
    for (const group of duplicateGroups) {
      const primary = this.choosePrimaryPeopleRecord(group);
      if (!primary) continue;
      let primaryContent = await this.host.app.vault.read(primary.file);
      let primaryFm = Object.assign({}, primary.fm || {});
      for (const duplicate of group) {
        if (!duplicate || duplicate.file === primary.file) continue;
        primaryFm = this.mergeDuplicatePeopleFrontmatter(primaryFm, duplicate.fm || {}, duplicate.entry, duplicate.file);
        replacements.push({ fromFile: duplicate.file, toFile: primary.file });
        const archiveMarkdown = this.formatMergedPeopleArchiveMarkdown(duplicate.file, primary.file, duplicate.fm || {});
        await this.host.app.vault.modify(duplicate.file, archiveMarkdown);
        const archivePath = findAvailableVaultPath(this.host.app, obsidian.normalizePath(`${archiveFolder}/${duplicate.file.basename}.md`));
        if (archivePath && this.host.app.fileManager && typeof this.host.app.fileManager.renameFile === "function") {
          await this.host.app.fileManager.renameFile(duplicate.file, archivePath);
        }
        merged++;
      }
      primaryContent = ensurePeopleNoteRelatedBaseSection(primaryContent, this.host.settings.mdFolder);
      await this.host.app.vault.modify(primary.file, upsertFrontmatterInMarkdown(primaryContent, primaryFm));
    }

    let updatedLinks = 0;
    if (replacements.length) {
      for (const file of this.host.app.vault.getMarkdownFiles()) {
        const path = obsidian.normalizePath(file.path || "");
        if (path.startsWith(archiveFolder + "/")) continue;
        const content = await this.host.app.vault.read(file);
        const next = this.replacePeopleWikiLinksInText(content, replacements);
        if (next !== content) {
          await this.host.app.vault.modify(file, next);
          updatedLinks++;
        }
      }
    }
    this.invalidatePeopleDirectoryCache();
    return { groups: duplicateGroups.length, merged, updatedLinks };
  }

  invalidatePeopleDirectoryCache() {
    this._peopleDirectoryCache = null;
  }

  async getCachedPeopleDirectorySuggestions() {
    const cache = normalizePeopleSuggestionCache(this.host.settings.peopleSuggestionCache);
    const people = await loadPeopleDirectory(this);
    const keptRecords = [];
    const suggestions = [];
    let changed = false;
    for (const record of cache.pending) {
      if (!isPeopleSuggestionCacheRecordCurrent(this, record) || isPeopleSuggestionIgnored(this.host.settings, record.suggestion)) {
        changed = true;
        continue;
      }
      const item = peopleSuggestionRecordToSuggestion(record);
      if (!item) {
        changed = true;
        continue;
      }
      item.match = findMatchingPersonEntry(people, item);
      item.matchPath = (item.match && item.match.path) || item.matchPath || "";
      keptRecords.push(Object.assign({}, record, {
        suggestion: Object.assign({}, record.suggestion || {}, { matchPath: item.matchPath }),
      }));
      suggestions.push(item);
    }
    if (changed || keptRecords.length !== cache.pending.length) {
      this.host.settings.peopleSuggestionCache = { pending: keptRecords };
      await this.host.saveSettings();
    }
    return suggestions;
  }

  cachePeopleDirectorySuggestions(sourceFile, suggestions) {
    const cache = normalizePeopleSuggestionCache(this.host.settings.peopleSuggestionCache);
    const byKey = new Map(cache.pending.map(record => [record.key, record]));
    let added = 0;
    for (const raw of suggestions || []) {
      if (isPeopleSuggestionIgnored(this.host.settings, raw)) continue;
      const record = makePeopleSuggestionCacheRecord(sourceFile, raw);
      if (!record) continue;
      const existing = byKey.get(record.key);
      byKey.set(record.key, Object.assign({}, existing || {}, record, {
        createdAt: existing && existing.createdAt ? existing.createdAt : record.createdAt,
        updatedAt: new Date().toISOString(),
      }));
      if (!existing) added++;
    }
    this.host.settings.peopleSuggestionCache = { pending: Array.from(byKey.values()).slice(-PEOPLE_SUGGESTION_CACHE_LIMIT) };
    return added;
  }

  removeCachedPeopleSuggestions(suggestions) {
    const cache = normalizePeopleSuggestionCache(this.host.settings.peopleSuggestionCache);
    const keys = new Set();
    for (const item of suggestions || []) {
      const key = item && (item.cacheKey || item.key || getPeopleSuggestionCacheKey(item.sourcePath || "", item));
      if (key) keys.add(String(key));
    }
    if (!keys.size) return 0;
    const pending = cache.pending.filter(record => !keys.has(record.key));
    this.host.settings.peopleSuggestionCache = { pending };
    return cache.pending.length - pending.length;
  }

  clearPeopleSuggestionCache() {
    this.host.settings.peopleSuggestionCache = { pending: [] };
  }

  async openCachedPeopleDirectorySuggestions() {
    const suggestions = await this.getCachedPeopleDirectorySuggestions();
    if (!suggestions.length) {
      new obsidian.Notice("当前没有待确认的人员建议");
      return false;
    }
    new PeopleDirectorySuggestionModal(this.host.app, this, null, suggestions, {
      fromCache: true,
      cachedCount: suggestions.length,
    }).open();
    return true;
  }

  async openIgnoredPeopleDirectorySuggestions() {
    const records = normalizePeopleSuggestionIgnores(this.host.settings.peopleSuggestionIgnores);
    if (!records.length) {
      new obsidian.Notice("当前没有已忽略的人员建议");
      return false;
    }
    const people = await loadPeopleDirectory(this);
    const suggestions = records
      .map(record => peopleSuggestionIgnoreRecordToSuggestion(record))
      .filter(Boolean)
      .map(item => {
        item.match = findMatchingPersonEntry(people, item);
        item.matchPath = (item.match && item.match.path) || item.matchPath || "";
        return item;
      });
    if (!suggestions.length) {
      new obsidian.Notice("已忽略列表里没有可编辑的人员建议");
      return false;
    }
    new PeopleDirectorySuggestionModal(this.host.app, this, null, suggestions, {
      fromIgnored: true,
      ignoredCount: records.length,
    }).open();
    return true;
  }

  async suggestPeopleDirectoryFromLibrary() {
    const cached = await this.getCachedPeopleDirectorySuggestions();
    if (cached.length) {
      new PeopleDirectorySuggestionModal(this.host.app, this, null, cached, {
        fromCache: true,
        cachedCount: cached.length,
      }).open();
      return;
    }
    if (!this.host.settings.llmApiKey && !canOmitServiceApiKey(this.host.settings.llmEndpoint)) {
      new obsidian.Notice("请先配置大模型服务");
      return;
    }
    const all = this.host.getKnowledgeExtractionSourceFiles("people");
    const batch = all.slice(0, KNOWLEDGE_EXTRACTION_BATCH_LIMIT);
    if (!batch.length) {
      new obsidian.Notice("没有需要扫描的新纪要。修改过的纪要会自动重新进入扫描。");
      return;
    }
    new obsidian.Notice(`QnALog：正在扫描 ${batch.length} 篇纪要提取人员信息…`);
    try {
      let cachedCount = 0;
      let processed = 0;
      let failed = 0;
      for (const file of batch) {
        try {
          const markdown = await this.host.app.vault.cachedRead(file);
          const items = await generatePeopleDirectorySuggestions(this, file, markdown);
          cachedCount += this.cachePeopleDirectorySuggestions(file, items);
          this.host.markKnowledgeExtractionSource("people", file);
          processed++;
        } catch (e) {
          failed++;
          console.error("[QnALog] library people extraction failed", file && file.path, e);
        }
      }
      await this.host.saveSettings();
      const suggestions = await this.getCachedPeopleDirectorySuggestions();
      if (!suggestions.length) {
        const suffix = failed ? `，失败 ${failed}` : "";
        new obsidian.Notice(`没有新的人员建议（已忽略的建议不会重复显示）${suffix}`);
        return;
      }
      if (failed) new obsidian.Notice(`人员扫描完成，${failed} 篇读取或提取失败，可稍后重试。`, 8000);
      const modal = new PeopleDirectorySuggestionModal(this.host.app, this, null, suggestions, {
        scannedCount: processed,
        cachedCount,
        remainingCount: Math.max(0, all.length - batch.length),
      });
      modal.open();
    } catch (e) {
      console.error("[QnALog] suggest people directory failed", e);
      new obsidian.Notice(`人员信息提取失败：${(e && e.message) || e}`, 8000);
    }
  }

  async ignorePeopleDirectorySuggestion(suggestion) {
    const ok = addPeopleSuggestionIgnore(this.host.settings, suggestion);
    if (ok) {
      this.removeCachedPeopleSuggestions([suggestion]);
      await this.host.saveSettings();
    }
    return ok;
  }

  removePeopleDirectorySuggestionIgnores(suggestions) {
    return removePeopleSuggestionIgnores(this.host.settings, suggestions);
  }

  async restoreIgnoredPeopleDirectorySuggestion(suggestion) {
    const removed = this.removePeopleDirectorySuggestionIgnores([suggestion]);
    if (!removed) return 0;
    const sourceFile = suggestion && suggestion.sourcePath
      ? this.host.app.vault.getAbstractFileByPath(obsidian.normalizePath(suggestion.sourcePath))
      : null;
    this.cachePeopleDirectorySuggestions(sourceFile instanceof obsidian.TFile ? sourceFile : null, [suggestion]);
    await this.host.saveSettings();
    return removed;
  }

  async updateSourceNoteRelatedPeopleLinks(sourceFile, personFiles) {
    if (!(sourceFile instanceof obsidian.TFile) || !personFiles || !personFiles.length) return false;
    const content = await this.host.app.vault.read(sourceFile);
    const fm = await readFileFrontmatter(this, sourceFile) || {};
    const next = upsertFrontmatterInMarkdown(content, mergeSourceNoteRelatedPeopleFrontmatter(fm, personFiles));
    if (next !== content) {
      await this.host.app.vault.modify(sourceFile, next);
      return true;
    }
    return false;
  }

  async resolvePeopleDirectorySuggestionTargets(suggestions) {
    const folder = obsidian.normalizePath(this.host.settings.peopleDirectoryFolder || DEFAULT_SETTINGS.peopleDirectoryFolder);
    let existingPeople = [];
    try {
      existingPeople = await loadPeopleDirectory(this, { force: true });
    } catch (e) {
      console.warn("[QnALog] load people directory before resolving suggestions failed", e);
    }
    const getPersonFileByPath = (path) => {
      const normalized = obsidian.normalizePath(path || "");
      if (!normalized) return null;
      const file = this.host.app.vault.getAbstractFileByPath(normalized);
      return file instanceof obsidian.TFile ? file : null;
    };
    const getExactPersonFileByName = (name) => {
      const safeName = sanitizeFilename(name) || "";
      if (!folder || !safeName) return null;
      return getPersonFileByPath(obsidian.normalizePath(`${folder}/${safeName}.md`));
    };
    const normalizeForApply = (raw) => {
      const suggestion = normalizePeopleSuggestion(raw);
      if (!suggestion) return null;
      suggestion.matchPath = raw.matchPath || (raw.match && raw.match.path) || "";
      suggestion.sourcePath = raw.sourcePath || "";
      suggestion.sourceBasename = raw.sourceBasename || "";
      suggestion.cacheKey = raw.cacheKey || "";
      suggestion.ignoreKey = raw.ignoreKey || "";
      suggestion.ignoreTerms = raw.ignoreTerms || [];
      return suggestion;
    };
    const resolvePath = (suggestion) => {
      const manual = getPersonFileByPath(suggestion && suggestion.matchPath || "");
      if (manual) return obsidian.normalizePath(manual.path);
      const exact = getExactPersonFileByName(suggestion && suggestion.name);
      if (exact) return obsidian.normalizePath(exact.path);
      const match = findMatchingPersonEntry(existingPeople, suggestion);
      return obsidian.normalizePath(match && match.path || "");
    };
    const groups = [];
    for (const raw of suggestions || []) {
      const suggestion = normalizeForApply(raw);
      if (!suggestion) continue;
      const targetPath = resolvePath(suggestion);
      let group = targetPath ? groups.find(item => item.targetPath === targetPath) : null;
      if (!group) group = groups.find(item => arePeopleSuggestionsRelated(item.suggestion, suggestion));
      if (group) {
        group.suggestion = mergePeopleSuggestions(group.suggestion, suggestion);
        if (targetPath && !group.targetPath) group.targetPath = targetPath;
      } else {
        groups.push({ targetPath, suggestion });
      }
    }
    return groups.map(group => Object.assign({}, group.suggestion, {
      matchPath: group.targetPath || group.suggestion.matchPath || "",
    }));
  }

  async applyPeopleDirectorySuggestions(sourceFile, suggestions) {
    await this.ensurePeopleDirectoryFiles({ overwrite: false });
    let created = 0;
    let updated = 0;
    const linkedPeopleRecords = [];
    const entries = [];
    for (const raw of await this.resolvePeopleDirectorySuggestionTargets(suggestions)) {
      const suggestion = normalizePeopleSuggestion(raw);
      if (!suggestion) continue;
      suggestion.matchPath = raw.matchPath || (raw.match && raw.match.path) || "";
      const matchPath = obsidian.normalizePath(suggestion.matchPath || "");
      let file = matchPath ? this.host.app.vault.getAbstractFileByPath(matchPath) : null;
      if (file instanceof obsidian.TFile) {
        const content = await this.host.app.vault.read(file);
        const fm = await readFileFrontmatter(this, file) || {};
        const body = ensurePeopleNoteRelatedBaseSection(content, this.host.settings.mdFolder);
        await this.host.app.vault.modify(file, upsertFrontmatterInMarkdown(body, mergePersonFrontmatter(fm, suggestion, sourceFile)));
        linkedPeopleRecords.push({ file, relation: suggestion.relation || "mentioned" });
        entries.push({ file, path: file.path, created: false, previousContent: content, kind: "person" });
        updated++;
      } else {
        const folder = obsidian.normalizePath(this.host.settings.peopleDirectoryFolder || DEFAULT_SETTINGS.peopleDirectoryFolder);
        if (folder) await ensureVaultFolder(this.host.app, folder);
        const safeName = sanitizeFilename(suggestion.name) || "未命名人员";
        const path = findAvailableVaultPath(this.host.app, obsidian.normalizePath(`${folder}/${safeName}.md`));
        if (!path) throw new Error("无法创建人员信息文件");
        const fm = mergePersonFrontmatter({ "姓名": suggestion.name }, suggestion, sourceFile);
        const body = formatPeopleNoteMarkdown(suggestion.name, this.host.settings.mdFolder);
        file = await this.host.app.vault.create(path, upsertFrontmatterInMarkdown(body, fm));
        linkedPeopleRecords.push({ file, relation: suggestion.relation || "mentioned" });
        entries.push({ file, path: file.path, created: true, previousContent: "", kind: "person" });
        created++;
      }
    }
    if (linkedPeopleRecords.length) {
      await this.updateSourceNoteRelatedPeopleLinks(sourceFile, linkedPeopleRecords);
      this.invalidatePeopleDirectoryCache();
    }
    return { created, updated, entries };
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
