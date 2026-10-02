import { describe, expect, it } from "vitest";
import { OutlinePlaybackController } from "../src/ui/outline-playback-controller";
import type { NoteAudioInterval } from "../src/notes/note-audio-timeline";

class FakeAudio extends EventTarget {
  src = "";
  currentTime = 0;
  duration = 10;
  readyState = 0;
  paused = true;
  muted = false;
  loads = 0;
  plays = 0;

  load(): void { this.loads += 1; }
  pause(): void { this.paused = true; this.dispatchEvent(new Event("pause")); }
  play(): Promise<void> {
    this.paused = false;
    this.plays += 1;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
  removeAttribute(name: string): void { if (name === "src") this.src = ""; }
  setMetadata(duration = this.duration): void {
    this.duration = duration;
    this.readyState = 1;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
  updateTime(seconds: number): void {
    this.currentTime = seconds;
    this.dispatchEvent(new Event("timeupdate"));
  }
  end(): void { this.dispatchEvent(new Event("ended")); }
}

const timeline: NoteAudioInterval[] = [
  { sourcePath: "audio/a.webm", sourceName: "a.webm", noteStartMs: 0, noteEndMs: 10000, localStartMs: 0, localEndMs: 10000 },
  { sourcePath: "audio/b.webm", sourceName: "b.webm", noteStartMs: 10000, noteEndMs: 20000, localStartMs: 0, localEndMs: 10000 },
  { sourcePath: "audio/c.webm", sourceName: "c.webm", noteStartMs: 20000, noteEndMs: 30000, localStartMs: 0, localEndMs: 10000 },
];

function setup() {
  const audio = new FakeAudio();
  const states: Array<{ currentMs: number; totalMs: number; sourcePath: string; playing: boolean; error: string }> = [];
  const controller = new OutlinePlaybackController({
    audio: audio as unknown as HTMLAudioElement,
    timeline,
    resolveSource: (path) => `vault://${path}`,
    onState: state => states.push(state),
  });
  return { audio, controller, states };
}

describe("outline playback controller", () => {
  it("switches to the requested source and seeks using file-local time", () => {
    const { audio, controller } = setup();
    expect(controller.seekGlobal(15000)).toBe(true);
    expect(audio.src).toBe("vault://audio/b.webm");
    audio.setMetadata();
    expect(audio.currentTime).toBe(5);
    expect(controller.state.currentMs).toBe(15000);
    expect(controller.state.totalMs).toBe(30000);
    controller.dispose();
  });

  it("ignores stale metadata after rapid cross-source seeks", () => {
    const { audio, controller } = setup();
    controller.seekGlobal(5000);
    controller.seekGlobal(22000);
    expect(audio.src).toBe("vault://audio/c.webm");
    audio.setMetadata();
    expect(audio.currentTime).toBe(2);
    expect(controller.state.sourcePath).toBe("audio/c.webm");
    controller.dispose();
  });

  it("keeps cumulative playback position when one source has repeated local ranges", () => {
    const audio = new FakeAudio();
    const controller = new OutlinePlaybackController({
      audio: audio as unknown as HTMLAudioElement,
      timeline: [
        { ...timeline[0], noteStartMs: 0, noteEndMs: 10000 },
        { ...timeline[0], noteStartMs: 20000, noteEndMs: 30000 },
      ],
      resolveSource: path => `vault://${path}`,
      onState: () => undefined,
    });
    expect(controller.seekGlobal(25000)).toBe(true);
    audio.setMetadata();
    audio.updateTime(6);
    expect(controller.state.currentMs).toBe(26000);
    controller.dispose();
  });

  it("continues across ledger source boundaries and reports truncated audio instead of skipping it", () => {
    const { audio, controller, states } = setup();
    controller.seekGlobal(0, true);
    audio.setMetadata(10);
    audio.updateTime(10);
    expect(audio.src).toBe("vault://audio/b.webm");
    audio.setMetadata(4);
    audio.updateTime(4);
    audio.end();
    expect(controller.state.playing).toBe(false);
    expect(controller.state.error).toContain("shorter than its transcript interval");
    expect(states.some(state => state.sourcePath === "audio/b.webm" && state.currentMs >= 10000)).toBe(true);
    controller.dispose();
  });

  it("does not resolve an ambiguous local timestamp or a missing source", () => {
    const { controller } = setup();
    expect(controller.seekSourceLocal("audio/missing.webm", 0, true)).toBe(false);
    const repeated: NoteAudioInterval[] = [
      { ...timeline[0], noteStartMs: 0, noteEndMs: 10000 },
      { ...timeline[0], noteStartMs: 20000, noteEndMs: 30000 },
    ];
    const other = new OutlinePlaybackController({
      audio: new FakeAudio() as unknown as HTMLAudioElement,
      timeline: repeated,
      resolveSource: path => path,
      onState: () => undefined,
    });
    expect(other.seekSourceLocal("audio/a.webm", 5000)).toBe(false);
    other.dispose();
    controller.dispose();
  });
});
