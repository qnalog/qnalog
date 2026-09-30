import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import { transcribeAudio } from "../src/asr/transcribe";
import { transcribeAudioByChannels } from "../src/asr/channel-transcription";
import { attachTranscriptResult, getCurrentTranscript } from "../src/transcript/session-transcript";
import type { AsrTranscriptResult } from "../src/asr/transcript-result";
import type { Segment } from "../src/shared/types";
import { replaceSpeakerDisplayName } from "../src/audio/channel-speakers";
import { readTranscriptBlocks, serializeTranscriptBlock } from "../src/transcript/transcript-markdown";
import { bindTranscriptSegmentToAudio } from "../src/transcript/audio-binding";

afterEach(() => vi.unstubAllGlobals());

const provider = {
  id: "test-asr",
  endpoint: "https://asr.example.com/v1/audio/transcriptions",
  apiKey: "test-key",
  model: "whisper-test",
};

function stubAsrResponse(payload: unknown): void {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => payload,
    text: async () => "",
  });
  vi.stubGlobal("window", { fetch, setTimeout, clearTimeout });
}

function plugin() {
  return {
    settings: {
      customVocabulary: "## 易错写法\nQNA 洛格 => QnALog",
      peopleContextMode: "privacy",
    },
  };
}

describe("structured ASR transcript results", () => {
  it("retains plain service text while exposing corrected citation units", async () => {
    const rawText = "  QNA 洛格.   Next?  ";
    stubAsrResponse({ text: rawText });

    const result = await transcribeAudio(plugin(), new Blob(["audio"]), "audio/webm", provider);

    expect(result).toMatchObject({
      text: "QnALog.   Next?",
      rawText,
      providerId: "test-asr",
    });
    expect(result.units.map((unit) => unit.rawText).join("")).toBe(rawText);
    expect(result.units.map((unit) => unit.normalizedText).join("")).toBe("  QnALog.   Next?  ");
    expect(result.units.map((unit) => unit.timing)).toEqual(["unknown", "unknown"]);
  });

  it("uses segment text when a provider omits the aggregate text field", async () => {
    stubAsrResponse({ segments: [{ text: "first sentence" }, { text: "second sentence" }] });
    const result = await transcribeAudio(plugin(), new Blob(["audio"]), "audio/webm", provider);
    expect(result.text).toBe("first sentence second sentence");
    expect(result.rawText).toBeNull();
    expect(result.units.map((unit) => unit.rawText)).toEqual(["first sentence", "second sentence"]);
    expect(result.units.every((unit) => unit.timing === "unknown")).toBe(true);
  });

  it("keeps provider sentence timing and speaker fields, rejecting invalid ranges without zero-filling", async () => {
    stubAsrResponse({
      segments: [
        { text: "QNA 洛格", speaker: "SPEAKER_00", start: 1.234, end: 2.789 },
        { text: " second", speaker: "SPEAKER_00", start: null, end: 3 },
        { text: " done.", speaker: "SPEAKER_01", start: -1, end: 0 },
      ],
    });

    const result = await transcribeAudio(plugin(), new Blob(["audio"]), "audio/webm", provider);

    expect(result.rawText).toBeNull();
    expect(result.units.map((unit) => unit.rawText)).toEqual(["QNA 洛格", " second", " done."]);
    expect(result.units[0]).toMatchObject({
      normalizedText: "QnALog",
      speakerId: "SPEAKER_00",
      speakerName: "说话人1",
      startMs: 1234,
      endMs: 2789,
      timing: "provider",
    });
    expect(result.units[1]).toMatchObject({ startMs: null, endMs: null, timing: "unknown", speakerName: "说话人1" });
    expect(result.units[2]).toMatchObject({ startMs: null, endMs: null, timing: "unknown", speakerName: "说话人2" });
  });

  it("keeps unit IDs across normalization updates and scopes repeated provider speaker IDs by source", () => {
    const result: AsrTranscriptResult = {
      text: "QnALog second",
      rawText: null,
      providerId: "test-asr",
      units: [
        {
          rawText: "QNA 洛格",
          normalizedText: "QnALog",
          speakerId: "SPEAKER_00",
          speakerName: "说话人1",
          startMs: 1234,
          endMs: 2789,
          timing: "provider",
        },
        {
          rawText: " second",
          normalizedText: " second",
          speakerId: "SPEAKER_00",
          speakerName: "说话人1",
          startMs: null,
          endMs: null,
          timing: "unknown",
        },
      ],
    };
    const sourceSegment: Segment = {
      index: 3,
      startOffsetMs: 0,
      endOffsetMs: 10_000,
      audioStartOffsetMs: 10_000,
      audioEndOffsetMs: 20_000,
      audioPath: "recordings/session.wav",
      audioName: "session.wav",
      text: result.text,
    };
    const attached = attachTranscriptResult(sourceSegment, "session/one", result, "asr");
    const originalRevision = getCurrentTranscript(attached.transcript!);
    expect(originalRevision.utterances[0]).toMatchObject({
      id: "seg:session%2Fone:3:r1:u1",
      speakerId: "seg:session%2Fone:3:SPEAKER_00",
      startMs: 11_234,
      endMs: 12_789,
      timing: "provider",
      audioRef: { path: "recordings/session.wav", startMs: 11_234, endMs: 12_789, precision: "provider" },
    });
    expect(originalRevision.utterances[1]).toMatchObject({ startMs: 10_000, endMs: 20_000, timing: "segment" });

    const normalizedAgain = attachTranscriptResult(
      { ...attached, text: "QNALog second" },
      "session/one",
      { ...result, text: "QNALog second", units: [{ ...result.units[0], normalizedText: "QNALog" }, result.units[1]] },
      "asr",
    );
    const correctedRevision = getCurrentTranscript(normalizedAgain.transcript!);
    expect(normalizedAgain.transcript?.currentRevision).toBe(1);
    expect(correctedRevision.normalizationRevision).toBe(2);
    expect(correctedRevision.utterances[0].id).toBe(originalRevision.utterances[0].id);
    expect(correctedRevision.utterances[0].rawText).toBe("QNA 洛格");
    expect(correctedRevision.corrections).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "text", from: "QnALog", to: "QNALog" }),
    ]));

    const secondSource = attachTranscriptResult(sourceSegment, "session/two", result, "asr");
    expect(getCurrentTranscript(secondSource.transcript!).utterances[0].speakerId)
      .not.toBe(originalRevision.utterances[0].speakerId);
  });

  it("rebinds local segment ranges to a retained master without changing utterance IDs", () => {
    const source: Segment = {
      index: 0,
      startOffsetMs: 5000,
      endOffsetMs: 6000,
      audioStartOffsetMs: 5000,
      audioEndOffsetMs: 6000,
      audioName: "clip.wav",
      audioPath: "cache/clip.wav",
      segmentAudioName: "clip.wav",
      segmentAudioPath: "cache/clip.wav",
      text: "A phrase.",
    };
    const attached = attachTranscriptResult(source, "session-audio", {
      text: "A phrase.",
      rawText: null,
      providerId: "test-asr",
      units: [{
        rawText: "A phrase.", normalizedText: "A phrase.", speakerId: null, speakerName: null,
        startMs: 100, endMs: 200, timing: "provider",
      }],
    }, "asr");
    const initial = getCurrentTranscript(attached.transcript!);
    const rebound = bindTranscriptSegmentToAudio(attached, "Recordings/session.wav", "session.wav");
    const current = getCurrentTranscript(rebound.transcript!);
    expect(current.utterances[0].id).toBe(initial.utterances[0].id);
    expect(current.utterances[0]).toMatchObject({
      startMs: 5100,
      endMs: 5200,
      audioRef: { path: "Recordings/session.wav", startMs: 5100, endMs: 5200, precision: "provider" },
    });
    expect(current.normalizationRevision).toBe(2);
    expect(bindTranscriptSegmentToAudio(rebound, "Recordings/session.wav", "session.wav")).toBe(rebound);
  });
  it("keeps channel speaker and activity ranges on structured ASR units", async () => {
    const left = new Float32Array(2000);
    const right = new Float32Array(2000);
    for (let index = 0; index < 1000; index += 1) left[index] = Math.sin(index / 10) * 0.5;
    for (let index = 1000; index < 2000; index += 1) right[index] = Math.sin(index / 10) * 0.5;
    const decoded = {
      numberOfChannels: 2,
      length: 2000,
      sampleRate: 1000,
      duration: 2,
      getChannelData: (channel: number) => channel === 0 ? left : right,
    } as unknown as AudioBuffer;
    class AudioContextStub {
      async decodeAudioData(): Promise<AudioBuffer> { return decoded; }
      async close(): Promise<void> {}
    }
    let requestCount = 0;
    const fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ segments: [{ text: requestCount++ === 0 ? "[说话人1] alpha." : "[说话人1] beta.", speaker: "SPEAKER_00", start: 0.1, end: 0.2 }] }),
      text: async () => "",
    }));
    vi.stubGlobal("window", { AudioContext: AudioContextStub, fetch, setTimeout, clearTimeout });
    const host = {
      settings: {
        activeTranscribeProvider: "test-asr",
        transcribeProviders: { "test-asr": provider },
        customVocabulary: "",
        peopleContextMode: "privacy",
      },
    };

    const result = await transcribeAudioByChannels(host, new Blob(["audio"]), "audio/webm", 2);

    expect(result.usedMultichannel).toBe(true);
    expect(result.providerId).toBe("test-asr");
    expect(result.units).toHaveLength(2);
    expect(result.units.map((unit) => unit.speakerId)).toEqual(["channel:spk-1", "channel:spk-2"]);
    expect(result.units.map((unit) => unit.speakerName)).toEqual(["说话人1", "说话人2"]);
    expect(result.units.map((unit) => unit.rawText)).toEqual(["[说话人1] alpha.", "[说话人1] beta."]);
    expect(result.units.map((unit) => unit.normalizedText)).toEqual(["alpha.", "beta."]);
    expect(result.units.map((unit) => unit.timing)).toEqual(["provider", "provider"]);
    for (const part of result.parts) {
      const unit = result.units.find((item) => item.speakerId === `channel:${part.speakerId}`)!;
      expect(unit.startMs).toBe(part.startMs + 100);
      expect(unit.endMs).toBe(part.startMs + 200);
    }
  });
  it("updates speaker projections while preserving ASR source identity", () => {
    const display = `<!-- qnalog-speaker:spk-1 -->\n**说话人1：** QnALog.`;
    const segment = attachTranscriptResult({
      index: 0,
      startOffsetMs: 0,
      endOffsetMs: 1000,
      text: display,
    }, "session-speaker", {
      text: display,
      rawText: null,
      providerId: "test-asr",
      units: [{
        rawText: "QNA 洛格.",
        normalizedText: "说话人1： QnALog.",
        speakerId: "channel:spk-1",
        speakerName: "说话人1",
        startMs: 0,
        endMs: 1000,
        timing: "audio-span",
      }],
    }, "asr");
    const note = serializeTranscriptBlock(segment, "### Segment 1", display);
    const renamed = replaceSpeakerDisplayName(note, "spk-1", "胡女士");
    const [block] = readTranscriptBlocks(renamed.markdown);
    const revision = getCurrentTranscript(block.segment.transcript!);
    expect(renamed.replacements).toBe(1);
    expect(block.visibleBlock).toContain("**胡女士：**");
    expect(revision.utterances[0]).toMatchObject({
      rawText: "QNA 洛格.",
      normalizedText: "胡女士： QnALog.",
      speakerName: "胡女士",
    });
    expect(revision.utterances[0].id).toBe(segment.transcript?.revisions[0].utterances[0].id);
    expect(revision.normalizationRevision).toBe(2);
    expect(revision.corrections).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "speaker", from: "说话人1", to: "胡女士" }),
    ]));
  });
});
