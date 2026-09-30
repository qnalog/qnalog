import type { RecordingSession } from "../shared/types";

export type SessionStoreListener = (
  current: RecordingSession | null,
  previous: RecordingSession | null,
) => void;

/** Owns the identity of the active recording/import session. */
export class SessionStore {
  private current: RecordingSession | null = null;
  private readonly listeners = new Set<SessionStoreListener>();

  get(): RecordingSession | null {
    return this.current;
  }

  begin(session: RecordingSession): void {
    if (this.current === session) return;
    const previous = this.current;
    this.current = session;
    for (const listener of [...this.listeners]) {
      if (this.listeners.has(listener)) listener(session, previous);
    }
  }

  end(expected: RecordingSession): boolean {
    if (!this.current || this.current !== expected) return false;
    const previous = this.current;
    this.current = null;
    for (const listener of [...this.listeners]) {
      if (this.listeners.has(listener)) listener(null, previous);
    }
    return true;
  }

  subscribe(listener: SessionStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
