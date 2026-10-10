/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。
import type { PluginSettings } from "./types";
import { NS_ROOT } from "./namespace";
import { getActiveUiLanguage } from "./i18n";

/**
 * 默认目录名的分语言写法。目录名会写进用户的知识库，属于数据层。
 *
 * 只有中英两套：界面语言是中文就用中文目录，其余语言（含 Obsidian 的其他语言）
 * 按 i18n 的规则回退英文。新装插件时按当时的语言选一次；用户之后改语言不会搬动
 * 已建好的目录，落盘的路径也始终优先于默认值（settings-io 的 normalize 用保存值兜底）。
 *
 * 这些值一律用取值器（getter）在读取时计算，不写成常量：常量在模块导入那一刻求值，
 * 而界面语言要到 onload 才确定，用常量会把所有用户的目录冻成同一种语言。
 * 同一条约定见 tests/i18n-bare-cjk.test.ts「语言在渲染时求值」。
 */
export interface DefaultFolderNames {
  audio: string;
  notes: string;
  meetingMaterials: string;
  htmlReports: string;
  library: string;
  glossary: string;
  people: string;
  views: string;
  peopleBase: string;
  todos: string;
  archive: string;
  duplicatePeople: string;
  system: string;
  diagnosticsLog: string;
  emailDrafts: string;
  emailAttachments: string;
}

const FOLDER_NAMES: Record<"zh" | "en", DefaultFolderNames> = {
  zh: {
    audio: "录音",
    notes: "转写纪要",
    meetingMaterials: "会议资料",
    htmlReports: "HTML报告",
    library: "资料库",
    glossary: "词汇表.md",
    people: "人员",
    views: "视图",
    peopleBase: "人员库.base",
    todos: "待办",
    archive: "归档",
    duplicatePeople: "重复人员",
    system: "系统",
    diagnosticsLog: "诊断日志",
    emailDrafts: "邮件草稿",
    emailAttachments: "附件",
  },
  en: {
    audio: "Recordings",
    notes: "Transcribed notes",
    meetingMaterials: "Meeting materials",
    htmlReports: "HTML reports",
    library: "Library",
    glossary: "Glossary.md",
    people: "People",
    views: "Views",
    peopleBase: "People.base",
    todos: "Todos",
    archive: "Archive",
    duplicatePeople: "Duplicate people",
    system: "System",
    diagnosticsLog: "Diagnostics log",
    emailDrafts: "Email drafts",
    emailAttachments: "Attachments",
  },
};

/** 由目录名拼出的默认路径，键名与设置键同名（邮件草稿两个键不属于设置）。 */
export interface DefaultFolderPaths {
  audioFolder: string;
  mdFolder: string;
  meetingMaterialsFolder: string;
  htmlReportFolder: string;
  vocabularyFile: string;
  peopleDirectoryFolder: string;
  peopleBaseFile: string;
  todoCardsFolder: string;
  basesFolder: string;
  archiveFolder: string;
  duplicatePeopleArchiveFolder: string;
  diagnosticsLogFolder: string;
  emailDraftFolder: string;
  emailDraftAttachmentFolder: string;
}

const FOLDER_PATHS = new Map<string, DefaultFolderPaths>();

