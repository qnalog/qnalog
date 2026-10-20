import { AUDIO_EXT } from "../shared/catalog-import";

/** Return whether a path names a relative audio file inside the vault. */
export function isSafeVaultAudioPath(path: string): boolean {
  if (!isSafeVaultRelativePath(path)) return false;
  const extension = (path.split("/").pop()?.split(".").pop() || "").toLowerCase();
  return AUDIO_EXT.has(extension);
}

export function isSafeVaultRelativePath(path: string): boolean {
  if (!path || path !== path.trim() || path.includes("\\") || path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  const parts = path.split("/");
  return !parts.some(part => !part || part === "." || part === "..");
}
