export type ExternalInboxFile = {
  fullPath: string;
  name: string;
  extension: string;
  size: number;
  mtimeMs: number;
  fingerprint: string;
};

export type ExternalInboxLedgerStatus =
  | "waiting"
  | "processing"
  | "imported"
  | "failed";

export type ExternalInboxLedgerEntry = {
  fingerprint: string;
  fullPath: string;
  name: string;
  size: number;
  mtimeMs: number;
  status: ExternalInboxLedgerStatus;
  attempts: number;
  firstSeenAt: number;
  updatedAt: number;
  nextRetryAt: number;
  notePath: string;
  error: string;
};

export type ExternalInboxLedger = {
  version: 1;
  entries: Record<string, ExternalInboxLedgerEntry>;
};

export type ExternalInboxDirectoryEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
};

export type ExternalInboxStat = {
  size: number;
  mtimeMs: number;
  isFile: boolean;
};

export type ExternalInboxFileSystem = {
  join: (...parts: string[]) => string;
  readdir: (folderPath: string) => Promise<ExternalInboxDirectoryEntry[]>;
  stat: (filePath: string) => Promise<ExternalInboxStat>;
};

export type ExternalInboxScanResult = {
  ready: ExternalInboxFile[];
  waiting: ExternalInboxFile[];
  scanned: number;
  truncated: boolean;
  errors: Array<{ path: string; message: string }>;
};

type StableObservation = {
  size: number;
  mtimeMs: number;
  stableSince: number;
};

const WINDOWS_ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/;
const POSIX_ABSOLUTE_PATH = /^\//;

export function isAbsoluteExternalInboxPath(value: unknown): boolean {
  const path = typeof value === "string" ? value.trim() : "";
  return !!path && (WINDOWS_ABSOLUTE_PATH.test(path) || POSIX_ABSOLUTE_PATH.test(path));
}

