import type * as obsidian from "obsidian";
import type { PluginSettings } from "../shared/types";
import type { TaskActivityService } from "../tasks/task-activity-service";
import type { VocabularyService } from "../vocabulary/vocabulary-service";
import type { PeopleDirectoryService } from "../people/people-directory-service";
import type { KnowledgeExtractionService } from "../indexing/knowledge-extraction-service";
import type { generatePeopleDirectorySuggestions, loadPeopleDirectory } from "../people";
import type { generateSedimentObjects, upsertSedimentPreExtractionBlockInFile, writeSedimentObjectCards } from "../sediment";
import type { loadVocabularyGroups } from "../vocabulary";
import type { extractNotePanelData } from "../notes/detail-blocks";

/**
 * 「沉淀」页签需要的窄能力。由 src/main.ts 装配，不暴露插件对象或完整设置。
 * 成员名沿用插件上的同名成员，搬迁前后的调用一一对应。
 */
export interface SedimentUiPort {
  settings: Pick<PluginSettings,
    | "customVocabulary" | "vocabularyFile" | "peopleSuggestionCache" | "peopleSuggestionIgnores"
    | "knowledgeExtractionHistory" | "promptTemplates" | "activeTemplateByMode" | "polishMode">;
  saveSettings(): Promise<void>;
  tasks: Pick<TaskActivityService,
    "startTaskActivity" | "patchTaskActivity" | "completeTaskActivity" | "failTaskActivity" | "cancelTaskActivity" | "runTaskActivity">;
  vocabulary: Pick<VocabularyService, "extractVocabularyFromMarkdown" | "writeVocabularyFile">;
  people: Pick<PeopleDirectoryService,
    "applyPeopleDirectorySuggestions" | "cachePeopleDirectorySuggestions" | "ignorePeopleDirectorySuggestion" | "removeCachedPeopleSuggestions">;
  knowledgeExtraction: Pick<KnowledgeExtractionService, "markKnowledgeExtractionSource">;
  /** 重绘侧栏（沉淀结果写入其他文件后）。 */
  refreshOutlineView(): void;
  loadPeopleDirectory(): ReturnType<typeof loadPeopleDirectory>;
  generatePeopleDirectorySuggestions(file: obsidian.TFile, markdown: string): ReturnType<typeof generatePeopleDirectorySuggestions>;
  openPeopleSuggestionModal(file: obsidian.TFile, items: unknown[], options: { fromCache?: boolean; cachedCount?: number }): void;
  generateSedimentObjects(file: obsidian.TFile, markdown: string): ReturnType<typeof generateSedimentObjects>;
  upsertSedimentPreExtractionBlock(file: obsidian.TFile, objects: unknown): ReturnType<typeof upsertSedimentPreExtractionBlockInFile>;
  writeSedimentObjectCards(file: obsidian.TFile, objects: unknown): ReturnType<typeof writeSedimentObjectCards>;
  loadVocabularyGroups(): ReturnType<typeof loadVocabularyGroups>;
}

/** 面板读写的视图状态：已完成纪要面板的缓存、当前页签与重绘。 */
export interface SedimentViewBridge {
  containerEl: HTMLElement;
  idlePanelTab: string;
  showRecentHome: boolean;
  notePanelCacheKey: string;
  notePanelCacheData: ReturnType<typeof extractNotePanelData> | null | undefined;
  notePanelLoading: boolean;
  render(): void;
  getActiveNoteFile(): obsidian.TFile | null;
  getCompletedNotePanelData(file: obsidian.TFile): ReturnType<typeof extractNotePanelData> | null | undefined;
}
