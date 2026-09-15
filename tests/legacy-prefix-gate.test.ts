import { describe, expect, it } from "vitest";
import { checkLegacyPrefixes } from "../scripts/check-legacy-prefixes.mjs";

// 静态门禁本身要有测试：它拦的是「改名漏了几处」，而漏改会变成用户数据的兼容负担
// （lex- 录音文件名已经写进 1.0.0 用户的知识库）。这里验证它确实能拦住新增的旧前缀。
describe("旧前缀静态门禁", () => {
  it("拦得住各种真实出现过的漏改形态", () => {
    const cases = [
      ["src/audio/recording-service.ts", 'const n = `lex-${stamp}.webm`;'],
      ["src/shared/util-common.ts", 'return "lv-" + Date.now();'],
      ["styles.css", ".x { --lex-sidebar-surface: var(--background-secondary); }"],
      ["styles.css", ".y { color: var(--lv-sediment-accent); }"],
      ["styles.css", ".z { color: var(--lvk-line); }"],
      ["src/asr/clients.ts", 'this.taskId = "lvtask-" + Date.now();'],
      ["src/ui/outline-view.ts", 'el.classList.add("lex-ms-active");'],
      ["src/notes/x.ts", 'const m = `<!-- lexvoice-session:${id} -->`;'],
      ["tests/some.test.ts", 'expect(f("lv-import-1")).toBe(1);'],
    ];
    for (const [file, content] of cases) {
      const found = checkLegacyPrefixes({ [file]: content });
      expect(found.length, `${file}: ${content}`).toBeGreaterThan(0);
    }
  });

  it("放行 qnalog 新前缀与无关文本", () => {
    const clean = {
      "src/a.ts": 'const n = `qnalog-${stamp}.webm`; el.classList.add("qnalog-ms-active");',
      "styles.css": ".x { --qnalog-sidebar-surface: var(--background-secondary); }",
      "README.md": "Q&A Log is derived from LexVoice — see NOTICE.",
      "src/b.ts": 'const word = "flex-wrap"; const other = "shelve";',
    };
    expect(checkLegacyPrefixes(clean)).toEqual([]);
  });

  it("白名单里的兼容代码被放行（读取 1.0.0 遗留数据是正当用途）", () => {
    const allowed = {
      "src/shared/namespace.ts": 'export const NS_AUDIO_PREFIX_LEGACY = "lex";',
      "src/report/render.ts": '.lv-panorama { display: none; }',
    };
    expect(checkLegacyPrefixes(allowed)).toEqual([]);
  });

  it("不因产物重复报同一处（main.js 由源码侧负责）", () => {
    expect(checkLegacyPrefixes({ "main.js": 'var x = "lex-20260101-120000"' })).toEqual([]);
  });

  it("发版说明必须能写出旧前缀（否则说不清修了什么）", () => {
    // 真实场景：1.0.1 的说明里要写「新录音的前缀仍是 lex-…，1.0.0 录下的文件仍可读取」
    const notes = { ".github/release-notes/1.0.1.md": "新录音的前缀仍是 `lex-`，1.0.0 录下的 `lv-sed-` 仍可读取。" };
    expect(checkLegacyPrefixes(notes)).toEqual([]);
    // 但同一句若出现在源码里就必须拦
    expect(checkLegacyPrefixes({ "src/x.ts": 'const p = "lex-";' }).length).toBe(1);
  });

  it("报告里带文件与行号，能直接定位", () => {
    const found = checkLegacyPrefixes({ "src/x.ts": "line1\nconst a = 'lv-abc';\n" });
    expect(found[0]).toContain("src/x.ts:2");
  });
});
