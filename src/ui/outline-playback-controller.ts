import type { NoteAudioInterval } from "../notes/note-audio-timeline";
import { mapNoteTimeToAudio } from "../notes/note-audio-timeline";

export interface OutlinePlaybackState {
  currentMs: number;
  totalMs: number;
  sourcePath: string;
  playing: boolean;
  error: string;
}

export interface OutlinePlaybackControllerOptions {
  audio: HTMLAudioElement;
  timeline: readonly NoteAudioInterval[];
  resolveSource(sourcePath: string, sourceName: string): string | null;
  onState(state: OutlinePlaybackState): void;
}

/** Plays ledger intervals in note order using one native audio element. */
export class OutlinePlaybackController {
  private readonly audio: HTMLAudioElement;
  private readonly timeline: readonly NoteAudioInterval[];
  private readonly resolveSource: OutlinePlaybackControllerOptions["resolveSource"];
  private readonly onState: OutlinePlaybackControllerOptions["onState"];
  private requestId = 0;
  private currentMs = 0;
  private currentSourcePath = "";
  private disposed = false;
  private error = "";
  private pendingMetadataHandler: (() => void) | null = null;
  private currentInterval: NoteAudioInterval | null = null;

  constructor(options: OutlinePlaybackControllerOptions) {
    this.audio = options.audio;
    this.timeline = options.timeline;
    this.resolveSource = (sourcePath, sourceName) => options.resolveSource(sourcePath, sourceName);
    this.onState = (state) => options.onState(state);
    this.audio.addEventListener("timeupdate", this.handleTimeUpdate);
    this.audio.addEventListener("ended", this.handleEnded);
    this.audio.addEventListener("play", this.emitState);
    this.audio.addEventListener("pause", this.emitState);
    this.audio.addEventListener("error", this.handleError);
    this.emitState();
  }

  get state(): OutlinePlaybackState {
    return {
      currentMs: this.currentMs,
      totalMs: this.timeline.length ? this.timeline[this.timeline.length - 1].noteEndMs : 0,
      sourcePath: this.currentSourcePath,
      playing: !this.audio.paused,
      error: this.error,
    };
  }

  seekGlobal(globalMs: number, autoplay = false): boolean {
    if (this.disposed) return false;
    const position = mapNoteTimeToAudio(this.timeline, globalMs);
    const interval = this.findIntervalForGlobal(globalMs);
    if (!position || !interval) return false;
    this.currentMs = Math.max(0, globalMs);
    this.error = "";
    const sameSource = this.currentSourcePath === position.sourcePath;
    this.currentInterval = interval;
    this.currentSourcePath = position.sourcePath;
    const src = this.resolveSource(position.sourcePath, position.sourceName);
    if (!src) {
      this.fail(`Audio source unavailable: ${position.sourceName || position.sourcePath}`);
      return false;
    }
    if (sameSource && this.audio.readyState >= 1) {
      this.seekLocal(position.localMs, autoplay);
      this.emitState();
      return true;
    }
    this.loadSource(position.sourcePath, src, position.localMs, autoplay);
    return true;
  }

  seekSourceLocal(sourcePath: string, localMs: number, autoplay = false): boolean {
    if (this.disposed || !Number.isFinite(localMs)) return false;
    const positions = this.timeline
      .filter(interval => interval.sourcePath === sourcePath && localMs >= interval.localStartMs && localMs < interval.localEndMs)
      .map(interval => interval.noteStartMs + localMs - interval.localStartMs);
    const unique = [...new Set(positions)];
    if (unique.length !== 1) return false;
    return this.seekGlobal(unique[0], autoplay);
  }

  play(): void {
    if (this.disposed) return;
    if (!this.currentSourcePath && this.timeline.length) {
      this.seekGlobal(this.timeline[0].noteStartMs, true);
      return;
    }
    void this.audio.play().catch(() => this.fail(`Audio could not be played: ${this.currentSourcePath}`));
  }

