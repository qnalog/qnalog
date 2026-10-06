import { describe, expect, it, vi } from "vitest";
import { VersionManifestStore, type VersionManifestHost } from "../src/versions/version-manifest-store";

vi.mock("obsidian", () => ({
  normalizePath: (value: string) => String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, ""),
}));

type MemoryHost = VersionManifestHost & { files: Map<string, string> };

function makeHost(): MemoryHost {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  return {
    files,
    async exists(path) { return files.has(path) || directories.has(path); },
    async read(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error(`Missing file: ${path}`);
      return value;
    },
    async write(path, content) { files.set(path, content); },
    async mkdir(path) { directories.add(path); },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("VersionManifestStore", () => {
  it("returns an in-memory empty manifest for a missing file without creating storage", async () => {
    const host = makeHost();
    const store = new VersionManifestStore(host);

    await expect(store.read("QnALog/.versions/source", "source")).resolves.toEqual({
      version: 1, activeVersionId: "", versions: [], sourceId: "source",
    });
    expect(host.files.size).toBe(0);
  });

  it.each([
    ["invalid JSON", "{"],
    ["array root", "[]"],
    ["foreign source", JSON.stringify({ sourceId: "other", versions: [] })],
    ["non-array versions", JSON.stringify({ versions: {} })],
    ["array record", JSON.stringify({ versions: [[]] })],
    ["missing record id", JSON.stringify({ versions: [{ fileName: "a.md", kind: "minutes" }] })],
    ["non-string id", JSON.stringify({ versions: [{ id: 1, fileName: "a.md", kind: "minutes" }] })],
    ["non-string filename", JSON.stringify({ versions: [{ id: "a", fileName: 1, kind: "minutes" }] })],
    ["non-string kind", JSON.stringify({ versions: [{ id: "a", fileName: "a.md", kind: null }] })],
    ["non-string active id", JSON.stringify({ versions: [], activeVersionId: false })],
  ])("rejects %s without changing the stored bytes", async (_name, content) => {
    const host = makeHost();
    const path = "QnALog/.versions/source/manifest.json";
    host.files.set(path, content);
    const store = new VersionManifestStore(host);

    await expect(store.read("QnALog/.versions/source", "source")).rejects.toThrow("Could not read version metadata");
    expect(host.files.get(path)).toBe(content);
  });

  it("preserves optional omissions, unknown fields, ordering, and version values", async () => {
    const host = makeHost();
    const store = new VersionManifestStore(host);
    const original = {
      version: 7,
      unknown: { nested: ["keep", { active: true }] },
      versions: [
        { id: "second", fileName: "second.md", kind: "minutes", extra: { label: "keep" } },
        { id: "first", fileName: "first.md", kind: "clean" },
      ],
    };
    host.files.set("QnALog/.versions/source/manifest.json", JSON.stringify(original));

    const loaded = await store.read("QnALog/.versions/source", "source");
    expect(loaded).toEqual(original);
    await store.write("QnALog/.versions/source", loaded);
    expect(JSON.parse(await host.read("QnALog/.versions/source/manifest.json"))).toEqual(original);
  });

  it("writes and rereads a missing manifest while preserving the generated source id", async () => {
    const host = makeHost();
    const store = new VersionManifestStore(host);
    const manifest = await store.read("QnALog/.versions/source", "source");
    manifest.versions.push({ id: "one", fileName: "one.md", kind: "minutes" });

    await store.write("QnALog/.versions/source", manifest);

    expect(await store.read("QnALog/.versions/source", "source")).toEqual(manifest);
    expect(host.files.has("QnALog/.versions/source/manifest.json")).toBe(true);
  });

  it("rejects readback that differs byte-for-byte even when JSON meaning is equal", async () => {
    const host = makeHost();
    const store = new VersionManifestStore({
      ...host,
      async write(path, content) { host.files.set(path, content); },
      async read(path) { return JSON.stringify(JSON.parse(await host.read(path))); },
    });

    await expect(store.write("QnALog/.versions/source", { versions: [] }))
      .rejects.toThrow("Could not verify version metadata");
  });

  it("propagates host failures from folder creation, write, and readback", async () => {
    for (const method of ["mkdir", "write", "read"] as const) {
      const failure = new Error(`${method} failed`);
      const host = makeHost();
      const store = new VersionManifestStore({
        ...host,
        async [method](): Promise<never> { throw failure; },
      });
      await expect(store.write("QnALog/.versions/source", { versions: [] })).rejects.toBe(failure);
    }
  });

  it("serializes same-source operations, isolates other sources, and releases after rejection", async () => {
    const store = new VersionManifestStore(makeHost());
    const firstGate = deferred();
    const enteredFirst = deferred();
    const events: string[] = [];
    const first = store.withLock("source", async () => {
      events.push("A-start");
      enteredFirst.resolve();
      await firstGate.promise;
      events.push("A-fail");
      throw new Error("A failed");
    });
    await enteredFirst.promise;
    const second = store.withLock("source", async () => { events.push("B"); return "B-result"; });
    const sameQueueThird = store.withLock("source", async () => { events.push("D"); });
    const otherSource = store.withLock("other", async () => { events.push("C"); });
    await otherSource;
    expect(events).toEqual(["A-start", "C"]);
    firstGate.resolve();

    await expect(first).rejects.toThrow("A failed");
    await expect(second).resolves.toBe("B-result");
    await sameQueueThird;
    expect(events).toEqual(["A-start", "C", "A-fail", "B", "D"]);
  });
});
