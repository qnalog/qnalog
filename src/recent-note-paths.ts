export function normalizeRecentNoteRoot(value: unknown): string {
  const root = (typeof value === "string" ? value : "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
  return root === "." || root === "/" ? "" : root;
}

export function normalizeRecentNoteRoots(values: unknown[]): string[] {
  const unique = Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map(normalizeRecentNoteRoot)
  ));
  if (unique.includes("")) return [""];
  unique.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const roots: string[] = [];
  for (const root of unique) {
    if (roots.some((parent) => root === parent || root.startsWith(`${parent}/`))) continue;
    roots.push(root);
  }
  return roots;
}

export function isPathUnderRecentNoteRoots(pathValue: unknown, rootsValue: unknown[]): boolean {
  const path = normalizeRecentNoteRoot(pathValue);
  if (!path) return false;
  const roots = normalizeRecentNoteRoots(rootsValue);
  return roots.some((root) => !root || path === root || path.startsWith(`${root}/`));
}

export function getRecentNoteParentPath(pathValue: unknown): string {
  const path = normalizeRecentNoteRoot(pathValue);
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

export function getRecentNotePathRelativeToRoot(pathValue: unknown, rootValue: unknown): string {
  const path = normalizeRecentNoteRoot(pathValue);
  const root = normalizeRecentNoteRoot(rootValue);
  if (!path) return "";
  if (!root) return path;
  if (path === root) return "";
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : "";
}

export function getRecentNoteTopLevelFolder(pathValue: unknown, rootValue: unknown): string {
  const relative = getRecentNotePathRelativeToRoot(pathValue, rootValue);
  return relative ? relative.split("/")[0] : "";
}