/** 当前界面语言的默认目录路径；按语言各算一次，语言切换后取到的是新值。 */
export function defaultFolderPaths(): DefaultFolderPaths {
  const langId = getActiveUiLanguage().id === "zh" ? "zh" : "en";
  const cached = FOLDER_PATHS.get(langId);
  if (cached) return cached;
  const n = FOLDER_NAMES[langId];
  const paths: DefaultFolderPaths = {
    audioFolder: `${NS_ROOT}/${n.audio}`,
    mdFolder: `${NS_ROOT}/${n.notes}`,
    meetingMaterialsFolder: `${NS_ROOT}/${n.meetingMaterials}`,
    htmlReportFolder: `${NS_ROOT}/${n.htmlReports}`,
    vocabularyFile: `${NS_ROOT}/${n.library}/${n.glossary}`,
    peopleDirectoryFolder: `${NS_ROOT}/${n.library}/${n.people}`,
    peopleBaseFile: `${NS_ROOT}/${n.library}/${n.views}/${n.peopleBase}`,
    todoCardsFolder: `${NS_ROOT}/${n.library}/${n.todos}`,
    basesFolder: `${NS_ROOT}/${n.library}/${n.views}`,
    archiveFolder: `${NS_ROOT}/${n.library}/${n.archive}`,
    duplicatePeopleArchiveFolder: `${NS_ROOT}/${n.library}/${n.archive}/${n.duplicatePeople}`,
    diagnosticsLogFolder: `${NS_ROOT}/${n.system}/${n.diagnosticsLog}`,
    emailDraftFolder: `${NS_ROOT}/${n.emailDrafts}`,
    emailDraftAttachmentFolder: `${NS_ROOT}/${n.emailDrafts}/${n.emailAttachments}`,
  };
  FOLDER_PATHS.set(langId, paths);
  return paths;
}

/** 资料库与诊断日志的默认路径；读取时按当前界面语言取值（键集合不变）。 */
export type DefaultLibraryPathKey =
  | "vocabularyFile" | "peopleDirectoryFolder" | "peopleBaseFile" | "todoCardsFolder"
  | "basesFolder" | "diagnosticsLogFolder" | "archiveFolder" | "duplicatePeopleArchiveFolder";

export const DEFAULT_LIBRARY_PATHS: Record<DefaultLibraryPathKey, string> = {
  get vocabularyFile() { return defaultFolderPaths().vocabularyFile; },
  get peopleDirectoryFolder() { return defaultFolderPaths().peopleDirectoryFolder; },
  get peopleBaseFile() { return defaultFolderPaths().peopleBaseFile; },
  get todoCardsFolder() { return defaultFolderPaths().todoCardsFolder; },
  get basesFolder() { return defaultFolderPaths().basesFolder; },
  get diagnosticsLogFolder() { return defaultFolderPaths().diagnosticsLogFolder; },
  get archiveFolder() { return defaultFolderPaths().archiveFolder; },
  get duplicatePeopleArchiveFolder() { return defaultFolderPaths().duplicatePeopleArchiveFolder; },
};