function normalizeFingerprintName(value: string): string {
  return value.trim().replace(/\\/g, "/").split("/").pop()?.toLocaleLowerCase() || "audio";
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function makeExternalInboxFingerprint(
  pathOrName: string,
  size: number,
  mtimeMs: number,
): string {
  const normalizedName = String(pathOrName || "")
    .trim()
    .replace(/\\/g, "/")
    .toLocaleLowerCase() || normalizeFingerprintName(pathOrName);
  const normalizedSize = Math.max(0, Math.floor(Number(size) || 0));
  const normalizedMtime = Math.max(0, Math.floor(Number(mtimeMs) || 0));
  const source = `${normalizedName}|${normalizedSize}|${normalizedMtime}`;
  return `external-${stableHash(source)}-${normalizedSize}`;
}

export function createExternalInboxLedger(): ExternalInboxLedger {
  return { version: 1, entries: {} };
}

export function normalizeExternalInboxLedger(value: unknown): ExternalInboxLedger {
  const ledger = createExternalInboxLedger();
  if (!value || typeof value !== "object" || Array.isArray(value)) return ledger;
  const rawEntries = (value as { entries?: unknown }).entries;
  if (!rawEntries || typeof rawEntries !== "object" || Array.isArray(rawEntries)) return ledger;
  for (const [key, raw] of Object.entries(rawEntries as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Partial<ExternalInboxLedgerEntry>;
    const fingerprint = typeof item.fingerprint === "string" && item.fingerprint.trim()
      ? item.fingerprint.trim()
      : key.trim();
    const status = item.status === "waiting"
      || item.status === "processing"
      || item.status === "imported"
      || item.status === "failed"
      ? item.status
      : "waiting";
    if (!fingerprint) continue;
    ledger.entries[fingerprint] = {
      fingerprint,
      fullPath: typeof item.fullPath === "string" ? item.fullPath : "",
      name: typeof item.name === "string" ? item.name : "",
      size: Math.max(0, Math.floor(Number(item.size) || 0)),
      mtimeMs: Math.max(0, Number(item.mtimeMs) || 0),
      status,
      attempts: Math.max(0, Math.floor(Number(item.attempts) || 0)),
      firstSeenAt: Math.max(0, Number(item.firstSeenAt) || 0),
      updatedAt: Math.max(0, Number(item.updatedAt) || 0),
      nextRetryAt: Math.max(0, Number(item.nextRetryAt) || 0),
      notePath: typeof item.notePath === "string" ? item.notePath : "",
      error: typeof item.error === "string" ? item.error : "",
    };
  }
  return ledger;
}

export function shouldImportExternalInboxFile(
  file: ExternalInboxFile,
  ledger: ExternalInboxLedger,
  options: { now?: number; manual?: boolean; maxAttempts?: number } = {},
): boolean {
  const entry = ledger.entries[file.fingerprint];
  if (!entry) return true;
  if (entry.status === "imported" || entry.status === "processing") return false;
  if (entry.status === "waiting") {
    return !!options.manual || entry.nextRetryAt <= (Number(options.now) || Date.now());
  }
  const now = Number(options.now) || Date.now();
  if (options.manual) return true;
  const maxAttempts = Math.max(1, Math.floor(Number(options.maxAttempts) || 3));
  return entry.attempts < maxAttempts && entry.nextRetryAt <= now;
}

export function pruneExternalInboxLedger(
  ledger: ExternalInboxLedger,
  options: { now?: number; maxEntries?: number; maxAgeMs?: number } = {},
): ExternalInboxLedger {
  const now = Number(options.now) || Date.now();
  const maxEntries = Math.max(50, Math.floor(Number(options.maxEntries) || 1000));
  const maxAgeMs = Math.max(24 * 60 * 60 * 1000, Number(options.maxAgeMs) || 180 * 24 * 60 * 60 * 1000);
  const entries = Object.values(ledger.entries)
    .filter((entry) => entry.status !== "imported" || now - entry.updatedAt <= maxAgeMs)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, maxEntries);
  return {
    version: 1,
    entries: Object.fromEntries(entries.map((entry) => [entry.fingerprint, entry])),
  };
}

export class ExternalInboxScanner {
  private observations = new Map<string, StableObservation>();

  reset(): void {
    this.observations.clear();
  }

  async scan(
    fileSystem: ExternalInboxFileSystem,
    rootPath: string,
    supportedExtensions: ReadonlySet<string>,
    options: {
      now?: number;
      quietMs?: number;
      maxDepth?: number;
      maxFiles?: number;
    } = {},
  ): Promise<ExternalInboxScanResult> {
    const now = Number(options.now) || Date.now();
    const quietMs = Math.max(0, Number(options.quietMs) || 0);
    const maxDepth = Math.max(0, Math.floor(Number(options.maxDepth) || 6));
    const maxFiles = Math.max(1, Math.floor(Number(options.maxFiles) || 2000));
    const ready: ExternalInboxFile[] = [];
    const waiting: ExternalInboxFile[] = [];
    const errors: Array<{ path: string; message: string }> = [];
    const seenPaths = new Set<string>();
    let scanned = 0;
    let truncated = false;

    const visit = async (folderPath: string, depth: number): Promise<void> => {
      if (truncated || depth > maxDepth) return;
      let entries: ExternalInboxDirectoryEntry[];
      try {
        entries = await fileSystem.readdir(folderPath);
      } catch (error) {
        errors.push({ path: folderPath, message: error instanceof Error ? error.message : String(error) });
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (truncated) break;
        if (!entry.name || entry.name.startsWith(".")) continue;
        const fullPath = fileSystem.join(folderPath, entry.name);
        if (entry.isDirectory) {
          await visit(fullPath, depth + 1);
          continue;
        }
        if (!entry.isFile) continue;
        const extension = entry.name.includes(".")
          ? entry.name.split(".").pop()?.toLocaleLowerCase() || ""
          : "";
        if (!supportedExtensions.has(extension)) continue;
        if (scanned >= maxFiles) {
          truncated = true;
          break;
        }
        scanned++;
        try {
          const stat = await fileSystem.stat(fullPath);
          if (!stat.isFile || stat.size <= 0) continue;
          seenPaths.add(fullPath);
          const previous = this.observations.get(fullPath);
          const unchanged = !!previous
            && previous.size === stat.size
            && previous.mtimeMs === stat.mtimeMs;
          const stableSince = unchanged ? previous.stableSince : now;
          this.observations.set(fullPath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            stableSince,
          });
          const file: ExternalInboxFile = {
            fullPath,
            name: entry.name,
            extension,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            fingerprint: makeExternalInboxFingerprint(fullPath, stat.size, stat.mtimeMs),
          };
          const observedStable = unchanged && now - stableSince >= quietMs;
          // Cloud clients can preserve the remote mtime while the local file is still being
          // downloaded. Requiring two unchanged observations is safer than trusting mtime.
          if (quietMs === 0 || observedStable) ready.push(file);
          else waiting.push(file);
        } catch (error) {
          errors.push({ path: fullPath, message: error instanceof Error ? error.message : String(error) });
        }
      }
    };

    await visit(rootPath, 0);
    for (const observedPath of this.observations.keys()) {
      if (!seenPaths.has(observedPath)) this.observations.delete(observedPath);
    }
    const byTime = (left: ExternalInboxFile, right: ExternalInboxFile) => left.mtimeMs - right.mtimeMs;
    ready.sort(byTime);
    waiting.sort(byTime);
    return { ready, waiting, scanned, truncated, errors };
  }
}
