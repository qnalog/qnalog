/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：转写服务配置解析：内置服务条目、协议、模型与说话人分离能力判定

import type { LexVoiceSettings } from "../shared/types";

/** TranscribeProfileService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface TranscribeProfileHost {
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: LexVoiceSettings;
}

export class TranscribeProfileService {
  declare host: TranscribeProfileHost;
  constructor(host) {
    this.host = host;
  }


  getTranscribeProviderProfile(id, provider) {
    const profiles = {
      siliconflow: {
        title: "硅基流动",
        badge: "云端转写",
        transcribeMode: "segmented",
        requiresKey: true,
        endpointPlaceholder: "https://api.siliconflow.cn/v1/audio/transcriptions",
        modelPlaceholder: "FunAudioLLM/SenseVoiceSmall",
        languagePlaceholder: "auto",
        endpointHelp: "硅基流动的音频转写服务地址。通常保持默认即可。",
        keyHelp: "从硅基流动控制台复制访问密钥。密钥以混淆（非加密）形式保存在本库的插件设置文件中，不会上传；请勿把整个库文件夹同步或分享给不信任的对象。",
        modelHelp: "推荐 FunAudioLLM/SenseVoiceSmall。延迟低，支持 50+ 语种，中文和粤语识别表现较好。",
        description: "OpenAI 兼容的音频转写接口。QnALog 会按设定的分段间隔切段上传。",
        priceHint: "FunAudioLLM/SenseVoiceSmall 目前在硅基流动免费且不限用量；平台规则可能调整，以硅基流动控制台为准。",
        steps: ["注册或登录硅基流动账号", "在控制台创建访问密钥", "确认服务地址和模型名称后运行连通性测试"],
        links: [
          ["访问密钥", "https://cloud.siliconflow.cn/account/ak"],
          ["转写文档", "https://docs.siliconflow.cn/cn/api-reference/audio/create-audio-transcriptions"],
        ],
      },
      openai: {
        title: "OpenAI（切片转写）",
        badge: "云端转写",
        transcribeMode: "segmented",
        requiresKey: true,
        endpointPlaceholder: "https://api.openai.com/v1/audio/transcriptions",
        modelPlaceholder: "gpt-4o-transcribe",
        languagePlaceholder: "",
        endpointHelp: "OpenAI 的音频转写服务地址。需要可访问 OpenAI API 的网络环境。",
        keyHelp: "填写 OpenAI 项目的访问密钥。",
        modelHelp: "推荐 gpt-4o-transcribe（HTTP 切片）。需要边说边出字幕时，可改用「OpenAI Realtime · 语音转写」。",
        description: "OpenAI 兼容的音频转写接口。QnALog 会按设定的分段间隔切段上传。",
        priceHint: "按音频用量计费（官方价 $6/百万音频 token），以 OpenAI 定价页为准。",
        steps: ["确认 OpenAI API 账户可用", "填写访问密钥", "运行连通性测试"],
        links: [["OpenAI 密钥", "https://platform.openai.com/api-keys"]],
      },
      "openai-diarize": {
        title: "OpenAI · 说话人分离",
        badge: "说话人分离",
        transcribeMode: "segmented",
        speakerDiarization: true,
        speakerLabelScope: "session",
        requiresWholeSession: true,
        requiresKey: true,
        endpointPlaceholder: "https://api.openai.com/v1/audio/transcriptions",
        modelPlaceholder: "gpt-4o-transcribe-diarize",
        languagePlaceholder: "",
        endpointHelp: "OpenAI 的音频转写服务地址。需要可访问 OpenAI API 的网络环境。",
        keyHelp: "填写 OpenAI 项目的访问密钥。",
        modelHelp: "使用 gpt-4o-transcribe-diarize。该模型会返回带时间和说话人标签的分段结果。",
        description: "停止录音后统一识别整场音频，以保持说话人编号在本场录音内一致。识别完成后可确认每个编号对应的姓名，再进入 AI 整理。",
        priceHint: "按音频用量计费，以 OpenAI 定价页为准。",
        steps: ["确认 OpenAI API 账户可用", "填写访问密钥", "运行连通性测试", "停止录音后确认说话人姓名"],
        links: [
          ["OpenAI 密钥", "https://platform.openai.com/api-keys"],
          ["说话人分离文档", "https://platform.openai.com/docs/api-reference/audio/createTranscription"],
        ],
        note: "为避免不同切片中的说话人编号重置，录音过程中不会分段上传；停止后才统一转写。原始逐字稿保留说话人编号，姓名映射用于 AI 整理。",
      },
      "dashscope-filetrans": {
        title: "阿里云百炼 Fun-ASR",
        badge: "长音频 · 说话人分离",
        transcribeMode: "whole-file",
        speakerDiarization: true,
        speakerLabelScope: "session",
        requiresWholeSession: true,
        requiresKey: true,
        endpointPlaceholder: "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
        modelPlaceholder: "fun-asr",
        languagePlaceholder: "zh",
        endpointHelp: "阿里云百炼录音文件识别接口，通常保持默认即可。",
        keyHelp: "填写阿里云百炼 API Key。音频会临时上传到阿里云并异步识别。",
        modelHelp: "推荐 fun-asr。支持整文件转写和说话人分离。",
        description: "导入音频专用。QnALog 直接提交整段音频，不在本地切成多个 ASR 任务。",
        priceHint: "普通录音文件识别最长支持 12 小时；启用说话人分离时，官方建议单文件不超过 2 小时。",
        steps: ["在百炼控制台创建 API Key", "保持默认服务地址和模型名", "运行连接测试", "在导入音频后确认说话人姓名"],
        links: [
          ["访问密钥", "https://help.aliyun.com/zh/model-studio/developer-reference/get-api-key"],
          ["录音文件识别文档", "https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide"],
        ],
        note: "整文件转写不会生成实时大纲。超过 2 小时仍可提交，但说话人分离的准确度可能下降。",
      },
      apimimo: {
        title: "APIMiMo V2.5 ASR",
        badge: "云端转写",
        transcribeMode: "segmented",
        requiresKey: true,
        endpointPlaceholder: "https://api.xiaomimimo.com/v1/chat/completions",
        modelPlaceholder: "mimo-v2.5-asr",
        languagePlaceholder: "auto / zh / en",
        languageHelp: "留空或 auto 自动检测；明确语种时填 zh（中文，含粤语、吴语、闽南话、四川话等方言）或 en（英文）可提升准确率。其它值会按 auto 处理。",
        endpointHelp: "小米 MiMo 的服务地址，保持默认即可。QnALog 会按 MiMo 要求的专用格式发送音频，与其他转写服务不同，无需手动调整。",
        keyHelp: "填写小米 MiMo 平台的访问密钥（API Key）。密钥以混淆（非加密）形式保存在本库的插件设置文件中，不会上传。",
        modelHelp: "固定使用 mimo-v2.5-asr。该服务只接受 wav/mp3、单段约 7.5MB 以内的音频；其他格式或更长的录音会由 QnALog 自动转换、切段后上传，无需手动处理。",
        description: "APIMiMo-V2.5-ASR 通过 OpenAI 兼容 Chat Completions 的 input_audio 识别音频。服务端只收 wav/mp3：选用本服务时 QnALog 会以 WebM/Opus 录音并在本机转成 WAV 分块上传；wav/mp3 文件未超限则直接发送。",
        priceHint: "按 MiMo 平台计费。大小限制由 QnALog 自动处理：超限录音会按约 3 分钟自动切块上传，无需手动干预。",
        steps: ["在小米 MiMo 平台创建 API Key", "保持默认服务地址和模型名", "运行连通性测试"],
        links: [["MiMo ASR 文档", "https://platform.xiaomimimo.com/docs/zh-CN/api/audio/Speech-Recognition"]],
        note: "此服务不支持热词参数；QnALog 会在转写结果返回后做本地热词纠错。在上方「识别语言」填 zh 或 en 可提升准确率。注意：此前用其他服务录制的 m4a/mp4 录音无法用本服务重新转写（仅影响重转写，新录音不受影响），如需重转写请临时切回原服务。",
      },
      "openai-realtime": {
        title: "OpenAI Realtime · 语音转写",
        badge: "流式实时",
        transcribeMode: "streaming",
        streamProtocol: "openai-realtime-transcription",
        requiresKey: true,
        endpointPlaceholder: "wss://api.openai.com/v1/realtime",
        modelPlaceholder: "gpt-realtime-whisper",
        languagePlaceholder: "（可留空，自动检测）",
        endpointHelp: "OpenAI Realtime 的 WebSocket 地址。保持默认即可。",
        keyHelp: "OpenAI 项目的访问密钥（与切片转写共用同一把 Key）。",
        modelHelp: "推荐 gpt-realtime-whisper（流式 ASR，专为实时字幕/会议记录设计）。",
        description: "流式转写，边说边出文字。QnALog 跳过分段切片，整场录音与服务保持一条实时连线，延迟约半秒以内。",
        priceHint: "gpt-realtime-whisper ≈ $0.017 / 分钟 ≈ ¥7.2 / 小时。",
        steps: ["确认 OpenAI API 账户可用且能访问 Realtime API", "填写访问密钥", "保持模型名 gpt-realtime-whisper", "选「仅麦克风」捕获模式开始录音"],
        links: [
          ["OpenAI 密钥", "https://platform.openai.com/api-keys"],
          ["Realtime 文档", "https://developers.openai.com/api/docs/guides/realtime-transcription"],
        ],
        note: "流式模式下「分段间隔」「即时分段」设置不生效；笔记会在录音过程中实时追加文字。",
      },
      "openai-realtime-translate": {
        title: "OpenAI Realtime · 语音翻译",
        badge: "流式翻译",
        transcribeMode: "streaming",
        streamProtocol: "openai-realtime-translation",
        requiresKey: true,
        endpointPlaceholder: "wss://api.openai.com/v1/realtime/translations",
        modelPlaceholder: "gpt-realtime-translate",
        languagePlaceholder: "",
        endpointHelp: "OpenAI Realtime Translations 的 WebSocket 基础地址。模型名会自动追加为查询参数。",
        keyHelp: "OpenAI 项目的访问密钥。",
        modelHelp: "推荐 gpt-realtime-translate（70+ 语言输入 → 13 语言输出，由专业口译员录音训练）。",
        description: "流式语音翻译。自动检测说话者语言，实时输出译文+原文双轨笔记。模型同时返回译音流（QnALog 自动丢弃，仅保留文字）。",
        priceHint: "gpt-realtime-translate ≈ $0.034 / 分钟 ≈ ¥14.4 / 小时。",
        steps: [
          "确认 OpenAI API 账户可用且能访问 Realtime API",
          "填写访问密钥",
          "在「目标语言」中选择需要的输出语言",
          "选「仅麦克风」捕获模式开始录音",
        ],
        links: [
          ["OpenAI 密钥", "https://platform.openai.com/api-keys"],
          ["Realtime 翻译文档", "https://developers.openai.com/api/docs/guides/realtime-translation"],
        ],
        note: "支持的目标语言：英语 (en)、中文 (zh)、日语 (ja)、韩语 (ko)、法语 (fr)、西班牙语 (es)、德语 (de)、意大利语 (it)、葡萄牙语 (pt)、俄语 (ru)、阿拉伯语 (ar)、印地语 (hi)、土耳其语 (tr)。",
        showTargetLanguage: true,
      },
      dashscope: {
        title: "阿里云百炼 Paraformer Realtime",
        badge: "流式实时",
        transcribeMode: "streaming",
        streamProtocol: "dashscope-ws",
        requiresKey: true,
        endpointPlaceholder: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
        modelPlaceholder: "paraformer-realtime-v2",
        languagePlaceholder: "",
        endpointHelp: "Paraformer Realtime 的 WebSocket 地址。保持默认即可。",
        keyHelp: "填写百炼控制台创建的访问密钥（API Key）。密钥以混淆（非加密）形式保存在本库的插件设置文件中，不会上传。",
        modelHelp: "推荐 paraformer-realtime-v2（中英混合）；电话场景可用 paraformer-realtime-8k-v2。",
        description: "流式转写，边说边出文字。QnALog 跳过分段切片，整场录音与服务保持一条实时连线，延迟约半秒以内。无需中转。",
        priceHint: "Paraformer Realtime ≈ ¥3.6 / 小时（国内最便宜）。",
        steps: ["在百炼控制台创建 API Key", "保持默认服务地址和模型名", "选「仅麦克风」捕获模式，开始录音即可"],
        links: [
          ["访问密钥", "https://help.aliyun.com/zh/model-studio/developer-reference/get-api-key"],
          ["Paraformer Realtime 文档", "https://help.aliyun.com/zh/model-studio/paraformer-realtime-api"],
        ],
        note: "流式模式下「分段间隔」「即时分段」设置不生效；笔记会在录音过程中实时追加文字。",
      },
      local: {
        title: "本地转写服务",
        badge: "本地服务",
        transcribeMode: "segmented",
        requiresKey: false,
        endpointPlaceholder: "http://127.0.0.1:8000/v1/audio/transcriptions",
        modelPlaceholder: "whisper-large-v3",
        languagePlaceholder: "zh",
        endpointHelp: "填写本地转写服务的 HTTP 地址。服务需要接收音频文件上传，并返回 text。",
        keyHelp: "多数本地服务可留空；如果服务要求鉴权，再填约定的密钥或令牌。",
        modelHelp: "模型名称由本地服务决定，例如 whisper-large-v3、whisper-large-v3-turbo、SenseVoiceSmall。",
        description: "适合隐私优先或离线工作流。QnALog 不负责下载模型或启动服务，只负责把音频发送到已启动的本地转写服务。",
        priceHint: "免费（消耗本机 GPU/CPU）。",
        steps: ["安装并启动本地转写服务", "确认服务能接收音频上传并返回 text", "填写服务地址、模型名称后运行连通性测试"],
        links: [
          ["Xinference 文档", "https://inference.readthedocs.io/en/latest/models/model_abilities/audio.html"],
          ["whisper.cpp", "https://github.com/ggml-org/whisper.cpp"],
        ],
      },
      whisperx: {
        title: "WhisperX · 说话人分离",
        badge: "本地分离",
        transcribeMode: "segmented",
        speakerDiarization: true,
        speakerLabelScope: "session",
        requiresWholeSession: true,
        requiresKey: false,
        endpointPlaceholder: "http://127.0.0.1:8000/v1/audio/transcriptions",
        modelPlaceholder: "whisper-large-v3",
        languagePlaceholder: "zh",
        endpointHelp: "填写已启动的 WhisperX 或兼容说话人分离服务地址。",
        keyHelp: "本地服务通常可以留空；如果你的网关要求鉴权，再填写访问密钥。",
        modelHelp: "模型名称由本地服务决定。响应需要包含 segments[].speaker，或在 text 中内联 SPEAKER_00 等标签。",
        description: "停止录音后由本地服务统一识别整场音频，并把说话人标签写入逐字稿。",
        priceHint: "免费（消耗本机 GPU/CPU）。",
        steps: ["安装并启动带 diarization 的 WhisperX 服务", "确认响应包含 speaker 字段", "运行连通性测试"],
        links: [["WhisperX", "https://github.com/m-bain/whisperX"]],
        note: "QnALog 只负责调用已启动的服务，不负责安装模型。为保持说话人编号一致，录音停止后统一转写。",
      },
      custom: {
        title: "其他转写服务",
        badge: "高级",
        transcribeMode: "segmented",
        requiresKey: false,
        endpointPlaceholder: "https://your-domain.example/v1/audio/transcriptions",
        modelPlaceholder: "your-transcribe-model",
        languagePlaceholder: "",
        endpointHelp: "填写第三方或自建转写服务地址。服务需要接收音频文件上传，并返回 text。",
        keyHelp: "按服务要求填写；不需要鉴权时可留空。",
        modelHelp: "按服务支持的模型名称填写。",
        description: "适合企业内部网关、自建转写服务或其他第三方转写服务。",
        priceHint: "",
        steps: ["确认服务能接收音频文件上传", "确认响应中包含 text 字段", "保存后运行连通性测试"],
        links: [],
      },
    };
    const base = profiles[id] || profiles.custom;
    const title = id === "custom" && provider && provider.name ? provider.name : base.title;
    return Object.assign({}, base, { title });
  }

  getActiveTranscribeProfile() {
    const id = this.host.settings.activeTranscribeProvider || "siliconflow";
    const provider = (this.host.settings.transcribeProviders || {})[id] || {};
    return this.getTranscribeProviderProfile(id, provider);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
