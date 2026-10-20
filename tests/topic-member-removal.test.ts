import { describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("obsidian", () => {
  class Modal { constructor(public app: unknown) {} }
  class Notice { constructor(message: string) { notices.messages.push(message); } }
  return { Modal, Notice };
});
vi.mock("../src/ui/helpers", () => ({ qnalogConfirm: vi.fn() }));

import { qnalogConfirm } from "../src/ui/helpers";
import { removeMembersFromTopic, topicMemberDisplayTitle } from "../src/ui/topic-member-removal";

function makePort() {
  const preview = {
    topicId: "t1", expectedHash: "h", pageWasManuallyEdited: false, completedBatches: 0, totalBatches: 0,
    items: [
      { id: "blk", type: "remove_block", operation: { type: "remove_block", blockId: "b", expectedText: "x", sourceId: "b.md" }, target: "T", text: "x", sourceId: "b.md", cancellable: true },
      { id: "mem", type: "remove_member", operation: { type: "remove_member", path: "b.md", force: true }, target: "B", text: "B", sourceId: "b.md", cancellable: true },
    ],
  };
  return {
    text: (key: string) => key,
    previewRemoveMembers: vi.fn(async () => preview),
    apply: vi.fn(async () => ({ path: "Topics/T.md", markdown: "", pageChangedDuringGeneration: false })),
    cancel: vi.fn(),
  };
}

describe("removing notes from a topic", () => {
  it("applies every item after one confirmation, without asking about individual points", async () => {
    vi.mocked(qnalogConfirm).mockResolvedValue(true);
    const port = makePort();
    const refresh = vi.fn();
    await removeMembersFromTopic({} as never, port as never, "t1", ["b.md"], refresh);
    expect(port.previewRemoveMembers).toHaveBeenCalledWith("t1", ["b.md"]);
    expect(port.apply).toHaveBeenCalledWith(expect.anything(), ["blk", "mem"]);
    expect(vi.mocked(qnalogConfirm).mock.calls.at(-1)?.[2]).toBe("Remove {0} note(s) and the {1} point(s) only they support? Points that other notes also support stay.".replace("{0}", "1").replace("{1}", "1"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("changes nothing when the confirmation is declined", async () => {
    vi.mocked(qnalogConfirm).mockResolvedValue(false);
    const port = makePort();
    const refresh = vi.fn();
    await removeMembersFromTopic({} as never, port as never, "t1", ["b.md"], refresh);
    expect(port.apply).not.toHaveBeenCalled();
    expect(port.cancel).toHaveBeenCalledWith("t1");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows the error when the preview fails", async () => {
    const port = makePort();
    port.previewRemoveMembers.mockRejectedValue(new Error("This note is not a member of the topic."));
    await removeMembersFromTopic({} as never, port as never, "t1", ["zzz.md"], vi.fn());
    expect(port.apply).not.toHaveBeenCalled();
    expect(notices.messages).toContain("This note is not a member of the topic.");
  });

  it("names a member by its link title, falling back to the file name", () => {
    const page = { memberLinks: ["[[Notes/a|Alpha]]"] } as never;
    expect(topicMemberDisplayTitle(page, "Notes/a.md")).toBe("Alpha");
    expect(topicMemberDisplayTitle(page, "Notes/b.md")).toBe("b");
  });
});