export const DEFAULT_SETTINGS: PluginSettings = {
  // 空串表示尚未生成本知识库的 SecretStorage 命名空间；loadAll 会生成随机值。
  apiKeyStorageNamespace: "",
  // 空串 = 跟随 Obsidian 界面语言（多数用户不会主动改插件语言）
  uiLanguage: "",
  // 目录默认值按界面语言取，读取时求值，原因见文件头注释
  get audioFolder() { return defaultFolderPaths().audioFolder; },
  get mdFolder() { return defaultFolderPaths().mdFolder; },
  get meetingMaterialsFolder() { return defaultFolderPaths().meetingMaterialsFolder; },
  get htmlReportFolder() { return defaultFolderPaths().htmlReportFolder; },
  reportBrandName: "",  // seminar 报告页脚公司名；留空则用纪要里的「公司/」标签。报告不含 logo。
  noteFileNameFormatNew: "YYYY-MM-DD HHmm",

  // —— 转写：多 provider 注册表 ——
  transcribeEndpoint: "https://api.siliconflow.cn/v1/audio/transcriptions",  // 兼容字段（旧版 / 兜底）
  transcribeApiKey: "",
  transcribeModel: "FunAudioLLM/SenseVoiceSmall",
  transcribeLanguage: "auto",

  activeTranscribeProvider: "siliconflow",
  importTranscribeProvider: "dashscope-filetrans",
  // 说话人识别是可选项：默认不启用；带说话人识别模型的预设（百炼 / OpenRouter）或用户自己再打开。
  importSpeakerDiarization: false,
  importSpeakerCount: 0,
  transcribeProviders: {
    siliconflow: {
      name: "SiliconFlow",
      endpoint: "https://api.siliconflow.cn/v1/audio/transcriptions",
      apiKey: "",
      model: "FunAudioLLM/SenseVoiceSmall",
      language: "auto",
      hint: "Stable access in China, cheap. Moderate accuracy.",
    },
    openai: {
      name: "OpenAI Official",
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      apiKey: "",
      model: "gpt-4o-transcribe",
      language: "",
      hint: "Chunked transcription. The accuracy ceiling. Strong at recognizing Chinese names/technical terms. Requires overseas network.",
    },
    "openai-diarize": {
      name: "OpenAI · Speaker Diarization",
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      apiKey: "",
      model: "gpt-4o-transcribe-diarize",
      language: "",
      protocol: "openai-diarized-transcription",
      hint: "Recognized all at once after the entire recording finishes, with speaker labels. When transcription ends, speaker numbers can be mapped to real names.",
    },
    apimimo: {
      name: "APIMiMo V2.5 ASR",
      endpoint: "https://api.xiaomimimo.com/v1/chat/completions",
      apiKey: "",
      model: "mimo-v2.5-asr",
      language: "auto",
      protocol: "apimimo-chat-input-audio",
      hint: "Xiaomi MiMo audio recognition. Chat Completions input_audio; the server accepts only wav/mp3 (other formats are transcoded and chunked automatically), each chunk's base64 ≤10MB; you can specify the language zh/en/auto for better accuracy.",
    },
    "openai-realtime": {
      name: "OpenAI Realtime · Speech Transcription",
      endpoint: "wss://api.openai.com/v1/realtime",
      apiKey: "",
      model: "gpt-realtime-whisper",
      language: "",
      hint: "Streaming ASR, subtitles as you speak. $0.017/min ≈ ¥7.2/hour.",
    },
    "openai-realtime-translate": {
      name: "OpenAI Realtime · Speech Translation",
      endpoint: "wss://api.openai.com/v1/realtime/translations",
      apiKey: "",
      model: "gpt-realtime-translate",
      language: "",
      targetLanguage: "zh",
      hint: "Streaming translation, 70+ inputs → 13 outputs. $0.034/min ≈ ¥14.4/hour.",
    },
    openrouter: {
      name: "OpenRouter · Speech Transcription",
      // 官方 STT 接口。OpenRouter 文档明确该端点同时接受 OpenAI 风格的 multipart/form-data，
      // 因此复用现有 OpenAI 兼容上传路径（file + model），无需新的协议分支。
      endpoint: "https://openrouter.ai/api/v1/audio/transcriptions",
      apiKey: "",
      model: "openai/whisper-large-v3",
      language: "",
      hint: "Globally accessible; no account outside mainland China is needed to sign up; usage-based billing; multiple transcription models available.",
    },
    // 导入音频专用：OpenRouter 整文件转写 + 说话人分离。
    // 与 openrouter 分开成两个条目，因为二者请求形状不同（分段 multipart vs 整文件
    // JSON + provider.options），模型与计费也不同；用户在「说话人识别」里单独选。
    "openrouter-diarize": {
      name: "OpenRouter · Speaker Diarization",
      endpoint: "https://openrouter.ai/api/v1/audio/transcriptions",
      apiKey: "",
      model: "microsoft/mai-transcribe-2",
      language: "",
      protocol: "openrouter-diarize",
      hint: "Whole-file transcription with speaker diarization. Which upstream a model routes to varies per model; the diarization switch is passed to that upstream. Speaker numbers can be mapped to real names after transcription.",
    },
    dashscope: {
      name: "Alibaba Cloud Bailian Qwen-Audio-3.1-ASR-Flash Streaming",
      endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      apiKey: "",
      model: "qwen-audio-3.1-asr-flash-streaming",
      language: "",
      hint: "Optional desktop-only real-time transcription over DashScope WebSocket. Check Bailian pricing for the configured region.",
    },
    // This native HTTP protocol is separate from the legacy Qwen3 Chat Completions entry below.
    "dashscope-flash": {
      name: "Alibaba Cloud Bailian Qwen-Audio-3.1-ASR-Flash",
      endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      apiKey: "",
      model: "qwen-audio-3.1-asr-flash",
      language: "",
      protocol: "dashscope-flash-input-audio",
      hint: "Native HTTP transcription for desktop and mobile. QnALog uses a 10 MB Base64 upload budget and converts long recordings into 3-minute WAV chunks.",
    },
    // Legacy Qwen3 Chat Completions remains available for existing and manually selected configurations.
    "dashscope-chat": {
      name: "Alibaba Cloud Bailian Qwen3-ASR Flash (legacy Chat API)",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "",
      model: "qwen3-asr-flash",
      language: "",
      protocol: "dashscope-chat-input-audio",
      hint: "Legacy Qwen3-ASR Flash Chat Completions API. Do not use qwen-audio-3.1-asr-flash with this endpoint.",
    },
    "dashscope-filetrans": {
      name: "Alibaba Cloud Bailian Qwen-Audio-3.1-ASR-Flash-Filetrans",
      endpoint: "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
      apiKey: "",
      model: "qwen-audio-3.1-asr-flash-filetrans",
      language: "zh",
      protocol: "dashscope-filetrans",
      hint: "For imported audio only. Whole-file asynchronous transcription with speaker diarization; standard transcription supports up to 12 hours, and no more than 2 hours is recommended when diarization is enabled.",
    },
    custom: {
      name: "Other transcription services",
      endpoint: "",
      apiKey: "",
      model: "",
      language: "",
      hint: "Suitable for enterprise internal gateways, self-hosted transcription services, or third-party transcription services.",
    },
    local: {
      name: "Local transcription service",
      endpoint: "http://127.0.0.1:8000/v1/audio/transcriptions",
      apiKey: "",
      model: "whisper-large-v3",
      language: "zh",
      hint: "Suitable for local services such as Xinference, faster-whisper-server, and whisper.cpp; it must accept audio file uploads and return text.",
    },
    whisperx: {
      name: "WhisperX · Speaker Diarization (local)",
      endpoint: "http://127.0.0.1:8000/v1/audio/transcriptions",
      apiKey: "",
      model: "whisper-large-v3",
      language: "zh",
      protocol: "speaker-diarization",
      hint: "Local WhisperX / whisper-diarization service: speaker diarization is done alongside transcription. The service must return segments[].speaker in its response (or inline [SPEAKER_00] in text), and QnALog normalizes it to [Speaker N] automatically. Note: speaker numbering is only consistent throughout for whole-file imported audio; in segmented mode that records and splits as it goes, numbering may not match across segments.",
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

  polishMode: "general",
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
  get vocabularyFile() { return defaultFolderPaths().vocabularyFile; },
  get peopleDirectoryFolder() { return defaultFolderPaths().peopleDirectoryFolder; },
  get peopleBaseFile() { return defaultFolderPaths().peopleBaseFile; },
  get todoCardsFolder() { return defaultFolderPaths().todoCardsFolder; },
  sedimentAutoExtract: false,  // 默认关闭：转写完成不自动沉淀，手动点「沉淀」再扫描（省 token）；开启则转写完成后自动扫描并入库

  get basesFolder() { return defaultFolderPaths().basesFolder; },
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
  // 用户点过「稍后设置」或关闭过首次配置向导后不再自动弹；首页的向导按钮不受它控制
  setupWizardDismissed: false,

  autoRenameWithTitle: true,
  consolidatedLayout: true,

  maxRetries: 3,
  diagnosticsLogEnabled: true,
  get diagnosticsLogFolder() { return defaultFolderPaths().diagnosticsLogFolder; },

  showFloatingBall: true,
  bubbleSize: "large",  // 悬浮气泡大小：large / medium / small
  floatingBallPos: { left: 60, top: 120 },
  autoOpenNoteAfterFinish: true,
  autoOpenHtmlReportAfterGenerate: true,

  lastUpdateCheckAt: null,
  availableUpdate: null,
  lastUpdateError: "",
  installedUpdateVersion: "",
};

export type { PluginSettings } from "./types";
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
