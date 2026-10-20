import { isSafeVaultAudioPath, isSafeVaultRelativePath } from "../audio/vault-audio-path";
import type * as obsidian from "obsidian";

export interface AdapterAudioTimeSource {
  kind: "adapter";
  path: string;
  name: string;
  extension: string;
  readBinary(): Promise<ArrayBuffer>;
}

export type AudioTimePlaybackSource =
  | { kind: "file"; file: obsidian.TFile }
  | AdapterAudioTimeSource;

export interface AudioTimeSourceVault {
  adapter?: {
    exists(path: string): Promise<boolean>;
    readBinary(path: string): Promise<ArrayBuffer>;
  } | null;
}

/** Decode one wiki-link path layer while keeping fragment/alias syntax out of the vault path. */
export function decodeAudioTimeLinkPath(linkPath: string): string | null {
  const rawTarget = String(linkPath || "").split("#")[0].split("|")[0].trim();
  if (!isSafeVaultRelativePath(rawTarget)) return null;
  const decodedParts: string[] = [];
  for (const part of rawTarget.split("/")) {
    let decoded = part;
    try { decoded = decodeURIComponent(part); }
    catch { /* A literal percent in an older link remains a literal path character. */ }
    if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return null;
    decodedParts.push(decoded);
  }
  const decodedPath = decodedParts.join("/");
  return isSafeVaultAudioPath(decodedPath) ? decodedPath : null;
}

export function encodeAudioTimeLinkPath(path: string): string {
  return path.split("/").map(part => encodeURIComponent(part)).join("/");
}

/** Resolve only the exact cache path from an audio time-link. */
export async function resolveSegmentCacheAudioTimeSource(
  vault: AudioTimeSourceVault,
  linkPath: string,
  cacheFolder: string,
): Promise<AdapterAudioTimeSource | null> {
  const folder = normalizeCacheFolder(cacheFolder);
  if (!folder || !isSafeVaultAudioPath(linkPath)) return null;
  const exactPath = linkPath;
  if (!exactPath.startsWith(`${folder}/`)) return null;
  const adapter = vault.adapter;
  if (!adapter || !(await adapter.exists(exactPath))) return null;
  const name = exactPath.split("/").pop() || exactPath;
  return {
    kind: "adapter",
    path: exactPath,
    name,
    extension: name.split(".").pop()?.toLowerCase() || "",
    readBinary: () => adapter.readBinary(exactPath),
  };
}

export function isSegmentCacheAudioTimePath(linkPath: string, cacheFolder: string): boolean {
  const folder = normalizeCacheFolder(cacheFolder);
  return !!folder && isSafeVaultAudioPath(linkPath) && linkPath.startsWith(`${folder}/`);
}

function normalizeCacheFolder(cacheFolder: string): string {
  const folder = cacheFolder.trim().replace(/\/+$/, "");
  return isSafeVaultRelativePath(folder) ? folder : "";
}
