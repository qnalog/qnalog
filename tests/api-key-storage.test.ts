import { describe, expect, it } from "vitest";
import {
  isValidApiKeyStorageNamespace,
  restoreApiKeySecrets,
  storeApiKeySecrets,
  type ApiKeySecretStorage,
} from "../src/shared/api-key-storage";
import { deobfuscateApiKey } from "../src/shared/util-key-diag";

class MemorySecretStorage implements ApiKeySecretStorage {
  readonly values = new Map<string, string>();
  failWrites = false;
  failOnWriteNumber = 0;
  writeCount = 0;

  getSecret(id: string): string | null {
    return this.values.has(id) ? this.values.get(id)! : null;
  }

  listSecrets(): string[] {
    return [...this.values.keys()];
  }

  setSecret(id: string, secret: string): void {
    this.writeCount += 1;
    if (this.failWrites || this.writeCount === this.failOnWriteNumber) throw new Error("storage unavailable");
    this.values.set(id, secret);
  }
}

const NAMESPACE = "0123456789abcdef0123456789abcdef";

function settingsWithKeys() {
  return {
    security: { apiKeyStorageNamespace: NAMESPACE },
    speech: {
      compatApiKey: "legacy-compat-key",
      providers: { "provider.with.dot": { apiKey: "provider-key" } },
    },
    composer: {
      apiKey: "llm-key",
      profiles: [{ id: "profile-a", apiKey: "profile-key", asr: { providerId: "openai", apiKey: "asr-key" } }],
    },
  };
}

describe("API Key SecretStorage", () => {
  it("imports nested legacy keys, then writes a data.json snapshot without key values", () => {
    const storage = new MemorySecretStorage();
    const snapshot = settingsWithKeys();
    const restored = restoreApiKeySecrets(snapshot, storage, NAMESPACE, true);

    expect(restored).toEqual({ needsPersist: true, failures: 0 });
    expect(storage.values.size).toBe(5);
    expect([...storage.values.keys()].every(id => /^qnalog-key-[a-f0-9-]+$/.test(id))).toBe(true);

    const savedSnapshot = JSON.parse(JSON.stringify(snapshot)) as ReturnType<typeof settingsWithKeys>;
    storeApiKeySecrets(savedSnapshot, storage, NAMESPACE);
    expect(JSON.stringify(savedSnapshot)).not.toMatch(/legacy-compat-key|provider-key|llm-key|profile-key|asr-key/);
    expect(savedSnapshot.speech.compatApiKey).toBe("");
    expect(savedSnapshot.speech.providers["provider.with.dot"].apiKey).toBe("");
    expect(savedSnapshot.composer.profiles[0].asr.apiKey).toBe("");
  });

  it("restores keys from SecretStorage when serialized setting fields are empty", () => {
    const storage = new MemorySecretStorage();
    const source = settingsWithKeys();
    restoreApiKeySecrets(source, storage, NAMESPACE, true);
    const persisted = JSON.parse(JSON.stringify(source)) as ReturnType<typeof settingsWithKeys>;
    storeApiKeySecrets(persisted, storage, NAMESPACE);

    const restored = restoreApiKeySecrets(persisted, storage, NAMESPACE, true);
    expect(restored).toEqual({ needsPersist: false, failures: 0 });
    expect(persisted.speech.compatApiKey).toBe("legacy-compat-key");
    expect(persisted.composer.profiles[0].asr.apiKey).toBe("asr-key");
  });

  it("clears removed-profile secrets and explicitly cleared keys", () => {
    const storage = new MemorySecretStorage();
    const persisted = settingsWithKeys();
    storeApiKeySecrets(persisted, storage, NAMESPACE);
    const values = [...storage.values.entries()];
    const compatId = values.find(([, value]) => value === "legacy-compat-key")![0];
    const profileIds = values
      .filter(([, value]) => value === "profile-key" || value === "asr-key")
      .map(([id]) => id);
    const runtimeSettings = settingsWithKeys();

    runtimeSettings.speech.compatApiKey = "";
    runtimeSettings.composer.profiles = [];
    storeApiKeySecrets(runtimeSettings, storage, NAMESPACE);

    expect(storage.getSecret(compatId)).toBe("");
    for (const id of profileIds) expect(storage.getSecret(id)).toBe("");
    expect(values.filter(([, value]) => value === "provider-key").every(([id]) => storage.getSecret(id) === "provider-key")).toBe(true);
    expect(values.filter(([, value]) => value === "llm-key").every(([id]) => storage.getSecret(id) === "llm-key")).toBe(true);
  });

  it("leaves the snapshot unchanged when SecretStorage writes fail", () => {
    const storage = new MemorySecretStorage();
    storage.failWrites = true;
    const snapshot = settingsWithKeys();
    const original = JSON.stringify(snapshot);

    expect(() => storeApiKeySecrets(snapshot, storage, NAMESPACE)).toThrow(/SecretStorage/);
    expect(JSON.stringify(snapshot)).toBe(original);
    expect(storage.values.size).toBe(0);
  });

  it("rolls back earlier secret writes before leaving the snapshot unchanged", () => {
    const storage = new MemorySecretStorage();
    storage.failOnWriteNumber = 2;
    const snapshot = settingsWithKeys();
    const original = JSON.stringify(snapshot);

    expect(() => storeApiKeySecrets(snapshot, storage, NAMESPACE)).toThrow(/SecretStorage/);
    expect(JSON.stringify(snapshot)).toBe(original);
    expect([...storage.values.values()]).toEqual([""]);
  });

  it("future-schema reads do not write legacy keys into SecretStorage", () => {
    const storage = new MemorySecretStorage();
    const snapshot = settingsWithKeys();

    const restored = restoreApiKeySecrets(snapshot, storage, NAMESPACE, false);
    expect(restored.needsPersist).toBe(true);
    expect(restored.failures).toBe(0);
    expect(storage.values.size).toBe(0);
    expect(snapshot.composer.apiKey).toBe("llm-key");
  });
  it("decodes a legacy key before importing it into SecretStorage", () => {
    const storage = new MemorySecretStorage();
    const apiKey = deobfuscateApiKey("qnk1:JQsyOEIGXwVCCAQV");
    const snapshot = { composer: { apiKey } };

    expect(apiKey).toBe("test-api-key");
    expect(restoreApiKeySecrets(snapshot, storage, NAMESPACE, true)).toEqual({ needsPersist: true, failures: 0 });
    expect([...storage.values.values()]).toEqual(["test-api-key"]);
    storeApiKeySecrets(snapshot, storage, NAMESPACE);
    expect(snapshot.composer.apiKey).toBe("");
  });

  it("accepts only generated-format vault namespaces", () => {
    expect(isValidApiKeyStorageNamespace(NAMESPACE)).toBe(true);
    expect(isValidApiKeyStorageNamespace("../vault")).toBe(false);
    expect(isValidApiKeyStorageNamespace("0123456789ABCDEF0123456789ABCDEF")).toBe(false);
  });
});
