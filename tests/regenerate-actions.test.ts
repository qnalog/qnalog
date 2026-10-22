import { afterEach, describe, expect, it, vi } from "vitest";

const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock("obsidian", () => ({ TFile: class TFile {}, Notice: class Notice {}, normalizePath: (p: string) => p }));
vi.mock("../src/ui/helpers", () => ({ qnalogConfirm: confirm }));

import { confirmAndReorganize, orderedRegenerateModes, type RegenerateActionsPort } from "../src/ui/regenerate-actions";

const transcriptNote = "<details><summary>分段原始转写</summary>\n### Segment 1\nHello\n</details>";

function makePort(markdown: string) {
  const reorganizeNoteInPlace = vi.fn(async () => true);
  const port = {
    app: { vault: { cachedRead: vi.fn(async () => markdown) } },
    settings: { repolishPreference: "" },
    saveSettings: vi.fn(async () => undefined),
    detectNoteMode: () => null,
    reorganizeNoteInPlace,
    saveAsNewVersion: vi.fn(async () => true),
  } as unknown as RegenerateActionsPort;
  return { port, reorganizeNoteInPlace };
}

afterEach(() => { confirm.mockReset(); confirm.mockImplementation(async () => true); });

describe("regenerate actions", () => {
  const file = { path: "Notes/a.md" } as never;

  it("hands a note without original transcript to the flow without asking (the flow offers recovery)", async () => {
    const { port, reorganizeNoteInPlace } = makePort("# Note\n\nNo transcript.");
    await confirmAndReorganize(port, file, { mode: "meeting" });
    expect(confirm).not.toHaveBeenCalled();
    expect(reorganizeNoteInPlace).toHaveBeenCalledWith(file, { mode: "meeting" });
  });

  it("asks before rewriting a note that has original transcript", async () => {
    const { port, reorganizeNoteInPlace } = makePort(transcriptNote);
    await confirmAndReorganize(port, file, { mode: "meeting", preference: { key: "concise", label: "Concise" } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(reorganizeNoteInPlace).toHaveBeenCalledWith(file, { mode: "meeting", preference: { key: "concise", label: "Concise" } });
  });

  it("does nothing when the confirmation is cancelled", async () => {
    confirm.mockImplementation(async () => false);
    const { port, reorganizeNoteInPlace } = makePort(transcriptNote);
    await expect(confirmAndReorganize(port, file)).resolves.toBe(false);
    expect(reorganizeNoteInPlace).not.toHaveBeenCalled();
  });

  it("lists the note's own mode first and keeps the others in order", () => {
    const modes = orderedRegenerateModes({} as never, null);
    const pick = modes[2];
    const ordered = orderedRegenerateModes({} as never, pick);
    expect(ordered[0]).toBe(pick);
    expect(ordered.slice(1)).toEqual(modes.filter((mode) => mode !== pick));
    expect(orderedRegenerateModes({} as never, "not-a-mode")).toEqual(modes);
  });
});
