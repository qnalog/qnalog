import type {
  AudioInputMode,
  KnowledgeExtractionHistory,
  KnowledgeExtractionRecord,
  LlmAsrSnapshot,
  LlmProfile,
  PeopleContextMode,
  PeopleSuggestionCache,
  PromptTemplate,
} from "./types";

const AUDIO_INPUT_MODES = new Set<AudioInputMode>(["mic", "mix-virtual", "virtualCable"]);
const PEOPLE_CONTEXT_MODES = new Set<PeopleContextMode>(["privacy", "hotwords", "localFull"]);
const PEOPLE_SUGGESTION_CACHE_LIMIT = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeVaultPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}

export function normalizeAudioInputMode(value: unknown): AudioInputMode {
  if (value === "mix") return "mix-virtual";
  if (value === "system") return "virtualCable";
  return typeof value === "string" && AUDIO_INPUT_MODES.has(value as AudioInputMode)
    ? value as AudioInputMode
    : "mic";
}

export function normalizeAsrConcurrency(value: unknown): number {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return 1;
  return Math.max(1, Math.min(3, Math.floor(number)));
}

function normalizeLlmAsrSnapshot(value: unknown): LlmAsrSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const providerId = text(value.providerId).trim();
  if (!providerId) return undefined;
  return {
    providerId,
    apiKey: text(value.apiKey),
    endpoint: text(value.endpoint).trim(),
    model: text(value.model).trim(),
    language: text(value.language).trim(),
  };
}

export function normalizeLlmProfiles(value: unknown): LlmProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles: LlmProfile[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = text(item.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const profile: LlmProfile = {
      id,
      name: text(item.name).trim() || "未命名配置",
      endpoint: text(item.endpoint).trim(),
      apiKey: text(item.apiKey),
      model: text(item.model).trim(),
    };
    const asr = normalizeLlmAsrSnapshot(item.asr);
    if (asr) profile.asr = asr;
    profiles.push(profile);
  }
  return profiles;
}

export function normalizePeopleContextMode(value: unknown): PeopleContextMode {
  return typeof value === "string" && PEOPLE_CONTEXT_MODES.has(value as PeopleContextMode)
    ? value as PeopleContextMode
    : "privacy";
}

export function normalizePeopleSuggestionIgnores(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === "string" || isRecord(item)).slice(-300);
}

export function normalizePeopleSuggestionCache(value: unknown): PeopleSuggestionCache {
  const source = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.pending)
      ? value.pending
      : [];
  return {
    pending: source.filter(isRecord).slice(-PEOPLE_SUGGESTION_CACHE_LIMIT),
  };
}

export function isCustomPromptModeTemplate(value: PromptTemplate): boolean {
  return value.customMode === true
    && typeof value.id === "string"
    && typeof value.mode === "string"
    && value.id === value.mode;
}

function normalizeKnowledgeBucket(value: unknown): Record<string, KnowledgeExtractionRecord> {
  const bucket: Record<string, KnowledgeExtractionRecord> = {};
  if (!isRecord(value)) return bucket;
  for (const [rawPath, rawRecord] of Object.entries(value)) {
    const path = normalizeVaultPath(rawPath);
    if (!path) continue;
    if (isRecord(rawRecord)) {
      bucket[path] = {
        mtime: Number(rawRecord.mtime) || 0,
        size: Number(rawRecord.size) || 0,
        scannedAt: text(rawRecord.scannedAt),
      };
    } else {
      const mtime = typeof rawRecord === "number" || typeof rawRecord === "string"
        ? Number(rawRecord)
        : 0;
      bucket[path] = { mtime: Number.isFinite(mtime) ? mtime : 0, size: 0, scannedAt: "" };
    }
  }
  return bucket;
}

export function normalizeKnowledgeExtractionHistory(value: unknown): KnowledgeExtractionHistory {
  const source = isRecord(value) ? value : {};
  return {
    vocabulary: normalizeKnowledgeBucket(source.vocabulary),
    people: normalizeKnowledgeBucket(source.people),
  };
}
