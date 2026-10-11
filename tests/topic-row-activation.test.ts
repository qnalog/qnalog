import { describe, expect, it } from "vitest";
import { suppressRowActivation } from "../src/ui/topic-row-activation";

const plain = { onCheckbox: false, onInteractive: false, selectedText: "", disabled: false };

describe("topic candidate row activation", () => {
  it("lets a plain text click toggle the row once", () => {
    expect(suppressRowActivation(plain)).toBe(false);
  });

  it("never interferes with the checkbox itself, which toggles natively", () => {
    expect(suppressRowActivation({ ...plain, onCheckbox: true })).toBe(false);
    expect(suppressRowActivation({ ...plain, onCheckbox: true, selectedText: "摘要" })).toBe(false);
  });

  it("cancels activation for expand and link controls inside the row", () => {
    expect(suppressRowActivation({ ...plain, onInteractive: true })).toBe(true);
  });

  it("cancels activation while the user is selecting text by dragging", () => {
    expect(suppressRowActivation({ ...plain, selectedText: "概要" })).toBe(true);
  });

  it("cancels activation for the disabled starting note", () => {
    expect(suppressRowActivation({ ...plain, disabled: true })).toBe(true);
  });
});
