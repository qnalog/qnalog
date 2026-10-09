import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({}));

import { getFrontmatterTags } from "../src/shared/frontmatter-tags";

function expectSameFailure(callback: () => unknown, failure: Error): void {
  try {
    callback();
    throw new Error("expected callback to throw");
  } catch (error) {
    expect(error).toBe(failure);
  }
}

describe("frontmatter tag extraction", () => {
  it.each([undefined, null, false, 0, "meeting"])("ignores non-object frontmatter: %s", (frontmatter) => {
    expect(getFrontmatterTags(frontmatter)).toEqual([]);
  });

  it("returns no tags when object fields are absent", () => {
    expect(getFrontmatterTags({})).toEqual([]);
  });

  it("splits scalar tags on commas and whitespace while retaining duplicates", () => {
    expect(getFrontmatterTags({ tags: " meeting,\tseminar\nmeeting " })).toEqual(["meeting", "seminar", "meeting"]);
  });

  it("converts array items to strings without splitting item contents", () => {
    expect(getFrontmatterTags({ tags: [" meeting,seminar ", "", null, false, 0, ["a", "b"]] }))
      .toEqual(["meeting,seminar", "null", "false", "0", "a,b"]);
  });

  it("uses JavaScript truthiness to select tags before tag", () => {
    expect(getFrontmatterTags({ tags: [], tag: "seminar" })).toEqual([]);
    expect(getFrontmatterTags({ tags: "", tag: "seminar" })).toEqual(["seminar"]);
    expect(getFrontmatterTags({ tags: 0, tag: "seminar" })).toEqual(["seminar"]);
  });

  it("reads inherited fields and leaves hash prefixes unchanged", () => {
    const inherited = Object.create({ tags: "qnalog/seminar" }) as object;
    expect(getFrontmatterTags(inherited)).toEqual(["qnalog/seminar"]);
    expect(getFrontmatterTags({ tags: "#meeting" })).toEqual(["#meeting"]);
  });

  it("uses custom string conversion for scalar and array values", () => {
    const value = { toString: () => " meeting " };
    expect(getFrontmatterTags({ tags: value })).toEqual(["meeting"]);
    expect(getFrontmatterTags({ tags: [value] })).toEqual(["meeting"]);
  });

  it("propagates errors from tags and fallback tag getters", () => {
    const tagsFailure = new Error("conversion");
    expectSameFailure(() => getFrontmatterTags({ get tags() { throw tagsFailure; } }), tagsFailure);

    const tagFailure = new Error("conversion");
    expectSameFailure(() => getFrontmatterTags({ tags: "", get tag() { throw tagFailure; } }), tagFailure);
  });

  it("propagates scalar and array item conversion errors", () => {
    const scalarFailure = new Error("conversion");
    expectSameFailure(() => getFrontmatterTags({ tags: { toString() { throw scalarFailure; } } }), scalarFailure);

    const arrayFailure = new Error("conversion");
    expectSameFailure(() => getFrontmatterTags({ tags: [{ toString() { throw arrayFailure; } }] }), arrayFailure);
  });

  it("reads tags once and only reads tag when tags is falsy", () => {
    const truthyReads: string[] = [];
    expect(getFrontmatterTags({
      get tags() { truthyReads.push("tags"); return "seminar"; },
      get tag() { truthyReads.push("tag"); return "meeting"; },
    })).toEqual(["seminar"]);
    expect(truthyReads).toEqual(["tags"]);

    const fallbackReads: string[] = [];
    expect(getFrontmatterTags({
      get tags() { fallbackReads.push("tags"); return ""; },
      get tag() { fallbackReads.push("tag"); return "seminar"; },
    })).toEqual(["seminar"]);
    expect(fallbackReads).toEqual(["tags", "tag"]);
  });
});
