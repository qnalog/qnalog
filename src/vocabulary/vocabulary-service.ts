/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：词汇表与行业提示词：术语抽取、词汇表写入、行业提示词生成与应用

import * as obsidian from "obsidian";
import { isKnownPolishMode, makeCustomPromptModeId, getCustomPromptModeTemplates, getBuiltInVisiblePolishModeKeys, getModeMeta, getEffectivePolishMode, sanitizePromptTemplate } from "../shared/mode-meta";
import { parseVocabularyGroups, flattenVocabularyGroups, normalizeVocabularyInput, mergeVocabularyGroups, loadVocabularyGroups, formatVocabularyMarkdown } from "../vocabulary";
import { callLlm } from "../llm/core";
import type { LexVoiceSettings } from "../shared/types";
import { KnowledgeExtractionService } from "../indexing/knowledge-extraction-service";
import { canOmitServiceApiKey } from "../shared/util-llm-endpoint";
import { INDUSTRY_META_PROMPT } from "../prompts/industry-meta";
import { KNOWLEDGE_EXTRACTION_BATCH_LIMIT } from "../shared/limits";
import { ensureVaultFolder } from "../shared/util-vault";
import type { IndustryProfile } from "../shared/types";

/** 行业画像的空值；字段与目标类型一致，避免读方拿到缺字段的对象。 */
function createEmptyIndustryProfile(): IndustryProfile {
  return { industry: "", scenarios: "", focus: "", outputPreference: "", generatedAt: null };
}

/** 生成自定义提示词时可选的名称与是否立即启用。 */
export interface CreateIndustryPromptVariantOptions {
  name?: string;
  activate?: boolean;
}

/** VocabularyService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface VocabularyHost {
  /** 知识库与工作区访问。 */
  app: obsidian.App;
  saveSettings(): Promise<void>;
  /** 知识提取服务：扫描记录与文件指纹。 */
  knowledgeExtraction: KnowledgeExtractionService;
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: LexVoiceSettings;
}

export class VocabularyService {
  declare host: VocabularyHost;
  constructor(host) {
    this.host = host;
  }

