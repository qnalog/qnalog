/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog 的设置/数据层有意保持动态类型（@ts-nocheck 且从 loadData 读未类型化 JSON），这些纯类型规则在此没有可执行结论，留待逐步补类型 */
// 由 main.ts 抽出（模块化拆解、纯搬迁、零行为改动）：转写服务配置解析：内置服务条目、协议、模型与说话人分离能力判定

import type { PluginSettings } from "../shared/types";
import { canOmitServiceApiKey } from "../shared/util-llm-endpoint";

/** TranscribeProfileService 需要宿主提供的能力；运行时由 src/main.ts 的插件实例实现。 */
export interface TranscribeProfileHost {
  /** 设置对象本身，不拷贝；服务直接读字段。 */
  settings: PluginSettings;
}

export class TranscribeProfileService {
  declare host: TranscribeProfileHost;
  constructor(host) {
    this.host = host;
  }


  getTranscribeProviderProfile(id, provider) {
    const profiles = {
      siliconflow: {
        title: "SiliconFlow",
        badge: "Cloud Transcription",
        transcribeMode: "segmented",
        requiresKey: true,
        endpointPlaceholder: "https://api.siliconflow.cn/v1/audio/transcriptions",
        modelPlaceholder: "FunAudioLLM/SenseVoiceSmall",
        languagePlaceholder: "auto",
        endpointHelp: "Audio transcription service URL for SiliconFlow. Usually keep the default.",
        keyHelp: "Copy the access key from the SiliconFlow console. The key is stored obfuscated (not encrypted) in this vault's plugin settings file and is never uploaded; do not sync or share the entire vault folder with anyone you do not trust.",
        modelHelp: "FunAudioLLM/SenseVoiceSmall is recommended. It has low latency, supports 50+ languages, and performs well on Chinese and Cantonese.",
        description: "OpenAI-compatible audio transcription endpoint. Q&A Log uploads audio in segments according to the configured segment interval.",
        priceHint: "FunAudioLLM/SenseVoiceSmall is currently free with no usage limit on SiliconFlow; platform rules may change, so the SiliconFlow console is the final authority.",
        steps: ["Register or log in to a SiliconFlow account", "Create an access key in the console", "Confirm the service URL and model name, then run the connectivity test"],
        links: [
          ["Access Key", "https://cloud.siliconflow.cn/account/ak"],
          ["转写文档", "https://docs.siliconflow.cn/cn/api-reference/audio/create-audio-transcriptions"],
        ],
      },
      openai: {
        title: "OpenAI (Segmented Transcription)",
        badge: "Cloud Transcription",
        transcribeMode: "segmented",
        requiresKey: true,
        endpointPlaceholder: "https://api.openai.com/v1/audio/transcriptions",
        modelPlaceholder: "gpt-4o-transcribe",
        languagePlaceholder: "",
        endpointHelp: "Audio transcription service URL for OpenAI. Requires network access to the OpenAI API.",
        keyHelp: "Enter the access key for your OpenAI project.",
        modelHelp: "gpt-4o-transcribe (HTTP segmented) is recommended. If you need subtitles as you speak, switch to \"OpenAI Realtime · Speech Transcription\".",
        description: "OpenAI-compatible audio transcription endpoint. Q&A Log uploads audio in segments according to the configured segment interval.",
        priceHint: "Billed by audio usage (official price $6 per million audio tokens); the OpenAI pricing page is the final authority.",
        steps: ["Confirm that your OpenAI API account is usable", "Enter the access key", "Run connectivity test"],
        links: [["OpenAI API Key", "https://platform.openai.com/api-keys"]],
      },
      "openrouter-diarize": {
        title: "OpenRouter · Speaker Diarization",
        badge: "Whole-file · Speaker Diarization",
        transcribeMode: "whole-file",
        speakerDiarization: true,
        speakerLabelScope: "session",
        requiresWholeSession: true,
        requiresKey: true,
        endpointPlaceholder: "https://openrouter.ai/api/v1/audio/transcriptions",
        modelPlaceholder: "microsoft/mai-transcribe-2",
        languagePlaceholder: "",
        endpointHelp: "OpenRouter speech transcription endpoint. Usually keep the default.",
        keyHelp: "Enter the API Key created in the OpenRouter console. The same key also works for recording transcription and AI organizing.",
        modelHelp: "microsoft/mai-transcribe-2 is recommended (supports speaker diarization). Which upstream a model routes to varies per model; Q&A Log looks up that upstream and passes the diarization switch to it.",
        description: "For audio import only. Q&A Log submits the whole recording as a single file and requests speaker labels together with the transcript.",
        priceHint: "Billed by audio duration and the selected model; the usage page of the OpenRouter console is the final authority.",
        steps: ["Register or log in to an OpenRouter account", "Create an API Key in the console", "Keep the default service URL and model name", "Confirm speaker names after importing audio"],
        links: [
          ["Access Key", "https://openrouter.ai/settings/keys"],
          ["说话人分离文档", "https://openrouter.ai/docs/guides/overview/multimodal/stt"],
        ],
        note: "Speaker diarization needs structured output, so this service sends audio as base64 JSON rather than a multipart upload. Upstream providers time out after about 60 seconds of processing, so very long recordings are better split.",
      },
      "openai-diarize": {
        title: "OpenAI · Speaker Diarization",
        badge: "Speaker Diarization",
        transcribeMode: "segmented",
        speakerDiarization: true,
        speakerLabelScope: "session",
        requiresWholeSession: true,
        requiresKey: true,
        endpointPlaceholder: "https://api.openai.com/v1/audio/transcriptions",
        modelPlaceholder: "gpt-4o-transcribe-diarize",
        languagePlaceholder: "",
        endpointHelp: "Audio transcription service URL for OpenAI. Requires network access to the OpenAI API.",
        keyHelp: "Enter the access key for your OpenAI project.",
        modelHelp: "Uses gpt-4o-transcribe-diarize. This model returns segments with timestamps and speaker labels.",
        description: "After you stop recording, the entire recording is transcribed at once so that speaker numbers stay consistent within the session. Once transcription finishes you can confirm the name for each number, then move on to AI processing.",
        priceHint: "Billed by audio usage; the OpenAI pricing page is the final authority.",
        steps: ["Confirm that your OpenAI API account is usable", "Enter the access key", "Run connectivity test", "Confirm speaker names after you stop recording"],
        links: [
          ["OpenAI API Key", "https://platform.openai.com/api-keys"],
          ["说话人分离文档", "https://platform.openai.com/docs/api-reference/audio/createTranscription"],
        ],
        note: "To avoid speaker numbering restarting in different segments, audio is not uploaded in parts while recording; the whole recording is transcribed after you stop. The raw transcript keeps speaker numbers, and the name mapping is used for AI processing.",
      },
      openrouter: {
        title: "OpenRouter · Speech Transcription",
        badge: "Cloud Transcription",
        transcribeMode: "segmented",
        requiresKey: true,
        endpointPlaceholder: "https://openrouter.ai/api/v1/audio/transcriptions",
        modelPlaceholder: "openai/whisper-large-v3",
        languagePlaceholder: "",
        endpointHelp: "OpenRouter speech transcription endpoint. Usually keep the default.",
        keyHelp: "Enter the API Key created in the OpenRouter console.",
        modelHelp: "Enter the transcription model ID on OpenRouter, for example openai/whisper-large-v3. You can filter available models in the console by output_modalities=transcription.",
        description: "OpenRouter provides an OpenAI-compatible transcription endpoint. Q&A Log uploads audio in segments according to the configured segment interval.",
        priceHint: "Billed by audio duration and the selected model; the usage page of the OpenRouter console is the final authority.",
        steps: ["Register or log in to an OpenRouter account", "Create an API Key in the console", "Confirm the model ID, then run the connectivity test"],
        links: [
          ["Access Key", "https://openrouter.ai/settings/keys"],
          ["转写文档", "https://openrouter.ai/docs/guides/overview/multimodal/stt"],
        ],
        note: "Maximum upload size is 25 MB per request; longer recordings are split according to the segment interval before uploading, so they are not subject to this limit.",
      },
      "dashscope-filetrans": {
        title: "Alibaba Cloud Bailian Recording File Recognition",
        badge: "Long Audio · Speaker Diarization",
        transcribeMode: "whole-file",
        speakerDiarization: true,
        speakerLabelScope: "session",
        requiresWholeSession: true,
        requiresKey: true,
        endpointPlaceholder: "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
        modelPlaceholder: "qwen-audio-3.0-asr-flash-filetrans",
        languagePlaceholder: "zh",
        endpointHelp: "Alibaba Cloud Bailian recording file recognition endpoint. Usually keep the default.",
        keyHelp: "Enter your Alibaba Cloud Bailian API Key. Audio is uploaded temporarily to Alibaba Cloud and recognized asynchronously.",
        modelHelp: "qwen-audio-3.0-asr-flash-filetrans is recommended (supports speaker diarization). fun-asr / paraformer-v2 still work.",
        description: "For audio import only. Q&A Log submits the entire audio as a single file and does not split it into multiple ASR jobs locally.",
        priceHint: "Standard recording file recognition supports up to 12 hours; with speaker diarization enabled, the official recommendation is no more than 2 hours per file.",
        steps: ["Create an API Key in the Bailian console", "Keep the default service URL and model name", "Run connection test", "Confirm speaker names after importing audio"],
        links: [
          ["Access Key", "https://help.aliyun.com/zh/model-studio/developer-reference/get-api-key"],
          ["录音文件识别文档", "https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide"],
        ],
        note: "Whole-file transcription does not generate a real-time outline. Recordings longer than 2 hours can still be submitted, but speaker diarization accuracy may drop.",
      },
      apimimo: {
        title: "APIMiMo V2.5 ASR",
        badge: "Cloud Transcription",
        transcribeMode: "segmented",
        requiresKey: true,
        endpointPlaceholder: "https://api.xiaomimimo.com/v1/chat/completions",
        modelPlaceholder: "mimo-v2.5-asr",
        languagePlaceholder: "auto / zh / en",
        languageHelp: "Leave blank or auto for automatic detection; specifying the language as zh (Chinese, including dialects such as Cantonese, Wu, Hokkien, and Sichuanese) or en (English) can improve accuracy. Other values are treated as auto.",
        endpointHelp: "Service URL for Xiaomi MiMo. Keep the default. Q&A Log sends audio in the dedicated format MiMo requires, unlike other transcription services, so no manual adjustment is needed.",
        keyHelp: "Enter the access key (API Key) for the Xiaomi MiMo platform. The key is stored obfuscated (not encrypted) in this vault's plugin settings file and is never uploaded.",
        modelHelp: "Always uses mimo-v2.5-asr. This service accepts only wav/mp3, about 7.5 MB or less per segment; other formats or longer recordings are converted and split automatically by Q&A Log, so no manual handling is needed.",
        description: "APIMiMo-V2.5-ASR recognizes audio through the input_audio field of OpenAI-compatible Chat Completions. The server accepts only wav/mp3: when this service is selected, Q&A Log records in WebM/Opus and converts it to WAV on this machine before uploading in chunks; wav/mp3 files under the size limit are sent directly.",
        priceHint: "Billed according to MiMo platform pricing. Size limits are handled automatically by Q&A Log: recordings over the limit are uploaded in blocks of about 3 minutes, with no manual intervention needed.",
        steps: ["Create an API Key on the Xiaomi MiMo platform", "Keep the default service URL and model name", "Run connectivity test"],
        links: [["MiMo ASR documentation", "https://platform.xiaomimimo.com/docs/zh-CN/api/audio/Speech-Recognition"]],
        note: "This service does not support hotword parameters; Q&A Log applies local hotword correction after the transcription results are returned. Entering zh or en under \"Recognition Language\" above can improve accuracy. Note: m4a/mp4 recordings made earlier with other services cannot be re-transcribed with this service (this only affects re-transcription; new recordings are unaffected), so switch back to the original service temporarily if you need to re-transcribe.",
      },
      "openai-realtime": {
        title: "OpenAI Realtime · Speech Transcription",
        badge: "Streaming Real-time",
        transcribeMode: "streaming",
        streamProtocol: "openai-realtime-transcription",
        requiresKey: true,
        endpointPlaceholder: "wss://api.openai.com/v1/realtime",
        modelPlaceholder: "gpt-realtime-whisper",
        languagePlaceholder: "(optional, auto-detect)",
        endpointHelp: "WebSocket URL for OpenAI Realtime. Keep the default.",
        keyHelp: "Access key for your OpenAI project (the same key is shared with segmented transcription).",
        modelHelp: "gpt-realtime-whisper is recommended (streaming ASR, designed for real-time subtitles/meeting notes).",
        description: "Streaming transcription: text appears as you speak. Q&A Log skips segment splitting and keeps a single real-time connection to the service for the whole recording, with latency under about half a second.",
        priceHint: "gpt-realtime-whisper ≈ $0.017 / minute ≈ ¥7.2 / hour.",
        steps: ["Confirm that your OpenAI API account is usable and can access the Realtime API", "Enter the access key", "Keep the model name gpt-realtime-whisper", "Choose the \"Microphone only\" capture mode and start recording"],
        links: [
          ["OpenAI API Key", "https://platform.openai.com/api-keys"],
          ["Realtime 文档", "https://developers.openai.com/api/docs/guides/realtime-transcription"],
        ],
        note: "In streaming mode the \"Segment Interval\" and \"Instant Segmentation\" settings have no effect; notes are appended with text in real time while recording.",
      },
      "openai-realtime-translate": {
        title: "OpenAI Realtime · Speech Translation",
        badge: "Streaming Translation",
        transcribeMode: "streaming",
        streamProtocol: "openai-realtime-translation",
        requiresKey: true,
        endpointPlaceholder: "wss://api.openai.com/v1/realtime/translations",
        modelPlaceholder: "gpt-realtime-translate",
        languagePlaceholder: "",
        endpointHelp: "WebSocket base URL for OpenAI Realtime Translations. The model name is appended automatically as a query parameter.",
        keyHelp: "Access key for your OpenAI project.",
        modelHelp: "gpt-realtime-translate is recommended (70+ input languages → 13 output languages, trained on recordings by professional interpreters).",
        description: "Streaming speech translation. Automatically detects the speaker's language and outputs a dual-track note of translation + original in real time. The model also returns a translated audio stream (which Q&A Log discards automatically, keeping only the text).",
        priceHint: "gpt-realtime-translate ≈ $0.034 / minute ≈ ¥14.4 / hour.",
        steps: [
          "Confirm that your OpenAI API account is usable and can access the Realtime API",
          "Enter the access key",
          "Select the output language you need under \"Target Language\"",
          "Choose the \"Microphone only\" capture mode and start recording",
        ],
        links: [
          ["OpenAI API Key", "https://platform.openai.com/api-keys"],
          ["Realtime 翻译文档", "https://developers.openai.com/api/docs/guides/realtime-translation"],
        ],
        note: "Supported target languages: English (en), Chinese (zh), Japanese (ja), Korean (ko), French (fr), Spanish (es), German (de), Italian (it), Portuguese (pt), Russian (ru), Arabic (ar), Hindi (hi), Turkish (tr).",
        showTargetLanguage: true,
      },
      dashscope: {
        title: "Alibaba Cloud Bailian Real-time Transcription",
        badge: "Streaming Real-time",
        transcribeMode: "streaming",
        streamProtocol: "dashscope-ws",
        requiresKey: true,
        endpointPlaceholder: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
        modelPlaceholder: "qwen-audio-3.0-asr-flash-streaming",
        languagePlaceholder: "",
        endpointHelp: "WebSocket URL for Bailian real-time recognition. Keep the default.",
        keyHelp: "Enter the access key (API Key) created in the Bailian console. The key is stored obfuscated (not encrypted) in this vault's plugin settings file and is never uploaded.",
        modelHelp: "qwen-audio-3.0-asr-flash-streaming is recommended (multilingual, supports dialects). The older paraformer-realtime-v2 configuration still works.",
        description: "Streaming transcription: text appears as you speak. Q&A Log skips segment splitting and keeps a single real-time connection to the service for the whole recording.",
        priceHint: "Billed according to Bailian real-time recognition; the Bailian console price is the final authority.",
        steps: ["Create an API Key in the Bailian console", "Keep the default service URL and model name", "Just start recording"],
        links: [
          ["Access Key", "https://help.aliyun.com/zh/model-studio/get-api-key"],
          ["实时语音识别文档", "https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide"],
        ],
        note: "In streaming mode the \"Segment Interval\" and \"Instant Segmentation\" settings have no effect; notes are appended with text in real time while recording. Desktop uses a streaming connection; on mobile, if you want real-time transcription, switch to a segmented transcription service under \"Advanced\".",
      },
      local: {
        title: "Local Transcription Service",
        badge: "Local Service",
        transcribeMode: "segmented",
        requiresKey: false,
        endpointPlaceholder: "http://127.0.0.1:8000/v1/audio/transcriptions",
        modelPlaceholder: "whisper-large-v3",
        languagePlaceholder: "zh",
        endpointHelp: "Enter the HTTP URL of your local transcription service. The service must accept an uploaded audio file and return text.",
        keyHelp: "Most local services can be left blank; if your service requires authentication, enter the agreed key or token.",
        modelHelp: "The model name is determined by the local service, for example whisper-large-v3, whisper-large-v3-turbo, SenseVoiceSmall.",
        description: "Suitable for privacy-first or offline workflows. Q&A Log does not download models or start services; it only sends audio to the local transcription service you have already started.",
        priceHint: "Free (uses this machine's GPU/CPU).",
        steps: ["Install and start a local transcription service", "Confirm that the service can accept an audio upload and return text", "Enter the service URL and model name, then run the connectivity test"],
        links: [
          ["Xinference documentation", "https://inference.readthedocs.io/en/latest/models/model_abilities/audio.html"],
          ["whisper.cpp", "https://github.com/ggml-org/whisper.cpp"],
        ],
      },
      whisperx: {
        title: "WhisperX · Speaker Diarization",
        badge: "Local Diarization",
        transcribeMode: "segmented",
        speakerDiarization: true,
        speakerLabelScope: "session",
        requiresWholeSession: true,
        requiresKey: false,
        endpointPlaceholder: "http://127.0.0.1:8000/v1/audio/transcriptions",
        modelPlaceholder: "whisper-large-v3",
        languagePlaceholder: "zh",
        endpointHelp: "Enter the URL of the WhisperX or compatible speaker diarization service you have started.",
        keyHelp: "Local services can usually be left blank; if your gateway requires authentication, enter the access key.",
        modelHelp: "The model name is determined by the local service. The response must include segments[].speaker, or inline labels such as SPEAKER_00 in text.",
        description: "After you stop recording, the local service transcribes the entire recording at once and writes speaker labels into the transcript.",
        priceHint: "Free (uses this machine's GPU/CPU).",
        steps: ["Install and start a WhisperX service with diarization", "Confirm that the response includes a speaker field", "Run connectivity test"],
        links: [["WhisperX", "https://github.com/m-bain/whisperX"]],
        note: "Q&A Log only calls the service you have already started; it does not install models. To keep speaker numbering consistent, the whole recording is transcribed after you stop.",
      },
      custom: {
        title: "Other transcription services",
        badge: "Advanced",
        transcribeMode: "segmented",
        requiresKey: false,
        endpointPlaceholder: "https://your-domain.example/v1/audio/transcriptions",
        modelPlaceholder: "your-transcribe-model",
        languagePlaceholder: "",
        endpointHelp: "Enter the URL of a third-party or self-hosted transcription service. The service must accept an uploaded audio file and return text.",
        keyHelp: "Fill in according to your service's requirements; leave blank if authentication is not needed.",
        modelHelp: "Enter the model name supported by the service.",
        description: "Suitable for internal enterprise gateways, self-hosted transcription services, or other third-party transcription services.",
        priceHint: "",
        steps: ["Confirm that the service can accept an uploaded audio file", "Confirm that the response includes a text field", "Save, then run the connectivity test"],
        links: [],
      },
    };
    const base = profiles[id] || profiles.custom;
    const title = id === "custom" && provider && provider.name ? provider.name : base.title;
    // 没有预设的 provider（用户自建、其它服务）原先一律沿用 custom 的 requiresKey: false，
    // 于是密钥栏显示「可选」；但导入时运行时会因缺 key 报错——用户按界面提示留空，
    // 等到真正使用才发现。改为按 endpoint 推断：本地/内网地址（明文 HTTP 允许的
    // 主机范围）不需要密钥，其余远处服务一律要求填写。
    if (!profiles[id]) {
      return Object.assign({}, base, { title, requiresKey: !canOmitServiceApiKey(provider && provider.endpoint) });
    }
    return Object.assign({}, base, { title });
  }

  getActiveTranscribeProfile() {
    const id = this.host.settings.activeTranscribeProvider || "siliconflow";
    const provider = (this.host.settings.transcribeProviders || {})[id] || {};
    return this.getTranscribeProviderProfile(id, provider);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
