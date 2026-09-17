/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。
import type { PluginSettings } from "./types";
import { NS_ROOT } from "./namespace";

import { t } from "../shared/i18n";
export const DEFAULT_LIBRARY_PATHS = {
  vocabularyFile: `${NS_ROOT}/资料库/词汇表.md`,
  peopleDirectoryFolder: `${NS_ROOT}/资料库/人员`,
  peopleBaseFile: `${NS_ROOT}/资料库/视图/人员库.base`,
  todoCardsFolder: `${NS_ROOT}/资料库/待办`,
  basesFolder: `${NS_ROOT}/资料库/视图`,
  diagnosticsLogFolder: `${NS_ROOT}/系统/诊断日志`,
  archiveFolder: `${NS_ROOT}/资料库/归档`,
  duplicatePeopleArchiveFolder: `${NS_ROOT}/资料库/归档/重复人员`,
} as const;

export const DEFAULT_DAILY_MEETING_OVERVIEW_HEADING = "今日会议概要";

export const DEFAULT_DAILY_MEETING_OVERVIEW_TEMPLATE = [
  "### {{time}} · {{note_link}}",
  "> 模式：{{mode}} · 时长：{{duration}} · 分段：{{segments}} · 模型：{{model}}",
  "",
  "- 核心信息：{{summary}}",
  "",
  "{{todos_block}}",
].join("\n");

