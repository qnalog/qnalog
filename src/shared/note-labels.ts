/**
 * 笔记结构标签的唯一契约模块。
 *
 * 背景：老笔记保持原语言不改写，新写入的笔记标签跟随当前界面语言，
 * 因此写入侧按 activeUiLanguage 产出标签，解析侧必须中英两套都认
 * （老笔记是中文、新笔记随生成时语言）。后续的写入/解析改造簇都从
 * 这里取标签与模式，不再各自硬编码。
 *
 * 模块内的两条硬约束（tests/i18n-bare-cjk.test.ts 门禁）：
 *   1. 不得出现中文字符串字面量——中文只允许写在正则字面量里（门禁不扫正则）；
 *   2. 不得在模块期调用 t()/translateInto——常量在导入时求值会把语言冻住，
 *      取词只能发生在函数体内（labelText 即如此）。
 *
 * Frontmatter 属性名由 namespace.ts 固定管理，与界面语言无关。
 */

import { t } from "./i18n";

/** 一条笔记结构标签：英文源键 + 中英双语解析模式 + 占位符个数。 */
export interface NoteLabelSpec {
  /** 英文源键（也是英文界面显示文本），可能含 {0}{1} 占位符。 */
  key: string;
  /**
   * 双语解析模式（中|英 交替）。必须能匹配该 key 在两种语言下完整渲染
   * 的子串：短语级即可，不带 ^$ 锚点——解析侧多在 `## `、`<summary>` 里用。
   */
  re: RegExp;
  /** 占位符个数（供测试填充样例参数；与 key 里出现的 {n} 个数一致）。 */
  params?: number;
}

/**
 * 全量标签目录。键名用小驼峰，是 labelText/labelPattern 的唯一定位符。
 * 解析侧一律经 labelPattern(name) 取模式，写入侧一律经 labelText(name, ...)
 * 取文案，禁止在调用点重新拼写中英文。
 */
