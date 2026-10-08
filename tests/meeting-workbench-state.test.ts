import { describe, expect, it, vi } from "vitest";
import { normalizeMeetingMaterials, normalizeMeetingWorkbench, hasMeetingWorkbenchContent, isImageMeetingMaterial } from "../src/notes/meeting-workbench-state";
import * as obsidian from "obsidian";

function thrownBy(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  return undefined;
}
vi.mock("obsidian", () => ({ normalizePath: vi.fn((path: string) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, "")) }));

describe("meeting workbench legacy state contracts", () => {
  it("normalizes materials with legacy conversion, dedupe order, and slicing", () => {
    expect(normalizeMeetingMaterials(null)).toEqual([]);
    expect(normalizeMeetingMaterials([null, false, 1, "x", {}, { path: "" }])).toEqual([]);
    const source = [
      { path: "QnALog\\Materials\\one.pdf", name: "first", kind: " doc ", addedAt: "  stamp  " },
      { path: "QnALog/Materials/one.pdf", name: "later" },
      { path: "a/42", name: 42, kind: true, addedAt: 0 },
      { path: "a/true", name: true, kind: false, addedAt: false },
      { path: "a/blank", name: "   " },
    ];
    expect(normalizeMeetingMaterials(source)).toEqual([
      { path: "QnALog/Materials/one.pdf", name: "first", kind: "doc", addedAt: "  stamp  " },
      { path: "a/42", name: "42", kind: "true", addedAt: "" },
      { path: "a/true", name: "true", kind: "", addedAt: "" },
      { path: "a/blank", name: "", kind: "", addedAt: "" },
    ]);
    expect(source[0].path).toBe("QnALog\\Materials\\one.pdf");
    const numbered = Array.from({ length: 32 }, (_, i) => ({ path: `p/${i}` }));
    expect(normalizeMeetingMaterials(numbered).map(x => x.path)).toEqual(Array.from({length:30},(_,i)=>`p/${i+2}`));
    expect(normalizeMeetingMaterials(numbered, 2).map(x => x.path)).toEqual(["p/30","p/31"]);
    expect(normalizeMeetingMaterials(numbered, 0).map(x => x.path)).toEqual(numbered.map(x=>x.path));
    expect(normalizeMeetingMaterials(numbered, -2).map(x => x.path)).toEqual(numbered.slice(2).map(x=>x.path));
  });
  it("normalizes state and entry defaults, limits, and content semantics", () => {
    const empty = { notes: "", draft: "", materials: [], entries: [] };
    for (const value of [undefined, null, false, 4, "x", []]) expect(normalizeMeetingWorkbench(value)).toEqual(empty);
    expect(normalizeMeetingWorkbench({ notes: { toString: () => "wrong" }, draft: { toString: () => "wrong" } })).toMatchObject({notes:"",draft:""});
    const entries = [null, { text:" ", interaction:{response:"orphan"} }, { text:"", materials:[{path:"m"}], atMs:61999, createdAt:"stamp" }, {text:" hi ",atMs:0,offsetMs:5,createdAt:"",addedAt:"added",interaction:[]}, {text:"n",atMs:null,offsetMs:-1}];
    expect(normalizeMeetingWorkbench({ entries }).entries).toEqual([
      { id:"meeting-entry-0-61999-stamp", atMs:61999, createdAt:"stamp", source:"material", text:"", materials:[{path:"m",name:"m",kind:"",addedAt:""}], interaction:null },
      { id:"meeting-entry-1-0-added", atMs:0, createdAt:"added", source:"manual", text:"hi", materials:[], interaction:{kind:"",query:"",status:"",response:"",error:"",updatedAt:"",assignee:"",task:""} },
      { id:"meeting-entry-2-0-time", atMs:0, createdAt:"", source:"manual", text:"n", materials:[], interaction:null },
    ]);
    expect(normalizeMeetingWorkbench({ draft:"draft" })).toMatchObject({draft:"draft"});
    expect(hasMeetingWorkbenchContent({draft:"draft"})).toBe(false);
    expect(hasMeetingWorkbenchContent({notes:"x"})).toBe(true);
    expect(hasMeetingWorkbenchContent({materials:[{path:"m"}]})).toBe(true);
    expect(hasMeetingWorkbenchContent({entries:[{text:"x"}]})).toBe(true);
    const materialList=Array.from({length:32},(_,i)=>({path:`m/${i}`}));
    expect(normalizeMeetingWorkbench({materials:materialList}).materials.map(x=>x.path)).toEqual(Array.from({length:30},(_,i)=>`m/${i+2}`));
    expect(normalizeMeetingWorkbench({entries:Array.from({length:102},(_,i)=>({text:String(i)}))}).entries).toHaveLength(100);
  });
  it("asserts entry material slicing, retained ranges, timestamp coercion, and defaults", () => {
    const materialRows = Array.from({length:14},(_,i)=>({path:`entry/${i}`}));
    const normalized = normalizeMeetingWorkbench({entries:[
      {text:"x",materials:materialRows,source:"custom",atMs:NaN},
      {text:"y",atMs:"61999",createdAt:"",addedAt:"stamp"},
      {text:"z",atMs:null,offsetMs:"7"},
      {text:"n",atMs:-1},
    ]}).entries;
    expect(normalized[0].materials.map(item=>item.path)).toEqual(Array.from({length:12},(_,i)=>`entry/${i+2}`));
    expect(normalized.map(entry=>[entry.atMs,entry.source,entry.createdAt])).toEqual([
      [0,"custom",""],[61999,"manual","stamp"],[7,"manual",""],[0,"manual",""],
    ]);
    const many = normalizeMeetingWorkbench({entries:Array.from({length:102},(_,i)=>({text:String(i)}))}).entries;
    expect(many.map(entry=>entry.text)).toEqual(Array.from({length:100},(_,i)=>String(i+2)));
    expect(many[0].id).toBe("meeting-entry-2-0-time");
    const top = Array.from({length:32},(_,i)=>({path:`top/${i}`}));
    top.push({path:"top/31",name:"DO_NOT_WIN"});
    expect(normalizeMeetingMaterials(top).map(item=>item.path)).toEqual(Array.from({length:30},(_,i)=>`top/${i+2}`));
    expect(normalizeMeetingMaterials([{path:"p",name:""},{path:"q"}])[1].name).toBe("q");
  });
  it("trims interaction text fields but not updatedAt and preserves explicit sources", () => {
    const normalized = normalizeMeetingWorkbench({entries:[{
      text:"text",source:"  source  ",interaction:{
        kind:" k ",query:" q ",status:" s ",response:" r ",error:" e ",updatedAt:"  u  ",assignee:" a ",task:" t ",
      },
    }]}).entries[0];
    expect(normalized.source).toBe("  source  ");
    expect(normalized.interaction).toEqual({kind:"k",query:"q",status:"s",response:"r",error:"e",updatedAt:"  u  ",assignee:"a",task:"t"});
  });
  it("recognizes only legacy image forms and propagates exact conversion failures", () => {
    for (const path of ["a.PNG","a.jpg","a.jpeg","a.webp","a.gif","a.bmp","a.svg"]) expect(isImageMeetingMaterial({path})).toBe(true);
    expect(isImageMeetingMaterial({kind:"IMAGE"})).toBe(true);
    for (const path of ["a.pdf","a","a.png?x=1","a.png#x"]) expect(isImageMeetingMaterial({path})).toBe(false);
    expect(isImageMeetingMaterial({kind:"image/png"})).toBe(false);
    expect(isImageMeetingMaterial(null)).toBe(false);
    const error = new Error("conversion");
    expect(thrownBy(() => isImageMeetingMaterial({get path(){throw error}}))).toBe(error);
    vi.mocked(obsidian.normalizePath).mockImplementation(() => { throw error; });
    try { expect(thrownBy(() => normalizeMeetingMaterials([{path:"x"}]))).toBe(error); }
    finally { vi.mocked(obsidian.normalizePath).mockImplementation(path => String(path || "").replace(/\\/g, "/").replace(/\/+$/, "")); }
  });
  it("preserves legacy array-object handling and exact thrown errors", () => {
    const withFields = Object.assign([], { notes: "  note  ", entries: [{ text: " array entry " }] });
    expect(normalizeMeetingWorkbench(withFields)).toMatchObject({ notes: "note", entries: [{ text: "array entry" }] });
    const materialFailure = new Error("material getter");
    expect(thrownBy(() => normalizeMeetingMaterials([Object.defineProperty({}, "path", { get() { throw materialFailure; } })]))).toBe(materialFailure);
    const stringFailure = new Error("toString failed");
    const badString = { toString() { throw stringFailure; } };
    expect(thrownBy(() => normalizeMeetingMaterials([{ path: "p", name: badString }]))).toBe(stringFailure);
    expect(thrownBy(() => normalizeMeetingWorkbench({ entries: [{ text: badString }] }))).toBe(stringFailure);
    expect(thrownBy(() => isImageMeetingMaterial({ path: badString }))).toBe(stringFailure);
    const getterFailure = new Error("interaction getter");
    expect(thrownBy(() => normalizeMeetingWorkbench({ entries: [{ text: "x", interaction: { get response() { throw getterFailure; } } }] }))).toBe(getterFailure);
    const pathFailure = new Error("meeting path failed");
    vi.mocked(obsidian.normalizePath).mockImplementationOnce(() => { throw pathFailure; });
    expect(thrownBy(() => normalizeMeetingMaterials([{ path: "bad" }]))).toBe(pathFailure);
    const first = new Error("kind getter");
    expect(thrownBy(() => isImageMeetingMaterial({ path: "a.png", get kind() { throw first; } }))).toBe(first);
    const imageInput = { path: { toString: () => "x.png" }, kind: "other" };
    expect(isImageMeetingMaterial(imageInput)).toBe(true);
    const source = { notes: " n ", draft: " d ", entries: [{ text: " e ", materials: [{ path: "m" }] }] };
    const snapshot = structuredClone({ notes: source.notes, draft: source.draft, entries: [{ text: " e ", materials: [{ path: "m" }] }] });
    normalizeMeetingWorkbench(source);
    expect(source).toEqual(snapshot);
  });
});
