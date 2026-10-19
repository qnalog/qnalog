import type { MasterPartialAdapter } from "../../src/audio/master-partial";

// 内存中的适配器：按路径保存文件，目录由路径前缀体现。失败注入通过 hooks 完成。
export class MemoryAdapter implements MasterPartialAdapter {
  files = new Map<string, string | ArrayBuffer>();
  dirs = new Set<string>();
  hooks: {
    writeBinary?: (path: string, data: ArrayBuffer) => Promise<void> | void;
    writeBinaryAfter?: (path: string, data: ArrayBuffer) => Promise<void> | void;
    write?: (path: string, data: string) => Promise<void> | void;
    read?: (path: string) => Promise<void> | void;
    rename?: (from: string, to: string) => Promise<void> | void;
    rmdir?: (path: string) => void;
    statSize?: (path: string, size: number) => number;
  } = {};

  async exists(path: string): Promise<boolean> { return this.files.has(path) || this.dirs.has(path); }
  async mkdir(path: string): Promise<void> { this.dirs.add(path); }
  async write(path: string, data: string): Promise<void> {
    if (this.hooks.write) await this.hooks.write(path, data);
    this.files.set(path, data);
  }
  async read(path: string): Promise<string> {
    if (this.hooks.read) await this.hooks.read(path);
    const value = this.files.get(path);
    if (typeof value !== "string") throw new Error(`ENOENT ${path}`);
    return value;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    if (this.hooks.writeBinary) await this.hooks.writeBinary(path, data);
    this.files.set(path, data.slice(0));
    if (this.hooks.writeBinaryAfter) await this.hooks.writeBinaryAfter(path, data);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.files.get(path);
    if (!(value instanceof ArrayBuffer)) throw new Error(`ENOENT ${path}`);
    return value.slice(0);
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    const direct = (name: string): boolean => name.startsWith(prefix) && !name.slice(prefix.length).includes("/");
    return {
      files: [...this.files.keys()].filter(direct),
      folders: [...this.dirs].filter(direct),
    };
  }
  async stat(path: string): Promise<{ size: number } | null> {
    const value = this.files.get(path);
    if (value === undefined) return null;
    const size = typeof value === "string" ? value.length : value.byteLength;
    return { size: this.hooks.statSize ? this.hooks.statSize(path, size) : size };
  }
  async remove(path: string): Promise<void> { this.files.delete(path); }
  async rename(from: string, to: string): Promise<void> {
    if (this.hooks.rename) await this.hooks.rename(from, to);
    if (this.files.has(to)) throw new Error(`EEXIST ${to}`);
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`ENOENT ${from}`);
    this.files.set(to, value);
    this.files.delete(from);
  }
  async rmdir(path: string, recursive: boolean): Promise<void> {
    if (this.hooks.rmdir) this.hooks.rmdir(path);
    const prefix = `${path}/`;
    const hasChildren = [...this.files.keys()].some((key) => key.startsWith(prefix))
      || [...this.dirs].some((dir) => dir.startsWith(prefix));
    if (!recursive && hasChildren) throw new Error(`ENOTEMPTY ${path}`);
    for (const key of [...this.files.keys()]) if (key.startsWith(`${path}/`)) this.files.delete(key);
    for (const dir of [...this.dirs]) if (dir === path || dir.startsWith(`${path}/`)) this.dirs.delete(dir);
  }
  text(path: string): string {
    const value = this.files.get(path);
    if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
    return String(value ?? "");
  }
}