export const DEFAULT_SETTINGS: PluginSettings = {
  // 空串 = 跟随 Obsidian 界面语言（多数用户不会主动改插件语言）
  uiLanguage: "",
  audioFolder: `${NS_ROOT}/录音`,
  mdFolder: `${NS_ROOT}/转写纪要`,
  meetingMaterialsFolder: `${NS_ROOT}/会议资料`,
  htmlReportFolder: `${NS_ROOT}/HTML报告`,
  reportBrandName: "",  // seminar 报告页脚公司名；留空则用纪要里的「公司/」标签。报告不含 logo。
  noteFileNameFormatNew: "YYYY-MM-DD HHmm",

  // —— 转写：多 provider 注册表 ——
  transcribeEndpoint: "https://api.siliconflow.cn/v1/audio/transcriptions",  // 兼容字段（旧版 / 兜底）
  transcribeApiKey: "",
  transcribeModel: "FunAudioLLM/SenseVoiceSmall",
  transcribeLanguage: "auto",

  activeTranscribeProvider: "siliconflow",
  importTranscribeProvider: "dashscope-filetrans",
  importSpeakerDiarization: true,
  importSpeakerCount: 0,
  transcribeProviders: {
    siliconflow: {
      name: "SiliconFlow",
      endpoint: "https://api.siliconflow.cn/v1/audio/transcriptions",
      apiKey: "",
      model: "FunAudioLLM/SenseVoiceSmall",
      language: "auto",
      hint: t("Stable access in China, cheap. Moderate accuracy."),
    },
    openai: {
      name: t("OpenAI Official"),
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      apiKey: "",
      model: "gpt-4o-transcribe",
      language: "",
      hint: t("Chunked transcription. The accuracy ceiling. Strong at recognizing Chinese names/technical terms. Requires overseas network."),
    },
    "openai-diarize": {
      name: t("OpenAI · Speaker Diarization"),
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      apiKey: "",
      model: "gpt-4o-transcribe-diarize",
      language: "",
      protocol: "openai-diarized-transcription",
      hint: t("Recognized all at once after the entire recording finishes, with speaker labels. When transcription ends, speaker numbers can be mapped to real names."),
    },
    apimimo: {
      name: "APIMiMo V2.5 ASR",
      endpoint: "https://api.xiaomimimo.com/v1/chat/completions",
      apiKey: "",
      model: "mimo-v2.5-asr",
      language: "auto",
      protocol: "apimimo-chat-input-audio",
      hint: t("Xiaomi MiMo audio recognition. Chat Completions input_audio; the server accepts only wav/mp3 (other formats are transcoded and chunked automatically), each chunk's base64 ≤10MB; you can specify the language zh/en/auto for better accuracy."),
    },
    "openai-realtime": {
      name: t("OpenAI Realtime · Speech Transcription"),
      endpoint: "wss://api.openai.com/v1/realtime",
      apiKey: "",
      model: "gpt-realtime-whisper",
      language: "",
      hint: t("Streaming ASR, subtitles as you speak. $0.017/min ≈ ¥7.2/hour."),
    },
    "openai-realtime-translate": {
      name: t("OpenAI Realtime · Speech Translation"),
      endpoint: "wss://api.openai.com/v1/realtime/translations",
      apiKey: "",
      model: "gpt-realtime-translate",
      language: "",
      targetLanguage: "zh",
      hint: t("Streaming translation, 70+ inputs → 13 outputs. $0.034/min ≈ ¥14.4/hour."),
    },
    openrouter: {
      name: t("OpenRouter · Speech Transcription"),
      // 官方 STT 接口。OpenRouter 文档明确该端点同时接受 OpenAI 风格的 multipart/form-data，
      // 因此复用现有 OpenAI 兼容上传路径（file + model），无需新的协议分支。
      endpoint: "https://openrouter.ai/api/v1/audio/transcriptions",
      apiKey: "",
      model: "openai/whisper-large-v3",
      language: "",
      hint: t("Globally accessible; no account outside mainland China is needed to sign up; usage-based billing; multiple transcription models available."),
    },
    // 导入音频专用：OpenRouter 整文件转写 + 说话人分离。
    // 与 openrouter 分开成两个条目，因为二者请求形状不同（分段 multipart vs 整文件
    // JSON + provider.options），模型与计费也不同；用户在「说话人识别」里单独选。
    "openrouter-diarize": {
      name: t("OpenRouter · Speaker Diarization"),
      endpoint: "https://openrouter.ai/api/v1/audio/transcriptions",
      apiKey: "",
      model: "microsoft/mai-transcribe-2",
      language: "",
      protocol: "openrouter-diarize",
      hint: t("Whole-file transcription with speaker diarization. Which upstream a model routes to varies per model; the diarization switch is passed to that upstream. Speaker numbers can be mapped to real names after transcription."),
    },
    dashscope: {
      name: t("Alibaba Cloud Bailian Paraformer Realtime"),
      endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      apiKey: "",
      model: "paraformer-realtime-v2",
      language: "",
      hint: t("The cheapest streaming ASR in China, about ¥3.6/hour."),
    },
    // 录音转写的分段方案。与上面的 dashscope 条目是两条独立路径：
    // dashscope 走 WebSocket 实时识别，桌面可用、移动端不可用（移动端无法给 WebSocket 设鉴权头）；
    // 本条目走 HTTP 的 OpenAI 兼容 Chat Completions，桌面与移动端都能用。
    // 一站式快速配置选的是这一条，原因是移动端也要能跑通。
    "dashscope-chat": {
      name: "阿里云百炼 Qwen3-ASR Flash",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "",
      model: "qwen3-asr-flash",
      language: "",
      protocol: "dashscope-chat-input-audio",
      hint: t("Bailian Qwen3-ASR Flash. HTTP interface that works on both desktop and mobile; audio is uploaded segment by segment (up to 5 minutes and 10MB per request; longer recordings are converted and split automatically)."),
    },
    "dashscope-filetrans": {
      name: t("Alibaba Cloud Bailian Fun-ASR"),
      endpoint: "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
      apiKey: "",
      model: "fun-asr",
      language: "zh",
      protocol: "dashscope-filetrans",
      hint: t("For imported audio only. Whole-file asynchronous transcription with speaker diarization; standard transcription up to 12 hours, and no more than 2 hours recommended when speaker diarization is enabled."),
    },
    custom: {
      name: t("Other transcription services"),
      endpoint: "",
      apiKey: "",
      model: "",
      language: "",
      hint: t("Suitable for enterprise internal gateways, self-hosted transcription services, or third-party transcription services."),
    },
    local: {
      name: t("Local transcription service"),
      endpoint: "http://127.0.0.1:8000/v1/audio/transcriptions",
      apiKey: "",
      model: "whisper-large-v3",
      language: "zh",
      hint: t("Suitable for local services such as Xinference, faster-whisper-server, and whisper.cpp; it must accept audio file uploads and return text."),
    },
    whisperx: {
      name: t("WhisperX · Speaker Diarization (local)"),
      endpoint: "http://127.0.0.1:8000/v1/audio/transcriptions",
      apiKey: "",
      model: "whisper-large-v3",
      language: "zh",
      protocol: "speaker-diarization",
      hint: t("Local WhisperX / whisper-diarization service: speaker diarization is done alongside transcription. The service must return segments[].speaker in its response (or inline [SPEAKER_00] in text), and Q&A Log normalizes it to [Speaker N] automatically. Note: speaker numbering is only consistent throughout for whole-file imported audio; in segmented mode that records and splits as it goes, numbering may not match across segments."),
    },
  },

  llmEndpoint: "https://api.siliconflow.cn/v1/chat/completions",
  llmApiKey: "",
  llmModel: "",
  llmServicePreset: "siliconflow",
  // 已保存的 LLM 配置库（含密钥），切换时无需重输。便利层：
  // 选配置 → 把 endpoint/apiKey/model 灌进上面三个工作字段；编辑工作字段 → 回写当前配置。
  // 所有调用大模型的代码仍只读 llmEndpoint/llmApiKey/llmModel，不受影响。
  llmProfiles: [],           // [{ id, name, endpoint, apiKey, model }]
  activeLlmProfile: "",      // 当前选中的配置 id；空 = 未保存为配置（临时）

  polishMode: "synthesis",
  polishPromptInterview: "",
  polishPromptMeeting: "",
  polishPromptHuddle: "",
  polishPromptSeminar: "",
  polishPromptMonologue: "",
  polishPromptLearning: "",

  // 提示词管理：内置提示词负责稳定底稿，自定义提示词负责用户自己的 Prompt 规则
  promptTemplates: {},  // { [id]: { id, mode, name, description, baseMode, prompt, customMode, createdAt, updatedAt } }
  activeTemplateByMode: {},  // 现行主键：mode → 当前启用模板 id；空 = 使用内置默认

  // 结构化程度：loose（散文为主）/ balanced（散文+列表，推荐）/ strict（多层嵌套列表）
  briefingStructureLevel: "balanced",
  repolishPreferencePromptAddendum: "",
  // 右键"重新整理为"时记住的偏好修饰（detailed/concise/structured/natural/expanded 或 ""=不加偏好）。
  repolishPreference: "",
  // 思考档：auto=默认（不动请求）/ reasoning=显式开思维链 / fast=关思维链省 token（仅对可控服务生效，见 llm/thinking.ts）。
  thinkingMode: "auto",

  briefingTranslationMode: "off",
  briefingTargetLanguage: "zh-CN",
  briefingCustomLanguage: "",
  briefingKeepOriginalTerms: true,
  briefingLanguageInstruction: "",

  industryProfile: {
    industry: "",
    scenarios: "",
    focus: "",
    outputPreference: "",
    generatedAt: null,
  },

  customVocabulary: "",
  vocabularyFile: DEFAULT_LIBRARY_PATHS.vocabularyFile,
  peopleDirectoryFolder: DEFAULT_LIBRARY_PATHS.peopleDirectoryFolder,
  peopleBaseFile: DEFAULT_LIBRARY_PATHS.peopleBaseFile,
  todoCardsFolder: DEFAULT_LIBRARY_PATHS.todoCardsFolder,
  sedimentAutoExtract: false,  // 默认关闭：转写完成不自动沉淀，手动点「沉淀」再扫描（省 token）；开启则转写完成后自动扫描并入库

  basesFolder: DEFAULT_LIBRARY_PATHS.basesFolder,
  peopleContextMode: "privacy",
  peopleHotwordsConsentAt: "",
  peopleSuggestionIgnores: [],
  peopleSuggestionCache: { pending: [] },
  knowledgeExtractionHistory: { vocabulary: {}, people: {} },

  inboxFolder: "",
  inboxAutoImport: true,
  inboxArchiveSubfolder: "processed",
  inboxStabilizeDelayMs: 3000,

  enableInterimOutput: true,
  segmentIntervalMinutes: 5,
  asrConcurrency: 1,
  segmentCacheFolder: `${NS_ROOT}/.cache/segments`,
  keepSegmentAudioFiles: false,
  filterShortRecordings: true,

  captureMode: "mic",
  audioChannelMode: "auto", // 自动：多声道设备保留声道，普通单声道麦克风继续使用语音增强
  selectedVirtualDevice: "",  // 用户指定的虚拟声卡 deviceId；空 = 拒绝录制并提示用户选择，插件不自动挑选设备
  selectedMicrophoneDevice: "", // 用户指定的麦克风 deviceId；空 = 使用系统默认输入（非插件挑选），选定设备不可用时直接报错不回退

  enableRealtimeOutline: true,
  realtimeOutlineDebounceMs: 2500, // 读取点有 2500 下限，低于无效
  autoOpenOutlineOnRecord: true,

  autoRenameWithTitle: true,
  consolidatedLayout: true,

  maxRetries: 3,
  diagnosticsLogEnabled: true,
  diagnosticsLogFolder: DEFAULT_LIBRARY_PATHS.diagnosticsLogFolder,

  showFloatingBall: true,
  bubbleSize: "large",  // 悬浮气泡大小：large / medium / small
  floatingBallPos: { left: 60, top: 120 },
  autoOpenNoteAfterFinish: true,
  autoOpenHtmlReportAfterGenerate: true,
  writeDailyMeetingOverview: true,
  dailyMeetingOverviewHeading: DEFAULT_DAILY_MEETING_OVERVIEW_HEADING,
  dailyMeetingOverviewTemplate: DEFAULT_DAILY_MEETING_OVERVIEW_TEMPLATE,

  autoCheckUpdates: true,
  lastUpdateCheckAt: null,
  availableUpdate: null,
  lastUpdateError: "",
  installedUpdateVersion: "",
};

export type { PluginSettings } from "./types";
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
