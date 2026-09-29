import { NS_API_KEY_SECRET_PREFIX } from "./namespace";
export interface ApiKeySecretStorage {
  getSecret(id: string): string | null;
  listSecrets(): string[];
  setSecret(id: string, secret: string): void;
}

interface ApiKeyEntry {
  owner: Record<string, unknown>;
  key: string;
  id: string;
  value: string;
}

interface SecretChange {
  id: string;
  previous: string | null;
  next: string;
}

export interface ApiKeyRestoreResult {
  needsPersist: boolean;
  failures: number;
}

const API_KEY_NAMESPACE_RE = /^[a-f0-9]{32}$/;
const MAX_SETTINGS_DEPTH = 32;

type SecretPathPart = string | number;

export function isValidApiKeyStorageNamespace(value: unknown): value is string {
  return typeof value === "string" && API_KEY_NAMESPACE_RE.test(value);
}

export function createApiKeyStorageNamespace(): string {
  const cryptoApi = window.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
    throw new Error("Secure random values are not available for API key storage.");
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function apiKeySecretPrefix(namespace: string): string {
  if (!isValidApiKeyStorageNamespace(namespace)) {
    throw new Error("The API key storage namespace is invalid.");
  }
  return `${NS_API_KEY_SECRET_PREFIX}-${namespace}-`;
}

function apiKeySecretId(namespace: string, path: SecretPathPart[]): string {
  const pathBytes = new TextEncoder().encode(JSON.stringify(path));
  let encodedPath = "";
  for (const byte of pathBytes) encodedPath += byte.toString(16).padStart(2, "0");
  return `${apiKeySecretPrefix(namespace)}${encodedPath}`;
}

function collectApiKeyEntries(
  value: unknown,
  namespace: string,
  path: SecretPathPart[] = [],
  entries: ApiKeyEntry[] = [],
  depth = 0,
): ApiKeyEntry[] {
  if (!value || typeof value !== "object" || depth > MAX_SETTINGS_DEPTH) return entries;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectApiKeyEntries(value[index], namespace, [...path, index], entries, depth + 1);
    }
    return entries;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (typeof child === "string" && /apikey$/i.test(key)) {
      entries.push({ owner: record, key, id: apiKeySecretId(namespace, [...path, key]), value: child });
    } else {
      collectApiKeyEntries(child, namespace, [...path, key], entries, depth + 1);
    }
  }
  return entries;
}

/** Loads canonical stored secrets, or imports legacy values from the settings object. */
export function restoreApiKeySecrets(
  settings: unknown,
  storage: ApiKeySecretStorage,
  namespace: string,
  allowWrite: boolean,
): ApiKeyRestoreResult {
  const entries = collectApiKeyEntries(settings, namespace);
  let needsPersist = false;
  let failures = 0;

  for (const entry of entries) {
    let stored: string | null;
    try {
      stored = storage.getSecret(entry.id);
    } catch {
      failures += 1;
      if (entry.value) needsPersist = true;
      continue;
    }

    if (stored !== null) {
      entry.owner[entry.key] = stored;
      if (entry.value) needsPersist = true;
      continue;
    }

    if (!entry.value) continue;
    needsPersist = true;
    if (!allowWrite) continue;
    try {
      storage.setSecret(entry.id, entry.value);
    } catch {
      failures += 1;
    }
  }

  return { needsPersist, failures };
}

/** Stores keys, clears obsolete entries, then blanks key fields in the data.json snapshot. */
export function storeApiKeySecrets(
  settings: unknown,
  storage: ApiKeySecretStorage,
  namespace: string,
): void {
  const prefix = apiKeySecretPrefix(namespace);
  const entries = collectApiKeyEntries(settings, namespace);
  const activeIds = new Set(entries.map(entry => entry.id));
  const changes: SecretChange[] = [];

  try {
    const listedIds = storage.listSecrets().filter(id => id.startsWith(prefix));
    for (const entry of entries) {
      const previous = storage.getSecret(entry.id);
      if (entry.value !== "" && previous !== entry.value) {
        changes.push({ id: entry.id, previous, next: entry.value });
      } else if (entry.value === "" && previous !== null && previous !== "") {
        changes.push({ id: entry.id, previous, next: "" });
      }
    }

    for (const id of listedIds) {
      if (activeIds.has(id)) continue;
      const previous = storage.getSecret(id);
      if (previous !== null && previous !== "") changes.push({ id, previous, next: "" });
    }
  } catch {
    throw new ApiKeyStorageError();
  }

  const applied: SecretChange[] = [];
  try {
    for (const change of changes) {
      storage.setSecret(change.id, change.next);
      applied.push(change);
    }
  } catch {
    let rollbackFailed = false;
    for (let index = applied.length - 1; index >= 0; index -= 1) {
      const change = applied[index];
      try {
        storage.setSecret(change.id, change.previous ?? "");
      } catch {
        rollbackFailed = true;
      }
    }
    throw new ApiKeyStorageError(rollbackFailed);
  }

  for (const entry of entries) entry.owner[entry.key] = "";
}

export class ApiKeyStorageError extends Error {
  readonly rollbackFailed: boolean;

  constructor(rollbackFailed = false) {
    super("Obsidian SecretStorage could not save QnALog API keys.");
    this.name = "ApiKeyStorageError";
    this.rollbackFailed = rollbackFailed;
  }
}
