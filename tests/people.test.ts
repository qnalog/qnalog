import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import {
  arePeopleSuggestionsRelated,
  mergePeopleSuggestions,
  mergeSourceNoteRelatedPeopleFrontmatter,
  normalizePeopleRelation,
  normalizePersonLookupText,
} from "../src/people";

describe("people suggestion merging", () => {
  it("merges full name and short name into one person candidate", () => {
    const full = {
      name: "胡悲伤",
      aliases: [],
      role: "负责人",
      organization: "产品组",
      note: "完整姓名候选",
      confidence: "高",
      evidence: ["胡悲伤负责跟进"],
    };
    const short = {
      name: "悲伤",
      aliases: [],
      role: "",
      organization: "",
      note: "简称候选",
      confidence: "中",
      evidence: ["悲伤补充了方案"],
    };

    expect(arePeopleSuggestionsRelated(full, short)).toBe(true);
    const merged = mergePeopleSuggestions(short, full);

    expect(merged?.name).toBe("胡悲伤");
    expect((merged?.aliases || []).map(normalizePersonLookupText)).toContain("悲伤");
    expect(merged?.role).toBe("负责人");
    expect(merged?.organization).toBe("产品组");
    expect(merged?.evidence.length).toBe(2);
  });

  it("normalizes person relation labels for note backlink fields", () => {
    expect(normalizePeopleRelation("参会人")).toBe("participant");
    expect(normalizePeopleRelation("待办责任人")).toBe("todo_owner");
    expect(normalizePeopleRelation("被提到")).toBe("mentioned");
    expect(normalizePeopleRelation("")).toBe("");
  });

  it("writes confirmed people links into relation-specific frontmatter fields", async () => {
    const { TFile } = await import("obsidian");
    const participant = new TFile() as any;
    participant.path = "LexVoice/人员/腾哥.md";
    participant.basename = "腾哥";
    const mentioned = new TFile() as any;
    mentioned.path = "LexVoice/人员/李总.md";
    mentioned.basename = "李总";
    const owner = new TFile() as any;
    owner.path = "LexVoice/人员/产品同事.md";
    owner.basename = "产品同事";

    const fm = mergeSourceNoteRelatedPeopleFrontmatter({}, [
      { file: participant, relation: "participant" },
      { file: mentioned, relation: "mentioned" },
      { file: owner, relation: "todo_owner" },
    ]);

    expect(fm["相关人员"]).toEqual([
      "[[LexVoice/人员/腾哥|腾哥]]",
      "[[LexVoice/人员/李总|李总]]",
      "[[LexVoice/人员/产品同事|产品同事]]",
    ]);
    expect(fm.participants).toEqual(["[[LexVoice/人员/腾哥|腾哥]]"]);
    expect(fm.mentioned_people).toEqual(["[[LexVoice/人员/李总|李总]]"]);
    expect(fm.todo_owners).toEqual(["[[LexVoice/人员/产品同事|产品同事]]"]);
  });
});
