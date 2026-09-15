import { describe, expect, it } from "vitest";
import {
  buildVersionPayload,
  replaceExistingActiveVersionBlock,
  replaceLeadingFrontmatter,
  sanitizeActiveVersionBody,
  splitLeadingFrontmatter,
  splitVersionPayload,
} from "../src/version-content";

const generatedDocument = [
  "---",
  "mode: seminar",
  "topic: Audio test",
  "tags:",
  "  - lexvoice/seminar",
  "---",
  "",
  "# Seminar minutes",
  "",
  "Generated body.",
].join("\n");

describe("LexVoice version content", () => {
  it("separates generated YAML from the display body", () => {
    const parts = splitVersionPayload(generatedDocument);
    expect(parts.frontmatter).toContain("mode: seminar");
    expect(parts.body).toBe("# Seminar minutes\n\nGenerated body.");
  });

  it("stores generated YAML in a non-frontmatter cache marker", () => {
    const source = splitVersionPayload(generatedDocument);
    const payload = buildVersionPayload(source.frontmatter, source.body);
    expect(payload).toContain("lexvoice-version-frontmatter-start");
    expect(payload).not.toMatch(/^---/);

    const restored = splitVersionPayload(payload);
    expect(restored).toEqual(source);
  });

  it("replaces the mother note frontmatter instead of adding another YAML block", () => {
    const mother = "---\nmode: synthesis\ntopic: Old\n---\n\n# Mother\n\nRaw tail";
    const generated = splitVersionPayload(generatedDocument);
    const next = replaceLeadingFrontmatter(mother, generated.frontmatter);
    expect(next.match(/^---$/gm)).toHaveLength(2);
    expect(next).toContain("mode: seminar");
    expect(next).not.toContain("mode: synthesis");
    expect(next).toContain("# Mother\n\nRaw tail");
  });

  it("never allows YAML to leak into an active version body", () => {
    const clean = sanitizeActiveVersionBody(generatedDocument);
    expect(clean).toBe("# Seminar minutes\n\nGenerated body.");
    expect(clean).not.toContain("mode: seminar");
    expect(clean).not.toMatch(/^---/);
  });

  it("reads legacy cache bodies that begin with generated frontmatter", () => {
    const cacheFile = "---\ntype: cache\n---\n\n" + generatedDocument;
    const cache = splitLeadingFrontmatter(cacheFile);
    const legacy = splitVersionPayload(cache.body);
    expect(legacy.frontmatter).toContain("mode: seminar");
    expect(legacy.body).toContain("Generated body.");
  });

  it("keeps the mother YAML when a body-only version is applied", () => {
    const mother = "---\nmode: synthesis\n---\n\n# Mother";
    expect(replaceLeadingFrontmatter(mother, "")).toBe(mother);
    expect(sanitizeActiveVersionBody("# Clean script")).toBe("# Clean script");
  });

  it("repairs a mother note that already contains duplicate YAML in its active block", () => {
    const malformed = [
      "---",
      "mode: synthesis",
      "topic: Old",
      "---",
      "# Mother",
      "<!-- lexvoice-active-version-start -->",
      "> [!info] Current version",
      "",
      generatedDocument,
      "<!-- lexvoice-active-version-end -->",
      "",
      "---",
      "",
      "<details>Raw transcript</details>",
    ].join("\n");
    const generated = splitVersionPayload(generatedDocument);
    const withCurrentYaml = replaceLeadingFrontmatter(malformed, generated.frontmatter);
    const block = [
      "<!-- lexvoice-active-version-start -->",
      "> [!info] Current version",
      "",
      sanitizeActiveVersionBody(generatedDocument),
      "<!-- lexvoice-active-version-end -->",
    ].join("\n");
    const repaired = replaceExistingActiveVersionBlock(withCurrentYaml, block);

    expect(repaired).not.toBeNull();
    expect(repaired!.match(/^---$/gm)).toHaveLength(3);
    expect(repaired!.slice(0, repaired!.indexOf("<!-- lexvoice-active-version-end -->"))).not.toContain("mode: synthesis");
    expect(repaired!.slice(0, repaired!.indexOf("<!-- lexvoice-active-version-end -->"))).toContain("mode: seminar");
    expect(repaired).toContain("<details>Raw transcript</details>");
  });
});
