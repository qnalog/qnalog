export interface NoteLayoutSettings {
  consolidatedLayout?: boolean;
}

export interface NoteLayoutSession {
  source?: unknown;
}

const CANONICAL_IMPORT_SOURCES = new Set([
  "import",
  "text-import",
  "merged-notes",
]);

export function isCanonicalImportSource(source: unknown): boolean {
  return typeof source === "string"
    && CANONICAL_IMPORT_SOURCES.has(source.trim());
}

/**
 * Imported material starts as a temporary raw-transcript shell. Once AI
 * organization succeeds it must be rebuilt into the canonical note layout,
 * otherwise the final briefing is appended below the raw transcript.
 */
export function shouldRewriteConsolidatedNote(
  settings: NoteLayoutSettings | null | undefined,
  session: NoteLayoutSession | null | undefined,
): boolean {
  return settings?.consolidatedLayout !== false
    || isCanonicalImportSource(session?.source);
}
