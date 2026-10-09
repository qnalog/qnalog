import { describe, expect, it } from "vitest";
import {
  applyRoleMappingToSegments,
  extractRoleMappingFromFrontmatter,
  flattenRoleMappedFrontmatter,
  parseRoleMapItem,
} from "../src/notes/role-mapping";

describe("role mapping", () => {
  it("parses the supported arrows and rejects empty or identity mappings", () => {
    expect(parseRoleMapItem("旧名 → 新名")).toEqual({ from: "旧名", to: "新名" });
    expect(parseRoleMapItem("旧名 => 新名")).toEqual({ from: "旧名", to: "新名" });
    expect(parseRoleMapItem("旧名 -> 新名")).toEqual({ from: "旧名", to: "新名" });
    expect(parseRoleMapItem("同名 → 同名")).toBeNull();
    expect(parseRoleMapItem("  → 新名")).toBeNull();
    expect(parseRoleMapItem("旧名 →  ")).toBeNull();
    expect(parseRoleMapItem(" ")).toBeNull();
  });

  it("extracts arrays and scalar fields, keeping the first mapping for each source", () => {
    expect(extractRoleMappingFromFrontmatter({
      参会人: ["甲 → 张三", "乙 => 李四", "甲 -> 王五", "无映射"],
      受访者: "丙 -> 赵六",
    })).toEqual([
      { from: "甲", to: "张三" },
      { from: "乙", to: "李四" },
      { from: "丙", to: "赵六" },
    ]);
  });

  it("adds both speaker label spellings from confirmed speaker names", () => {
    const mappings = extractRoleMappingFromFrontmatter({
      qnalog_speakers: { "spk-2": { personName: "李四" } },
    });
    expect(mappings).toEqual([
      { from: "说话人2", to: "李四" },
      { from: "说话人 2", to: "李四" },
    ]);
  });

  it("applies longer names first and treats mapping sources as literal text", () => {
    const segments = [{ text: "A.+(B) and A.+(B) Ltd." }];
    expect(applyRoleMappingToSegments(segments, [
      { from: "A.+(B)", to: "Alice" },
      { from: "A.+(B) Ltd.", to: "Alice Company" },
    ])).toEqual([{ text: "Alice and Alice Company" }]);
    expect(segments[0].text).toBe("A.+(B) and A.+(B) Ltd.");
  });

  it("preserves the segment array when mappings are empty and flattens a copied frontmatter", () => {
    const segments = [{ text: "甲" }];
    expect(applyRoleMappingToSegments(segments, [])).toBe(segments);

    const frontmatter = {
      参会人: ["甲 → 张三", "普通参与者"],
      受访者: "乙 -> 李四",
      keep: { nested: true },
    };
    const flattened = flattenRoleMappedFrontmatter(frontmatter, [
      { from: "甲", to: "张三" },
      { from: "乙", to: "李四" },
    ]);
    expect(flattened).toEqual({
      参会人: ["张三", "普通参与者"],
      受访者: "李四",
      keep: { nested: true },
    });
    expect(flattened).not.toBe(frontmatter);
    expect(frontmatter).toEqual({
      参会人: ["甲 → 张三", "普通参与者"],
      受访者: "乙 -> 李四",
      keep: { nested: true },
    });
    expect(flattenRoleMappedFrontmatter(frontmatter, [])).toEqual(frontmatter);
    expect(flattenRoleMappedFrontmatter(frontmatter, [])).not.toBe(frontmatter);
  });
});
