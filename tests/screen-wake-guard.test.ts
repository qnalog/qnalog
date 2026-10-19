import { describe, expect, it, vi } from "vitest";
import { ScreenWakeGuard, type WakeVideo } from "../src/audio/screen-wake-guard";
import { watchRecordingVisibility } from "../src/audio/recording-visibility-guard";

function makeDoc() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_t: string, fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_t: string, fn: () => void) => { listeners.delete(fn); },
  };
  return { doc: doc as unknown as Document, setState(v: DocumentVisibilityState) { doc.visibilityState = v; listeners.forEach((fn) => fn()); }, listeners };
}
function makeSentinel() {
  let onRelease: (() => void) | null = null;
  return {
    release: vi.fn(async () => { onRelease?.(); }),
    addEventListener: (_t: "release", fn: () => void) => { onRelease = fn; },
    systemRelease: () => onRelease?.(),
  };
}
function makeVideo(): WakeVideo & { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
  return { play: vi.fn(async () => undefined), pause: vi.fn(), remove: vi.fn() };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ScreenWakeGuard", () => {
  it("requests a screen wake lock on acquire and releases it on release", async () => {
    const sentinel = makeSentinel();
    const request = vi.fn(async () => sentinel);
    const { doc, listeners } = makeDoc();
    const guard = new ScreenWakeGuard({ isMobile: () => true, isRecording: () => true, log: vi.fn(), nav: { wakeLock: { request } }, doc });
    await guard.acquire();
    expect(request).toHaveBeenCalledWith("screen");
    await guard.release();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it("does nothing on desktop", async () => {
    const request = vi.fn();
    const guard = new ScreenWakeGuard({ isMobile: () => false, isRecording: () => true, log: vi.fn(), nav: { wakeLock: { request } }, doc: makeDoc().doc });
    await guard.acquire();
    expect(request).not.toHaveBeenCalled();
  });

  it("re-requests the lock when the page becomes visible while still recording", async () => {
    const first = makeSentinel();
    const second = makeSentinel();
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const env = makeDoc();
    const guard = new ScreenWakeGuard({ isMobile: () => true, isRecording: () => true, log: vi.fn(), nav: { wakeLock: { request } }, doc: env.doc });
    await guard.acquire();
    env.setState("hidden");
    first.systemRelease(); // the system drops the lock when the page is hidden
    env.setState("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("stops listening and does not re-request once recording has ended", async () => {
    const request = vi.fn(async () => makeSentinel());
    const env = makeDoc();
    let recording = true;
    const guard = new ScreenWakeGuard({ isMobile: () => true, isRecording: () => recording, log: vi.fn(), nav: { wakeLock: { request } }, doc: env.doc });
    await guard.acquire();
    recording = false;
    env.setState("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(env.listeners.size).toBe(0);
  });

  it("falls back to the hidden video when wakeLock is missing, and removes it on release", async () => {
    const video = makeVideo();
    const guard = new ScreenWakeGuard({ isMobile: () => true, isRecording: () => true, log: vi.fn(), nav: {}, doc: makeDoc().doc, createVideo: () => video });
    await guard.acquire();
    expect(video.play).toHaveBeenCalledTimes(1);
    await guard.release();
    expect(video.pause).toHaveBeenCalled();
    expect(video.remove).toHaveBeenCalled();
  });

  it("falls back to the video and logs when the wake lock request fails", async () => {
    const video = makeVideo();
    const log = vi.fn();
    const request = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    const guard = new ScreenWakeGuard({ isMobile: () => true, isRecording: () => true, log, nav: { wakeLock: { request } }, doc: makeDoc().doc, createVideo: () => video });
    await expect(guard.acquire()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("recording.wake_lock_failed", expect.any(String), expect.objectContaining({ stage: "wake-lock" }));
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it("never throws when neither wake lock nor video is available", async () => {
    const log = vi.fn();
    const guard = new ScreenWakeGuard({ isMobile: () => true, isRecording: () => true, log, nav: {}, doc: makeDoc().doc, createVideo: () => null });
    await expect(guard.acquire()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });
});

describe("watchRecordingVisibility", () => {
  it("calls onHidden when the page is hidden and onVisible when it returns", () => {
    const env = makeDoc();
    const handlers = { onHidden: vi.fn(), onVisible: vi.fn() };
    const stop = watchRecordingVisibility(handlers, env.doc);
    env.setState("hidden");
    expect(handlers.onHidden).toHaveBeenCalledTimes(1);
    env.setState("visible");
    expect(handlers.onVisible).toHaveBeenCalledTimes(1);
    stop();
    env.setState("hidden");
    expect(handlers.onHidden).toHaveBeenCalledTimes(1);
  });
});
