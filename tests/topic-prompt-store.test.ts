import { describe, expect, it } from "vitest";
import { TopicPromptStore } from "../src/topics/topic-prompt-store";

describe("topic prompt store", () => {
  it("keeps prompts in memory per note and removes only an ignored note/topic pair", () => {
    const store = new TopicPromptStore();
    store.set("Notes/new.md", [
      { path: "Notes/new.md", topicId: "topic-a", title: "A", matchedTags: ["project/qalog"] },
      { path: "Notes/new.md", topicId: "topic-b", title: "B", matchedTags: ["topic/workflow"] },
    ]);
    store.set("Notes/other.md", [{ path: "Notes/other.md", topicId: "topic-a", title: "A", matchedTags: ["project/qalog"] }]);
    store.remove("Notes/new.md", "topic-a");
    expect(store.get("Notes/new.md").map((prompt) => prompt.topicId)).toEqual(["topic-b"]);
    expect(store.get("Notes/other.md")).toHaveLength(1);
  });
});
