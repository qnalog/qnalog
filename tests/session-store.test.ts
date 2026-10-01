import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/session/session-store";
import type { RecordingSession } from "../src/shared/types";

function createSession(id: string): RecordingSession {
  return { id, segments: [], mdPath: `${id}.md` } as RecordingSession;
}

describe("SessionStore", () => {
  it("publishes identity transitions and refuses to end a replaced session", () => {
    const store = new SessionStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const first = createSession("first");
    const second = createSession("second");

    expect(store.get()).toBeNull();
    store.begin(first);
    expect(store.get()).toBe(first);
    store.begin(first);
    expect(listener).toHaveBeenCalledTimes(1);
    store.begin(second);
    expect(listener).toHaveBeenLastCalledWith(second, first);
    expect(store.end(first)).toBe(false);
    expect(store.get()).toBe(second);
    expect(store.end(second)).toBe(true);
    expect(store.get()).toBeNull();
    expect(listener).toHaveBeenLastCalledWith(null, second);

    unsubscribe();
    store.begin(first);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("allows a listener removed during notification to stop receiving that transition", () => {
    const store = new SessionStore();
    const later = vi.fn();
    let unsubscribeLater = () => undefined;
    store.subscribe(() => unsubscribeLater());
    unsubscribeLater = store.subscribe(later);

    store.begin(createSession("first"));
    expect(later).not.toHaveBeenCalled();
  });
});
