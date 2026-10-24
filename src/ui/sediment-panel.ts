/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 ui/outline-view.ts 搬出（纯搬迁、行为不变）：侧栏「沉淀」页签——扫描、候选审核、提交与撤销、待办行内编辑。
// 领域能力经 SedimentUiPort 注入（src/main.ts 装配），视图状态经 SedimentViewBridge 读写。

import { t as i18nT } from '../shared/i18n';
import * as obsidian from "obsidian";

import { trashVaultFileRef } from "./helpers";

import { stripModePrefixFromTitle } from "../notes/note-title-path";

import { getPeopleSuggestionCacheKey, loadPeopleDirectory, normalizePeopleSuggestionCache, normalizePeopleSuggestionIgnores, peopleSuggestionIgnoreRecordToSuggestion, peopleSuggestionRecordToSuggestion } from "../people";
import { normalizePersonLookupText, splitPersonFieldValue } from "../people/person-text";

import { getSedimentHotwordId, getSedimentPersonId, getSedimentTodoId, normalizeSedimentExtractionModel, normalizeSedimentTodoSubtasks, removeSedimentGroupDone, sanitizeSedimentText, withSedimentCandidateIds } from "../sediment";

import { countVocabularyGroups, createVocabularyGroups, mergeVocabularyGroups } from "../vocabulary";

import { DEFAULT_SETTINGS } from "../shared/defaults";

import { SEDIMENT_GROUP_CONFIG, SEDIMENT_GROUP_ORDER } from "../shared/catalog-sediment";

import { primitiveText } from "../shared/util-common";

import { getTaskErrorMessage } from "../shared/task-activity";

import { clampSpeakerChannelCount, replaceSpeakerDisplayName } from "../audio/channel-speakers";

import { isKnowledgeSourceAlreadyScanned } from "../notes/recording-issues";

import {
  appendSedimentDecisionItems as appendSedimentDecisionItemsFlow,
  buildSedimentDecisionLog as buildSedimentDecisionLogFlow,
  cloneSedimentBucket as cloneSedimentBucketValue,
  countSedimentHotwordCandidates as countSedimentHotwordCandidatesFlow,
  createEmptySedimentBucket,
  findSedimentNextPendingGroup as findSedimentNextPendingGroupFlow,
  getActiveSedimentGroup as getActiveSedimentGroupFlow,
  getSedimentCandidateSignature as getSedimentCandidateSignatureFlow,
  getSedimentDisplayItems as getSedimentDisplayItemsFlow,
  getSedimentGroupRawItems as getSedimentGroupRawItemsFlow,
  getSedimentGroupReview as getSedimentGroupReviewFlow,
  getSedimentHotwordItems as getSedimentHotwordItemsFlow,
  getSedimentNodeState as getSedimentNodeStateFlow,
  getSedimentSelectedIds as getSedimentSelectedIdsFlow,
  mergeSedimentPeopleCandidates as mergeSedimentPeopleCandidatesFlow,
  setSedimentDecisionLog as setSedimentDecisionLogFlow,
  setSedimentSelectedIds as setSedimentSelectedIdsFlow,
  type SedimentBucketPort,
  type SedimentCandidateBucket,
  type SedimentIdPort,
  type SedimentGroup,
  type SedimentGroupReview,
  type SedimentItem,
  type SedimentPanelState,
} from "../sediment/sediment-flow/sediment-panel-state";
import { scanSedimentFile, cancelSedimentScan, type SedimentScanNormalized } from "../sediment/sediment-flow/sediment-scan-flow";
import { scheduleSedimentAutoAdvance as scheduleSedimentAutoAdvanceFlow } from "../sediment/sediment-flow/sediment-advance";
import { commitSedimentGroupFlow } from "../sediment/sediment-flow/sediment-commit-flow";
import { restoreSedimentCommitFlow } from "../sediment/sediment-flow/sediment-undo-flow";

import type { SedimentUiPort, SedimentViewBridge } from "./sediment-ui-port";
import { enterInlineTitleEdit } from "./inline-title-edit";

type SedimentBucketPatch = Partial<SedimentCandidateBucket>;

/** 沉淀提示条的选项。 */
type SedimentToastOptions = {
  icon?: string;
  /** 提示条样式变体；有值时加在 class 上。 */
  variant?: string;
  /** 提示条上的按钮集合：既支持 { id, label } 形态，也支持 { text, action } 形态。 */
  actions?: { id?: string; label?: string; primary?: boolean; text?: string; action?: () => void }[];
  /** 提示条位置参数（由 OpenOutlineContext 透传）。 */
  onTimeLink?: (payload: unknown) => void;
  actionText?: string;
  onAction?: () => void;
  /** 提示条显示时长（毫秒）。 */
  duration?: number;
};

/** 一次沉淀提交的撤销记录。 */
type SedimentCommitUndo = {
  filePath: string;
  bucketBefore: SedimentCandidateBucket;
  entries: Array<{
    path?: string;
    file?: unknown;
    created?: boolean;
    previousContent?: string;
  }>;
  sourceSnapshot?: { path: string; content: string };
  vocabulary?: {
    path?: string;
    existed?: boolean;
    previousContent?: string;
    previousCustomVocabulary?: string;
  };
};

/** 内联提示浮层：除 DOM 元素外挂一个关闭回调。 */
type InlinePopover = HTMLElement & { _qnalogClose?: () => void };

/** 人员候选项：取 id 与来源路径时用到的最小形状。 */
type PeopleSuggestionLike = { cacheKey?: string; key?: string; sourcePath?: string };

function sedimentNoticeErrorSuffix(error: unknown): string {
  const suffix = (error && Reflect.get(Object(error), "message")) || error;
  return `${suffix}`;
}

export class SedimentPanel {
  declare app: obsidian.App;
  declare port: SedimentUiPort;
  declare view: SedimentViewBridge;
  /** 沉淀面板当前选中的分组（person / todo / hotword）。 */
  declare sedimentGroup: string;
  /** 分组切换浮层是否展开。 */
  declare sedimentSwitcherOpen: boolean;
  /** 已「展开全部」的候选分组。 */
  declare sedimentExpandedGroups: Set<string>;
  /** 各纪要的沉淀候选桶（按文件路径索引），未落盘前的编辑态。 */
  declare sedimentCandidatesByPath: Record<string, SedimentCandidateBucket>;
  /** 沉淀提交提示的隐藏定时器。 */
  declare sedimentToastTimer: number;
  /** 沉淀分组自动前进的定时器。 */
  declare sedimentAdvanceTimer: number;
  /** 沉淀扫描的递增令牌；用于丢弃过期的异步结果。 */
  declare sedimentScanToken: number;
  /** 最近一次沉淀提交的撤销信息。 */
  declare sedimentLastUndo: unknown;
  /** 待办行内编辑后要聚焦的字段。 */
  declare inlineTodoPendingFocus: { todoId: string; field: string } | null;
  /** 当前打开的待办行内编辑器。 */
  declare inlineTodoEditor: { _anchor?: unknown; close(): void } | null;
  /** 当前打开的待办字段浮层。 */
  declare _activeTodoFieldPopover: HTMLElement | null;
  constructor(app: obsidian.App, port: SedimentUiPort, view: SedimentViewBridge) {
    this.app = app;
    this.port = port;
    this.view = view;
    this.sedimentGroup = "person";
    this.sedimentSwitcherOpen = false;
    this.sedimentExpandedGroups = new Set(); // 哪些候选分组已t("Expand all")（默认只显示前 8 条）
    this.sedimentCandidatesByPath = {};
    this.sedimentToastTimer = 0;
    this.sedimentAdvanceTimer = 0;
    this.sedimentScanToken = 0;
    this.sedimentLastUndo = null;
    this.inlineTodoPendingFocus = null;
    this.inlineTodoEditor = null;
    this._activeTodoFieldPopover = null;
  }

  /** 视图关闭时清掉沉淀提示与自动前进的定时器。 */
  dispose(): void {
    if (this.sedimentToastTimer) { window.clearTimeout(this.sedimentToastTimer); this.sedimentToastTimer = 0; }
    if (this.sedimentAdvanceTimer) { window.clearTimeout(this.sedimentAdvanceTimer); this.sedimentAdvanceTimer = 0; }
  }

  renderExtractionPanel(root, file) {
    const sec = root.createDiv({ cls: "qnalog-outline-section qnalog-outline-extract qnalog-sediment" });
    const panelData = this.view.getCompletedNotePanelData(file);
    if (panelData && panelData.preExtractedSediment) this.hydrateSedimentCandidatesFromEmbedded(file, panelData.preExtractedSediment);
    const state = this.getSedimentPanelState(file);

    if (panelData === undefined) {
      sec.createDiv({ cls: "qnalog-outline-empty", text: i18nT("Reading distilled data…") });
      return;
    }

    if (panelData && panelData.speakerIds && panelData.speakerIds.length) {
      this.renderSedimentSpeakerMap(sec, file, panelData);
    }

    if (state.scanning) {
      this.renderSedimentScanning(sec, file, state);
      return;
    }

    if (!state.hasPipelineStarted) {
      this.renderSedimentStart(sec, file, state);
      return;
    }

    const groupKey = this.getActiveSedimentGroup(state.groups);

    this.renderSedimentBaton(sec, state, groupKey, file);
    this.renderSedimentGroup(sec, file, state, groupKey);
  }

  hydrateSedimentCandidatesFromEmbedded(file, objects) {
    if (!(file instanceof obsidian.TFile) || !objects) return false;
    const current = this.getSedimentCandidateBucket(file);
    const hasExisting = !!(
      current.scannedAt
      || (current.people || []).length
      || (current.todos || []).length
      || (current.cards || []).length
      || countVocabularyGroups(current.hotwords)
    );
    if (hasExisting) return false;
    const path = obsidian.normalizePath(file.path || "");
    const normalized = withSedimentCandidateIds(objects, path, file.basename);
    this.setSedimentCandidateBucket(file, {
      people: normalized.people || [],
      todos: normalized.todos || [],
      hotwords: normalized.hotwords || createVocabularyGroups(),
      scannedAt: new Date(file.stat && file.stat.mtime ? file.stat.mtime : Date.now()).toISOString(),
      source: "pre-extracted",
      initialCounts: this.getSedimentInitialCountsFromObjects(normalized),
      doneGroups: [],
      selectedByGroup: {},
      decisionLogByGroup: {},
      transitionGroup: "",
    });
    return true;
  }

  getSedimentPanelState(file): SedimentPanelState {
    const currentPath = obsidian.normalizePath(file.path || "");
    const bucket = this.getSedimentCandidateBucket(file);
    const pendingRecords = normalizePeopleSuggestionCache(this.port.settings.peopleSuggestionCache).pending || [];
    const allPeople = pendingRecords.map(record => peopleSuggestionRecordToSuggestion(record)).filter(Boolean);
    const cachedPeople = allPeople.filter(item => obsidian.normalizePath(item.sourcePath || "") === currentPath);
    const currentPeople = this.mergeSedimentPeopleCandidates(currentPath, bucket.people || [], cachedPeople);
    // 应用用户在侧边栏手动改的人名（override 按原始 id，不改 id 本身）
    const nameOverrides = bucket.peopleNameOverrides || {};
    for (const candidate of currentPeople) {
      const p = candidate as Record<string, unknown>;
      const sourcePath = typeof p.sourcePath === "string" ? p.sourcePath : currentPath;
      const pid = getSedimentPersonId(sourcePath, p);
      if (pid && Object.prototype.hasOwnProperty.call(nameOverrides, pid)) p.name = nameOverrides[pid];
    }
    const otherPeopleCount = Math.max(0, allPeople.length - cachedPeople.length);
    const ignoredPeople = normalizePeopleSuggestionIgnores(this.port.settings.peopleSuggestionIgnores)
      .map(record => peopleSuggestionIgnoreRecordToSuggestion(record))
      .filter(Boolean)
      .filter(item => obsidian.normalizePath(item.sourcePath || "") === currentPath);
    const vocabScanned = isKnowledgeSourceAlreadyScanned(this.port.settings, "vocabulary", file);
    const peopleScanned = isKnowledgeSourceAlreadyScanned(this.port.settings, "people", file);
    const pendingCounts = {
      person: currentPeople.length,
      todo: (bucket.todos || []).length,
      hotword: this.countSedimentHotwordCandidates(bucket.hotwords),
    };
    const initialCounts = bucket.initialCounts && typeof bucket.initialCounts === "object" ? bucket.initialCounts : {};
    const doneGroups = new Set(Array.isArray(bucket.doneGroups) ? bucket.doneGroups : []);
    const hasCandidates = SEDIMENT_GROUP_ORDER.some(key => pendingCounts[key] > 0);
    const scanning = !!bucket.scanning;
    const hasPipelineStarted = !!(bucket.scannedAt || hasCandidates || peopleScanned || vocabScanned || ignoredPeople.length);
    const groups = SEDIMENT_GROUP_ORDER.map((key, index) => {
      const cfg = SEDIMENT_GROUP_CONFIG[key];
      const pending = pendingCounts[key] || 0;
      const oldDone = key === "person" ? peopleScanned : (key === "hotword" ? vocabScanned : false);
      const initial = Math.max(0, Number(initialCounts[key]) || 0);
      const hasDoneFlag = doneGroups.has(key) || oldDone;
      const emptyDone = !!bucket.scannedAt && !pending && !initial && !hasDoneFlag;
      const total = Math.max(pending, initial, (hasDoneFlag || emptyDone) ? 1 : 0);
      const done = total ? Math.max(0, Math.min(total, (hasDoneFlag || emptyDone) ? total : total - pending)) : 0;
      return {
        key,
        lead: i18nT(cfg.lead),
        label: i18nT(cfg.label),
        unit: i18nT(cfg.unit),
        dest: i18nT(cfg.dest),
        model: cfg.model,
        pending,
        total,
        done,
        emptyDone,
        status: total ? (done >= total ? i18nT("Processed") : i18nT("To add")) : i18nT("No candidates"),
        next: SEDIMENT_GROUP_ORDER[index + 1] || null,
      };
    });
    return { currentPeople, otherPeopleCount, ignoredPeople, vocabScanned, peopleScanned, groups, bucket, hasPipelineStarted, scanning };
  }

  getSedimentCandidateBucket(file) {
    const path = file instanceof obsidian.TFile ? obsidian.normalizePath(file.path || "") : "";
    const raw = path && this.sedimentCandidatesByPath ? this.sedimentCandidatesByPath[path] : null;
    return Object.assign(createEmptySedimentBucket(), raw || {});
  }

  setSedimentCandidateBucket(file, patch: SedimentBucketPatch) {
    if (!(file instanceof obsidian.TFile)) return;
    const path = obsidian.normalizePath(file.path || "");
    if (!path) return;
    const current = this.getSedimentCandidateBucket(file);
    this.sedimentCandidatesByPath[path] = Object.assign({}, current, patch || {});
  }

  getSedimentInitialCountsFromObjects(objects) {
    const normalized = normalizeSedimentExtractionModel(objects);
    return {
      person: (normalized.people || []).length,
      todo: (normalized.todos || []).length,
      hotword: this.countSedimentHotwordCandidates(normalized.hotwords),
    };
  }

  markSedimentGroupDone(file, groupKey: string, fallbackTotal = 0) {
    if (!(file instanceof obsidian.TFile) || !SEDIMENT_GROUP_CONFIG[groupKey]) return false;
    const bucket = this.getSedimentCandidateBucket(file);
    const initialCounts = Object.assign({}, bucket.initialCounts || {});
    const fallback = Math.max(0, Number(fallbackTotal) || 0);
    initialCounts[groupKey] = Math.max(Number(initialCounts[groupKey]) || 0, fallback, 1);
    const doneGroups = Array.from(new Set([...(Array.isArray(bucket.doneGroups) ? bucket.doneGroups : []), groupKey]));
    this.setSedimentCandidateBucket(file, { initialCounts, doneGroups, transitionGroup: groupKey });
    return true;
  }

