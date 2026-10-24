import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Sha256, Sha256TimeBudgetError, sha256ArrayBuffer } from "../src/shared/sha256";

const encoder = new TextEncoder();

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function nodeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pseudoRandomBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

describe("Sha256 (FIPS 180-4 test vectors)", () => {
  it("hashes the empty message", () => {
    expect(new Sha256().digestHex()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashes \"abc\"", () => {
    expect(new Sha256().update(encoder.encode("abc")).digestHex())
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes the two-block NIST message", () => {
    expect(new Sha256().update(encoder.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).digestHex())
      .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("hashes one million repetitions of \"a\"", async () => {
    const bytes = new Uint8Array(1_000_000).fill(0x61);
    const expected = "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0";
    expect(new Sha256().update(bytes).digestHex()).toBe(expected);
    expect(await sha256ArrayBuffer(bufferOf(bytes), { chunkBytes: 4096, yieldControl: async () => undefined })).toBe(expected);
  });

  it("refuses to produce a second digest", () => {
    const hash = new Sha256();
    hash.digestHex();
    expect(() => hash.digestHex()).toThrow();
    expect(() => hash.update(new Uint8Array([1]))).toThrow();
  });
});

describe("Sha256 incremental updates", () => {
  it("matches node:crypto for lengths around the 55/56/64-byte padding boundaries", () => {
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
      const bytes = pseudoRandomBytes(length, length + 7);
      expect(new Sha256().update(bytes).digestHex(), `length ${length}`).toBe(nodeSha256(bytes));
    }
  });

  it("gives the same digest regardless of how the input is split", () => {
    const bytes = pseudoRandomBytes(10_007, 42);
    const expected = nodeSha256(bytes);
    for (const step of [1, 3, 63, 65, 1000, 4099]) {
      const hash = new Sha256();
      for (let offset = 0; offset < bytes.length; offset += step) hash.update(bytes.subarray(offset, offset + step));
      expect(hash.digestHex(), `step ${step}`).toBe(expected);
    }
  });

  it("chunks an ArrayBuffer with chunk sizes that do not divide the input", async () => {
    const bytes = pseudoRandomBytes(3 * 1024 * 1024 + 17, 9);
    const expected = nodeSha256(bytes);
    const yieldControl = async () => undefined;
    for (const chunkBytes of [64, 1000, 65_537, 1024 * 1024]) {
      expect(await sha256ArrayBuffer(bufferOf(bytes), { chunkBytes, yieldControl }), `chunk ${chunkBytes}`).toBe(expected);
    }
    // The default yield uses window.setTimeout (Obsidian's popout-safe timer).
    vi.stubGlobal("window", { setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms) });
    try {
      expect(await sha256ArrayBuffer(bufferOf(bytes)), "default chunk size and yield").toBe(expected);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hashes only the bytes inside the ArrayBuffer and does not modify them", async () => {
    const bytes = pseudoRandomBytes(5000, 3);
    const copy = bytes.slice();
    const buffer = bufferOf(bytes);
    await sha256ArrayBuffer(buffer, { chunkBytes: 777, yieldControl: async () => undefined });
    expect(new Uint8Array(buffer)).toEqual(copy);
  });

  it("yields between chunks", async () => {
    let yields = 0;
    await sha256ArrayBuffer(new ArrayBuffer(1000), { chunkBytes: 300, yieldControl: async () => { yields++; } });
    expect(yields).toBe(3);
  });

  it("stops with Sha256TimeBudgetError when computation time exceeds the budget", async () => {
    let clock = 0;
    // Each now() call advances 5 ms, so each chunk counts 5 ms of computation; 10 chunks exceed 25 ms.
    const run = sha256ArrayBuffer(new ArrayBuffer(10_000), {
      chunkBytes: 1000,
      timeBudgetMs: 25,
      now: () => (clock += 5),
      yieldControl: async () => {},
    });
    await expect(run).rejects.toBeInstanceOf(Sha256TimeBudgetError);
  });

  it("does not count time spent between chunks, such as the app being suspended in the background", async () => {
    let clock = 0;
    const input = new Uint8Array(10_000).map((_, i) => i % 251);
    // Computation takes no clock time; each yield jumps the clock by 10 minutes, far beyond the budget.
    const digest = await sha256ArrayBuffer(input.buffer, {
      chunkBytes: 1000,
      timeBudgetMs: 25,
      now: () => clock,
      yieldControl: async () => { clock += 600_000; },
    });
    expect(digest).toBe(createHash("sha256").update(input).digest("hex"));
  });
});
