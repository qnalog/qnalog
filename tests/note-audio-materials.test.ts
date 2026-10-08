import { vi } from "vitest";
vi.mock("obsidian", () => ({
  TFile: class TFile {},
  TFolder: class TFolder {},
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/"),
}));
import { describe, expect, it } from "vitest";
import { getAudioTimeLink, getSessionMasterAudioName } from "../src/notes/audio-reference-text";
import { buildExternalAudioSourceDetails, buildMasterAudioDetails } from "../src/notes/note-session-materials";
import { buildRealtimeOutlineAnchorSources, buildRealtimeOutlineTranscript } from "../src/notes/realtime-outline";
import { formatMergeSegmentForPrompt } from "../src/prompts/briefing-prompts";
import { getActiveUiLanguage, matchUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

function withLanguage<T>(language: string, run: () => T): T {
  const previous = getActiveUiLanguage();
  setActiveUiLanguage(matchUiLanguage(language)!);
  try { return run(); } finally { setActiveUiLanguage(previous); }
}

const specialAudioName = "音频 $& $` $' $$.webm";

describe("audio material helper contracts", () => {
  it("keeps exact audio links, duration coercion, and thrown conversions", () => {
    expect(getAudioTimeLink("  音频 $& $` $' $$.webm  ", 61_999)).toBe("[[音频 $& $` $' $$.webm|01:01]]");
    for (const duration of [0, undefined, null, Number.NaN, -1]) {
      expect(getAudioTimeLink("clip.webm", duration)).toBe("[[clip.webm|00:00]]");
    }
    for (const name of [" ", "", null, undefined, false, 0]) expect(getAudioTimeLink(name)).toBe("");
    expect(getAudioTimeLink(42)).toBe("[[42|00:00]]");
    const failure = new Error("conversion failed");
    expect(() => getAudioTimeLink({ toString: () => { throw failure; } })).toThrow(failure);
  });

  it("keeps master-name priority, path fallback, repeated reads, and exceptions", () => {
    expect(getSessionMasterAudioName({ masterAudioName: "  master.webm  ", masterAudioPath: "ignored.webm" })).toBe("master.webm");
    expect(getSessionMasterAudioName({ masterAudioName: "  ", masterAudioPath: " QnALog/Audio/fallback.webm " })).toBe("fallback.webm");
    expect(getSessionMasterAudioName({ masterAudioPath: "QnALog/Audio/" })).toBe("QnALog/Audio/");
    expect(getSessionMasterAudioName({ masterAudioPath: "C:\\Audio\\clip.webm" })).toBe("C:\\Audio\\clip.webm");
    for (const session of [undefined, null, {}, { masterAudioName: " ", masterAudioPath: " " }]) expect(getSessionMasterAudioName(session)).toBe("");
    let nameReads = 0;
    let pathReads = 0;
    const session = Object.defineProperties({}, {
      masterAudioName: { get: () => ++nameReads === 1 ? "FIRST" : "SECOND" },
      masterAudioPath: { get: () => { pathReads += 1; return "ignored"; } },
    });
    expect(getSessionMasterAudioName(session)).toBe("SECOND");
    expect(nameReads).toBe(2);
    expect(pathReads).toBe(0);
    let pathReadsOnFallback = 0;
    const fallback = Object.defineProperties({ masterAudioName: " " }, {
      masterAudioPath: { get: () => ++pathReadsOnFallback === 1 ? "FIRST.webm" : "SECOND.webm" },
    });
    expect(getSessionMasterAudioName(fallback)).toBe("SECOND.webm");
    expect(pathReadsOnFallback).toBe(2);
    const failure = new Error("getter failed");
    expect(() => getSessionMasterAudioName(Object.defineProperty({}, "masterAudioName", { get: () => { throw failure; } }))).toThrow(failure);
  });

  it.each(["zh", "en"]) ("builds exact master audio details in %s", (language) => withLanguage(language, () => {
    const summary = language === "zh" ? "原始音频（完整录音，01:01）" : "Original audio (full recording, 01:01)";
    const listen = language === "zh" ? "回听：" : "Listen back: ";
    expect(buildMasterAudioDetails({ masterAudioName: specialAudioName }, 61_999)).toBe([
      "<details>", `<summary>${summary}</summary>`, "", `![[${specialAudioName}]]`, "",
      `${listen}[[${specialAudioName}|00:00]]`, "", "</details>",
    ].join("\n"));
    expect(buildMasterAudioDetails({ masterAudioPath: "QnALog/Audio/fallback.webm" }, 0)).toContain("![[fallback.webm]]");
    expect(buildMasterAudioDetails({})).toBe("");
    expect(buildMasterAudioDetails({ masterAudioName: "clip.webm" }, null)).toContain("00:00");
    expect(buildMasterAudioDetails({ masterAudioName: "clip.webm" }, undefined)).toContain("00:00");
    expect(buildMasterAudioDetails({ masterAudioName: "clip.webm" }, 3_661_999)).toContain("1:01:01");
  }));

  it.each(["zh", "en"]) ("builds exact external source details in %s", (language) => withLanguage(language, () => {
    const name = "外部 $& $` $' $$.wav";
    expect(buildExternalAudioSourceDetails({ externalAudioSource: {
      name: `  ${name}  `, path: "/private/DO_NOT_RENDER/source.wav", fingerprint: "DO_NOT_RENDER_FINGERPRINT",
    } })).toBe([
      "<details>", `<summary>${language === "zh" ? "导入来源" : "Import source"}</summary>`, "",
      `${language === "zh" ? "文件：" : "File: "}${name}`, "",
      "源音频保留在同步文件夹中，未复制到当前知识库。", "", "</details>",
    ].join("\n"));
    for (const source of [undefined, null, {}, { name: " " }, { path: "only-path.wav" }]) {
      expect(buildExternalAudioSourceDetails({ externalAudioSource: source })).toBe("");
    }
    expect(buildExternalAudioSourceDetails({ externalAudioSource: { name: 42 } })).toContain(`${language === "zh" ? "文件：" : "File: "}42`);
    expect(buildExternalAudioSourceDetails({ externalAudioSource: { name: false } })).toBe("");
    expect(buildExternalAudioSourceDetails({ externalAudioSource: { name: 0 } })).toBe("");
    expect(buildExternalAudioSourceDetails({ externalAudioSource: { name: { toString: () => "object-name" } } })).toContain("object-name");
    let reads = 0;
    expect(buildExternalAudioSourceDetails({ externalAudioSource: { get name() { reads += 1; return "one-read.wav"; } } })).toContain("one-read.wav");
    expect(reads).toBe(1);
    const failure = new Error("getter failed");
    expect(() => buildExternalAudioSourceDetails({ externalAudioSource: { get name() { throw failure; } } })).toThrow(failure);
  }));
});

describe("audio link consumers", () => {
  it("uses local audio offsets in outline text, outline sources, and merge prompts", () => {
    const segment = {
      index: 2, startOffsetMs: 61_000, endOffsetMs: 65_000, audioStartOffsetMs: 7_000,
      audioName: "分段 $& $` $' $$.webm", text: "ANCHOR RAW",
    };
    const link = "[[分段 $& $` $' $$.webm|00:07]]";
    expect(buildRealtimeOutlineTranscript([segment])).toBe(`【段落 3｜01:01-01:05｜回听 ${link}】\nANCHOR RAW`);
    expect(buildRealtimeOutlineAnchorSources([segment])).toEqual([{ anchor: link, text: "ANCHOR RAW", index: 61_000 }]);
    expect(formatMergeSegmentForPrompt(segment, 0)).toBe(`===SEG 3 (01:01-01:05) ${link}===\nANCHOR RAW`);
    const withoutAudio = { ...segment, audioName: "" };
    expect(buildRealtimeOutlineTranscript([withoutAudio])).toBe("【段落 3｜01:01-01:05】\nANCHOR RAW");
    expect(buildRealtimeOutlineAnchorSources([withoutAudio])).toEqual([]);
    expect(formatMergeSegmentForPrompt(withoutAudio, 0)).toBe("===SEG 3 (01:01-01:05)===\nANCHOR RAW");
  });
});