  markSedimentGroupDoneIfEmpty(file, groupKey: string, fallbackTotal = 0) {
    if (!(file instanceof obsidian.TFile) || !SEDIMENT_GROUP_CONFIG[groupKey]) return false;
    const state = this.getSedimentPanelState(file);
    const group = state.groups.find(item => item.key === groupKey);
    if (group && group.pending > 0) return false;
    return this.markSedimentGroupDone(file, groupKey, fallbackTotal);
  }

  getSedimentCandidateSignature() {
    return getSedimentCandidateSignatureFlow(this.sedimentCandidatesByPath || {});
  }

  mergeSedimentPeopleCandidates(currentPath, memoryPeople, cachedPeople) {
    return mergeSedimentPeopleCandidatesFlow(
      currentPath,
      memoryPeople || [],
      cachedPeople || [],
      getPeopleSuggestionCacheKey,
    );
  }

  countSedimentHotwordCandidates(groups) {
    return countSedimentHotwordCandidatesFlow(groups);
  }

  getSedimentHotwordItems(groups) {
    return getSedimentHotwordItemsFlow(groups, this.sedimentIdPort());
  }

  getSedimentGroupRawItems(state, groupKey) {
    return getSedimentGroupRawItemsFlow(state, groupKey, this.sedimentIdPort());
  }

  getSedimentDisplayItems(state: SedimentPanelState, groupKey: string): SedimentItem[] {
    return getSedimentDisplayItemsFlow(state, groupKey, this.sedimentIdPort());
  }

  private sedimentIdPort(): SedimentIdPort {
    return {
      getHotwordId: getSedimentHotwordId,
      getPersonId: getSedimentPersonId,
      getTodoId: getSedimentTodoId,
    };
  }

  private sedimentBucketPort(file): SedimentBucketPort {
    return {
      get: () => this.getSedimentCandidateBucket(file),
      set: patch => this.setSedimentCandidateBucket(file, patch),
      ids: this.sedimentIdPort(),
    };
  }

  getSedimentSelectedIds(file, groupKey: string, items: SedimentItem[]) {
    return getSedimentSelectedIdsFlow(this.sedimentBucketPort(file), groupKey, items);
  }

  setSedimentSelectedIds(file, groupKey: string, ids: string[]) {
    setSedimentSelectedIdsFlow(this.sedimentBucketPort(file), groupKey, ids);
  }

  getSedimentGroupReview(file, groupKey): SedimentGroupReview | null {
    return getSedimentGroupReviewFlow(this.sedimentBucketPort(file), groupKey);
  }

  getActiveSedimentGroup(groups: SedimentGroup[]) {
    return getActiveSedimentGroupFlow(groups, this.sedimentGroup, key => { this.sedimentGroup = key; });
  }

  setSedimentGroup(key) {
    this.sedimentGroup = key || "person";
    this.sedimentSwitcherOpen = false;
    this.view.showRecentHome = false;
    this.view.idlePanelTab = "extract";
    this.view.render();
  }

  getSedimentNodeState(group: SedimentGroup | null | undefined, currentKey: string) {
    return getSedimentNodeStateFlow(group, currentKey);
  }

  findSedimentNextPendingGroup(groups: SedimentGroup[], afterKey = "") {
    return findSedimentNextPendingGroupFlow(groups, afterKey);
  }

  scheduleSedimentAutoAdvance(file, completedKey) {
    scheduleSedimentAutoAdvanceFlow({
      isFile: target => target instanceof obsidian.TFile,
      normalizePath: path => obsidian.normalizePath(path),
      getTimer: () => this.sedimentAdvanceTimer,
      setTimer: timer => { this.sedimentAdvanceTimer = timer; },
      clearTimer: timer => window.clearTimeout(timer),
      scheduleTimer: (callback, delay) => window.setTimeout(callback, delay),
      getActiveNotePath: () => {
        const active = this.view.getActiveNoteFile();
        return active && active.path ? active.path : "";
      },
      getGroups: target => this.getSedimentPanelState(target).groups,
      findNextPendingGroup: (groups, key) => this.findSedimentNextPendingGroup(groups as SedimentGroup[], key),
      clearTransitionGroup: target => this.setSedimentCandidateBucket(target, { transitionGroup: "" }),
      selectGroup: key => this.setSedimentGroup(key),
      render: () => this.view.render(),
    }, file, completedKey);
  }

  renderSedimentBaton(parent, state, groupKey, file) {
    const group = state.groups.find(item => item.key === groupKey) || state.groups[0];
    const allDone = (state.groups || []).length && (state.groups || []).every(item => !item.total || item.done >= item.total);
    const currentDone = group && group.total && group.done >= group.total;
    const wrap = parent.createDiv({ cls: "qnalog-sediment-baton" + (currentDone || allDone ? " is-done" : "") });
    const top = wrap.createDiv({ cls: "qnalog-sediment-baton-top" });
    const status = top.createDiv({ cls: "qnalog-sediment-status" });
    status.createDiv({ cls: "qnalog-sediment-dot" });
    const noteTitle = file && file.basename ? file.basename : i18nT("Current note");
    const title = status.createSpan({ cls: "qnalog-sediment-status-title", text: allDone ? i18nT("This meeting has been fully sedimented") : noteTitle });
    title.setAttr("title", noteTitle);
    top.createSpan({ cls: "qnalog-sediment-progress-text", text: group && group.total ? `${group.done} / ${group.total}` : "0 / 0" });

    const pipeline = wrap.createDiv({ cls: "qnalog-sediment-pipeline" });
    (state.groups || []).forEach((item, index) => {
      const nodeState = this.getSedimentNodeState(item, groupKey);
      const node = pipeline.createEl("button", {
        cls: `qnalog-sediment-pipeline-node is-${nodeState}`,
        attr: {
          type: "button",
          "data-group": item.key,
          "aria-label": i18nT("{0}: {1}").replace("{0}", item.label).replace("{1}", item.status),
        },
      });
      const clickable = nodeState === "pending" || (nodeState === "done" && item.key !== groupKey);
      node.disabled = !clickable;
      const circle = node.createSpan({ cls: "qnalog-sediment-pipeline-circle" });
      if (nodeState === "done") {
        try { obsidian.setIcon(circle, "check"); } catch { circle.setText("✓"); }
      } else {
        circle.setText(String(item.total || 0));
      }
      node.createSpan({ cls: "qnalog-sediment-pipeline-label", text: item.label });
      node.onclick = (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (!clickable) return;
        this.setSedimentGroup(item.key);
      };
      if (index < (state.groups || []).length - 1) {
        const chevron = pipeline.createSpan({ cls: "qnalog-sediment-pipeline-chevron", attr: { "aria-hidden": "true" } });
        try { obsidian.setIcon(chevron, "chevron-right"); } catch { chevron.setText("›"); }
      }
    });
  }

  renderSedimentSwitchPopover(parent, groups, groupKey) {
    const pop = parent.createDiv({ cls: "qnalog-sediment-switch-popover" });
    for (const group of groups) {
      const item = pop.createEl("button", {
        cls: "qnalog-sediment-switch-item" + (group.key === groupKey ? " is-current" : ""),
        attr: { type: "button" },
      });
      const left = item.createSpan({ cls: "qnalog-sediment-switch-left" });
      left.createSpan({ cls: "qnalog-sediment-switch-dot" });
      left.createSpan({ text: group.label });
      item.createSpan({ cls: "qnalog-sediment-switch-count", text: group.pending ? `${group.pending} ${group.unit}` : group.status });
      item.onclick = (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.setSedimentGroup(group.key);
      };
    }
  }

  renderSedimentGroup(parent, file, state: SedimentPanelState, groupKey: string) {
    const body = parent.createDiv({ cls: "qnalog-sediment-body" });
    const group = (state.groups || []).find(item => item.key === groupKey);
    const isReview = group && group.total > 0 && group.done >= group.total;
    if (isReview) {
      this.renderSedimentReviewGroup(body, file, state, groupKey);
      return;
    }
    if (groupKey === "person") {
      this.renderSedimentRescanRow(body, file);
      this.renderSedimentPeople(body, file, state);
    } else if (groupKey === "todo") {
      this.renderSedimentObjectList(body, file, state, "todo");
    } else {
      this.renderSedimentObjectList(body, file, state, "hotword");
    }
  }

