import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");

describe("quick settings contract", () => {
  it("keeps separate Bailian ASR and AI model choices", () => {
    const source = fs.readFileSync(path.join(root, "src/ui/settings-tab.ts"), "utf8");
    const quickSettings = source.slice(
      source.indexOf("// 快速配置：百炼分别选择"),
      source.indexOf("const prep = page.createDiv", source.indexOf("// 快速配置：百炼分别选择")),
    );

    expect(quickSettings).toContain('.setName("ASR 模型")');
    expect(quickSettings).toContain('.setName("AI 整理模型")');
    expect(quickSettings).toContain("fetchImportTranscribeModels");
    expect(quickSettings).toContain("fetchLlmModelList");
    expect(quickSettings).toContain("testImportTranscribeProvider");
    expect(quickSettings).toContain("testLlmConnection");
  });
});
