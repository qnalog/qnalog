export interface NoteLayoutSession {
  source?: unknown;
}

export function isTextImportSession(session: NoteLayoutSession | null | undefined): boolean {
  return !!(session && session.source === "text-import");
}