  renderSedimentSpeakerMap(parent, file, panelData) {
    const card = parent.createDiv({ cls: "qnalog-speaker-map" });
    const header = card.createDiv({ cls: "qnalog-speaker-map-header" });
    const heading = header.createDiv({ cls: "qnalog-speaker-map-heading" });
    heading.createDiv({ cls: "qnalog-speaker-map-title", text: i18nT("Edit speakers") });
    const list = card.createDiv({ cls: "qnalog-speaker-map-list" });
    const datalistId = `qnalog-speaker-names-${String(file.path || "note").replace(/[^a-z0-9_-]/gi, "-")}`;
    const datalist = list.createEl("datalist", { attr: { id: datalistId } });
    const mappings = panelData.speakerMappings || {};

    void this.port.loadPeopleDirectory()
      .then((people) => {
        for (const person of people || []) {
          const name = String(person && person.name || "").trim();
          if (name) datalist.createEl("option", { attr: { value: name } });
        }
      })
      .catch((error) => console.warn("[QnALog] load speaker mapping people failed", error));

    for (const speakerId of panelData.speakerIds || []) {
      const mapping = mappings[speakerId] || {};
      const channel = Math.max(1, Number(String(speakerId).replace(/^spk-/, "")) || 1);
      const row = list.createDiv({ cls: "qnalog-speaker-map-row" });
      const source = row.createDiv({ cls: "qnalog-speaker-map-source" });
      source.createSpan({ cls: "qnalog-speaker-map-label", text: i18nT("Speaker {0}").replace("{0}", String(clampSpeakerChannelCount(channel))) });
      const input = row.createEl("input", {
        cls: "qnalog-speaker-map-input",
        attr: {
          type: "text",
          list: datalistId,
          placeholder: i18nT("Enter name"),
          value: String(mapping.personName || ""),
          "aria-label": `${i18nT("Speaker {0}").replace("{0}", String(clampSpeakerChannelCount(channel)))}${i18nT("Name")}`,
        },
      });
      input.value = String(mapping.personName || "");
      const apply = row.createEl("button", {
        cls: "qnalog-speaker-map-apply",
        text: i18nT("Save"),
        attr: { type: "button" },
      });
      const commit = async () => {
        const personName = String(input.value || "").trim();
        if (!personName) {
          new obsidian.Notice(i18nT("Please enter a name"));
          input.focus();
          return;
        }
        apply.disabled = true;
        apply.setText(i18nT("Saving…"));
        try {
          await this.applySpeakerDisplayMapping(file, speakerId, personName);
        } finally {
          apply.disabled = false;
          apply.setText(i18nT("Save"));
        }
      };
      apply.onclick = () => { void commit(); };
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        void commit();
      });
    }
  }

  async applySpeakerDisplayMapping(file, speakerId, personName) {
    if (!(file instanceof obsidian.TFile)) return false;
    const original = await this.app.vault.cachedRead(file);
    const preview = replaceSpeakerDisplayName(original, speakerId, personName);
    if (!preview.replacements) {
      new obsidian.Notice(i18nT("No replaceable speaker segments found"));
      return false;
    }

    let people = [];
    try { people = await this.port.loadPeopleDirectory() || []; } catch { /* mapping can still use a free-form name */ }
    const personKey = normalizePersonLookupText(personName);
    const matched = people.find((person) => {
      const names = [person && person.name, ...splitPersonFieldValue(person && person.aliases)];
      return names.some((name) => normalizePersonLookupText(name) === personKey);
    });

    const result = await this.port.applySpeakerNames(file, {
      [speakerId]: { personName, personPath: matched && matched.path ? String(matched.path) : undefined },
    });
    if (result.bodyError) {
      this.view.render();
      return false;
    }
    this.view.notePanelCacheKey = "";
    this.view.notePanelCacheData = undefined;
    this.view.notePanelLoading = false;
    new obsidian.Notice(`${i18nT("Speaker {0}").replace("{0}", String(clampSpeakerChannelCount(Number(String(speakerId).replace(/^spk-/, "")) || 1)))}${i18nT(" updated to ")}${personName}`);
    this.view.render();
    return true;
  }

  renderSedimentRescanRow(parent, file) {
    const row = parent.createDiv({ cls: "qnalog-sediment-rescan-row" });
    const btn = row.createEl("button", { cls: "qnalog-sediment-rescan-button", attr: { type: "button" } });
    try { obsidian.setIcon(btn.createSpan({ cls: "qnalog-sediment-rescan-icon" }), "refresh-cw"); } catch { /* intentionally empty */ }
    btn.createSpan({ text: i18nT("Rescan") });
    btn.onclick = () => this.confirmSedimentRescan(file);
  }

  formatSedimentNoteLabel(file) {
    const name = file && file.basename ? String(file.basename) : "";
    // 与 Q&A 一致：标题只留「日期时间 + 主题」，模板名前缀不重复出现。
    // 前缀可能是另一种界面语言下写进文件名的，因此中英两种都要剥。
    const settings = this.port && this.port.settings ? this.port.settings : DEFAULT_SETTINGS;
    const stripped = stripModePrefixFromTitle(name, settings);
    return stripped.replace(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2})(\d{2})(.*)$/u, "$2-$3 $4:$5$6");
  }

  renderSedimentStart(parent, file, state) {
    this.renderSedimentPrompt(parent, {
      icon: "sparkles",
      subtitle: this.formatSedimentNoteLabel(file),
      title: i18nT("AI has not read this note yet"),
      desc: i18nT("Scan once to organize people, tasks, knowledge, and hotwords together"),
      primaryText: i18nT("Scan this note"),
      onPrimary: () => this.requestSedimentExtraction(file, !!(state.peopleScanned || state.vocabScanned || (state.currentPeople && state.currentPeople.length) || (state.ignoredPeople && state.ignoredPeople.length) || state.otherPeopleCount)),
    });
  }

  renderSedimentScanning(parent, file, state) {
    const bucket = state.bucket || {};
    const counts = bucket.initialCounts || {};
    const box = parent.createDiv({ cls: "qnalog-sediment-prompt is-scanning" });
    const icon = box.createDiv({ cls: "qnalog-sediment-prompt-icon" });
    // 不再用旋转 spinner（下方进度条已经表达"进行中"语义），换成静态扫描图标
    try { obsidian.setIcon(icon, "scan-line"); } catch { /* intentionally empty */ }
    box.createDiv({ cls: "qnalog-sediment-prompt-subtitle", text: this.formatSedimentNoteLabel(file) });
    box.createDiv({ cls: "qnalog-sediment-prompt-title", text: i18nT("Scanning this note") });
    const progress = box.createDiv({ cls: "qnalog-sediment-scan-progress" });
    progress.createDiv({ cls: "qnalog-sediment-scan-progress-fill" });
    const stats = box.createDiv({ cls: "qnalog-sediment-scan-stats" });
    for (const key of SEDIMENT_GROUP_ORDER) {
      const cfg = SEDIMENT_GROUP_CONFIG[key];
      const count = Math.max(0, Number(counts[key]) || 0);
      const stat = stats.createDiv({ cls: "qnalog-sediment-scan-stat" });
      stat.createDiv({ cls: "qnalog-sediment-scan-number", text: String(count) });
      stat.createDiv({ cls: "qnalog-sediment-scan-label", text: `${i18nT("Recognized")}${i18nT(cfg.label)}` });
    }
    const actions = box.createDiv({ cls: "qnalog-sediment-prompt-actions" });
    actions.createEl("button", { text: i18nT("Cancel scan"), cls: "qnalog-sediment-button is-secondary", attr: { type: "button" } }).onclick = () => this.cancelSedimentExtraction(file);
  }

  // "还有 N 条"改成可点击展开/收起：默认只显示前 8 条保持紧凑，点一下渲染全部（面板自然滚动），
  // 否则后面的候选既滚不到也无法逐条改名/取消选中 —— 即"操作上卡死"。
  renderSedimentMoreToggle(list, key, hiddenCount, expanded) {
    const more = list.createDiv({
      cls: "qnalog-sediment-more is-clickable",
      text: i18nT(expanded ? "Collapse" : "") || `${i18nT("Another ")}${hiddenCount}${i18nT(" items · click to expand")}`,
      attr: { role: "button", tabindex: "0", title: expanded ? i18nT("Collapse") : i18nT("Show all candidates") },
    });
    const toggle = (evt) => {
      if (evt) evt.stopPropagation();
      if (this.sedimentExpandedGroups.has(key)) this.sedimentExpandedGroups.delete(key);
      else this.sedimentExpandedGroups.add(key);
      this.view.render();
    };
    more.onclick = toggle;
    more.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(e); } };
  }

  renderSedimentPeople(parent, file, state) {
    if (state.currentPeople.length) {
      const list = parent.createDiv({ cls: "qnalog-sediment-list" });
      const expanded = this.sedimentExpandedGroups.has("person");
      const shown = expanded ? state.currentPeople : state.currentPeople.slice(0, 8);
      for (const item of shown) this.renderSedimentPeopleItem(list, file, item);
      if (state.currentPeople.length > 8) {
        this.renderSedimentMoreToggle(list, "person", state.currentPeople.length - 8, expanded);
      }
      this.renderSedimentFooter(parent, state.groups.find(item => item.key === "person"), state.currentPeople.length, {
        secondaryText: i18nT("Ignore all"),
        onSecondary: () => this.ignorePeopleSuggestions(state.currentPeople, file),
        onPrimary: () => this.keepPeopleSuggestions(file, state.currentPeople),
      });
      return;
    }
    this.renderSedimentEmptyList(parent);
    this.renderSedimentFooter(parent, state.groups.find(item => item.key === "person"), 0, {
      secondaryText: i18nT("Ignore all"),
      onSecondary: () => { /* intentionally empty */ },
      onPrimary: () => { /* intentionally empty */ },
    });
  }

  renderSedimentObjectList(parent, file, state, groupKey) {
    const group = state.groups.find(item => item.key === groupKey);
    const items = this.getSedimentDisplayItems(state, groupKey);
    const selected = this.getSedimentSelectedIds(file, groupKey, items);
    this.renderSedimentMultiselectHeader(parent, file, groupKey, items, selected);
    const list = parent.createDiv({ cls: "qnalog-sediment-list" });
    if (!items.length) {
      this.renderSedimentEmptyList(list);
    } else {
      const expanded = this.sedimentExpandedGroups.has(groupKey);
      const shown = expanded ? items : items.slice(0, 8);
      for (const item of shown) this.renderSedimentObjectItem(list, file, groupKey, item, selected.has(item.id));
      if (items.length > 8) this.renderSedimentMoreToggle(list, groupKey, items.length - 8, expanded);
    }
    const selectedCount = Array.from(selected).filter(id => items.some(item => item.id === id)).length;
    const unselectedCount = Math.max(0, items.length - selectedCount);
    this.renderSedimentFooter(parent, group, selectedCount, {
      secondaryText: i18nT("Ignore unselected"),
      secondaryDisabled: !unselectedCount,
      secondaryTitle: unselectedCount ? `${i18nT("Unselected ")}${unselectedCount}${i18nT(" items will be marked as ignored")}` : i18nT("No unselected entries"),
      onSecondary: () => this.confirmIgnoreSedimentUnselected(file, groupKey, unselectedCount),
      onPrimary: () => this.commitSedimentGroup(file, groupKey),
    });
  }

  renderSedimentMultiselectHeader(parent, file, groupKey, items, selected) {
    const total = (items || []).length;
    const selectedCount = Array.from(selected || []).filter(id => (items || []).some(item => item.id === id)).length;
    const allSelected = total > 0 && selectedCount === total;
    const noneSelected = selectedCount === 0;
    const header = parent.createDiv({ cls: "qnalog-sediment-multiselect-header" });
    const left = header.createDiv({ cls: "qnalog-sediment-multiselect-left" });
    const master = left.createEl("button", {
      cls: "qnalog-sediment-checkbox" + (allSelected ? " is-checked" : (!noneSelected ? " is-indeterminate" : "")),
      attr: { type: "button", "aria-label": allSelected ? i18nT("Deselect all") : i18nT("Select all") },
    });
    master.onclick = () => {
      this.setSedimentSelectedIds(file, groupKey, allSelected ? [] : (items || []).map(item => item.id));
      this.view.render();
    };
    left.createSpan({ cls: "qnalog-sediment-multiselect-count", text: `${i18nT("Selected")}${selectedCount} / ${total}` });
    const actions = header.createDiv({ cls: "qnalog-sediment-multiselect-actions" });
    const selectAll = actions.createEl("button", { text: i18nT("Select all"), cls: "qnalog-sediment-text-button", attr: { type: "button" } });
    selectAll.disabled = allSelected || !total;
    selectAll.onclick = () => {
      this.setSedimentSelectedIds(file, groupKey, (items || []).map(item => item.id));
      this.view.render();
    };
    const invert = actions.createEl("button", { text: i18nT("Invert selection"), cls: "qnalog-sediment-text-button", attr: { type: "button" } });
    invert.disabled = !total;
    invert.onclick = () => {
      const next = (items || []).filter(item => !selected.has(item.id)).map(item => item.id);
      this.setSedimentSelectedIds(file, groupKey, next);
      this.view.render();
    };
    const rescan = actions.createEl("button", { cls: "qnalog-sediment-text-button qnalog-sediment-rescan-inline", attr: { type: "button" } });
    try { obsidian.setIcon(rescan.createSpan({ cls: "qnalog-sediment-rescan-icon" }), "refresh-cw"); } catch { /* intentionally empty */ }
    rescan.createSpan({ text: i18nT("Rescan") });
    rescan.onclick = () => this.confirmSedimentRescan(file);
  }

  renderSedimentObjectItem(parent, file, groupKey, item, checked) {
    const row = parent.createDiv({ cls: `qnalog-sediment-list-item qnalog-sediment-select-item is-${groupKey}` + (checked ? " is-checked" : " is-unchecked") });
    const checkbox = row.createEl("button", {
      cls: "qnalog-sediment-checkbox" + (checked ? " is-checked" : ""),
      attr: { type: "button", "aria-label": checked ? i18nT("Clear selection") : i18nT("Select") },
    });
    checkbox.onclick = () => {
      const state = this.getSedimentPanelState(file);
      const items = this.getSedimentDisplayItems(state, groupKey);
      const selected = this.getSedimentSelectedIds(file, groupKey, items);
      if (selected.has(item.id)) selected.delete(item.id);
      else selected.add(item.id);
      this.setSedimentSelectedIds(file, groupKey, Array.from(selected));
      this.view.render();
    };
    const content = row.createDiv({ cls: "qnalog-sediment-item-content" });
    if (groupKey === "hotword") {
      const top = content.createDiv({ cls: "qnalog-sediment-item-title-row" });
      // 标题可点击就地改名（ASR 转错的词直接改）
      const titleEl = top.createDiv({
        cls: "qnalog-sediment-item-title qnalog-sediment-editable-title",
        text: item.title || "",
        attr: { role: "button", tabindex: "0", title: i18nT("Click to edit") },
      });
      titleEl.onclick = (evt) => {
        evt.stopPropagation();
        this.enterSedimentInlineTitleEdit(titleEl, item.title || "", (next) => this.updateSedimentHotwordTerm(file, item, next));
      };
      this.renderSedimentTypePill(top, item.sub || i18nT("Hotwords"), this.getSedimentTypeIcon(groupKey, item.sub, item.sectionKey));
      return;
    }
    if (groupKey === "todo") {
      const raw = item.raw || {};
      const todoId = getSedimentTodoId(raw);
      row.dataset.todoId = todoId;
      // 标题：可点击进入 contenteditable 编辑态
      const titleEl = content.createDiv({
        cls: "qnalog-sediment-item-title qnalog-todo-title",
        text: item.title || "",
        attr: { "data-field": "title", role: "button", tabindex: "0" },
      });
      titleEl.onclick = (evt) => { evt.stopPropagation(); this.enterTodoTitleEdit(titleEl, file, raw); };
      const meta = content.createDiv({ cls: "qnalog-sediment-field-row" });
      const ownerField = this.renderSedimentField(meta, "user", raw.owner || i18nT("Add owner"), raw.owner ? "" : "is-empty");
      ownerField.dataset.field = "owner";
      ownerField.onclick = (evt) => { evt.stopPropagation(); void this.enterTodoOwnerEdit(ownerField, content, file, raw); };
      const dueField = this.renderSedimentField(meta, "calendar-plus", raw.due || i18nT("Add time"), raw.due ? "is-time" : "is-empty");
      dueField.dataset.field = "due";
      dueField.onclick = (evt) => { evt.stopPropagation(); this.enterTodoDueEdit(dueField, content, file, raw); };
      // Todoist 风格：字段位置永远只是"+ 添加子任务"，已有的子任务在下面常驻一条列表
      const subtaskField = this.renderSedimentField(meta, "plus", i18nT("Add subtask"), "is-empty is-add-subtask");
      subtaskField.dataset.field = "subtasks";
      subtaskField.onclick = (evt) => { evt.stopPropagation(); this.enterTodoSubtasksAdd(subtaskField, content, file, raw); };
      // 常驻子任务列表（每行 contenteditable，× 删除）
      const existingSubs = normalizeSedimentTodoSubtasks(raw.subtasks || raw.children || []);
      if (existingSubs.length) this.renderTodoSubtaskStrip(content, file, raw, existingSubs);
      // 渲染完成后，如果有待恢复的 inline 编辑（来自 Tab 切换 / 保存后的下一字段），自动进入
      if (this.inlineTodoPendingFocus && this.inlineTodoPendingFocus.todoId === todoId) {
        const pending = this.inlineTodoPendingFocus;
        this.inlineTodoPendingFocus = null;
        const target = row.querySelector(`[data-field="${pending.field}"]`);
        if (target) window.setTimeout(() => target.click(), 20);
      }
      return;
    }
    const top = content.createDiv({ cls: "qnalog-sediment-item-top" });
    top.createDiv({ cls: "qnalog-sediment-item-title", text: item.title || "" });
    if (item.sub) content.createDiv({ cls: "qnalog-sediment-item-sub", text: item.sub });
    if (item.meta) content.createDiv({ cls: "qnalog-sediment-item-meta", text: item.meta });
  }

  getSedimentTypeIcon(groupKey, label, key) {
    const text = `${label || ""} ${key || ""}`;
    if (/人|people|person/i.test(text)) return "user";
    if (/品牌|机构|brand|org|company/i.test(text)) return "building";
    if (/观点|point|insight/i.test(text)) return "bulb";
    if (/机制|mechanism|settings/i.test(text)) return "settings-2";
    if (/案例|case/i.test(text)) return "flask";
    if (/问答|qa|question/i.test(text)) return "message-question";
    return "tag";
  }

  renderSedimentTypePill(parent, label, iconName) {
    const pill = parent.createSpan({ cls: "qnalog-sediment-type-pill" });
    try { obsidian.setIcon(pill.createSpan({ cls: "qnalog-sediment-type-icon" }), iconName || "tag"); } catch { /* intentionally empty */ }
    pill.createSpan({ text: label || i18nT("Type") });
    return pill;
  }

  renderSedimentField(parent, iconName, text, cls = "") {
    const field = parent.createSpan({ cls: `qnalog-sediment-field ${cls}`.trim() });
    field.setAttr("role", "button");
    field.setAttr("tabindex", "0");
    try { obsidian.setIcon(field.createSpan({ cls: "qnalog-sediment-field-icon" }), iconName); } catch { /* intentionally empty */ }
    field.createSpan({ text: text || "" });
    return field;
  }

  // ===================== 待办行内编辑（v3.5 设计稿） =====================
  // 设计原则：就地编辑、零弹窗、键盘优先。同一时间只允许一个待办处于编辑态。
  // 切换字段或切换待办时，前一个编辑自动 commit + cleanup。
  // 保存触发 updateSedimentTodoCandidate → render()，DOM 整体重建。
  // Tab 切换字段：把 { todoId, field } 写入 this.inlineTodoPendingFocus，
  // render 时由 todo 渲染分支检测到并自动重新进入对应字段。

  closeInlineTodoEditor() {
    if (this.inlineTodoEditor && typeof this.inlineTodoEditor.close === "function") {
      try { this.inlineTodoEditor.close(); } catch (e) { console.warn("[QnALog] inline close failed", e); }
    }
    this.inlineTodoEditor = null;
  }

  // 标题：contenteditable 就地改
  enterTodoTitleEdit(titleEl, file, raw) {
    if (this.inlineTodoEditor && this.inlineTodoEditor._anchor === titleEl) return;
    this.closeInlineTodoEditor();
    const original = (titleEl.textContent || "").trim();
    const todoId = getSedimentTodoId(raw);
    titleEl.contentEditable = "true";
    titleEl.classList.add("is-editing");
    titleEl.focus();
    // 全选已有文本，方便直接覆盖
    const sel = window.getSelection();
    if (sel) {
      const range = activeDocument.createRange();
      range.selectNodeContents(titleEl);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    let done = false;
    const finish = async (shouldSave, nextField) => {
      if (done) return;
      done = true;
      titleEl.contentEditable = "false";
      titleEl.classList.remove("is-editing");
      titleEl.removeEventListener("keydown", onKey);
      titleEl.removeEventListener("blur", onBlur);
      const newText = (titleEl.textContent || "").trim();
      this.inlineTodoEditor = null;
      if (nextField) this.inlineTodoPendingFocus = { todoId, field: nextField };
      if (shouldSave && newText && newText !== original) {
        await this.updateSedimentTodoCandidate(file, raw, { task: newText });
      } else if (nextField) {
        this.view.render();
      }
    };
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); void finish(true, null); }
      else if (e.key === "Escape") { e.preventDefault(); titleEl.textContent = original; void finish(false, null); }
      else if (e.key === "Tab") {
        e.preventDefault();
        void finish(true, e.shiftKey ? null : "owner");
      }
    };
    const onBlur = () => finish(true, null);
    titleEl.addEventListener("keydown", onKey);
    titleEl.addEventListener("blur", onBlur);
    this.inlineTodoEditor = { _anchor: titleEl, close: () => { void finish(true, null); } };
  }

  // 责任人：字段位置改 input，下方展开下拉
  async enterTodoOwnerEdit(fieldEl, content, file, raw) {
    if (this.inlineTodoEditor && this.inlineTodoEditor._anchor === fieldEl) return;
    this.closeInlineTodoEditor();
    const todoId = getSedimentTodoId(raw);
    const input = (activeWindow as Window & { createEl: <K extends keyof HTMLElementTagNameMap>(tag: K) => HTMLElementTagNameMap[K] }).createEl("input");
    input.type = "text";
    input.className = "qnalog-todo-inline-input is-owner";
    input.placeholder = i18nT("Enter name");
    input.value = raw.owner || "";
    fieldEl.replaceWith(input);
    const panel = content.createDiv({ cls: "qnalog-todo-inline-panel is-owner" });
    const list = panel.createDiv({ cls: "qnalog-todo-inline-list" });
    list.createDiv({ cls: "qnalog-todo-inline-loading", text: i18nT("Loading people…") });
    let people = [];
    try { people = await loadPeopleDirectory(this) || []; } catch (e) { console.warn("[QnALog] load people failed", e); }
    let items = [];
    let selectedIdx = 0;
    const highlight = () => items.forEach((it, i) => it.classList.toggle("is-active", i === selectedIdx));
    const renderList = (query) => {
      list.empty();
      items = [];
      const q = (query || "").trim().toLowerCase();
      const filtered = !q ? people : people.filter((p) => {
        const txt = `${p.name || ""} ${p.aliases || ""} ${p.role || ""} ${p.org || ""}`.toLowerCase();
        return txt.includes(q);
      });
      if (raw.owner) {
        const cur = list.createDiv({ cls: "qnalog-todo-inline-item is-current" });
        try { obsidian.setIcon(cur.createSpan({ cls: "qnalog-todo-inline-item-icon" }), "user-check"); } catch { /* intentionally empty */ }
        cur.createSpan({ cls: "qnalog-todo-inline-item-name", text: raw.owner });
        const clr = cur.createSpan({ cls: "qnalog-todo-inline-item-clear", text: i18nT("Clear") });
        clr.onclick = (e) => { e.stopPropagation(); void finish("", null); };
        cur.dataset.value = raw.owner;
        cur.onclick = () => finish(raw.owner, null);
        items.push(cur);
      }
      for (const p of filtered.slice(0, 8)) {
        const it = list.createDiv({ cls: "qnalog-todo-inline-item" });
        try { obsidian.setIcon(it.createSpan({ cls: "qnalog-todo-inline-item-icon" }), "user"); } catch { /* intentionally empty */ }
        it.createSpan({ cls: "qnalog-todo-inline-item-name", text: p.name || i18nT("Untitled") });
        if (p.role || p.org) it.createSpan({ cls: "qnalog-todo-inline-item-meta", text: [p.role, p.org].filter(Boolean).join(" · ") });
        it.dataset.value = p.name || "";
        it.onclick = () => finish(p.name || "", null);
        items.push(it);
      }
      if (q && !filtered.some((p) => (p.name || "").toLowerCase() === q)) {
        const it = list.createDiv({ cls: "qnalog-todo-inline-item is-new" });
        try { obsidian.setIcon(it.createSpan({ cls: "qnalog-todo-inline-item-icon" }), "user-plus"); } catch { /* intentionally empty */ }
        it.createSpan({ cls: "qnalog-todo-inline-item-name", text: i18nT("+ New \"{0}\"").replace("{0}", query.trim()) });
        it.dataset.value = query.trim();
        it.onclick = () => finish(query.trim(), null);
        items.push(it);
      }
      if (!items.length) list.createDiv({ cls: "qnalog-todo-inline-empty", text: i18nT("The person library is empty; type a new name and press Enter") });
      selectedIdx = 0;
      highlight();
    };
    renderList("");
    let done = false;
    const finish = async (newOwner, nextField) => {
      if (done) return;
      done = true;
      cleanup();
      this.inlineTodoEditor = null;
      if (nextField) this.inlineTodoPendingFocus = { todoId, field: nextField };
      const trimmed = String(newOwner || "").trim();
      if (trimmed !== (raw.owner || "")) {
        await this.updateSedimentTodoCandidate(file, raw, { owner: trimmed });
      } else {
        this.view.render();
      }
    };
    const onInput = () => renderList(input.value);
    const onKey = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); if (items.length) { selectedIdx = Math.min(selectedIdx + 1, items.length - 1); highlight(); } }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (items.length) { selectedIdx = Math.max(selectedIdx - 1, 0); highlight(); } }
      else if (e.key === "Enter") {
        e.preventDefault();
        const target = items[selectedIdx];
        if (target) void finish(target.dataset.value || "", null);
        else if (input.value.trim()) void finish(input.value.trim(), null);
      }
      else if (e.key === "Escape") { e.preventDefault(); void finish(raw.owner || "", null); }
      else if (e.key === "Tab") { e.preventDefault(); void finish(input.value.trim() || (raw.owner || ""), e.shiftKey ? "title" : "due"); }
    };
    const onOutside = (e) => {
      if (!panel.contains(e.target) && e.target !== input && !input.contains(e.target)) void finish(input.value.trim() || (raw.owner || ""), null);
    };
    const cleanup = () => {
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKey);
      activeDocument.removeEventListener("mousedown", onOutside, true);
    };
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKey);
    window.setTimeout(() => activeDocument.addEventListener("mousedown", onOutside, true), 0);
    input.focus();
    input.select();
    this.inlineTodoEditor = { _anchor: fieldEl, close: () => { void finish(input.value.trim() || (raw.owner || ""), null); } };
  }

  // 截止日：5 个快捷 + native date input
  enterTodoDueEdit(fieldEl, content, file, raw) {
    if (this.inlineTodoEditor && this.inlineTodoEditor._anchor === fieldEl) return;
    this.closeInlineTodoEditor();
    const todoId = getSedimentTodoId(raw);
    fieldEl.classList.add("is-editing");
    // 设计稿：字段在编辑态文字变成"选时间"
    const textSpan = fieldEl.querySelector(":scope > span:not(.qnalog-sediment-field-icon)");
    if (textSpan) textSpan.setText(i18nT("Pick a time"));
    const panel = content.createDiv({ cls: "qnalog-todo-inline-panel is-due" });
    const bar = panel.createDiv({ cls: "qnalog-todo-inline-quickbar" });
    const moment = window.moment;
    const presets = moment ? [
      { key: "1", label: i18nT("Today"), value: moment().format("YYYY-MM-DD") },
      { key: "2", label: i18nT("Tomorrow"), value: moment().add(1, "day").format("YYYY-MM-DD") },
      { key: "3", label: i18nT("This weekend"), value: moment().endOf("week").format("YYYY-MM-DD") },
      { key: "4", label: i18nT("Next week"), value: moment().add(1, "week").format("YYYY-MM-DD") },
    ] : [];
    let matched = false;
    for (const p of presets) {
      const btn = bar.createEl("button", { cls: "qnalog-todo-inline-preset", text: p.label, attr: { type: "button", "data-key": p.key } });
      // 只让第一个匹配的 preset 高亮（避免"今天 = 本周末"这种重叠都亮起）
      if (!matched && raw.due && raw.due === p.value) { btn.classList.add("is-active"); matched = true; }
      btn.onclick = () => finish(p.value, null);
    }
    const customBtn = bar.createEl("button", { cls: "qnalog-todo-inline-preset is-custom", attr: { type: "button", "data-key": "5" } });
    try { obsidian.setIcon(customBtn.createSpan({ cls: "qnalog-todo-inline-preset-icon" }), "calendar"); } catch { /* intentionally empty */ }
    customBtn.createSpan({ text: i18nT("Custom date") });
    customBtn.onclick = () => showCustom();
    if (raw.due) {
      const clr = bar.createEl("button", { cls: "qnalog-todo-inline-preset is-clear", text: i18nT("Clear"), attr: { type: "button" } });
      clr.onclick = () => finish("", null);
    }
    const showCustom = () => {
      bar.empty();
      const dateInput = bar.createEl("input", { cls: "qnalog-todo-inline-date", attr: { type: "date" } });
      const currentISO = raw.due && /^\d{4}-\d{2}-\d{2}/.test(raw.due) ? raw.due.slice(0, 10) : "";
      dateInput.value = currentISO;
      dateInput.onchange = () => { if (dateInput.value) void finish(dateInput.value, null); };
      dateInput.focus();
      try { dateInput.click(); } catch { /* intentionally empty */ }
    };
    let done = false;
    const finish = async (newDue, nextField) => {
      if (done) return;
      done = true;
      cleanup();
      this.inlineTodoEditor = null;
      if (nextField) this.inlineTodoPendingFocus = { todoId, field: nextField };
      if (newDue !== (raw.due || "")) {
        await this.updateSedimentTodoCandidate(file, raw, { due: newDue });
      } else {
        this.view.render();
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); void finish(raw.due || "", null); }
      else if (e.key === "Tab") { e.preventDefault(); void finish(raw.due || "", e.shiftKey ? "owner" : "subtasks"); }
      else if (["1","2","3","4","5"].includes(e.key)) {
        const btn = bar.querySelector(`[data-key="${e.key}"]`);
        if (btn) { e.preventDefault(); btn.click(); }
      }
    };
    const onOutside = (e) => { if (!panel.contains(e.target) && e.target !== fieldEl) void finish(raw.due || "", null); };
    const cleanup = () => {
      activeDocument.removeEventListener("keydown", onKey, true);
      activeDocument.removeEventListener("mousedown", onOutside, true);
    };
    window.setTimeout(() => {
      activeDocument.addEventListener("keydown", onKey, true);
      activeDocument.addEventListener("mousedown", onOutside, true);
    }, 0);
    this.inlineTodoEditor = { _anchor: fieldEl, close: () => { void finish(raw.due || "", null); } };
  }

  // 常驻子任务列表（Todoist 风格）：永远显示已有子任务，行内可改、× 删除
  renderTodoSubtaskStrip(content, file, raw, subs) {
    const strip = content.createDiv({ cls: "qnalog-todo-subtask-strip" });
    subs.forEach((sub, idx) => {
      const row = strip.createDiv({ cls: "qnalog-todo-subtask-strip-row" });
      row.createSpan({ cls: "qnalog-todo-subtask-strip-check" });
      const text = row.createSpan({ cls: "qnalog-todo-subtask-strip-text", text: sub });
      text.setAttr("contenteditable", "true");
      text.setAttr("spellcheck", "false");
      text.dataset.original = sub;
      text.addEventListener("focus", () => text.classList.add("is-editing"));
      const saveIfChanged = async () => {
        text.classList.remove("is-editing");
        const val = (text.textContent || "").trim();
        const original = text.dataset.original || "";
        if (val === original) return;
        const next = subs.slice();
        if (val) next[idx] = val;
        else next.splice(idx, 1);
        const cleaned = next.map((s) => String(s || "").trim()).filter(Boolean);
        await this.updateSedimentTodoCandidate(file, raw, { subtasks: cleaned });
      };
      text.addEventListener("blur", () => { void saveIfChanged(); });
      text.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); text.blur(); }
        else if (e.key === "Escape") {
          e.preventDefault();
          text.textContent = text.dataset.original || "";
          text.blur();
        }
        else if (e.key === "Backspace" && !text.textContent) {
          e.preventDefault();
          text.dataset.original = ""; // 触发 blur 后按t("Delete")路径
          text.blur();
        }
      });
      const del = row.createSpan({ cls: "qnalog-todo-subtask-strip-del", attr: { "aria-label": i18nT("Delete") } });
      try { obsidian.setIcon(del, "x"); } catch { del.setText("×"); }
      del.onmousedown = (e) => { e.preventDefault(); }; // 防止 text contenteditable 先触发 blur
      del.onclick = async (e) => {
        e.stopPropagation();
        const next = subs.slice();
        next.splice(idx, 1);
        await this.updateSedimentTodoCandidate(file, raw, { subtasks: next });
      };
    });
  }

  // "+ 添加子任务" 专职 add：只展开一个紧凑的 input；Enter 即添加 + 即时保存
  enterTodoSubtasksAdd(fieldEl, content, file, raw) {
    if (this.inlineTodoEditor && this.inlineTodoEditor._anchor === fieldEl) return;
    this.closeInlineTodoEditor();
    const todoId = getSedimentTodoId(raw);
    const MAX = 5;
    const existingSubs = normalizeSedimentTodoSubtasks(raw.subtasks || raw.children || []);
    if (existingSubs.length >= MAX) {
      try { new obsidian.Notice(i18nT("Up to 5 subtasks")); } catch { /* intentionally empty */ }
      return;
    }
    fieldEl.classList.add("is-editing");
    const addPanel = content.createDiv({ cls: "qnalog-todo-inline-panel is-subtask-add" });
    const addRow = addPanel.createDiv({ cls: "qnalog-todo-inline-subtask-add" });
    try { obsidian.setIcon(addRow.createSpan({ cls: "qnalog-todo-inline-subtask-add-icon" }), "plus"); } catch { /* intentionally empty */ }
    const input = addRow.createEl("input", {
      cls: "qnalog-todo-inline-subtask-input",
      attr: { type: "text", placeholder: existingSubs.length ? i18nT("Added {0}/{1}, add more").replace("{0}", String(existingSubs.length)).replace("{1}", String(MAX)) : i18nT("Add subtask, press Enter to continue") },
    });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      fieldEl.classList.remove("is-editing");
      this.inlineTodoEditor = null;
      try { addPanel.remove(); } catch { /* intentionally empty */ }
    };
    const onKey = async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const val = input.value.trim();
        if (!val) return;
        const fresh = normalizeSedimentTodoSubtasks(raw.subtasks || raw.children || []).slice();
        if (fresh.length >= MAX) { try { new obsidian.Notice(i18nT("Up to 5 subtasks")); } catch { /* intentionally empty */ }; return; }
        fresh.push(val);
        // 即时保存：会触发 render；为了让用户能继续按 Enter 添加下一条，
        // 把 pending focus 设到 subtasks 字段，render 后会自动重开 add 输入框
        cleanup();
        fieldEl.classList.remove("is-editing");
        this.inlineTodoEditor = null;
        done = true;
        if (fresh.length < MAX) this.inlineTodoPendingFocus = { todoId, field: "subtasks" };
        await this.updateSedimentTodoCandidate(file, raw, { subtasks: fresh });
      }
      else if (e.key === "Escape") { e.preventDefault(); finish(); }
      else if (e.key === "Tab") { e.preventDefault(); finish(); }
    };
    const onOutside = (e) => { if (!addPanel.contains(e.target) && e.target !== fieldEl) finish(); };
    const cleanup = () => {
      input.removeEventListener("keydown", onKey);
      activeDocument.removeEventListener("mousedown", onOutside, true);
    };
    input.addEventListener("keydown", onKey);
    window.setTimeout(() => activeDocument.addEventListener("mousedown", onOutside, true), 0);
    input.focus();
    this.inlineTodoEditor = { _anchor: fieldEl, close: finish };
  }

  // (旧实现保留作 dead code；新调用走 enterTodoSubtasksAdd + renderTodoSubtaskStrip)
  enterTodoSubtasksEdit(fieldEl, content, file, raw) {
    if (this.inlineTodoEditor && this.inlineTodoEditor._anchor === fieldEl) return;
    this.closeInlineTodoEditor();
    const todoId = getSedimentTodoId(raw);
    fieldEl.classList.add("is-editing");
    const existing = normalizeSedimentTodoSubtasks(raw.subtasks || raw.children || []).slice();
    const MAX = 5;
    const panel = content.createDiv({ cls: "qnalog-todo-inline-panel is-subtasks" });
    const listEl = panel.createDiv({ cls: "qnalog-todo-inline-subtask-list" });
    const addRow = panel.createDiv({ cls: "qnalog-todo-inline-subtask-add" });
    try { obsidian.setIcon(addRow.createSpan({ cls: "qnalog-todo-inline-subtask-add-icon" }), "plus"); } catch { /* intentionally empty */ }
    const addInput = addRow.createEl("input", {
      cls: "qnalog-todo-inline-subtask-input",
      attr: { type: "text", placeholder: i18nT("Add subtask, press Enter to continue") },
    });
    const footer = panel.createDiv({ cls: "qnalog-todo-inline-subtask-footer" });
    const countEl = footer.createSpan({ cls: "qnalog-todo-inline-subtask-count" });
    footer.createSpan({ cls: "qnalog-todo-inline-subtask-hint", text: i18nT("↵ Add · Esc to collapse") });
    const updateCount = () => {
      countEl.setText(`${existing.length}/${MAX}${i18nT(" items")}`);
      if (existing.length >= MAX) {
        addInput.disabled = true;
        addInput.placeholder = i18nT("Limit reached");
      } else {
        addInput.disabled = false;
        addInput.placeholder = i18nT("Add subtask, press Enter to continue");
      }
    };
    const renderList = () => {
      listEl.empty();
      existing.forEach((sub, i) => {
        const row = listEl.createDiv({ cls: "qnalog-todo-inline-subtask-row" });
        row.createSpan({ cls: "qnalog-todo-inline-subtask-check" });
        const text = row.createSpan({ cls: "qnalog-todo-inline-subtask-text", text: sub });
        text.setAttr("contenteditable", "true");
        text.oninput = () => { existing[i] = text.textContent || ""; };
        text.onkeydown = (e) => {
          if (e.key === "Enter") { e.preventDefault(); addInput.focus(); }
          if (e.key === "Backspace" && !text.textContent) {
            e.preventDefault();
            existing.splice(i, 1);
            renderList();
            updateCount();
          }
        };
        const del = row.createSpan({ cls: "qnalog-todo-inline-subtask-del", attr: { "aria-label": i18nT("Delete") } });
        try { obsidian.setIcon(del, "x"); } catch { del.setText("×"); }
        del.onclick = (e) => {
          e.stopPropagation();
          existing.splice(i, 1);
          renderList();
          updateCount();
        };
      });
    };
    renderList();
    updateCount();
    let done = false;
    const finish = async (nextField) => {
      if (done) return;
      done = true;
      cleanup();
      this.inlineTodoEditor = null;
      if (nextField) this.inlineTodoPendingFocus = { todoId, field: nextField };
      // 过滤空项
      const cleanedSubs = existing.map((s) => String(s || "").trim()).filter(Boolean);
      const oldSubs = normalizeSedimentTodoSubtasks(raw.subtasks || raw.children || []);
      const changed = cleanedSubs.length !== oldSubs.length
        || cleanedSubs.some((s, i) => s !== oldSubs[i]);
      if (changed) await this.updateSedimentTodoCandidate(file, raw, { subtasks: cleanedSubs });
      else this.view.render();
    };
    const onAddKey = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const val = addInput.value.trim();
        if (val && existing.length < MAX) {
          existing.push(val);
          addInput.value = "";
          renderList();
          updateCount();
          addInput.focus();
        }
      }
      else if (e.key === "Escape") { e.preventDefault(); void finish(null); }
      else if (e.key === "Tab") { e.preventDefault(); void finish(e.shiftKey ? "due" : null); }
    };
    const onOutside = (e) => { if (!panel.contains(e.target) && e.target !== fieldEl) void finish(null); };
    const cleanup = () => {
      addInput.removeEventListener("keydown", onAddKey);
      activeDocument.removeEventListener("mousedown", onOutside, true);
    };
    addInput.addEventListener("keydown", onAddKey);
    window.setTimeout(() => activeDocument.addEventListener("mousedown", onOutside, true), 0);
    addInput.focus();
    this.inlineTodoEditor = { _anchor: fieldEl, close: () => { void finish(null); } };
  }
  // ===================== /待办行内编辑 =====================

  async updateSedimentTodoCandidate(file, sourceTodo, patch) {
    if (!(file instanceof obsidian.TFile) || !sourceTodo) return;
    const bucket = this.getSedimentCandidateBucket(file);
    const oldId = getSedimentTodoId(sourceTodo);
    let updated = null;
    const todos = (bucket.todos || []).map((todo) => {
      if (getSedimentTodoId(todo) !== oldId) return todo;
      updated = Object.assign({}, todo, patch || {});
      updated.subtasks = normalizeSedimentTodoSubtasks(updated.subtasks || updated.children || updated.steps || updated.items);
      // 保留空字符串，让 UI 端 "加责任人 / 加时间" 占位逻辑能生效
      if (!updated.owner || /^(未指定|无|待定|TBD|N\/A|null|none)$/i.test(String(updated.owner))) updated.owner = "";
      if (!updated.due || /^(未指定|无|待定|TBD|N\/A|null|none)$/i.test(String(updated.due))) updated.due = "";
      updated.id = updated.id || getSedimentTodoId(updated);
      return updated;
    });
    if (!updated) return;
    const selectedByGroup: Record<string, string[]> = { ...(bucket.selectedByGroup || {}) };
    if (Array.isArray(selectedByGroup.todo)) {
      const nextId = getSedimentTodoId(updated);
      selectedByGroup.todo = selectedByGroup.todo.map(id => id === oldId ? nextId : id);
    }
    this.setSedimentCandidateBucket(file, { todos, selectedByGroup });
    await this.persistSedimentCandidateBucket(file);
    this.view.render();
  }

  // 通用：把一个标题元素变成 contenteditable 就地编辑（热词 / 人员候选改名共用）。
  // Enter / 失焦保存（仅当有变化），Esc 恢复原文。commitFn(newText) 负责落库。
  enterSedimentInlineTitleEdit(titleEl, original, commitFn) {
    enterInlineTitleEdit(titleEl, String(original || ""), commitFn);
  }

  // 热词候选改名：在 bucket.hotwords[sectionKey] 词数组里把旧词替换成新词
  async updateSedimentHotwordTerm(file, item, newTerm) {
    if (!(file instanceof obsidian.TFile) || !item || !item.sectionKey) return;
    const next = String(newTerm || "").trim();
    if (!next) return;
    const bucket = this.getSedimentCandidateBucket(file);
    const groups = bucket.hotwords ? JSON.parse(JSON.stringify(bucket.hotwords)) : createVocabularyGroups();
    const arr = Array.isArray(groups[item.sectionKey]) ? groups[item.sectionKey] : [];
    const oldTerm = item.term;
    const idx = arr.indexOf(oldTerm);
    if (idx < 0) return;
    if (arr.includes(next) && next !== oldTerm) {
      // 改成的词已存在 → 直接删掉旧词去重
      arr.splice(idx, 1);
    } else {
      arr[idx] = next;
    }
    groups[item.sectionKey] = arr;
    // 选择集里用旧 id 的换成新 id
    const oldId = getSedimentHotwordId(item.sectionKey, oldTerm);
    const newId = getSedimentHotwordId(item.sectionKey, next);
    const selectedByGroup: Record<string, string[]> = { ...(bucket.selectedByGroup || {}) };
    if (Array.isArray(selectedByGroup.hotword)) {
      selectedByGroup.hotword = selectedByGroup.hotword.map(id => id === oldId ? newId : id);
    }
    // 记录"笔记里的原词 → 最终更正词"映射，供"加入热词库"时回写正文。
    // 连环改名 A→B→C 归并为 A→C；改回原词则取消映射。改成已存在词（上面的去重分支）同样记录——
    // 用户意图仍是"笔记里的旧写法应当是那个词"。
    const termRenames = Object.assign({}, bucket.hotwordTermRenames || {});
    let originKey = "";
    for (const k of Object.keys(termRenames)) if (termRenames[k] === oldTerm) { originKey = k; break; }
    const origin = originKey || oldTerm;
    if (origin === next) delete termRenames[origin];
    else termRenames[origin] = next;
    this.setSedimentCandidateBucket(file, { hotwords: groups, selectedByGroup, hotwordTermRenames: termRenames });
    await this.persistSedimentCandidateBucket(file);
    this.view.render();
  }

  // 人员候选改名：用 override 映射（按原始 id），保留原 id 不影响选择 / 去重 / 合并逻辑
  async updateSedimentPersonName(file, item, newName) {
    if (!(file instanceof obsidian.TFile) || !item) return;
    const next = String(newName || "").trim();
    if (!next) return;
    const id = getSedimentPersonId(item.sourcePath || (file && file.path) || "", item);
    if (!id) return;
    const bucket = this.getSedimentCandidateBucket(file);
    const overrides = Object.assign({}, bucket.peopleNameOverrides || {});
    const originals = Object.assign({}, (bucket as { peopleOriginalNames?: Record<string, string> }).peopleOriginalNames || {});
    // 首次改名时记下"笔记正文/YAML 里写着的那个名字"(此刻 item.name 尚未被任何 override 改过)，
    // 供"加入人员库"时把旧名替换成更正后的名字。后续再改名不覆盖这个原名。
    if (!Object.prototype.hasOwnProperty.call(originals, id)) {
      const orig = String(item.name || "").trim();
      if (orig) originals[id] = orig;
    }
    overrides[id] = next;
    this.setSedimentCandidateBucket(file, { peopleNameOverrides: overrides, peopleOriginalNames: originals });
    await this.persistSedimentCandidateBucket(file);
    this.view.render();
  }

  // 把用户在侧边栏更正的人名（旧名 → 新名）替换到笔记正文 + YAML 人员字段 + 末尾沉淀块。
  // 触发自"加入人员库"成功后；撤销由 keepPeopleSuggestions 开头的 sourceSnapshot 兜底（整篇还原）。
  async applyPeopleRenamesToNote(file, items) {
    if (!(file instanceof obsidian.TFile)) return [];
    const bucket = this.getSedimentCandidateBucket(file);
    const originals = (bucket as { peopleOriginalNames?: Record<string, string> }).peopleOriginalNames || {};
    const path = obsidian.normalizePath(file.path || "");
    const renames = [];
    const seen = new Set();
    for (const item of (items || [])) {
      const pid = getSedimentPersonId(item.sourcePath || path, item);
      if (!pid) continue;
      const from = String(originals[pid] || "").trim();
      const to = String(item.name || "").trim();
      // from(原名) 与 to(更正名) 不同才替换；跳过 1 字名（无词边界，易误伤其它词）。
      if (!from || !to || from === to || from.length < 2) continue;
      // 分隔符用转义 \0（人名不可能含 NUL，键无歧义）；绝不可写成裸 0x00 字节——会让 grep/rg 把整个文件当二进制截断搜索。
      const k = from + "\0" + to;
      if (seen.has(k)) continue;
      seen.add(k);
      renames.push({ from, to });
    }
    if (!renames.length) return [];
    // 长名优先替换，避免短名先替导致长名匹配不到（与 applyRoleMappingToSegments 同策略）。
    renames.sort((a, b) => b.from.length - a.from.length);
    const content = await this.app.vault.read(file);
    let next = content;
    for (const r of renames) next = next.split(r.from).join(r.to); // 纯字符串全局替换，含正文/YAML/沉淀块
    if (next !== content) {
      await this.app.vault.modify(file, next);
      try { this.port.refreshOutlineView(); } catch { /* intentionally empty */ }
    }
    return renames;
  }

  // 把用户在侧边栏更正的热词（笔记原词 → 更正词）替换到笔记正文（含分段转写/沉淀块）。
  // 触发自"加入热词库"成功后，只回写本次真正入库的词；撤销由提交处的 sourceSnapshot 兜底（整篇还原）。
  async applyHotwordRenamesToNote(file, items) {
    if (!(file instanceof obsidian.TFile)) return [];
    const bucket = this.getSedimentCandidateBucket(file);
    const renameMap = bucket.hotwordTermRenames || {};
    const committedTerms = new Set((items || []).map(it => String((it && it.term) || "").trim()).filter(Boolean));
    const renames = [];
    for (const [rawFrom, rawTo] of Object.entries(renameMap)) {
      const from = String(rawFrom || "").trim();
      const to = primitiveText(rawTo).trim();
      if (!committedTerms.has(to)) continue;
      // 跳过 1 字词（无词边界，易误伤其它词）；from === to 不可能出现（updateSedimentHotwordTerm 已取消该映射）。
      if (!from || !to || from === to || from.length < 2) continue;
      renames.push({ from, to });
    }
    if (!renames.length) return [];
    // 长词优先替换，避免短词先替导致长词匹配不到（与人名回写同策略）。
    renames.sort((a, b) => b.from.length - a.from.length);
    const content = await this.app.vault.read(file);
    let next = content;
    for (const r of renames) next = next.split(r.from).join(r.to); // 纯字符串全局替换，含正文/YAML/沉淀块
    if (next !== content) {
      await this.app.vault.modify(file, next);
      try { this.port.refreshOutlineView(); } catch { /* intentionally empty */ }
    }
    // 已消费的映射清掉，避免下次提交对同一篇重复替换
    const remaining = Object.assign({}, renameMap);
    for (const r of renames) delete remaining[r.from];
    this.setSedimentCandidateBucket(file, { hotwordTermRenames: remaining });
    return renames;
  }

  openSedimentTodoEditModal(file, todo, focus = "task") {
    if (!(file instanceof obsidian.TFile) || !todo) return;
    const modal = new obsidian.Modal(this.app);
    modal.onOpen = () => {
      const { contentEl } = modal;
      contentEl.empty();
      contentEl.addClass("qnalog-sediment-rescan-modal");
      contentEl.createEl("h3", { text: i18nT("Edit to-do") });
      const form = contentEl.createDiv({ cls: "qnalog-sediment-todo-edit" });

      const makeField = (label, value, multi = false) => {
        const row = form.createDiv({ cls: "qnalog-sediment-todo-edit-row" });
        row.createDiv({ cls: "qnalog-sediment-todo-edit-label", text: label });
        const input = multi
          ? row.createEl("textarea", { cls: "qnalog-sediment-todo-edit-control", attr: { rows: "4" } })
          : row.createEl("input", { cls: "qnalog-sediment-todo-edit-control", attr: { type: "text" } });
        input.value = value || "";
        return input;
      };

      const taskInput = makeField(i18nT("Item"), todo.task || todo.title || "");
      const ownerInput = makeField(i18nT("Owner"), todo.owner && todo.owner !== "未指定" ? todo.owner : "");
      const dueInput = makeField(i18nT("Time"), todo.due && todo.due !== "未指定" ? todo.due : "");
      const subtasksInput = makeField(i18nT("Subtask"), normalizeSedimentTodoSubtasks(todo.subtasks || todo.children || todo.steps || todo.items).join("\n"), true);

      const actions = contentEl.createDiv({ cls: "qnalog-sediment-confirm-actions" });
      const cancel = actions.createEl("button", { text: i18nT("Cancel"), attr: { type: "button" } });
      const save = actions.createEl("button", { text: i18nT("Save"), cls: "mod-cta", attr: { type: "button" } });
      cancel.onclick = () => modal.close();
      save.onclick = async () => {
        const task = sanitizeSedimentText(taskInput.value, 160);
        if (!task) {
          new obsidian.Notice(i18nT("To-do item cannot be empty"));
          return;
        }
        save.disabled = true;
        await this.updateSedimentTodoCandidate(file, todo, {
          task,
          // 空值保留空字符串，由 UI "加责任人 / 加时间" 占位渲染
          owner: sanitizeSedimentText(ownerInput.value, 40) || "",
          due: sanitizeSedimentText(dueInput.value, 40) || "",
          subtasks: normalizeSedimentTodoSubtasks(subtasksInput.value),
        });
        modal.close();
      };

      const focusTarget = focus === "owner" ? ownerInput : focus === "due" ? dueInput : focus === "subtasks" ? subtasksInput : taskInput;
      window.setTimeout(() => focusTarget.focus(), 0);
    };
    modal.open();
  }

  /**
   * 待办字段 inline popover（替代全屏 modal）
   * 设计参考：qnalog-design-baseline-v2.html #assignee-1
   * - owner: 搜索 + 人员候选 + 自定义
   * - due:   快捷日期按钮 + 自定义日期 + 清除
   * - subtasks: inline 列表编辑
   */
  openSedimentTodoFieldPopover(file, todo, field, anchorEl) {
    if (!(file instanceof obsidian.TFile) || !todo || !anchorEl) return;
    // 关掉已有同类 popover
    if (this._activeTodoFieldPopover) {
      try { this._activeTodoFieldPopover.remove(); } catch { /* intentionally empty */ }
      this._activeTodoFieldPopover = null;
    }
    const pop: InlinePopover = activeDocument.body.createDiv({ cls: `qnalog-todo-popover is-${field}` });
    this._activeTodoFieldPopover = pop;

    // 定位：贴近 anchor，向下展开，必要时翻转
    const rect = anchorEl.getBoundingClientRect();
    pop.setCssStyles({ position: "fixed", maxWidth: "320px" });
    pop.style.left = `${Math.max(8, rect.left)}px`;
    pop.style.top = `${rect.bottom + 6}px`;

    // 渲染对应内容
    if (field === "owner") void this.renderTodoOwnerPopover(pop, file, todo);
    else if (field === "due") this.renderTodoDuePopover(pop, file, todo);
    else if (field === "subtasks") this.renderTodoSubtasksPopover(pop, file, todo);

    // 翻转：如果浮层超出视口底部，向上翻
    window.setTimeout(() => {
      const pr = pop.getBoundingClientRect();
      const vh = window.innerHeight;
      if (pr.bottom > vh - 8) {
        pop.style.top = `${Math.max(8, rect.top - pr.height - 6)}px`;
      }
      if (pr.right > window.innerWidth - 8) {
        pop.style.left = `${Math.max(8, window.innerWidth - pr.width - 12)}px`;
      }
    }, 0);

    // 点外面 / Escape 关闭
    const close = () => {
      try { pop.remove(); } catch { /* intentionally empty */ }
      if (this._activeTodoFieldPopover === pop) this._activeTodoFieldPopover = null;
      activeDocument.removeEventListener("mousedown", onDocDown, true);
      activeDocument.removeEventListener("keydown", onKeyDown, true);
    };
    const onDocDown = (e) => {
      if (!pop.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) close();
    };
    const onKeyDown = (e) => { if (e.key === "Escape") close(); };
    window.setTimeout(() => {
      activeDocument.addEventListener("mousedown", onDocDown, true);
      activeDocument.addEventListener("keydown", onKeyDown, true);
    }, 0);
    pop._qnalogClose = close;
  }

  async renderTodoOwnerPopover(pop, file, todo) {
    const search = pop.createEl("input", {
      cls: "qnalog-todo-popover-search",
      attr: { type: "text", placeholder: i18nT("AI Organize") },
    });
    const list = pop.createDiv({ cls: "qnalog-todo-popover-list" });
    list.createDiv({ cls: "qnalog-todo-popover-loading", text: i18nT("Loading people…") });

    let people = [];
    try {
      people = await loadPeopleDirectory(this) || [];
    } catch { /* intentionally empty */ }

    const renderRows = (filter) => {
      list.empty();
      const q = (filter || "").trim().toLowerCase();
      const filtered = !q ? people : people.filter(p => {
        const txt = `${p.name || ""} ${p.aliases || ""} ${p.role || ""} ${p.org || ""}`.toLowerCase();
        return txt.includes(q);
      });
      if (!filtered.length && !q) {
        list.createDiv({ cls: "qnalog-todo-popover-empty", text: i18nT("The person library is empty; type a new name and press Enter") });
        return;
      }
      // 当前选中
      if (todo.owner) {
        list.createDiv({ cls: "qnalog-todo-popover-section", text: i18nT("Current") });
        const row = list.createDiv({ cls: "qnalog-todo-popover-item is-current" });
        row.createSpan({ cls: "qnalog-todo-popover-item-name", text: todo.owner });
        const clear = row.createSpan({ cls: "qnalog-todo-popover-item-clear", text: i18nT("Clear") });
        clear.onclick = async (e) => {
          e.stopPropagation();
          await this.updateSedimentTodoCandidate(file, todo, { owner: "" });
          if (pop._qnalogClose) pop._qnalogClose();
        };
      }
      if (filtered.length) {
        list.createDiv({ cls: "qnalog-todo-popover-section", text: q ? i18nT("Matched") : i18nT("Person library") });
        for (const p of filtered.slice(0, 12)) {
          const row = list.createDiv({ cls: "qnalog-todo-popover-item" });
          row.createSpan({ cls: "qnalog-todo-popover-item-name", text: p.name || i18nT("Untitled") });
          if (p.role || p.org) {
            row.createSpan({
              cls: "qnalog-todo-popover-item-meta",
              text: [p.role, p.org].filter(Boolean).join(" · "),
            });
          }
          row.onclick = async () => {
            await this.updateSedimentTodoCandidate(file, todo, { owner: p.name || "" });
            if (pop._qnalogClose) pop._qnalogClose();
          };
        }
      }
      // 当 search 有值且没匹配任何人员 → 显示"新建"项
      if (q && !filtered.some(p => (p.name || "").toLowerCase() === q)) {
        list.createDiv({ cls: "qnalog-todo-popover-section", text: i18nT("New name") });
        const row = list.createDiv({ cls: "qnalog-todo-popover-item is-new" });
        row.createSpan({ cls: "qnalog-todo-popover-item-name", text: `+ "${filter.trim()}"` });
        row.onclick = async () => {
          await this.updateSedimentTodoCandidate(file, todo, { owner: filter.trim() });
          if (pop._qnalogClose) pop._qnalogClose();
        };
      }
    };
    renderRows("");

    search.oninput = () => renderRows(search.value);
    search.onkeydown = async (e) => {
      if (e.key === "Enter" && search.value.trim()) {
        e.preventDefault();
        await this.updateSedimentTodoCandidate(file, todo, { owner: search.value.trim() });
        if (pop._qnalogClose) pop._qnalogClose();
      }
    };
    window.setTimeout(() => search.focus(), 30);
  }

  renderTodoDuePopover(pop, file, todo) {
    pop.createDiv({ cls: "qnalog-todo-popover-section", text: i18nT("Shortcuts") });
    const presetWrap = pop.createDiv({ cls: "qnalog-todo-popover-presets" });
    const moment = window.moment;
    const presets = moment ? [
      { label: i18nT("Today"), value: moment().format("YYYY-MM-DD") },
      { label: i18nT("Tomorrow"), value: moment().add(1, "day").format("YYYY-MM-DD") },
      { label: i18nT("This weekend"), value: moment().endOf("week").format("YYYY-MM-DD") },
      { label: i18nT("Next week"), value: moment().add(1, "week").format("YYYY-MM-DD") },
      { label: i18nT("Next month"), value: moment().add(1, "month").format("YYYY-MM-DD") },
    ] : [];
    for (const p of presets) {
      const btn = presetWrap.createEl("button", {
        cls: "qnalog-todo-popover-preset",
        text: p.label,
        attr: { type: "button" },
      });
      btn.onclick = async () => {
        await this.updateSedimentTodoCandidate(file, todo, { due: p.value });
        if (pop._qnalogClose) pop._qnalogClose();
      };
    }
    pop.createDiv({ cls: "qnalog-todo-popover-divider" });
    pop.createDiv({ cls: "qnalog-todo-popover-section", text: i18nT("Custom") });
    const dateInput = pop.createEl("input", {
      cls: "qnalog-todo-popover-date",
      attr: { type: "date" },
    });
    const currentISO = todo.due && /^\d{4}-\d{2}-\d{2}/.test(todo.due) ? todo.due.slice(0, 10) : "";
    dateInput.value = currentISO;
    dateInput.onchange = async () => {
      if (dateInput.value) {
        await this.updateSedimentTodoCandidate(file, todo, { due: dateInput.value });
        if (pop._qnalogClose) pop._qnalogClose();
      }
    };
    if (todo.due) {
      const clear = pop.createEl("button", {
        cls: "qnalog-todo-popover-clear",
        text: i18nT("Clear time"),
        attr: { type: "button" },
      });
      clear.onclick = async () => {
        await this.updateSedimentTodoCandidate(file, todo, { due: "" });
        if (pop._qnalogClose) pop._qnalogClose();
      };
    }
  }

  renderTodoSubtasksPopover(pop, file, todo) {
    pop.createDiv({ cls: "qnalog-todo-popover-section", text: i18nT("Subtask") });
    const existing = normalizeSedimentTodoSubtasks(todo.subtasks || todo.children || []);
    const list = pop.createDiv({ cls: "qnalog-todo-popover-subtasks" });
    const renderList = () => {
      list.empty();
      existing.forEach((sub, i) => {
        const row = list.createDiv({ cls: "qnalog-todo-popover-subtask-row" });
        const input = row.createEl("input", {
          cls: "qnalog-todo-popover-subtask-input",
          attr: { type: "text", value: sub },
        });
        input.value = sub;
        input.oninput = () => { existing[i] = input.value; };
        const del = row.createEl("button", {
          cls: "qnalog-todo-popover-subtask-del",
          attr: { type: "button", "aria-label": i18nT("Delete subtask") },
        });
        try { obsidian.setIcon(del, "x"); } catch { del.setText("×"); }
        del.onclick = (e) => {
          e.stopPropagation();
          existing.splice(i, 1);
          renderList();
        };
      });
    };
    renderList();
    const addRow = pop.createDiv({ cls: "qnalog-todo-popover-subtask-add" });
    const addInput = addRow.createEl("input", {
      cls: "qnalog-todo-popover-subtask-input",
      attr: { type: "text", placeholder: i18nT("+ Add a subtask, press Enter to confirm") },
    });
    addInput.onkeydown = (e) => {
      if (e.key === "Enter" && addInput.value.trim()) {
        e.preventDefault();
        existing.push(addInput.value.trim());
        addInput.value = "";
        renderList();
        addInput.focus();
      }
    };
    const actions = pop.createDiv({ cls: "qnalog-todo-popover-actions" });
    const save = actions.createEl("button", {
      cls: "qnalog-todo-popover-save mod-cta",
      text: i18nT("Save"),
      attr: { type: "button" },
    });
    save.onclick = async () => {
      const cleaned = existing.map(s => sanitizeSedimentText(s, 100)).filter(Boolean);
      await this.updateSedimentTodoCandidate(file, todo, { subtasks: cleaned });
      if (pop._qnalogClose) pop._qnalogClose();
    };
    window.setTimeout(() => addInput.focus(), 30);
  }

  renderSedimentEmptyList(parent, text = "") {
    const empty = parent.createDiv({ cls: "qnalog-sediment-empty-line" });
    empty.setText(text || i18nT("Nothing to add yet"));
  }

  renderSedimentReviewGroup(parent, file, state: SedimentPanelState, groupKey: string) {
    const review = this.getSedimentGroupReview(file, groupKey);
    const items: SedimentItem[] = review && Array.isArray(review.items) ? review.items : [];
    const canRollback = !!(review && review.restore);
    // 顶部说明：只有真有处理记录可看的时候才提"N 条记录可回看"
    const note = parent.createDiv({ cls: "qnalog-sediment-review-note" });
    note.setText(items.length ? i18nT("This group has been fully processed · {0} records can be reviewed").replace("{0}", String(items.length)) : i18nT("This group has been fully processed"));
    // 有记录才画列表；空记录不再硬塞"本组无处理记录"占位（会让用户困惑）
    if (items.length) {
      const list = parent.createDiv({ cls: "qnalog-sediment-list" });
      for (const item of items.slice(0, 10)) {
        const row = list.createDiv({ cls: "qnalog-sediment-list-item qnalog-sediment-review-item" });
        const badge = row.createSpan({ cls: `qnalog-sediment-review-badge is-${item.status || "done"}`, text: item.statusText || i18nT("Processed") });
        badge.setAttr("title", item.statusText || i18nT("Processed"));
        const content = row.createDiv({ cls: "qnalog-sediment-item-content" });
        const top = content.createDiv({ cls: "qnalog-sediment-item-top" });
        top.createDiv({ cls: "qnalog-sediment-item-title", text: item.title || "" });
        if (item.sub) content.createDiv({ cls: "qnalog-sediment-item-sub", text: item.sub });
        if (item.meta) content.createDiv({ cls: "qnalog-sediment-item-meta", text: item.meta });
      }
      if (items.length > 10) list.createDiv({ cls: "qnalog-sediment-more", text: `${i18nT("Another ")}${items.length - 10}${i18nT(" processing records")}` });
    }
    // "重新处理本组"按钮只有当 review 真有 restore 快照可以单组回滚时才出现 —— 这种情况下点击只影响本组。
    // 没有 restore 时（旧版本 / 无快照）不再画这个按钮，避免和顶部全局"重扫"重复并误导用户。
    if (canRollback) {
      const footer = parent.createDiv({ cls: "qnalog-sediment-footer" });
      const reset = footer.createEl("button", { text: i18nT("Reprocess this group"), cls: "qnalog-sediment-text-button", attr: { type: "button" } });
      reset.onclick = async () => {
        reset.disabled = true;
        try {
          await this.reprocessSedimentGroup(file, groupKey);
        } finally {
          reset.disabled = false;
        }
      };
    }
  }

  renderSedimentFooter(parent, group, count, actions) {
    const cfg = Object.assign({}, SEDIMENT_GROUP_CONFIG[(group && group.key) || "person"] || SEDIMENT_GROUP_CONFIG.person, group || {});
    const footer = parent.createDiv({ cls: "qnalog-sediment-footer" });
    const secondary = footer.createEl("button", { text: actions.secondaryText || i18nT("Ignore unselected"), cls: "qnalog-sediment-text-button", attr: { type: "button" } });
    secondary.disabled = actions.secondaryDisabled !== undefined ? !!actions.secondaryDisabled : !count;
    if (actions.secondaryTitle) secondary.setAttr("title", actions.secondaryTitle);
    secondary.onclick = () => {
      if (secondary.disabled || typeof actions.onSecondary !== "function") return;
      actions.onSecondary();
    };
    const primaryText = cfg.primaryButtonText
      ? i18nT(cfg.primaryButtonText).replace("{0}", String(count))
      : `${i18nT("Add to ")}${i18nT(cfg.dest)} (${count})`;
    const primary = footer.createEl("button", { text: primaryText, cls: "qnalog-sediment-button is-primary", attr: { type: "button" } });
    primary.disabled = !count;
    if (!count) primary.setAttr("title", i18nT("Please select at least one item"));
    primary.onclick = () => {
      if (!count || typeof actions.onPrimary !== "function") return;
      actions.onPrimary();
    };
  }

  renderSedimentPeopleItem(parent, file, item) {
    const row = parent.createDiv({ cls: "qnalog-sediment-list-item is-person-candidate" });
    const evidence = item.evidence || item.reason || item.note || "";
    if (evidence) row.setAttr("title", `${i18nT("Basis:")}${evidence}`);
    const icon = row.createDiv({ cls: "qnalog-sediment-item-icon" });
    try { obsidian.setIcon(icon, "user-round"); } catch { icon.setText(i18nT("People")); }
    const content = row.createDiv({ cls: "qnalog-sediment-item-content" });
    const top = content.createDiv({ cls: "qnalog-sediment-item-top" });
    // 人名可点击就地改名（ASR 转错的名字直接改）
    const nameEl = top.createDiv({
      cls: "qnalog-sediment-item-title qnalog-sediment-editable-title",
      text: item.name || i18nT("Unnamed person"),
      attr: { role: "button", tabindex: "0", title: i18nT("Click to edit") },
    });
    nameEl.onclick = (evt) => {
      evt.stopPropagation();
      this.enterSedimentInlineTitleEdit(nameEl, item.name || "", (next) => this.updateSedimentPersonName(file, item, next));
    };
    const actions = top.createDiv({ cls: "qnalog-sediment-actions" });
    actions.createEl("button", { text: i18nT("Keep"), cls: "qnalog-sediment-action is-primary", attr: { type: "button" } }).onclick = () => this.keepPeopleSuggestions(file, [item]);
    actions.createEl("button", { text: i18nT("Merge"), cls: "qnalog-sediment-action", attr: { type: "button" } }).onclick = () => {
      this.port.openPeopleSuggestionModal(file, [item], { fromCache: true, cachedCount: 1 });
    };
    actions.createEl("button", { text: i18nT("Ignore"), cls: "qnalog-sediment-action is-muted", attr: { type: "button" } }).onclick = () => this.ignorePeopleSuggestions([item], file);
    const org = item.org || item.organization || "";
    const aliases = item.aliases && item.aliases.length ? item.aliases.join(i18nT(", ")) : "";
    const meta = [item.role || "", org, aliases].filter(Boolean).join(" · ");
    content.createDiv({ cls: "qnalog-sediment-item-meta", text: meta || i18nT("Identity to be filled in") });
  }

  renderSedimentPrompt(parent, opts) {
    const box = parent.createDiv({ cls: "qnalog-sediment-prompt" });
    const icon = box.createDiv({ cls: "qnalog-sediment-prompt-icon" });
    try { obsidian.setIcon(icon, opts.icon || "sparkles"); } catch { /* intentionally empty */ }
    if (opts.subtitle) box.createDiv({ cls: "qnalog-sediment-prompt-subtitle", text: opts.subtitle });
    if (opts.title) box.createDiv({ cls: "qnalog-sediment-prompt-title", text: opts.title });
    if (opts.desc) box.createDiv({ cls: "qnalog-sediment-prompt-desc", text: opts.desc });
    const actions = box.createDiv({ cls: "qnalog-sediment-prompt-actions" });
    if (opts.secondaryText && opts.onSecondary) {
      actions.createEl("button", { text: opts.secondaryText, cls: "qnalog-sediment-button is-secondary", attr: { type: "button" } }).onclick = opts.onSecondary;
    }
    if (opts.primaryText && opts.onPrimary) {
      actions.createEl("button", { text: opts.primaryText, cls: "qnalog-sediment-button is-primary", attr: { type: "button" } }).onclick = opts.onPrimary;
    }
    if (opts.smallText) box.createDiv({ cls: "qnalog-sediment-prompt-small", text: opts.smallText });
    if (opts.extraActions && opts.extraActions.length) {
      const extra = box.createDiv({ cls: "qnalog-sediment-extra-actions" });
      for (const item of opts.extraActions) {
        extra.createEl("button", { text: item.text, cls: "qnalog-sediment-text-button", attr: { type: "button" } }).onclick = item.action;
      }
    }
  }

  requestSedimentExtraction(file, needsConfirm) {
    if (needsConfirm) {
      this.confirmSedimentRescan(file);
      return;
    }
    void this.extractSedimentForFile(file);
  }

  getSedimentPendingCandidateCount(file) {
    const state = this.getSedimentPanelState(file);
    return (state.groups || []).reduce((sum, group) => sum + Math.max(0, Number(group.pending) || 0), 0);
  }

  confirmSedimentRescan(file) {
    const modal = new obsidian.Modal(this.app);
    modal.onOpen = () => {
      const { contentEl } = modal;
      contentEl.addClass("qnalog-sediment-rescan-modal");
      const head = contentEl.createDiv({ cls: "qnalog-sediment-confirm-head" });
      const icon = head.createDiv({ cls: "qnalog-sediment-confirm-icon" });
      try { obsidian.setIcon(icon, "refresh-cw"); } catch { /* intentionally empty */ }
      head.createEl("h3", { text: i18nT("Rescan this note?") });
      const pendingCount = this.getSedimentPendingCandidateCount(file);
      const list = contentEl.createEl("ul", { cls: "qnalog-sediment-confirm-list" });
      [
        ["check", i18nT("Items already added to the library are unaffected")],
        ["check", i18nT("Ignored items will not appear again")],
        ["alert-triangle", i18nT("Currently {0} unconfirmed candidates will be overwritten").replace("{0}", String(pendingCount))],
      ].forEach(([iconName, text]) => {
        const li = list.createEl("li");
        try { obsidian.setIcon(li.createSpan({ cls: "qnalog-sediment-confirm-list-icon" }), iconName); } catch { /* intentionally empty */ }
        li.createSpan({ text });
      });
      const note = contentEl.createDiv({ cls: "qnalog-sediment-confirm-note" });
      note.setText(i18nT("Rescanning regenerates four sets of candidates; items already added to the library are not deleted."));
      const actions = contentEl.createDiv({ cls: "qnalog-sediment-confirm-actions" });
      const cancel = actions.createEl("button", { text: i18nT("Cancel"), attr: { type: "button" } });
      const confirm = actions.createEl("button", { text: i18nT("Rescan"), cls: "mod-cta", attr: { type: "button" } });
      cancel.onclick = () => modal.close();
      confirm.onclick = async () => {
        confirm.disabled = true;
        modal.close();
        await this.extractSedimentForFile(file);
      };
    };
    modal.open();
  }

  showSedimentToast(message, opts: SedimentToastOptions = {}) {
    const root = this.view.containerEl && this.view.containerEl.children && this.view.containerEl.children[1];
    if (!root) return;
    const old = root.querySelector(".qnalog-sediment-toast");
    if (old) old.remove();
    if (this.sedimentToastTimer) {
      window.clearTimeout(this.sedimentToastTimer);
      this.sedimentToastTimer = 0;
    }
    const toast = root.createDiv({ cls: "qnalog-sediment-toast" + (opts.variant ? ` is-${opts.variant}` : "") });
    const icon = toast.createDiv({ cls: "qnalog-sediment-toast-icon" });
    try { obsidian.setIcon(icon, opts.icon || "check"); } catch { /* intentionally empty */ }
    toast.createDiv({ cls: "qnalog-sediment-toast-message", text: message || "" });
    const actions = Array.isArray(opts.actions) ? opts.actions : (opts.actionText && typeof opts.onAction === "function" ? [{ text: opts.actionText, action: opts.onAction }] : []);
    for (const item of actions) {
      if (!item || !item.text || typeof item.action !== "function") continue;
      const action = toast.createEl("button", { text: item.text, cls: "qnalog-sediment-toast-action", attr: { type: "button" } });
      action.onclick = () => item.action();
    }
    this.sedimentToastTimer = window.setTimeout(() => {
      toast.remove();
      this.sedimentToastTimer = 0;
    }, opts.duration || 5000);
  }

  async extractVocabularyForFile(file) {
    const taskId = `vocabulary:${file.path}`;
    try {
      const terms = await this.port.tasks.runTaskActivity({
        id: taskId,
        kind: "vocabulary",
        title: i18nT("Extract transcript terms"),
        subject: file.path,
        status: "running",
        stage: "reading",
        stageLabel: i18nT("Read the note content"),
        detail: file.basename,
        progress: 5,
        actions: [],
      }, async ({ patch }) => {
        const markdown = await this.app.vault.cachedRead(file);
        patch({
          stage: "extracting",
          stageLabel: i18nT("AI is identifying transcription terms"),
          progress: 30,
          deadlineAt: Date.now() + 120_000,
        });
        const extracted = await this.port.vocabulary.extractVocabularyFromMarkdown(file, markdown);
        patch({
          stage: "saving",
          stageLabel: i18nT("Saving glossary candidates"),
          progress: 85,
          deadlineAt: 0,
        });
        this.port.knowledgeExtraction.markKnowledgeExtractionSource("vocabulary", file);
        await this.port.saveSettings();
        this.port.tasks.completeTaskActivity(taskId, {
          stage: "done",
          stageLabel: i18nT("Transcription term extraction complete"),
          detail: `${extracted.length}${i18nT(" candidate words")}`,
          progress: 100,
          actions: [
            { id: "open-task-note", label: i18nT("Open note"), primary: true },
            { id: "dismiss-task", label: i18nT("Dismiss") },
          ],
        });
        return extracted;
      }, {
        failureLabel: i18nT("Transcription term extraction not complete"),
        failureActions: [
          { id: "open-task-note", label: i18nT("Open note"), primary: true },
          { id: "dismiss-task", label: i18nT("Dismiss") },
        ],
      });
      new obsidian.Notice(`${i18nT("ASR hotword extraction complete: ")}${terms.length}${i18nT(" candidate words")}`);
      this.view.render();
    } catch (e) {
      console.error("[QnALog] extract vocabulary from current note failed", e);
      new obsidian.Notice(`${i18nT("Extract failed:")}${(e && e.message) || e}`, 8000);
    }
  }

  async extractPeopleSuggestionsForFile(file) {
    const taskId = `people-suggestions:${file.path}`;
    try {
      const added = await this.port.tasks.runTaskActivity({
        id: taskId,
        kind: "people-suggestions",
        title: i18nT("Extract people suggestions"),
        subject: file.path,
        status: "running",
        stage: "reading",
        stageLabel: i18nT("Read the note content"),
        detail: file.basename,
        progress: 5,
        actions: [],
      }, async ({ patch }) => {
        const markdown = await this.app.vault.cachedRead(file);
        patch({
          stage: "extracting",
          stageLabel: i18nT("AI is identifying people and relationships"),
          progress: 30,
          deadlineAt: Date.now() + 120_000,
        });
        const items = await this.port.generatePeopleDirectorySuggestions(file, markdown);
        patch({
          stage: "saving",
          stageLabel: i18nT("Saving person suggestions"),
          progress: 85,
          deadlineAt: 0,
        });
        const addedCount = this.port.people.cachePeopleDirectorySuggestions(file, items);
        this.port.knowledgeExtraction.markKnowledgeExtractionSource("people", file);
        await this.port.saveSettings();
        this.port.tasks.completeTaskActivity(taskId, {
          stage: "done",
          stageLabel: i18nT("Person suggestions generated"),
          detail: addedCount ? `${addedCount}${i18nT(" pending")}` : i18nT("No new person suggestions detected"),
          progress: 100,
          actions: [
            { id: "open-task-note", label: i18nT("Open note"), primary: true },
            { id: "dismiss-task", label: i18nT("Dismiss") },
          ],
        });
        return addedCount;
      }, {
        failureLabel: i18nT("Person suggestion extraction not finished"),
        failureActions: [
          { id: "open-task-note", label: i18nT("Open note"), primary: true },
          { id: "dismiss-task", label: i18nT("Dismiss") },
        ],
      });
      new obsidian.Notice(added ? `${i18nT("Person suggestions generated: ")}${added}${i18nT(" pending")}` : i18nT("No new person suggestions detected"));
      this.view.render();
    } catch (e) {
      console.error("[QnALog] extract people from current note failed", e);
      new obsidian.Notice(`${i18nT("Person suggestion extraction failed: ")}${(e && e.message) || e}`, 8000);
    }
  }

  getSedimentObjectsFromBucket(file) {
    const bucket = this.getSedimentCandidateBucket(file);
    return {
      people: bucket.people || [],
      todos: bucket.todos || [],
      hotwords: bucket.hotwords || createVocabularyGroups(),
    };
  }

  async persistSedimentCandidateBucket(file) {
    try {
      await this.port.upsertSedimentPreExtractionBlock(file, this.getSedimentObjectsFromBucket(file));
      this.view.notePanelCacheKey = "";
      return true;
    } catch (e) {
      console.warn("[QnALog] persist pre-extracted sediment failed", e);
      new obsidian.Notice(`${i18nT("Failed to write back the distillation status:")}${(e && e.message) || e}`, 8000);
      return false;
    }
  }

  async extractSedimentForFile(file) {
    await scanSedimentFile({
      currentToken: () => this.sedimentScanToken,
      incrementToken: () => ++this.sedimentScanToken,
      patchBucket: (_target, patch) => this.setSedimentCandidateBucket(file, patch),
      persistBucket: () => this.persistSedimentCandidateBucket(file),
      readMarkdown: () => this.app.vault.cachedRead(file),
      generate: (_target, markdown) => this.port.generateSedimentObjects(file, markdown),
      normalizeAndAddIds: (objects, path, basename) => withSedimentCandidateIds(objects, path, basename),
      normalizePath: path => obsidian.normalizePath(path),
      createVocabularyGroups,
      initialCounts: objects => this.getSedimentInitialCountsFromObjects(objects),
      countRawPeople: objects => ((objects as SedimentScanNormalized | null)?.people || []).length,
      countRawTodos: objects => ((objects as SedimentScanNormalized | null)?.todos || []).length,
      countRawHotwords: objects => countVocabularyGroups((objects as SedimentScanNormalized | null)?.hotwords),
      selectGroupState: () => this.getSedimentPanelState(file),
      findNextPendingGroup: groups => this.findSedimentNextPendingGroup(groups as SedimentGroup[]),
      setSelectedGroup: group => { this.sedimentGroup = group; },
      setSwitcherOpen: open => { this.sedimentSwitcherOpen = open; },
      render: () => this.view.render(),
      showToast: (message, options) => this.showSedimentToast(message, options),
      showFailureNotice: (error, duration) => { new obsidian.Notice(`${i18nT("Failed to scan this note:")}${sedimentNoticeErrorSuffix(error)}`, duration); },
      errorMessage: error => getTaskErrorMessage(error),
      logFailure: error => console.error("[QnALog] extract sediment from current note failed", error),
      tasks: {
        startTaskActivity: input => this.port.tasks.startTaskActivity(input),
        patchTaskActivity: (id, patch) => this.port.tasks.patchTaskActivity(id, patch),
        cancelTaskActivity: (id, reason) => this.port.tasks.cancelTaskActivity(id, reason),
        completeTaskActivity: (id, result) => this.port.tasks.completeTaskActivity(id, result),
        failTaskActivity: (id, error, result) => this.port.tasks.failTaskActivity(id, error, result),
      },
    }, file);
  }

  cancelSedimentExtraction(file) {
    cancelSedimentScan({
      incrementToken: () => ++this.sedimentScanToken,
      patchBucket: (_target, patch) => this.setSedimentCandidateBucket(file, patch),
      tasks: {
        cancelTaskActivity: (id, reason) => this.port.tasks.cancelTaskActivity(id, reason),
      },
      render: () => this.view.render(),
      showToast: (message, options) => this.showSedimentToast(message, options),
    }, file);
  }

  cloneSedimentBucket(file) {
    return cloneSedimentBucketValue(this.getSedimentCandidateBucket(file));
  }

  setSedimentDecisionLog(file, groupKey, log) {
    setSedimentDecisionLogFlow(this.sedimentBucketPort(file), groupKey, log);
  }

  appendSedimentDecisionItems(file, groupKey, rawItems, status, statusText, state) {
    appendSedimentDecisionItemsFlow(
      this.sedimentBucketPort(file),
      groupKey,
      rawItems || [],
      status,
      statusText,
      state || this.getSedimentPanelState(file),
      this.sedimentIdPort(),
      file instanceof obsidian.TFile ? obsidian.normalizePath(file.path || "") : "",
    );
  }

  buildSedimentDecisionLog(state: SedimentPanelState, groupKey: string, selectedIds: Set<string>, actionLabel = "") {
    return buildSedimentDecisionLogFlow(state, groupKey, selectedIds, this.sedimentIdPort(), actionLabel);
  }

  buildVocabularyGroupsFromHotwordItems(items) {
    const groups = createVocabularyGroups();
    for (const item of items || []) {
      const sectionKey = item && (item.sectionKey || (item.raw && item.raw.sectionKey));
      const term = item && (item.term || item.title || (item.raw && item.raw.term));
      if (sectionKey && groups[sectionKey] && term && !groups[sectionKey].includes(term)) groups[sectionKey].push(term);
    }
    return groups;
  }

  async restoreSedimentUndo(undo) {
    await restoreSedimentCommitFlow({
      restoreEntries: async record => {
        const value = record as SedimentCommitUndo;
        for (const entry of value.entries || []) {
          const target = entry && entry.path ? this.app.vault.getAbstractFileByPath(entry.path) : entry.file;
          if (!(target instanceof obsidian.TFile)) continue;
          if (entry.created) await trashVaultFileRef(this.app, target);
          else await this.app.vault.modify(target, entry.previousContent || "");
        }
      },
      restoreVocabulary: async record => {
        const value = record as SedimentCommitUndo;
        if (!value.vocabulary) return;
        const vocabulary = value.vocabulary;
        if (vocabulary.path) {
          const target = this.app.vault.getAbstractFileByPath(vocabulary.path);
          if (vocabulary.existed && target instanceof obsidian.TFile) await this.app.vault.modify(target, vocabulary.previousContent || "");
          else if (!vocabulary.existed && target instanceof obsidian.TFile) await trashVaultFileRef(this.app, target);
        } else {
          this.port.settings.customVocabulary = vocabulary.previousCustomVocabulary || "";
          await this.port.saveSettings();
        }
      },
      restoreSourceSnapshot: async record => {
        const snapshot = (record as SedimentCommitUndo).sourceSnapshot;
        if (!snapshot || !snapshot.path) return;
        const source = this.app.vault.getAbstractFileByPath(snapshot.path);
        if (source instanceof obsidian.TFile) await this.app.vault.modify(source, snapshot.content || "");
      },
      restoreBucket: async record => {
        const value = record as SedimentCommitUndo;
        if (!value.bucketBefore || !value.filePath) return;
        const target = this.app.vault.getAbstractFileByPath(value.filePath);
        if (!(target instanceof obsidian.TFile)) return;
        this.sedimentCandidatesByPath[value.filePath] = value.bucketBefore;
        await this.persistSedimentCandidateBucket(target);
      },
      render: () => this.view.render(),
      showUndoToast: () => this.showSedimentToast(i18nT("This library import was undone"), { icon: "rotate-ccw", variant: "muted" }),
      presentError: error => {
        console.error("[QnALog] undo sediment commit failed", error);
        new obsidian.Notice(`${i18nT("Undo failed:")}${sedimentNoticeErrorSuffix(error)}`, 8000);
      },
    }, undo);
  }

  async openSedimentCommitTarget(undo) {
    const entry = undo && (undo.entries || []).find(item => item && item.path);
    if (entry) {
      const file = this.app.vault.getAbstractFileByPath(entry.path);
      if (file instanceof obsidian.TFile) {
        await this.app.workspace.getLeaf(false).openFile(file);
        return;
      }
    }
    if (undo && undo.vocabulary && undo.vocabulary.path) {
      const file = this.app.vault.getAbstractFileByPath(undo.vocabulary.path);
      if (file instanceof obsidian.TFile) await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  showSedimentCommitToast(message, undo) {
    this.sedimentLastUndo = undo || null;
    this.showSedimentToast(message, {
      icon: "check",
      actions: [
        { text: i18nT("Undo"), action: () => { void this.restoreSedimentUndo(this.sedimentLastUndo); } },
        { text: i18nT("View"), action: () => { void this.openSedimentCommitTarget(this.sedimentLastUndo); } },
      ],
      duration: 5000,
    });
  }

  confirmIgnoreSedimentUnselected(file, groupKey, count) {
    if (!(count > 0)) return;
    const modal = new obsidian.Modal(this.app);
    modal.onOpen = () => {
      const { contentEl } = modal;
      contentEl.addClass("qnalog-sediment-rescan-modal");
      const head = contentEl.createDiv({ cls: "qnalog-sediment-confirm-head" });
      const icon = head.createDiv({ cls: "qnalog-sediment-confirm-icon" });
      try { obsidian.setIcon(icon, "circle-minus"); } catch { /* intentionally empty */ }
      head.createEl("h3", { text: i18nT("Ignore unselected content?") });
      const note = contentEl.createDiv({ cls: "qnalog-sediment-confirm-note" });
      note.setText(`${i18nT("Unselected ")}${count}${i18nT(" items will be marked as ignored and cannot be restored. After you continue, the selected content will be added to the corresponding library.")}`);
      const actions = contentEl.createDiv({ cls: "qnalog-sediment-confirm-actions" });
      const cancel = actions.createEl("button", { text: i18nT("Cancel"), attr: { type: "button" } });
      const confirm = actions.createEl("button", { text: i18nT("Continue"), cls: "mod-cta", attr: { type: "button" } });
      cancel.onclick = () => modal.close();
      confirm.onclick = async () => {
        confirm.disabled = true;
        modal.close();
        await this.commitSedimentGroup(file, groupKey);
      };
    };
    modal.open();
  }

  async commitSedimentGroup(file, groupKey) {
    try {
      const state = this.getSedimentPanelState(file);
      const displayItems = this.getSedimentDisplayItems(state, groupKey);
      const selected = groupKey === "person"
        ? new Set(displayItems.map(item => item.id))
        : this.getSedimentSelectedIds(file, groupKey, displayItems);
      const selectedItems = displayItems.filter(item => selected.has(item.id));
      if (SEDIMENT_GROUP_CONFIG[groupKey] && SEDIMENT_GROUP_CONFIG[groupKey].decisionModel === "checkbox" && !selectedItems.length) return;
      if (groupKey !== "todo" && groupKey !== "hotword") {
        await this.keepPeopleSuggestions(file, state.currentPeople);
        return;
      }
      const filePath = obsidian.normalizePath(file.path || "");
      const count = selectedItems.length;
      if (!count) return;
      let undo: SedimentCommitUndo;
      let successText = "";
      let hotwordRenames = [];
      await commitSedimentGroupFlow({
        snapshotBucket: () => {
          undo = { filePath, bucketBefore: this.cloneSedimentBucket(file), entries: [] };
          return undo;
        },
        write: async () => {
          if (groupKey === "todo") {
            const result = await this.port.writeSedimentObjectCards(file, { todos: selectedItems.map(item => item.raw) });
            undo.entries = result.entries || [];
            successText = `${i18nT("Added to to-dos:")}${count}${i18nT(" line items")}`;
            return;
          }
          try { undo.sourceSnapshot = { path: filePath, content: await this.app.vault.read(file) }; } catch { /* intentionally empty */ }
          const vocabPath = this.port.settings.vocabularyFile;
          if (vocabPath) {
            const norm = obsidian.normalizePath(vocabPath);
            const vocabFile = this.app.vault.getAbstractFileByPath(norm);
            undo.vocabulary = {
              path: norm,
              existed: vocabFile instanceof obsidian.TFile,
              previousContent: vocabFile instanceof obsidian.TFile ? await this.app.vault.read(vocabFile) : "",
            };
          } else {
            undo.vocabulary = {
              path: "",
              existed: false,
              previousCustomVocabulary: this.port.settings.customVocabulary || "",
            };
          }
          const existing = await this.port.loadVocabularyGroups();
          const selectedGroups = this.buildVocabularyGroupsFromHotwordItems(selectedItems);
          await this.port.vocabulary.writeVocabularyFile(mergeVocabularyGroups(existing, selectedGroups));
          try { hotwordRenames = await this.applyHotwordRenamesToNote(file, selectedItems); } catch (e) { console.error("[QnALog] rename hotwords in note failed", e); }
          this.port.knowledgeExtraction.markKnowledgeExtractionSource("vocabulary", file);
          await this.port.saveSettings();
          const renameNote = hotwordRenames.length
            ? `${i18nT(", and correct those in the body: ")}${hotwordRenames.map(r => `${r.from}→${r.to}`).join(", ")}${i18nT(" corrected as well")}`
            : "";
          successText = `${i18nT("Added to hotword library:")}${count}${i18nT(" file items")}${renameNote}`;
        },
        recordDecisionLog: () => {
          this.setSedimentDecisionLog(file, groupKey, this.buildSedimentDecisionLog(state, groupKey, selected, i18nT("Added")));
        },
        markDone: () => {
          if (groupKey === "todo") this.setSedimentCandidateBucket(file, { todos: [] });
          else this.setSedimentCandidateBucket(file, { hotwords: createVocabularyGroups(), hotwordTermRenames: {} });
          return this.markSedimentGroupDone(file, groupKey, displayItems.length || count);
        },
        persistBucket: async () => {
          const selectedByGroup: Record<string, string[]> = { ...(this.getSedimentCandidateBucket(file).selectedByGroup || {}) };
          selectedByGroup[groupKey] = [];
          this.setSedimentCandidateBucket(file, { selectedByGroup });
          return this.persistSedimentCandidateBucket(file);
        },
        render: () => this.view.render(),
        showCommitToast: record => this.showSedimentCommitToast(successText, record),
        scheduleAutoAdvance: () => this.scheduleSedimentAutoAdvance(file, groupKey),
      });
    } catch (e) {
      console.error("[QnALog] commit sediment group failed", groupKey, e);
      new obsidian.Notice(`${i18nT("Failed to add: ")}${(e && e.message) || e}`, 8000);
    }
  }

  async ignoreSedimentGroup(file, groupKey) {
    const state = this.getSedimentPanelState(file);
    const displayItems = this.getSedimentDisplayItems(state, groupKey);
    const count = displayItems.length;
    if (groupKey !== "todo" && groupKey !== "hotword") {
      this.setSedimentDecisionLog(file, groupKey, this.buildSedimentDecisionLog(state, groupKey, new Set(), i18nT("Added")));
      return;
    }
    await commitSedimentGroupFlow({
      snapshotBucket: () => null,
      recordDecisionLog: () => {
        this.setSedimentDecisionLog(file, groupKey, this.buildSedimentDecisionLog(state, groupKey, new Set(), i18nT("Added")));
        if (groupKey === "todo") this.setSedimentCandidateBucket(file, { todos: [] });
        else this.setSedimentCandidateBucket(file, { hotwords: createVocabularyGroups(), hotwordTermRenames: {} });
      },
      markDone: () => count > 0 && this.markSedimentGroupDone(file, groupKey, count),
      persistBucket: () => this.persistSedimentCandidateBucket(file),
      render: () => this.view.render(),
      showCommitToast: () => this.showSedimentToast(i18nT("Unselected items ignored"), { icon: "circle-minus", variant: "muted" }),
      scheduleAutoAdvance: () => this.scheduleSedimentAutoAdvance(file, groupKey),
    });
  }

  async reprocessSedimentGroup(file, groupKey) {
    const review = this.getSedimentGroupReview(file, groupKey);
    const bucket = this.getSedimentCandidateBucket(file);
    const patch: SedimentBucketPatch = {
      doneGroups: removeSedimentGroupDone(bucket.doneGroups, groupKey),
      transitionGroup: "",
    };
    const selectedByGroup: Record<string, string[]> = { ...(bucket.selectedByGroup || {}) };
    delete selectedByGroup[groupKey];
    patch.selectedByGroup = selectedByGroup;
    const decisionLogByGroup: Record<string, SedimentGroupReview> = { ...(bucket.decisionLogByGroup || {}) } as Record<string, SedimentGroupReview>;
    delete decisionLogByGroup[groupKey];
    patch.decisionLogByGroup = decisionLogByGroup;
    const hasRestore = review && review.restore;
    if (hasRestore) {
      // 有完整的 restore 数据：把候选恢复回来
      if (groupKey === "person") patch.people = review.restore.people || [];
      else if (groupKey === "todo") patch.todos = review.restore.todos || [];
      else if (groupKey === "hotword") { patch.hotwords = review.restore.hotwords || createVocabularyGroups(); patch.hotwordTermRenames = {}; }
    } else {
      // 旧版本的 done 状态没存 restore 快照 —— 兜底：清空本组候选并触发重新扫描
      if (groupKey === "person") patch.people = [];
      else if (groupKey === "todo") patch.todos = [];
      else if (groupKey === "hotword") { patch.hotwords = createVocabularyGroups(); patch.hotwordTermRenames = {}; }
    }
    this.setSedimentCandidateBucket(file, patch);
    await this.persistSedimentCandidateBucket(file);
    this.setSedimentGroup(groupKey);
    if (!hasRestore) {
      // 触发对当前纪要的整体重新扫描，把候选重新跑出来
      try { new obsidian.Notice(i18nT("This group has no rollback data; a rescan has been triggered")); } catch { /* intentionally empty */ }
      this.requestSedimentExtraction(file, true);
    }
  }

  removeSedimentPeopleCandidates(file, suggestions) {
    const bucket = this.getSedimentCandidateBucket(file);
    if (!bucket.people || !bucket.people.length) return;
    const path = obsidian.normalizePath(file && file.path || "");
    const keys = new Set((suggestions || []).map(item => item && (item.cacheKey || item.key || getPeopleSuggestionCacheKey(item.sourcePath || path, item))).filter(Boolean));
    if (!keys.size) return;
    this.setSedimentCandidateBucket(file, {
      people: (bucket.people as PeopleSuggestionLike[]).filter(item => !keys.has(item && (item.cacheKey || item.key || getPeopleSuggestionCacheKey(item.sourcePath || path, item)))),
    });
  }

  async keepPeopleSuggestions(file, suggestions) {
    const items = (suggestions || []).filter(Boolean);
    if (!items.length) return;
    try {
      let undo: SedimentCommitUndo | null = null;
      let stateBefore: SedimentPanelState | null = null;
      let result;
      let renames = [];
      await commitSedimentGroupFlow({
        snapshotBucket: async () => {
          if (file instanceof obsidian.TFile) {
            const sourceSnapshot = { path: file.path, content: await this.app.vault.read(file) };
            undo = {
              filePath: obsidian.normalizePath(file.path || ""),
              bucketBefore: this.cloneSedimentBucket(file),
              entries: [],
              sourceSnapshot,
            };
            stateBefore = this.getSedimentPanelState(file);
          }
          return undo;
        },
        write: async record => {
          result = await this.port.people.applyPeopleDirectorySuggestions(file, items);
          if (record) record.entries = result.entries || [];
          try { renames = await this.applyPeopleRenamesToNote(file, items); } catch (e) { console.error("[QnALog] rename people in note failed", e); }
          this.port.people.removeCachedPeopleSuggestions(items);
          this.removeSedimentPeopleCandidates(file, items);
        },
        recordDecisionLog: async () => {
          if (file instanceof obsidian.TFile) this.appendSedimentDecisionItems(file, "person", items, "kept", i18nT("Added"), stateBefore);
          this.port.knowledgeExtraction.markKnowledgeExtractionSource("people", file);
          await this.port.saveSettings();
        },
        markDone: () => this.markSedimentGroupDoneIfEmpty(file, "person", items.length),
        persistBucket: async () => file instanceof obsidian.TFile ? this.persistSedimentCandidateBucket(file) : false,
        render: () => this.view.render(),
        showToastWhenPersistenceFails: true,
        showCommitToast: record => {
          const renameNote = renames.length
            ? `${i18nT(", and correct those in the body/properties: ")}${renames.map(r => `${r.from}→${r.to}`).join(", ")}${i18nT(" corrected as well")}`
            : "";
          const message = `${i18nT("Added to person library: created ")}${result.created || 0}${i18nT(", updated ")}${result.updated || 0}${renameNote}`;
          this.showSedimentCommitToast(message, record);
        },
        scheduleAutoAdvance: () => this.scheduleSedimentAutoAdvance(file, "person"),
      });
    } catch (e) {
      console.error("[QnALog] keep people suggestions failed", e);
      new obsidian.Notice(`${i18nT("Failed to save person suggestions: ")}${(e && e.message) || e}`, 8000);
    }
  }

  async ignorePeopleSuggestions(suggestions, file = null) {
    const items = (suggestions || []).filter(Boolean);
    if (!items.length) return;
    try {
      let count = 0;
      let stateBefore: SedimentPanelState | null = null;
      await commitSedimentGroupFlow({
        snapshotBucket: () => {
          stateBefore = file instanceof obsidian.TFile ? this.getSedimentPanelState(file) : null;
          return null;
        },
        write: async () => {
          for (const item of items) if (await this.port.people.ignorePeopleDirectorySuggestion(item)) count++;
          if (file instanceof obsidian.TFile) this.removeSedimentPeopleCandidates(file, items);
        },
        recordDecisionLog: () => {
          if (file instanceof obsidian.TFile) this.appendSedimentDecisionItems(file, "person", items, "ignored", i18nT("Ignored"), stateBefore);
        },
        markDone: () => file instanceof obsidian.TFile ? this.markSedimentGroupDoneIfEmpty(file, "person", items.length) : false,
        persistBucket: async () => file instanceof obsidian.TFile ? this.persistSedimentCandidateBucket(file) : false,
        render: () => this.view.render(),
        showToastWhenPersistenceFails: true,
        showCommitToast: () => this.showSedimentToast(`${i18nT("Ignored ")}${count}${i18nT(" people")}`, { icon: "circle-minus", variant: "muted" }),
        scheduleAutoAdvance: () => this.scheduleSedimentAutoAdvance(file, "person"),
      });
    } catch (e) {
      console.error("[QnALog] ignore people suggestions failed", e);
      new obsidian.Notice(`${i18nT("Ignore failed:")}${(e && e.message) || e}`, 8000);
    }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
