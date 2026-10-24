import { afterEach, describe, expect, it } from "vitest";
import {
  bracketsForNumberedLabel,
  convertInlineSpeakerRefs,
  formatSpeakerMention,
  localeMentionBrackets,
  markSpeakerMentionsInOrganizedBody,
  noteBodyMentionBrackets,
  wrapSpeakerMentions,
} from "../src/audio/speaker-mentions";
import { extractSpeakerIdsFromMarkdown, replaceSpeakerDisplayName } from "../src/audio/channel-speakers";
import { attachTranscriptResult } from "../src/transcript/session-transcript";
import { getActiveUiLanguage, resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

const CJK = bracketsForNumberedLabel("说话人1")!;
const LATIN = bracketsForNumberedLabel("Speaker 1")!;
const previousLanguage = getActiveUiLanguage();
afterEach(() => setActiveUiLanguage(previousLanguage));

describe("speaker mention brackets", () => {
  it("takes the pair from the language of the numbered label and of the UI locale", () => {
    expect(formatSpeakerMention("说话人 3", CJK)).toBe("『说话人3』");
    expect(formatSpeakerMention("Speaker  3", LATIN)).toBe("[Speaker 3]");
    setActiveUiLanguage(resolveUiLanguage("zh", "zh"));
    expect(localeMentionBrackets()).toBe(CJK);
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    expect(localeMentionBrackets()).toBe(LATIN);
    // The mapping default label in frontmatter is always Chinese; the body decides.
    expect(noteBodyMentionBrackets("---\nqnalog_speakers:\n  spk-1:\n    label: 说话人1\n---\n\nSpeaker 1 said hi.")).toBe(LATIN);
  });

  it("escapes the opening bracket when an English mention is followed by ( [ or :", () => {
    expect(formatSpeakerMention("Alice", LATIN, "(")).toBe("\\[Alice]");
    expect(formatSpeakerMention("Alice", LATIN, "[")).toBe("\\[Alice]");
    expect(formatSpeakerMention("Alice", LATIN, " ")).toBe("[Alice]");
    expect(formatSpeakerMention("张华", CJK, "(")).toBe("『张华』");
    const text = wrapSpeakerMentions("Ask Alice(the lead) and Alice[1] and Alice.", ["Alice"], LATIN);
    expect(text).toBe("Ask \\[Alice](the lead) and \\[Alice][1] and [Alice].");
    expect(wrapSpeakerMentions(text, ["Alice"], LATIN)).toBe(text);
  });
});

describe("wrapping speaker mentions in organized prose", () => {
  it("wraps numbered labels with and without a space, and named speakers, in Chinese and English", () => {
    const zh = wrapSpeakerMentions("说话人3猜测原因，说话人 1 反对；张华已复现。\n- [ ] 事项：张华跟进", ["张华"], CJK);
    expect(zh).toBe("『说话人3』猜测原因，『说话人1』 反对；『张华』已复现。\n- [ ] 事项：『张华』跟进");
    const en = wrapSpeakerMentions("Speaker 3 guessed; Alice reproduced it. Speaker 12 agreed.", ["Alice"], LATIN);
    expect(en).toBe("[Speaker 3] guessed; [Alice] reproduced it. [Speaker 12] agreed.");
  });

  it("is idempotent", () => {
    const once = wrapSpeakerMentions("说话人3和张华讨论；Speaker 2 and Bob agreed.", ["张华", "Bob"], CJK);
    expect(wrapSpeakerMentions(once, ["张华", "Bob"], CJK)).toBe(once);
  });

  it("leaves frontmatter, code, links, details, comments and machine lines alone", () => {
    const source = [
      "---", "qnalog_speakers:", "  spk-1:", "    personName: 张华", "---", "",
      "张华说明了 `说话人1` 的配置，见 [[张华]] 与 [说话人1 的记录](https://example.com/张华)。",
      "```", "说话人2: code", "```",
      "<details>", "<summary>Raw transcript</summary>", "**说话人1：** 原话", "</details>",
      "<!-- qnalog-people: 张华, 说话人1 -->",
      "qnalog-tags: 说话人2",
    ].join("\n");
    const out = wrapSpeakerMentions(source, ["张华"], CJK);
    expect(out.split("\n").slice(0, 6).join("\n")).toBe(source.split("\n").slice(0, 6).join("\n"));
    expect(out).toContain("『张华』说明了 `说话人1` 的配置，见 [[张华]] 与 [说话人1 的记录](https://example.com/张华)。");
    expect(out).toContain("```\n说话人2: code\n```");
    expect(out).toContain("**说话人1：** 原话");
    expect(out).toContain("<!-- qnalog-people: 张华, 说话人1 -->");
    expect(out).toContain("qnalog-tags: 说话人2");
  });

  it("wraps only whole configured names of at least two characters, longest first", () => {
    expect(wrapSpeakerMentions("张华东与张华开会，华也在。", ["张华", "张华东", "华"], CJK)).toBe("『张华东』与『张华』开会，华也在。");
    expect(wrapSpeakerMentions("Alicia met Alice.", ["Alice"], LATIN)).toBe("Alicia met [Alice].");
    expect(wrapSpeakerMentions("说话人30来了", [], CJK)).toBe("『说话人30』来了");
  });

  it("collects names from the mapping and the ledger for the organized body and evidence lines", () => {
    const text = "Alice ships it.";
    const segment = attachTranscriptResult({ index: 0, startOffsetMs: 0, endOffsetMs: 1000, text }, "m1", {
      text, rawText: null, providerId: "stub", units: [
        { rawText: text, normalizedText: text, speakerId: "spk-1", speakerName: "Speaker 1", startMs: 0, endMs: 900, timing: "provider" },
      ],
    }, "asr");
    const body = "## Plan\n\nAlice ships it while Speaker 1 watches.\n\n- **Decision**: Ship — Speaker 1 [[a.webm|00:00]] “Alice ships it.”";
    const marked = markSpeakerMentionsInOrganizedBody(body, [segment], { qnalog_speakers: { "spk-2": { personName: "Alice", label: "说话人2" } } });
    expect(marked).toContain("[Alice] ships it while [Speaker 1] watches.");
    expect(marked).toContain("— [Speaker 1] [[a.webm|00:00]] “[Alice] ships it.”");
  });
});

describe("renaming inside markers and converting legacy forms", () => {
  it("renames inside markers and converts bare labels and inline speaker-ref comments", () => {
    const body = [
      "# 会议", "",
      "『说话人2』提出方案，说话人2 随后补充；<!-- qnalog-speaker-ref:spk-1 -->王敏<!-- qnalog-speaker-ref-end:spk-1 -->同意，说话人3未表态。",
      "", "---", "", "## 原始材料", "",
      "<details>", "<summary>原始转写 · 段落 1 (00:00–01:00)</summary>",
      "&lt;!-- qnalog-speaker:spk-2 --&gt;", "**说话人2：** 我提出方案。", "</details>",
    ].join("\n");
    const renamed = replaceSpeakerDisplayName(body, "spk-2", "张华");
    const prose = renamed.markdown.split("## 原始材料")[0];
    expect(prose).toContain("『张华』提出方案，『张华』 随后补充；『王敏』同意，『说话人3』未表态。");
    expect(prose).not.toContain("<!--");
    expect(renamed.markdown).toContain("**张华：** 我提出方案。");
    const again = replaceSpeakerDisplayName(renamed.markdown, "spk-2", "刘华", ["张华"]);
    expect(again.markdown).toContain("『刘华』提出方案，『刘华』 随后补充");
    expect(again.markdown).not.toContain("张华");
    expect(extractSpeakerIdsFromMarkdown("『说话人3』与 [Speaker 4] 讨论")).toEqual(["spk-3", "spk-4"]);
  });

  it("converts English inline speaker-ref comments to escaped brackets before a parenthesis", () => {
    const out = convertInlineSpeakerRefs("<!-- qnalog-speaker-ref:spk-1 -->Alice<!-- qnalog-speaker-ref-end:spk-1 -->(lead) agreed.", LATIN);
    expect(out.markdown).toBe("\\[Alice](lead) agreed.");
    expect(out.replacements).toBe(1);
  });
});