  pause(): void {
    if (!this.disposed) this.audio.pause();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requestId += 1;
    this.audio.removeEventListener("timeupdate", this.handleTimeUpdate);
    this.audio.removeEventListener("ended", this.handleEnded);
    this.audio.removeEventListener("play", this.emitState);
    this.audio.removeEventListener("pause", this.emitState);
    this.audio.removeEventListener("error", this.handleError);
    if (this.pendingMetadataHandler) {
      this.audio.removeEventListener("loadedmetadata", this.pendingMetadataHandler);
      this.pendingMetadataHandler = null;
    }
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.currentSourcePath = "";
    this.currentInterval = null;
  }

  private readonly handleTimeUpdate = (): void => {
    if (this.disposed || !this.currentSourcePath) return;
    const interval = this.findCurrentInterval();
    if (!interval) return;
    const localMs = Math.max(0, this.audio.currentTime * 1000);
    this.currentMs = Math.min(interval.noteEndMs, interval.noteStartMs + localMs - interval.localStartMs);
    if (localMs >= interval.localEndMs) {
      const next = this.timeline.find(candidate => candidate.noteStartMs >= interval.noteEndMs);
      if (next) this.seekGlobal(next.noteStartMs, !this.audio.paused);
      else this.currentMs = interval.noteEndMs;
    }
    this.emitState();
  };

  private readonly handleEnded = (): void => {
    if (this.disposed) return;
    const interval = this.findCurrentInterval();
    if (!interval) return;
    if (this.audio.currentTime * 1000 + 50 < interval.localEndMs) {
      this.fail(`Audio is shorter than its transcript interval: ${this.currentSourcePath}`);
      return;
    }
    const next = this.timeline.find(candidate => candidate.noteStartMs >= interval.noteEndMs);
    if (next) this.seekGlobal(next.noteStartMs, true);
    else {
      this.currentMs = interval.noteEndMs;
      this.emitState();
    }
  };

  private readonly handleError = (): void => {
    if (this.currentSourcePath) this.fail(`Audio source failed to load: ${this.currentSourcePath}`);
  };

  private findCurrentInterval(): NoteAudioInterval | null {
    return this.currentInterval && this.currentInterval.sourcePath === this.currentSourcePath
      ? this.currentInterval
      : null;
  }

  private findIntervalForGlobal(globalMs: number): NoteAudioInterval | null {
    if (this.timeline.length && globalMs === this.timeline[this.timeline.length - 1].noteEndMs) {
      return this.timeline[this.timeline.length - 1];
    }
    let match: NoteAudioInterval | null = null;
    for (const interval of this.timeline) {
      if (globalMs < interval.noteStartMs || globalMs >= interval.noteEndMs) continue;
      if (match) return null;
      match = interval;
    }
    return match;
  }

  private loadSource(sourcePath: string, src: string, localMs: number, autoplay: boolean): void {
    const requestId = ++this.requestId;
    const wasPlaying = !this.audio.paused;
    if (this.pendingMetadataHandler) {
      this.audio.removeEventListener("loadedmetadata", this.pendingMetadataHandler);
      this.pendingMetadataHandler = null;
    }
    this.currentSourcePath = sourcePath;
    this.audio.pause();
    this.audio.src = src;
    const onMetadata = (): void => {
      if (this.disposed || requestId !== this.requestId) return;
      this.audio.removeEventListener("loadedmetadata", onMetadata);
      if (this.pendingMetadataHandler === onMetadata) this.pendingMetadataHandler = null;
      this.seekLocal(localMs, autoplay || wasPlaying);
      this.emitState();
    };
    this.pendingMetadataHandler = onMetadata;
    this.audio.addEventListener("loadedmetadata", onMetadata);
    this.audio.load();
    if (this.audio.readyState >= 1) onMetadata();
    this.emitState();
  }

  private seekLocal(localMs: number, autoplay: boolean): void {
    const durationMs = Number.isFinite(this.audio.duration) ? this.audio.duration * 1000 : Number.POSITIVE_INFINITY;
    if (localMs > durationMs) {
      this.fail(`Audio is shorter than its transcript interval: ${this.currentSourcePath}`);
      return;
    }
    this.audio.currentTime = Math.max(0, localMs / 1000);
    if (autoplay) void this.audio.play().catch(() => this.fail(`Audio could not be played: ${this.currentSourcePath}`));
  }

  private fail(message: string): void {
    this.error = message;
    this.audio.pause();
    this.emitState();
  }

  private readonly emitState = (): void => {
    if (!this.disposed) this.onState(this.state);
  };
}