  // 单 mode 生成定制 Prompt：调一次 LLM，返回纯文本
  async generateIndustryPromptForMode(mode) {
    const p = this.host.settings.industryProfile || createEmptyIndustryProfile();
    if (!p.industry || !p.scenarios) {
      throw new Error("请先在「AI 整理」填写「行业 / 角色」和「主要工作场景」");
    }
    if (!this.host.settings.llmApiKey) throw new Error("请先在 API 页配置大模型服务");
    if (!isKnownPolishMode(this.host.settings, mode)) throw new Error("未知的 mode：" + mode);
    const meta = getModeMeta(this.host.settings, mode);
    const modeLabel = meta && meta.prefix ? meta.prefix : mode;
    const sys = "你是 Prompt 工程师，专门为真实工作和学习场景生成可直接用于录音整理的 Markdown Prompt。输出要克制、清晰、可维护，不要堆砌 callout。";
    const userMsg = INDUSTRY_META_PROMPT
      .replace(/\{\{INDUSTRY\}\}/g, p.industry || "（未指定）")
      .replace(/\{\{SCENARIOS\}\}/g, p.scenarios || "（未指定）")
      .replace(/\{\{FOCUS\}\}/g, p.focus || "（未指定）")
      .replace(/\{\{OUTPUT_PREFERENCE\}\}/g, p.outputPreference || "（未指定）")
      .replace(/\{\{MODE\}\}/g, `${mode}（${modeLabel}）`);
    const text = await callLlm(this.host, sys, userMsg);
    let cleaned = text
      .replace(/^```\w*\s*/, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    if (!cleaned.includes("{{TRANSCRIPT}}")) {
      cleaned = cleaned + "\n\n原始转写：\n{{TRANSCRIPT}}";
    }
    return cleaned;
  }

  // 把生成好的 Prompt 保存为新的自定义提示词；不再覆盖内置提示词。
  async createIndustryPromptVariant(mode, promptText, opts: CreateIndustryPromptVariantOptions = {}) {
    if (!isKnownPolishMode(this.host.settings, mode)) throw new Error("未知的 mode：" + mode);
    const moment = window.moment;
    const stamp = moment ? moment().format("YYYY-MM-DD HH:mm") : new Date().toISOString().slice(0, 16);
    const profile = this.host.settings.industryProfile || createEmptyIndustryProfile();
    const meta = getModeMeta(this.host.settings, mode);
    const role = (profile.industry || "自定义").trim();
    const firstScenario = String(profile.scenarios || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || (meta.prefix || "场景");
    const name = (opts && opts.name) || (role + " · " + firstScenario);
    const id = makeCustomPromptModeId(name || "scene");
    const tpl = {
      id,
      mode: id,
      name,
      description: "由角色、任务和输出偏好生成。参考提示词：" + (meta.prefix || meta.label || mode) + "。生成时间：" + stamp,
      baseMode: mode,
      prompt: promptText,
      isBuiltin: false,
      customMode: true,
      source: "ai-prompt-generator",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (!this.host.settings.promptTemplates) this.host.settings.promptTemplates = {};
    if (!this.host.settings.activeTemplateByMode) this.host.settings.activeTemplateByMode = {};
    const clean = sanitizePromptTemplate(tpl, mode);
    this.host.settings.promptTemplates[clean.id] = clean;
    this.host.settings.activeTemplateByMode[clean.id] = clean.id;
    if (!opts || opts.activate !== false) this.host.settings.polishMode = clean.id;
    if (!this.host.settings.industryProfile) this.host.settings.industryProfile = createEmptyIndustryProfile();
    this.host.settings.industryProfile.generatedAt = new Date().toISOString();
    await this.host.saveSettings();
    return clean;
  }

  // 一站式入口：生成 + 入库 + 激活，由调用方决定是否走后台 queue
  async generateAndApplyIndustryPrompt(mode, options) {
    const promptText = await this.generateIndustryPromptForMode(mode);
    const tpl = await this.createIndustryPromptVariant(mode, promptText, options);
    return tpl;
  }
  // 旧入口保留：把历史批量生成结果转成新的自定义提示词，避免覆盖内置提示词
  async applyIndustryPrompts(prompts) {
    const created = [];
    const visible = getBuiltInVisiblePolishModeKeys(this.host.settings);
    for (const mode of visible) {
      const text = prompts && prompts[mode];
      if (!text) continue;
      try {
        const tpl = await this.createIndustryPromptVariant(mode, text);
        created.push(tpl);
      } catch (e) {
        console.error("[QnALog] createIndustryPromptVariant failed", mode, e);
      }
    }
    return created;
  }

  async extractVocabulary(merge) {
    const p = this.host.settings.industryProfile || createEmptyIndustryProfile();
    if (!this.host.settings.llmApiKey && !canOmitServiceApiKey(this.host.settings.llmEndpoint)) throw new Error("请先在 API 页配置大模型服务");
    const customPromptBrief = getCustomPromptModeTemplates(this.host.settings)
      .slice(0, 12)
      .map(t => `- ${t.name || t.id}: ${(t.prompt || t.description || "").replace(/\s+/g, " ").slice(0, 180)}`)
      .join("\n") || "（暂无自定义提示词）";
    const currentMode = getEffectivePolishMode(this.host.settings, this.host.settings.polishMode, "meeting");
    const currentMeta = getModeMeta(this.host.settings, currentMode);
    const sys = "你是 ASR 领域词汇提取助手。请根据用户的工作描述、常用提示词和 QnALog 使用场景，抽取最可能在录音中出现、ASR 容易识别错的专有词，并按固定类别输出。";
    const user = `【用户行业 / 角色】${p.industry || "（未指定）"}

【主要工作场景】
${p.scenarios || "（未指定）"}

【关注点】
${p.focus || "（未指定）"}

【当前默认提示词】
${currentMeta.prefix || currentMeta.label || currentMode}

【自定义提示词摘要】
${customPromptBrief}

【任务】
列出 30–80 个可能高频出现、且值得加入 ASR 热词表的专有词。若能推断出常见误写，也可以列出少量「易错写法 => 标准写法」。若用户背景为空，请根据当前默认提示词与自定义提示词推断；不要编造真实人名、真实公司或隐私信息，可以使用类别化占位词。
- 人名：客户、同事、专家、讲师、候选人、常用称呼
- 品牌/机构：公司、学校、客户、供应商、社区、品牌名
- 项目/产品：项目代号、产品名、模型名、系统名、服务名、插件名
- 行业术语：专业概念、业务流程词、缩写、英文混杂词
- 易错写法：只列非常确定的标准写法映射，例如 open router => OpenRouter；不要虚构真实姓名或真实公司
- 其他专有名词：暂时不好归类但 ASR 容易识别错的词

【输出格式】
严格只输出下面的 Markdown 结构；每行一个词，不加解释。某类没有词也保留标题。「易错写法」只允许使用“错误写法 => 标准写法”。

## 人名
- <词>

## 品牌/机构
- <词>

## 项目/产品
- <词>

## 行业术语
- <词>

## 易错写法
- <错误写法> => <标准写法>

## 其他专有名词
- <词>`;
    const result = await callLlm(this.host, sys, user);
    const cleaned = result
      .replace(/^```\w*\s*/, "")
      .replace(/\s*```\s*$/, "")
      .replace(/^好的[，,].*?\n/, "")
      .trim();
    let newGroups = parseVocabularyGroups(cleaned);
    let newTerms = flattenVocabularyGroups(newGroups);
    if (!newTerms.length) {
      newGroups = normalizeVocabularyInput(cleaned.split(/\r?\n/)
        .map((s) => s.replace(/^[\d\-*.、]+\s*/, "").replace(/^["「『]|["」』]$/g, "").trim())
        .filter(Boolean));
      newTerms = flattenVocabularyGroups(newGroups);
    }

    let finalGroups = newGroups;
    if (merge) {
      const existing = await loadVocabularyGroups(this.host);
      finalGroups = mergeVocabularyGroups(existing, newGroups);
    }
    await this.writeVocabularyFile(finalGroups);
    return newTerms;
  }

  async extractVocabularyFromMarkdown(file, markdown) {
    if (!this.host.settings.llmApiKey && !canOmitServiceApiKey(this.host.settings.llmEndpoint)) throw new Error("请先在 API 页配置大模型服务");
    const source = String(markdown || "")
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/m, "")
      .slice(0, 18000);
    const sys = "你是 ASR 领域词汇提取助手。请只根据用户当前笔记提取可能提升语音转写准确率的词汇，不要编造，不要输出非指定格式。";
    const user = `请从下面这篇 QnALog 笔记中提取适合加入 ASR 热词表的词汇。

文件名：${file && file.basename ? file.basename : "当前笔记"}

提取规则：
- 只提取笔记中真实出现、后续录音里可能反复出现、且 ASR 容易识别错的词。
- 专有名词优先：人名/称呼、品牌/机构、项目/产品、行业术语、英文缩写、中英混合词。
- 人名只提取姓名或常用称呼，不提取身份号码、手机号、住址、邮箱等隐私字段。
- 人员角色、组织关系和长期备注不要塞进 ASR 热词表；这些应进入人员资料。
- 「易错写法」只写非常确定的映射，例如 open router => OpenRouter。
- 不确定就不要提取。

输出格式：
严格只输出下面的 Markdown 结构；每行一个词，不加解释。某类没有词也保留标题。

## 人名
- <词>

## 品牌/机构
- <词>

## 项目/产品
- <词>

## 行业术语
- <词>

## 易错写法
- <错误写法> => <标准写法>

## 其他专有名词
- <词>

笔记正文：
${source}`;
    const result = await callLlm(this.host, sys, user, { timeoutMs: 60000 });
    const cleaned = result
      .replace(/^```\w*\s*/, "")
      .replace(/\s*```\s*$/, "")
      .replace(/^好的[，,].*?\n/, "")
      .trim();
    let newGroups = parseVocabularyGroups(cleaned);
    let newTerms = flattenVocabularyGroups(newGroups);
    if (!newTerms.length) {
      newGroups = normalizeVocabularyInput(cleaned.split(/\r?\n/)
        .map((s) => s.replace(/^[\d\-*.、]+\s*/, "").replace(/^["「『]|["」』]$/g, "").trim())
        .filter(Boolean));
      newTerms = flattenVocabularyGroups(newGroups);
    }
    if (!newTerms.length) return [];
    const existing = await loadVocabularyGroups(this.host);
    await this.writeVocabularyFile(mergeVocabularyGroups(existing, newGroups));
    return newTerms;
  }

  async writeVocabularyFile(terms) {
    const groups = normalizeVocabularyInput(terms);
    const path = this.host.settings.vocabularyFile;
    if (!path) {
      // 不再静默吞进隐藏的 customVocabulary：提示用户补路径，否则热词在设置里"看不见摸不着"
      this.host.settings.customVocabulary = flattenVocabularyGroups(groups).join("\n");
      await this.host.saveSettings();
      try { new obsidian.Notice("未配置热词表路径，本次热词已暂存在插件设置中；请在「设置 → 信息对象 → ASR 热词表」填写路径后重新整理。", 9000); } catch { /* intentionally empty */ }
      return null;
    }
    const norm = obsidian.normalizePath(path);
    const folderPath = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
    if (folderPath) await ensureVaultFolder(this.host.app, folderPath);
    const content = formatVocabularyMarkdown(groups, this.host.settings.industryProfile);
    let file = this.host.app.vault.getAbstractFileByPath(norm);
    if (file instanceof obsidian.TFile) {
      await this.host.app.vault.modify(file, content);
    } else {
      file = await this.host.app.vault.create(norm, content);
    }
    return file;
  }
  async extractVocabularyFromLibrary() {
    if (!this.host.settings.llmApiKey && !canOmitServiceApiKey(this.host.settings.llmEndpoint)) {
      new obsidian.Notice("请先配置大模型服务");
      return { processed: 0, added: 0, failed: 0, remaining: 0 };
    }
    const all = this.host.knowledgeExtraction.getKnowledgeExtractionSourceFiles("vocabulary");
    const batch = all.slice(0, KNOWLEDGE_EXTRACTION_BATCH_LIMIT);
    if (!batch.length) {
      new obsidian.Notice("没有需要扫描的新纪要。修改过的纪要会自动重新进入扫描。");
      return { processed: 0, added: 0, failed: 0, remaining: 0 };
    }
    new obsidian.Notice(`QnALog：正在扫描 ${batch.length} 篇纪要提取词汇…`);
    let processed = 0;
    let added = 0;
    let failed = 0;
    for (const file of batch) {
      try {
        const markdown = await this.host.app.vault.cachedRead(file);
        const terms = await this.extractVocabularyFromMarkdown(file, markdown);
        added += terms.length;
        processed++;
        this.host.knowledgeExtraction.markKnowledgeExtractionSource("vocabulary", file);
      } catch (e) {
        failed++;
        console.error("[QnALog] library vocabulary extraction failed", file && file.path, e);
      }
    }
    await this.host.saveSettings();
    return { processed, added, failed, remaining: Math.max(0, all.length - batch.length) };
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
