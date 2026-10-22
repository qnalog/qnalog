import { describe, expect, it } from "vitest";
import { splitLiteralAudioTimeLinks } from "../src/notes/literal-audio-links";

const isAudio = (target: string) => /\.(?:webm|m4a|mp3|wav|ogg)$/i.test(target);

describe("literal audio time links inside transcript details", () => {
  it("turns the [[recording|mm:ss]] written after <summary> into a link part", () => {
    expect(splitLiteralAudioTimeLinks("[[qnalog-20261022-143021.webm|00:00]]", isAudio)).toEqual([
      { target: "qnalog-20261022-143021.webm", label: "00:00" },
    ]);
  });

  it("keeps surrounding text and handles several links, paths and hour or range labels", () => {
    expect(splitLiteralAudioTimeLinks("a [[QnALog/Recordings/rec one.m4a|1:02:03]] b [[rec.mp3|00:10–00:20]] c", isAudio)).toEqual([
      { text: "a " },
      { target: "QnALog/Recordings/rec one.m4a", label: "1:02:03" },
      { text: " b " },
      { target: "rec.mp3", label: "00:10–00:20" },
      { text: " c" },
    ]);
  });

  it("leaves non-audio targets and non-time labels as text", () => {
    expect(splitLiteralAudioTimeLinks("[[Some note|00:10]]", isAudio)).toBeNull();
    expect(splitLiteralAudioTimeLinks("[[rec.webm|intro]]", isAudio)).toBeNull();
    expect(splitLiteralAudioTimeLinks("[[rec.webm]]", isAudio)).toBeNull();
    expect(splitLiteralAudioTimeLinks("plain transcript text", isAudio)).toBeNull();
  });

  it("only replaces the audio link when a note link sits next to it", () => {
    expect(splitLiteralAudioTimeLinks("[[Note|00:01]] [[rec.webm|00:01]]", isAudio)).toEqual([
      { text: "[[Note|00:01]] " },
      { target: "rec.webm", label: "00:01" },
    ]);
  });
});