export const NOTE_LABELS: Record<string, NoteLabelSpec> = {
  // —— 标题类 ——
  originalMaterial: { key: "Original material", re: /原始材料|Original material/ },
  currentVersion: { key: "Current version", re: /当前版本|Current version/ },
  currentMinutes: { key: "Current minutes", re: /当前纪要|Current minutes/ },
  currentMinutesAt: { key: "Current minutes ({0})", params: 1, re: /当前纪要（[^）]*）|Current minutes \([^)]*\)/ },
  mergedVersion: { key: "Merged version", re: /整合版|Merged version/ },
  mergedVersionAt: { key: "Merged version ({0})", params: 1, re: /整合版（[^）]*）|Merged version \([^)]*\)/ },
  appendTo: { key: "Append to {0}", params: 1, re: /续录\s*\d+|Append to\s+\d+/ },
  appendToAt: { key: "Append to {0} ({1})", params: 2, re: /续录\s*\d+\s*（[^）]*）|Append to\s+\d+\s*\([^)]*\)/ },
  supplementaryRecording: { key: "Supplementary recording", re: /补录|Supplementary recording/ },
  qa: { key: "Q&A", re: /问一问|Q&A/ },
  recordingInfo: { key: "Recording info", re: /录音信息|Recording info/ },
  playbackTimeline: { key: "Playback timeline", re: /回听时间轴|Playback timeline/ },
  indexData: { key: "Index data", re: /索引数据|Index data/ },
  distilledData: { key: "Distilled data", re: /沉淀数据|Distilled data/ },
  meetingMaterial: { key: "Material added during the meeting", re: /会中补充材料|Material added during the meeting/ },
  importedTextInfo: { key: "Imported text info", re: /导入文本信息|Imported text info/ },
  textImportInfo: { key: "Text import info", re: /文本导入信息|Text import info/ },
  importedTextSources: { key: "Imported text ({0} sources)", params: 1, re: /导入文本原文（\d+ 个来源）|Imported text \(\d+ sources\)/ },
  importSource: { key: "Import source", re: /导入来源|Import source/ },
  importInfo: { key: "Import info", re: /导入信息|Import info/ },
  previousVersion: { key: "Previous version (before reorganizing · {0})", params: 1, re: /上一版纪要（重新整理前 · [^）]*）|Previous version \(before reorganizing · [^)]*\)/ },
  previousVersionEmpty: { key: "(previous version was empty)", re: /（上一版为空）|\(previous version was empty\)/ },
  liveOutlineDraft: { key: "Live outline while recording (draft)", re: /录音中实时大纲（草稿）|Live outline while recording \(draft\)/ },
  outlineIntro: {
    key: "Outline generated from the segments completed while recording; the final minutes take precedence. The time markers let you jump back to the matching parts.",
    re: /基于录音过程中已完成的分段自动生成，正文纪要以最终整理为准。时间标记可用于快速回听对应片段。|Outline generated from the segments completed while recording; the final minutes take precedence. The time markers let you jump back to the matching parts./,
  },
  outlineIntroPrefix: {
    key: "Outline generated from the segments completed while recording; the final minutes take precedence. The time markers let you jump back to the matching parts.",
    re: /基于录音过程中已完成的分段自动生成，正文纪要以最终整理为准。|Outline generated from the segments completed while recording; the final minutes take precedence\./,
  },
  outlineCoverage: {
    key: "The outline covers only {0}/{1} transcript segments; the rest still went into the minutes. Refresh the outline in the sidebar to fill the gaps.",
    params: 2,
    re: /大纲仅覆盖 \d+\/\d+ 个转写分段，未覆盖部分仍已用于正文纪要。可在侧边栏刷新大纲后补齐。|The outline covers only \d+\/\d+ transcript segments; the rest still went into the minutes. Refresh the outline in the sidebar to fill the gaps./,
  },
  outlineCoverageCurrentRecording: {
    key: "The outline covers only {0}/{1} segments of this recording; the rest still went into the minutes.",
    params: 2,
    re: /本次录音大纲仅覆盖 \d+\/\d+ 段，其余转写仍已用于正文纪要。|The outline covers only \d+\/\d+ segments of this recording; the rest still went into the minutes./,
  },
  outlineCoverageWholeNote: {
    key: "The outline covers only {0}/{1} segments of the whole note; the rest still went into the minutes.",
    params: 2,
    re: /整篇笔记大纲仅覆盖 \d+\/\d+ 段，其余转写仍已用于正文纪要。|The outline covers only \d+\/\d+ segments of the whole note; the rest still went into the minutes./,
  },

  // —— 段落 / 分段 ——
  segment: { key: "Segment {0}", params: 1, re: /段落\s*\d+|Segment\s+\d+/ },
  segmentRange: { key: "Segment {0} ({1}–{2})", params: 3, re: /段落\s*\d+\s*（[^）]*）|Segment\s+\d+\s*\([^)]*\)/ },
  audio: { key: "Audio {0}", params: 1, re: /音频\s*\d+|Audio\s+\d+/ },
  textSource: { key: "Text source {0}:", params: 1, re: /文本来源\s*\d+\s*：|Text source\s+\d+:/ },
  rawFallbackPart: { key: "Part {0} · {1}–{2} (raw transcript fallback)", params: 3, re: /第\s*\d+\s+部分\s*·[^（]*（原始转写保底）|Part\s+\d+\s+·[^)]*\(raw transcript fallback\)/ },

  // —— 信息行（键尾带空格：英文靠它与后继值衔接，中文值以全角冒号收尾、不带空格） ——
  currentDisplayedVersionLabel: { key: "Currently displayed version: ", re: /当前显示版本：|Currently displayed version:/ },
  versionGeneratedAtLabel: { key: "Generated at: ", re: /生成时间：|Generated at:/ },
  sourceTranscriptFingerprintLabel: { key: "Source transcript fingerprint: ", re: /源转写指纹：|Source transcript fingerprint:/ },
  timeLabel: { key: "Time: ", re: /时间：|Time:/ },
  durationLabel: { key: "Duration: ", re: /时长：|Duration:/ },
  modeLabel: { key: "Mode: ", re: /模式：|Mode:/ },
  segmentsLabel: { key: "Segments: ", re: /分段：|Segments:/ },
  modelLabel: { key: "Model: ", re: /模型：|Model:/ },
  sourceFilesLabel: { key: "Source files: ", re: /来源文件：|Source files:/ },
  sourceLabel: { key: "Source: ", re: /来源：|Source:/ },
  fileLabel: { key: "File: ", re: /文件：|File:/ },
  listenBack: { key: "Listen back: ", re: /回听[:：]|Listen back:/ },
  filesLabel: { key: "Files: ", re: /文件数：|Files:/ },
  transcriptionLabel: { key: "Transcription: ", re: /转写：|Transcription:/ },
  wholeFile: { key: "Whole file", re: /整文件|Whole file/ },

  // —— 折叠区摘要 ——
  segmentedRawTranscript: { key: "Segmented raw transcript ({0} segments)", params: 1, re: /分段原始转写（\d+ 段）|Segmented raw transcript \(\d+ segments\)/ },
  originalAudioSegments: { key: "Original audio ({0} segments, {1})", params: 2, re: /原始音频（\d+ 段，[^）]*）|Original audio \(\d+ segments, [^)]*\)/ },
  originalAudioSegmentsContinuation: { key: "Original audio ({0} segments, {1}, including sessions recorded before the appended one)", params: 2, re: /原始音频（\d+ 段，[^）]*，含追加录音前场次）|Original audio \(\d+ segments, [^)]*, including sessions recorded before the appended one\)/ },
  originalAudioFull: { key: "Original audio (full recording, {0})", params: 1, re: /原始音频（完整录音，[^）]*）|Original audio \(full recording, [^)]*\)/ },

  // —— 占位与失败标记 ——
  noUsableTranscript: { key: "(no usable transcript for this segment)", re: /（本段未获得可用转写内容）|\(no usable transcript for this segment\)/ },
  noRawSegmentsInPart: { key: "(no raw transcript segments to keep in this part)", re: /（本部分没有可保留的原始转写片段）|\(no raw transcript segments to keep in this part\)/ },
  noContentSegment: { key: "_[No content in this segment]_", re: /_\[此段无内容\]_|_\[No content in this segment\]_/ },
  waitingBackground: { key: "_[Waiting for background transcription; the audio has been kept]_", re: /_\[等待后台转写，音频已保留\]_|_\[Waiting for background transcription; the audio has been kept\]_/ },
  notFullyTranscribed: { key: "_[This segment is not fully transcribed yet; the audio has been kept]_", re: /_\[此段尚未完成转写，音频已保留\]_|_\[This segment is not fully transcribed yet; the audio has been kept\]_/ },
  noContentAudio: { key: "_[No content in this audio]_", re: /_\[此音频无内容\]_|_\[No content in this audio\]_/ },
  emptyTextSource: { key: "_[This text source is empty]_", re: /_\[此文本来源为空\]_|_\[This text source is empty\]_/ },
  aiOrganizingFailed: { key: "AI organizing failed: {0}", params: 1, re: /AI 整理失败|AI organizing failed/ },
  mergeFailedQueued: { key: "Merge failed (queued for retry): {0}", params: 1, re: /合并润色失败|Merge failed/ },
  organized: { key: "Organized", re: /已整理|Organized/ },

  // —— 标题后缀与导入头 ——
  importing: { key: "(importing…)", re: /（导入处理中…）|\(importing…\)/ },
  textImporting: { key: "(text importing…)", re: /（文本导入处理中…）|\(text importing…\)/ },
};

