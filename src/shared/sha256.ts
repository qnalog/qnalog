/**
 * 增量 SHA-256（FIPS 180-4），纯 TypeScript 实现，不依赖 Node 或 Electron 模块。
 * 计算本身不用全局对象；默认的块间让出用 `window.setTimeout`，调用时才访问，模块加载时不访问。
 *
 * 不用 `crypto.subtle`：它只接受整份数据、没有增量接口，且在 Obsidian 移动端的可用性未核实。
 * `sha256ArrayBuffer` 对已在内存中的 ArrayBuffer 按视图分块计算（不复制整份数据），
 * 每块之间让出事件循环，超过耗时预算时抛出 `Sha256TimeBudgetError`。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** 增量计算器：可多次 `update`，最后调用一次 `digestHex`。 */
export class Sha256 {
  private readonly state = new Uint32Array(INITIAL_STATE);
  private readonly block = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private blockLength = 0;
  private totalBytes = 0;
  private finished = false;

  update(bytes: Uint8Array): this {
    if (this.finished) throw new Error("SHA-256 digest was already produced");
    let offset = 0;
    const length = bytes.length;
    this.totalBytes += length;
    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, length);
      this.block.set(bytes.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset = take;
      if (this.blockLength < 64) return this;
      this.compress(this.block, 0);
      this.blockLength = 0;
    }
    while (offset + 64 <= length) {
      this.compress(bytes, offset);
      offset += 64;
    }
    if (offset < length) {
      this.block.set(bytes.subarray(offset), 0);
      this.blockLength = length - offset;
    }
    return this;
  }

  digestHex(): string {
    if (this.finished) throw new Error("SHA-256 digest was already produced");
    this.finished = true;
    const bitLengthHigh = Math.floor(this.totalBytes / 0x20000000);
    const bitLengthLow = (this.totalBytes * 8) >>> 0;
    this.block[this.blockLength] = 0x80;
    this.block.fill(0, this.blockLength + 1);
    if (this.blockLength + 1 > 56) {
      this.compress(this.block, 0);
      this.block.fill(0);
    }
    this.block[56] = bitLengthHigh >>> 24;
    this.block[57] = bitLengthHigh >>> 16;
    this.block[58] = bitLengthHigh >>> 8;
    this.block[59] = bitLengthHigh;
    this.block[60] = bitLengthLow >>> 24;
    this.block[61] = bitLengthLow >>> 16;
    this.block[62] = bitLengthLow >>> 8;
    this.block[63] = bitLengthLow;
    this.compress(this.block, 0);
    let hex = "";
    for (const value of this.state) hex += value.toString(16).padStart(8, "0");
    return hex;
  }

  private compress(data: Uint8Array, offset: number): void {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15];
      const w2 = w[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    const s = this.state;
    let a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    s[0] = (s[0] + a) >>> 0;
    s[1] = (s[1] + b) >>> 0;
    s[2] = (s[2] + c) >>> 0;
    s[3] = (s[3] + d) >>> 0;
    s[4] = (s[4] + e) >>> 0;
    s[5] = (s[5] + f) >>> 0;
    s[6] = (s[6] + g) >>> 0;
    s[7] = (s[7] + h) >>> 0;
  }
}

/** 超过耗时预算时抛出；调用方据此记日志并放弃，不重试。 */
export class Sha256TimeBudgetError extends Error {
  constructor(readonly processedBytes: number, readonly elapsedMs: number) {
    super(`SHA-256 time budget exceeded after ${processedBytes} bytes (${elapsedMs} ms)`);
    this.name = "Sha256TimeBudgetError";
  }
}

export interface Sha256ChunkOptions {
  /** 每块字节数；默认 2 MiB。 */
  chunkBytes?: number;
  /** 总耗时上限（毫秒）；缺省不限。 */
  timeBudgetMs?: number;
  /** 读取当前时间；测试可替换。 */
  now?: () => number;
  /** 两块之间让出事件循环；测试可替换。 */
  yieldControl?: () => Promise<void>;
}

export const SHA256_DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, 0); });
}

/** 对内存中的 ArrayBuffer 分块计算 SHA-256，返回小写十六进制字符串。 */
export async function sha256ArrayBuffer(buffer: ArrayBuffer, options: Sha256ChunkOptions = {}): Promise<string> {
  const chunkBytes = Math.max(64, Math.floor(options.chunkBytes ?? SHA256_DEFAULT_CHUNK_BYTES));
  const now = options.now ?? (() => Date.now());
  const yieldControl = options.yieldControl ?? yieldToEventLoop;
  const budget = options.timeBudgetMs;
  const startedAt = now();
  const hash = new Sha256();
  const total = buffer.byteLength;
  for (let offset = 0; offset < total; offset += chunkBytes) {
    hash.update(new Uint8Array(buffer, offset, Math.min(chunkBytes, total - offset)));
    if (offset + chunkBytes < total) {
      const elapsed = now() - startedAt;
      if (budget !== undefined && elapsed > budget) throw new Sha256TimeBudgetError(offset + chunkBytes, elapsed);
      await yieldControl();
    }
  }
  return hash.digestHex();
}
