import { describe, expect, it, vi } from "vitest";
import { findOpenMarkdownLeaf, openOrRevealFile } from "../src/ui/open-note";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.?\//, "").replace(/\/$/, ""),
}));

type FakeLeaf = { view: { file?: { path: string } | null }; id: string };
const leaf = (id: string, path?: string): FakeLeaf => ({ id, view: path === undefined ? {} : { file: { path } } });

function fakeApp(leaves: FakeLeaf[]) {
  const newLeaf = { openFile: vi.fn(async () => undefined) };
  const workspace = {
    getLeavesOfType: vi.fn(() => leaves),
    revealLeaf: vi.fn(async () => undefined),
    setActiveLeaf: vi.fn(),
    getLeaf: vi.fn(() => newLeaf),
  };
  return { app: { workspace } as never, workspace, newLeaf };
}

const topicFile = { path: "QnALog/主题/Topic.md" } as never;

describe("open or reveal a note", () => {
  it("finds the leaf whose file path matches after path normalization", () => {
    const leaves = [leaf("a", "QnALog/其他.md"), leaf("b", "QnALog\\主题\\Topic.md")] as never;
    expect(findOpenMarkdownLeaf(leaves, "QnALog//主题/Topic.md")).toEqual(expect.objectContaining({ id: "b" }));
    expect(findOpenMarkdownLeaf(leaves, "./QnALog/主题/Topic.md/")).toEqual(expect.objectContaining({ id: "b" }));
  });

  it("ignores leaves without a file and is case-sensitive like the vault paths", () => {
    const leaves = [leaf("empty"), leaf("upper", "QnALog/主题/topic.md")] as never;
    expect(findOpenMarkdownLeaf(leaves, "QnALog/主题/Topic.md")).toBeNull();
  });

  it("reveals and focuses the existing tab without opening a new one", async () => {
    const existing = leaf("open", "QnALog/主题/Topic.md");
    const { app, workspace, newLeaf } = fakeApp([existing]);
    await openOrRevealFile(app, topicFile);
    expect(workspace.revealLeaf).toHaveBeenCalledWith(existing);
    expect(workspace.setActiveLeaf).toHaveBeenCalledWith(existing, { focus: true });
    expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(newLeaf.openFile).not.toHaveBeenCalled();
  });

  it("opens the note in a new leaf only when it is not open", async () => {
    const { app, workspace, newLeaf } = fakeApp([leaf("other", "QnALog/其他.md")]);
    await openOrRevealFile(app, topicFile);
    expect(workspace.getLeaf).toHaveBeenCalledWith(true);
    expect(newLeaf.openFile).toHaveBeenCalledWith(topicFile);
    expect(workspace.revealLeaf).not.toHaveBeenCalled();
  });
});
