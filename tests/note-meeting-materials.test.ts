import { describe, expect, it, vi } from "vitest";
import { getActiveUiLanguage, matchUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";
import { buildMeetingWorkbenchDetails } from "../src/notes/note-session-materials";
import { buildMeetingWorkbenchPrompt } from "../src/notes/meeting-workbench";
import * as obsidian from "obsidian";

vi.mock("obsidian", () => ({ normalizePath: vi.fn((path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, "")) }));

const fixture = {
  notes: "  NOTES $& $` $' $$\r\nSECOND NOTE  ", draft: "DO_NOT_RENDER_DRAFT",
  entries: [
    { id:"entry-one",atMs:61999,text:"  ENTRY $& $` $' $$  ", interaction:{kind:"question",query:"DO_NOT_RENDER_QUERY",status:"done",response:"  FIRST AI $& $` $' $$\r\nSECOND AI\nTHIRD AI  ",error:"DO_NOT_RENDER_ERROR"}, materials:[{path:"QnALog\\Materials\\entry.PNG",name:"  图 $& $` $' $$  ",kind:" IMAGE "},{path:"QnALog/Materials/entry.pdf",name:"  ",type:" pdf "}] },
    {id:"entry-two",offsetMs:3661999,text:" ",materials:[{path:"QnALog/Materials/poster.bin",name:"poster",kind:"image"}]},
    {text:" ",interaction:{response:"DO_NOT_RENDER_ORPHAN_RESPONSE"}},
  ], materials:[{path:"QnALog/Materials/diagram.SVG"},{path:"QnALog/Materials/report.pdf",name:"报告 $& $` $' $$",kind:"document"},{path:"QnALog/Materials/report.pdf",name:"DO_NOT_RENDER_DUPLICATE"}],
};
const expected = (language: string) => ["<details>",`<summary>${language === "en" ? "Material added during the meeting" : "会中补充材料"}</summary>`,"","#### 会中零散记录","","NOTES $& $` $' $$\r\nSECOND NOTE","","#### 用户补充","","- 01:01 ENTRY $& $` $' $$","  - AI：FIRST AI $& $` $' $$\n    SECOND AI\n    THIRD AI","  - [[QnALog/Materials/entry.PNG|图 $& $` $' $$]] · IMAGE","  ![[QnALog/Materials/entry.PNG]]","  - [[QnALog/Materials/entry.pdf|entry.pdf]] · pdf","- 1:01:01","  - [[QnALog/Materials/poster.bin|poster]] · image","  ![[QnALog/Materials/poster.bin]]","","#### 补充材料","","- [[QnALog/Materials/diagram.SVG|diagram.SVG]]","![[QnALog/Materials/diagram.SVG]]","","- [[QnALog/Materials/report.pdf|报告 $& $` $' $$]] · document","","</details>"].join("\n");

describe("meeting materials details and prompt legacy contracts", () => {
  it.each(["zh","en"]) ("renders full details literally (%s)", language => {
    const oldLanguage = getActiveUiLanguage();
    const snapshot = structuredClone(fixture);
    try {
      setActiveUiLanguage(matchUiLanguage(language)!);
      expect(buildMeetingWorkbenchDetails({meetingWorkbench:fixture})).toBe(expected(language));
      expect(buildMeetingWorkbenchDetails({meetingWorkbench:fixture})).toBe(expected(language));
      expect(fixture).toEqual(snapshot);
      expect(fixture.notes).toContain("\r\n");
    } finally { setActiveUiLanguage(oldLanguage); }
  });
  it("renders only populated sections and suppresses draft-only state", () => {
    const previous = getActiveUiLanguage();
    try {
      setActiveUiLanguage(matchUiLanguage("zh")!);
      expect(buildMeetingWorkbenchDetails(null)).toBe("");
      expect(buildMeetingWorkbenchDetails({meetingWorkbench:{draft:"draft"}})).toBe("");
      expect(buildMeetingWorkbenchDetails({meetingWorkbench:{notes:"NOTE"}})).toBe(["<details>","<summary>会中补充材料</summary>","","#### 会中零散记录","","NOTE","","</details>"].join("\n"));
      expect(buildMeetingWorkbenchDetails({meetingWorkbench:{entries:[{atMs:1000,text:"ENTRY"}]}})).toContain("- 00:01 ENTRY");
      expect(buildMeetingWorkbenchDetails({meetingWorkbench:{materials:[{path:"a.pdf"}]}})).toContain("- [[a.pdf|a.pdf]]");
      expect(buildMeetingWorkbenchDetails({meetingWorkbench:{notes:"",draft:"",entries:[],materials:[]}})).toBe("");
      expect(buildMeetingWorkbenchDetails({meetingWorkbench:{entries:[{atMs:1000,text:"ENTRY"}]}})).toBe(["<details>","<summary>会中补充材料</summary>","","#### 用户补充","","- 00:01 ENTRY","","</details>"].join("\n"));
      expect(buildMeetingWorkbenchDetails({meetingWorkbench:{materials:[{path:"a.pdf"}]}})).toBe(["<details>","<summary>会中补充材料</summary>","","#### 补充材料","","- [[a.pdf|a.pdf]]","","</details>"].join("\n"));
    } finally { setActiveUiLanguage(previous); }
  });
  it("keeps prompt distinctions and metadata dedicated", () => {
    const prompt = buildMeetingWorkbenchPrompt(fixture);
    for (const text of [fixture.notes.trim(),"[01:01]","FIRST AI $& $` $' $$；SECOND AI；THIRD AI","entry.PNG","report.pdf"]) expect(prompt).toContain(text);
    expect(prompt).not.toContain("![[");
    const metadata=buildMeetingWorkbenchPrompt({entries:[{text:"@Mina Prepare report",atMs:1000,interaction:{kind:"assignee",assignee:"Mina",task:"Prepare report"}},{text:"/ Review report",atMs:2000,interaction:{kind:"todo",task:"Review report"}}]});
    expect(metadata).toContain("- [00:01] @Mina：Prepare report");
    expect(metadata).toContain("- [00:02] Review report");
    expect(metadata).not.toContain("### 用户补充\n- [00:01]");
  });
  it("propagates second-normalization and getter errors from details and prompt", () => {
    const reset = (path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
    try {
      for (const render of [
        () => buildMeetingWorkbenchDetails({meetingWorkbench:{materials:[{path:"QnALog/Materials/bad.pdf"}]}}),
        () => buildMeetingWorkbenchPrompt({materials:[{path:"QnALog/Materials/bad.pdf"}]}),
      ]) {
        const failure = new Error("meeting path failed");
        let calls = 0;
        vi.mocked(obsidian.normalizePath).mockImplementation(path => {
          calls += 1;
          if (calls === 2) throw failure;
          return reset(path);
        });
        expect(render).toThrow(failure);
      }
      const getterFailure = new Error("meeting getter failed");
      expect(() => buildMeetingWorkbenchDetails({get meetingWorkbench() { throw getterFailure; }})).toThrow(getterFailure);
      expect(() => buildMeetingWorkbenchPrompt({get notes() { throw getterFailure; }})).toThrow(getterFailure);
    } finally {
      vi.mocked(obsidian.normalizePath).mockImplementation(reset);
    }
  });
});
