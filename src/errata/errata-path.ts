import { NS_ERRATA_FOLDER } from "../shared/namespace";

function normalizePath(path: string): string {
  return String(path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function isErrataPath(path: string): boolean {
  const normalized = normalizePath(path).toLocaleLowerCase();
  const root = normalizePath(NS_ERRATA_FOLDER).toLocaleLowerCase();
  return normalized === root || normalized.startsWith(`${root}/`);
}
