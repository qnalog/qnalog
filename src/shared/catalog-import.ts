/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。

export const AUDIO_EXT = new Set(["webm", "mp3", "m4a", "aac", "acc", "wav", "ogg", "flac", "mp4", "mpeg", "mpga", "oga"]);

export const TEXT_IMPORT_EXT = new Set(["md", "txt"]);

export const IMPORT_TEXT_CATEGORY_CONFIG = {
  "qnalog-normal": {
    label: "Completed Q&A Log minutes",
    shortLabel: "Complete",
    desc: "Already organized by AI; can be merged, re-organized with another template, or converted to another mode.",
  },
  "qnalog-repair": {
    label: "Unfinished Q&A Log transcripts",
    shortLabel: "Needs repair",
    desc: "Contains failed transcriptions, failed organizing, or only raw segments; suitable for re-organizing.",
  },
  external: {
    label: "Other Markdown / TXT files",
    shortLabel: "External",
    desc: "Hand-typed notes, third-party minutes, or plain Markdown; skips speech transcription and goes straight to the LLM.",
  },
};

export const IMPORT_TEXT_CATEGORY_ORDER = ["qnalog-normal", "qnalog-repair", "external"];

export const VIRTUAL_CABLE_PATTERNS = [
  // Windows
  /CABLE Output/i,             // VB-Cable
  /VB-Audio Virtual Cable/i,
  /Virtual Audio Cable/i,      // 商业版 VAC
  /VoiceMeeter Output/i,       // VoiceMeeter Banana / Potato
  /VoiceMeeter Aux Output/i,
  /VoiceMeeter VAIO[3]? Output/i,
  /立体声混音/i,
  /Stereo Mix/i,
  // macOS
  /^BlackHole/i,               // BlackHole 2ch / 16ch
  /Loopback Audio/i,           // Rogue Amoeba Loopback
  /Soundflower/i,
  /Existential Audio/i,
  /SoundWire/i,                // Network audio bridge, not a local physical mic
  // Linux
  /Monitor of /i,              // PulseAudio loopback monitor sources
  /pulse_monitor/i,
];
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
