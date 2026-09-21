import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  normalizePath: (p: string) => String(p || "").replace(/\\/g, "/"),
  TFile: class {}, TFolder: class {},
}));
import { extractTranscriptSegments } from "../src/notes/note-markdown";

// 整合版布局的段标题行带回听链接 `[[audio|mm:ss]]`、正文只有纯文本；
// 旧布局的段正文带嵌入 `![[audio]]`。读回分段时两种来源都要还原 audioName，
// 否则续录/重新整理重写后旧段落的回听链接消失、旧音频文件失去全部引用。
describe("extractTranscriptSegments 音频名还原", () => {
  it("段标题行带 [[audio|mm:ss]] 时读出 audioName（整合版布局）", () => {
    const md = [
      "# 笔记",
      "",
      "正文",
      "",
      "---",
      "",
      "## 原始材料",
      "",
      "<details>",
      "<summary>分段原始转写（1 段）</summary>",
      "",
      "### 段落 1 (00:00–03:56) [[qnalog-20260917-115635.m4a|00:00]] · 结束",
      "",
      "第一段转写文本。",
      "",
      "</details>",
    ].join("\n");
    const segs = extractTranscriptSegments(md);
    expect(segs.length).toBe(1);
    expect(segs[0].audioName).toBe("qnalog-20260917-115635.m4a");
    expect(segs[0].startOffsetMs).toBe(0);
    expect(segs[0].endOffsetMs).toBe(236000);
    expect(segs[0].text).toContain("第一段转写文本");
  });

  it("段正文嵌入 ![[audio]] 依旧识别（旧布局不回归）", () => {
    const embed = "!" + "[[" + "qnalog-a-seg01.m4a]]";
    const md = [
      "<details>",
      "<summary>分段原始转写（1 段）</summary>",
      "",
      "### 段落 1 (00:10–01:20)",
      "",
      embed,
      "",
      "正文文字。",
      "",
      "</details>",
    ].join("\n");
    const segs = extractTranscriptSegments(md);
    expect(segs[0].audioName).toBe("qnalog-a-seg01.m4a");
    expect(segs[0].startOffsetMs).toBe(10000);
  });

  it("标题链接带库内路径时取文件名", () => {
    const link = "[[" + "QnALog/录音/qnalog-x.m4a|01:00]]";
    const md = [
      "<details>",
      "<summary>分段原始转写</summary>",
      "",
      "### 段落 2 (01:00–02:00) " + link,
      "",
      "文本 B。",
      "",
      "</details>",
    ].join("\n");
    const segs = extractTranscriptSegments(md);
    expect(segs[0].audioName).toBe("qnalog-x.m4a");
    expect(segs[0].startOffsetMs).toBe(60000);
  });

  it("正文嵌入优先于标题链接（两者都在时以嵌入为准）", () => {
    const embed = "!" + "[[" + "qnalog-embed.m4a]]";
    const link = "[[" + "qnalog-heading.m4a|00:05]]";
    const md = [
      "<details>",
      "<summary>分段原始转写</summary>",
      "",
      "### 段落 1 (00:00–01:00) " + link,
      "",
      embed,
      "",
      "文本 C。",
      "",
      "</details>",
    ].join("\n");
    const segs = extractTranscriptSegments(md);
    expect(segs[0].audioName).toBe("qnalog-embed.m4a");
  });

  it("无任何音频引用时 audioName 为空（不虚构）", () => {
    const md = [
      "<details>",
      "<summary>分段原始转写</summary>",
      "",
      "### 段落 1 (00:00–00:30) · 结束",
      "",
      "纯文本。",
      "",
      "</details>",
    ].join("\n");
    const segs = extractTranscriptSegments(md);
    expect(segs[0].audioName).toBe("");
  });
});
