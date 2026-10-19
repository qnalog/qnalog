// 移动端录音期间阻止屏幕自动熄灭：优先 Screen Wake Lock，不可用时退回静音循环视频。
// 申请失败只写诊断日志，不影响录音本身。

type WakeLockSentinelLike = {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
};

type NavigatorWithWakeLock = {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
};

type VisibilityDocument = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

/** 兜底用的隐藏视频；pause 之后不再占用屏幕常亮。 */
export interface WakeVideo {
  play(): Promise<void>;
  pause(): void;
  remove(): void;
}

export interface ScreenWakeGuardDeps {
  isMobile(): boolean;
  /** 仍在录音时返回 true；页面回到前台后据此决定是否重新申请。 */
  isRecording(): boolean;
  log(code: string, message: string, data: Record<string, unknown>): void;
  nav?: NavigatorWithWakeLock;
  doc?: VisibilityDocument;
  createVideo?: () => WakeVideo | null;
}

/** 默认的兜底视频：1×1 像素、静音、行内播放、循环，画面来自 canvas 采集流。 */
export function createHiddenLoopVideo(): WakeVideo | null {
  if (typeof document === "undefined") return null;
  const canvas = createEl("canvas");
  canvas.width = 1;
  canvas.height = 1;
  if (typeof canvas.captureStream !== "function") return null;
  const video = document.body.createEl("video", { cls: "qnalog-wake-video" });
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-hidden", "true");
  video.srcObject = canvas.captureStream(1);
  return { play: () => video.play(), pause: () => video.pause(), remove: () => video.remove() };
}

export class ScreenWakeGuard {
  private active = false;
  private sentinel: WakeLockSentinelLike | null = null;
  private video: WakeVideo | null = null;
  private requesting = false;
  private readonly onVisibility = () => {
    const doc = this.doc();
    if (!doc || doc.visibilityState !== "visible" || !this.active) return;
    if (!this.deps.isRecording()) { void this.release(); return; }
    void this.request();
  };

  constructor(private readonly deps: ScreenWakeGuardDeps) {}

  private doc(): VisibilityDocument | null {
    return this.deps.doc ?? (typeof document !== "undefined" ? document : null);
  }
  private nav(): NavigatorWithWakeLock | null {
    return this.deps.nav ?? (typeof navigator !== "undefined" ? navigator : null);
  }

  async acquire(): Promise<void> {
    if (this.active || !this.deps.isMobile()) return;
    this.active = true;
    this.doc()?.addEventListener("visibilitychange", this.onVisibility);
    await this.request();
  }

  async release(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.doc()?.removeEventListener("visibilitychange", this.onVisibility);
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (sentinel) {
      try { await sentinel.release(); } catch (e) { this.logFailure("release", e); }
    }
    if (this.video) {
      try { this.video.pause(); this.video.remove(); } catch (e) { this.logFailure("video-release", e); }
      this.video = null;
    }
  }

  private async request(): Promise<void> {
    if (this.requesting || this.sentinel) return;
    this.requesting = true;
    try {
      const wakeLock = this.nav()?.wakeLock;
      if (wakeLock) {
        try {
          const sentinel = await wakeLock.request("screen");
          if (!this.active) { await sentinel.release().catch(() => undefined); return; }
          sentinel.addEventListener("release", () => { if (this.sentinel === sentinel) this.sentinel = null; });
          this.sentinel = sentinel;
          return;
        } catch (e) {
          this.logFailure("wake-lock", e);
        }
      }
      await this.startVideoFallback();
    } finally {
      this.requesting = false;
    }
  }

  private async startVideoFallback(): Promise<void> {
    try {
      if (!this.video) this.video = (this.deps.createVideo ?? createHiddenLoopVideo)();
      if (!this.video) { this.logFailure("video-unavailable", new Error("no fallback video source")); return; }
      await this.video.play();
    } catch (e) {
      this.logFailure("video-play", e);
    }
  }

  private logFailure(stage: string, error: unknown): void {
    try {
      this.deps.log("recording.wake_lock_failed", "Screen wake lock unavailable", {
        stage,
        error: error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error",
      });
    } catch { /* diagnostics must not affect recording */ }
  }
}
