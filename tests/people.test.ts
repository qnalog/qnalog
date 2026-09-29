import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import {
  arePeopleSuggestionsRelated,
  formatPeopleNoteMarkdown,
  mergePeopleSuggestions,
  mergePersonFrontmatter,
  mergeSourceNoteRelatedPeopleFrontmatter,
  normalizePeopleRelation,
  normalizePersonLookupText,
} from "../src/people";
import { NS_FM } from "../src/shared/namespace";

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
    participant.path = "QnALog/人员/腾哥.md";
    participant.basename = "腾哥";
    const mentioned = new TFile() as any;
    mentioned.path = "QnALog/人员/李总.md";
    mentioned.basename = "李总";
    const owner = new TFile() as any;
    owner.path = "QnALog/人员/产品同事.md";
    owner.basename = "产品同事";

    const fm = mergeSourceNoteRelatedPeopleFrontmatter({}, [
      { file: participant, relation: "participant" },
      { file: mentioned, relation: "mentioned" },
      { file: owner, relation: "todo_owner" },
    ]);

    expect(fm[NS_FM.relatedPeople]).toEqual([
      "[[QnALog/人员/腾哥|腾哥]]",
      "[[QnALog/人员/李总|李总]]",
      "[[QnALog/人员/产品同事|产品同事]]",
    ]);
    expect(fm[NS_FM.participants]).toEqual(["[[QnALog/人员/腾哥|腾哥]]"]);
    expect(fm[NS_FM.mentionedPeople]).toEqual(["[[QnALog/人员/李总|李总]]"]);
    expect(fm[NS_FM.todoOwners]).toEqual(["[[QnALog/人员/产品同事|产品同事]]"]);
    expect(fm["相关人员"]).toBeUndefined();
    expect(fm.participants).toBeUndefined();
    expect(fm.mentioned_people).toBeUndefined();
    expect(fm.todo_owners).toBeUndefined();
    });

  it("merges parallel legacy people arrays into the canonical field when a note is edited", () => {
    const fm = mergeSourceNoteRelatedPeopleFrontmatter({ people: ["李四"], 人物: ["王五"] }, []);
    expect(fm[NS_FM.people]).toEqual(["李四", "王五"]);
    expect(fm.people).toBeUndefined();
    expect(fm["人物"]).toBeUndefined();
  });

  it("creates and updates person properties using stable canonical keys", async () => {
    const { TFile } = await import("obsidian");
    const source = new TFile() as any;
    source.path = "QnALog/转写纪要/2026-09-29.md";
    source.basename = "2026-09-29";
    const updated = mergePersonFrontmatter(
      { 姓名: "李四", 角色: "设计师", 常用称呼: ["小李"], 邮箱: "li@example.com" },
      { name: "李四", role: "", organization: "产品组", aliases: ["老李"], note: "", evidence: [] },
      source,
    );
    expect(updated[NS_FM.name]).toBe("李四");
    expect(updated[NS_FM.role]).toBe("设计师");
    expect(updated[NS_FM.organization]).toBe("产品组");
    expect(updated[NS_FM.aliases]).toEqual(["小李", "老李"]);
    expect(updated[NS_FM.email]).toBe("li@example.com");
    expect(updated["姓名"]).toBeUndefined();
    expect(updated["角色"]).toBeUndefined();
    expect(updated["常用称呼"]).toBeUndefined();
    expect(updated["邮箱"]).toBeUndefined();

    const markdown = formatPeopleNoteMarkdown("李四");
    expect(markdown).toContain(`${NS_FM.type}: qnalog-person`);
    expect(markdown).toContain(`${NS_FM.name}:`);
    expect(markdown).toContain(`${NS_FM.organization}:`);
    expect(markdown).not.toMatch(/^(?:姓名|角色|组织|邮箱):/m);
  });
});
