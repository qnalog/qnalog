/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）：跨模块共用的时间与数量阈值常量
import { NS_TAG } from "./namespace";

export const QUICK_INTERIM_CUTS_MS = [10 * 1000, 60 * 1000, 3 * 60 * 1000];

/** 短录音直接丢弃的时长上限：低于此值且开关为开时，不保存音频、不建纪要。 */
export const SHORT_RECORDING_FILTER_MS = 3000;

/** 短录音只保留音频的时长上限：低于此值不建纪要、不自动转写，音频留在录音目录里。 */
export const SHORT_RECORDING_SKIP_NOTE_MS = 10 * 1000;

export const KNOWLEDGE_EXTRACTION_BATCH_LIMIT = 20;

export const SEGMENT_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const EXTERNAL_INBOX_SCAN_INTERVAL_MS = 30 * 1000;

export const EXTERNAL_INBOX_RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

// 「一个 Key 通用」供应商：同一把 Key 同时支持语音转写 + 大模型对话。首页快速配置一处填 Key + 选供应商即可两边都配好。
// asrProvider 对应 transcribeProviders 里的 id；llmPreset 对应 LLM_SERVICE_PRESETS 里的 id。

// 取值写在用户笔记里（版本块标记）。常量名用 QNALOG_，取值保持上游字面量：
// 改取值会让既有笔记的版本块不再被识别，随数据层命名空间重置一并处理。
export const QNALOG_ACTIVE_VERSION_START = `<!-- ${NS_TAG}-active-version-start -->`;

export const QNALOG_ACTIVE_VERSION_END = `<!-- ${NS_TAG}-active-version-end -->`;

// 「清理空白短录音」的判定上限：≤10 秒且无有效转写的独立纪要会被列为清理候选。
// 与 SHORT_RECORDING_SKIP_NOTE_MS 数值相同但含义不同：那条决定新录音是否自动转写，
// 这条决定既有笔记要不要清理，各自按需要调整，不要互相引用。
export const QNALOG_EMPTY_SHORT_LIMIT_MS = 10 * 1000;

export const TEXT_IMPORT_PRE_SUMMARY_THRESHOLD_CHARS = 120000;

export const TEXT_IMPORT_PRE_SUMMARY_MAX_CHUNKS = 24;

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
