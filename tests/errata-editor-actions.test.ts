import { describe, expect, it, vi } from "vitest";
import { getCorrectionSelectionPrefill, saveErrataNoise, saveErrataReplacement } from "../src/errata/errata-editor-actions";

describe("errata editor actions", () => {
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
    const editor = { getValue: () => value, setValue: (next: string) => { value = next; } };
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

  it("preserves errors from errata creation so the modal can keep its entered values", async () => {
    const appendReplacement = vi.fn(async () => { throw new Error("folder unavailable"); });
    await expect(saveErrataReplacement({ appendReplacement } as never, {} as never, { getValue: () => "wrong term", setValue: vi.fn() } as never, "wrong term", "right term"))
      .rejects.toThrow("folder unavailable");
  });
});
