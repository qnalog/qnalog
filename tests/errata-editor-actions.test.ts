import { describe, expect, it, vi } from "vitest";
const notices = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("obsidian", () => ({
  Modal: class Modal { app: unknown; contentEl = { empty: vi.fn() }; constructor(app: unknown) { this.app = app; } open() {} close() {} },
  Notice: class Notice { constructor(message: string) { notices.messages.push(message); } },
}));
vi.mock("../src/shared/open-note", () => ({ openOrRevealFile: vi.fn(async () => undefined) }));
import { getCorrectionSelectionPrefill, openErrataForFile, saveErrataNoise, saveErrataReplacement } from "../src/errata/errata-editor-actions";
import { openOrRevealFile } from "../src/shared/open-note";

describe("errata editor actions", () => {
  it("creates the errata and then opens it", async () => {
    const file = { path: "Notes/source.md" } as never;
    const errataFile = { path: "QnALog/勘误表/source · 勘误.md" } as never;
    const app = {} as never;
    const createForFile = vi.fn(async () => errataFile);
    vi.mocked(openOrRevealFile).mockClear();

    await openErrataForFile(app, { createForFile }, file);

    expect(createForFile).toHaveBeenCalledWith(file);
    expect(openOrRevealFile).toHaveBeenCalledWith(app, errataFile);
    expect(createForFile.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(openOrRevealFile).mock.invocationCallOrder[0]);
  });

  it("shows the creation error and does not open a file", async () => {
    const app = {} as never;
    const createForFile = vi.fn(async () => { throw new Error("folder unavailable"); });
    vi.mocked(openOrRevealFile).mockClear();
    notices.messages.length = 0;

    await openErrataForFile(app, { createForFile }, { path: "Notes/source.md" } as never);

    expect(openOrRevealFile).not.toHaveBeenCalled();
    expect(notices.messages).toContain("Could not create or open the errata: folder unavailable");
  });

  it("prefills only a single-line selection of at most 60 characters", () => {
    expect(getCorrectionSelectionPrefill("wrong term")).toEqual({ wrongText: "wrong term", tooLong: false });
    expect(getCorrectionSelectionPrefill("line one\nline two")).toEqual({ wrongText: "", tooLong: true });
    expect(getCorrectionSelectionPrefill("x".repeat(61))).toEqual({ wrongText: "", tooLong: true });
    expect(getCorrectionSelectionPrefill("")).toEqual({ wrongText: "", tooLong: false });
  });

  it("stores a replacement and updates only unprotected editor text immediately", async () => {
    const source = [
      "# Draft",
      "wrong term in the body",
      "<!-- qnalog-transcript-start:session -->",
      "wrong term in the transcript",
      "<!-- qnalog-transcript-end:session -->",
    ].join("\n");
    let value = source;
    const editor = {
      getValue: () => value,
      offsetToPos: (offset: number) => ({ line: value.slice(0, offset).split("\n").length - 1, ch: value.slice(0, offset).split("\n").pop()?.length || 0 }),
      replaceRange: (replacement: string, from: { line: number; ch: number }, to: { line: number; ch: number }) => {
        const offset = (position: { line: number; ch: number }) => value.split("\n").slice(0, position.line).join("\n").length + (position.line ? 1 : 0) + position.ch;
        value = value.slice(0, offset(from)) + replacement + value.slice(offset(to));
      },
    };
    const appendReplacement = vi.fn(async () => ({ path: "QnALog/勘误表/example · 勘误.md" }));
    await saveErrataReplacement({ appendReplacement } as never, { path: "QnALog/Notes/example.md" } as never, editor as never, "wrong term", "right term");
    expect(appendReplacement).toHaveBeenCalledWith(expect.anything(), "wrong term", "right term");
    expect(value).toContain("right term in the body");
    expect(value).toContain("wrong term in the transcript");
  });

  it("allows multiline noise up to 2000 characters and rejects empty or longer selections", async () => {
    const appendNoise = vi.fn(async () => ({ path: "QnALog/勘误表/example · 勘误.md" }));
    await saveErrataNoise({ appendNoise } as never, { path: "QnALog/Notes/example.md" } as never, "line one\nline two");
    expect(appendNoise).toHaveBeenCalledWith(expect.anything(), "line one\nline two");
    await expect(saveErrataNoise({ appendNoise } as never, {} as never, " ")).rejects.toThrow();
    await expect(saveErrataNoise({ appendNoise } as never, {} as never, "x".repeat(2001))).rejects.toThrow();
  });

  it("rejects a one-character wrong term without changing the note or errata", async () => {
    let value = "x in note body";
    const appendReplacement = vi.fn(async () => ({ path: "errata.md" }));
    const editor = { getValue: () => value, replaceRange: vi.fn(), offsetToPos: vi.fn() };
    await expect(saveErrataReplacement({ appendReplacement } as never, {} as never, editor as never, "x", "y"))
      .rejects.toThrow("at least 2 characters");
    expect(value).toBe("x in note body");
    expect(appendReplacement).not.toHaveBeenCalled();
    expect(editor.replaceRange).not.toHaveBeenCalled();
  });

  it("preserves errors from errata creation so the modal can keep its entered values", async () => {
    const appendReplacement = vi.fn(async () => { throw new Error("folder unavailable"); });
    await expect(saveErrataReplacement({ appendReplacement } as never, {} as never, { getValue: () => "wrong term", setValue: vi.fn() } as never, "wrong term", "right term"))
      .rejects.toThrow("folder unavailable");
  });
});