/**
 * 取标签文案：按当前界面语言取译文，并按参数顺序填充 {0}{1} 占位符。
 * t() 只能在函数体内调用（模块期求值会把语言冻成导入时的默认值）。
 */
export function labelText(name: string, ...args: Array<string | number>): string {
  const spec = NOTE_LABELS[name];
  if (!spec) throw new Error(`Unknown note label: ${name}`);
  let out = t(spec.key);
  for (let i = 0; i < args.length; i++) {
    out = out.split(`{${i}}`).join(String(args[i]));
  }
  return out;
}

/** 取该标签的双语解析模式。解析侧统一从这里取，不再各自维护正则。 */
export function labelPattern(name: string): RegExp {
  const spec = NOTE_LABELS[name];
  if (!spec) throw new Error(`Unknown note label: ${name}`);
  return spec.re;
}


// ============================================================
// 共享解析片段（写入/解析改造簇直接取用，勿再各自复制）
// ============================================================

/**
 * 工具性标题白名单：note-index.ts 与 canvas/semantic-outline-canvas.ts
 * 各有一份重复的中文标题清单，收敛为此一份（取两处的并集，中英双语）。
 * 原始清单：`^(?:原始材料|原始转写|逐字稿|录音原文|分段原始转写|回听时间轴|
 * 录音中实时大纲|会中补充材料|问一问|附录|参考资料|版本信息)$`。
 */
export const UTILITY_HEADING_RE =
  /^(?:原始材料|原始转写|逐字稿|录音原文|分段原始转写|回听时间轴|录音中实时大纲|会中补充材料|问一问|附录|参考资料|版本信息|Original material|Raw transcript|Verbatim transcript|Recording transcript|Segmented raw transcript|Playback timeline|Live outline while recording|Material added during the meeting|Q&A|Appendix|Reference materials|Version info)$/;

/** Summary 名称白名单与索引、语义图原先的工具 details 读取范围一致。 */
export const UTILITY_DETAILS_SUMMARY_RE =
  /(?:原始转写|逐字稿|原始材料|回听时间轴|录音中实时大纲|索引数据|沉淀数据|Raw transcript|Verbatim transcript|Original material|Playback timeline|Live outline while recording|Index data|Distilled data)/;
/**
 * 信息行词（时间/时长/模式/分段/模型/状态 + 英文对应词），供剥离
 * `- 时间：…` / `- Time: …` 这类元信息行（如 ui/helpers.ts 的归一化）。
 * 词后接半角或全角冒号；不带行锚点，调用方按需嵌入 ^\s*…$ 里。
 */
export const INFO_LINE_WORDS_RE = /(?:时间|时长|模式|分段|模型|状态|Time|Duration|Mode|Segments|Model|Status)[:：]/;

/**
 * 「第 N 部分 / Part N」标题片段（可含 `1/3` 形式的分母）。
 * detail-blocks 的长转写兜底标题与 briefing 流水线的成文剥离正则都用它。
 */
export const PART_HEADING_RE = /第\s*\d+(?:\s*\/\s*\d+)?\s+部分|Part\s+\d+(?:\s*\/\s*\d+)?/;
