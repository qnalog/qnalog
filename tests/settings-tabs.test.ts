import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 设置页的选项卡结构契约。
//
// 这份用例防的是「设置项变成孤儿」：拆页或改名时漏改分发，
// 方法还在、用户却点不到。本轮就发生过一次（renderRecording 建好后未被分发调用，
// 分段间隔等项在界面上消失）。所以断言分两层：
// 每个选项卡都有分发目标，且每个分发目标都能被选项卡走到。

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/ui/settings-tab.ts"), "utf8");

/** 选项卡列表里声明的 id。 */
function declaredTabIds(): string[] {
  const block = source.slice(source.indexOf("export const LV_SETTINGS_TABS"), source.indexOf("];", source.indexOf("export const LV_SETTINGS_TABS")));
  return [...block.matchAll(/\{\s*id:\s*"([a-z]+)"/g)].map((m) => m[1]);
}

/** switch 里实际分发到的渲染方法名。 */
function dispatchedRenderers(): string[] {
  return [...source.matchAll(/case "[a-z]+":\s*this\.(render[A-Za-z]+)\(content\);/g)].map((m) => m[1]);
}

describe("设置选项卡结构", () => {
  it("每个选项卡都有对应的渲染分发", () => {
    const ids = declaredTabIds();
    const cases = [...source.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(cases, `选项卡 ${id} 没有 case 分发`).toContain(id);
    }
  });

  it("分发到的每个渲染方法都真实存在（防止方法改名后漏改分发）", () => {
    for (const name of dispatchedRenderers()) {
      expect(source, `${name} 未定义，分发指向了不存在的方法`).toContain(`  ${name}(c) {`);
    }
  });

  it("没有定义却没人调用的渲染方法（孤儿方法＝用户点不到的设置）", () => {
    const defined = [...source.matchAll(/^  (render[A-Z][A-Za-z]*)\(c\) \{/gm)].map((m) => m[1]);
    const dispatched = new Set(dispatchedRenderers());
    // renderAudioInputSettings / renderApiSchemeSelector / renderImportAudio 是页内片段，由所在页调用
    const fragments = ["renderAudioInputSettings", "renderApiSchemeSelector", "renderImportAudio"];
    const orphans = defined.filter((d) => !dispatched.has(d) && !fragments.includes(d) && !source.includes(`this.${d}(`));
    expect(orphans, `这些渲染方法没有被任何地方调用：${orphans.join(", ")}`).toEqual([]);
  });

  it("录音参数留在「录音」页，不回到旁路页", () => {
    // 分段与并发直接决定录到了什么，属常项；曾被埋在「进阶」页的长列表里。
    const rec = source.slice(source.indexOf("renderRecording(c) {"), source.indexOf("renderImport(c) {"));
    expect(rec).toContain("segmentIntervalMinutes");
    expect(rec).toContain("asrConcurrency");
    expect(rec).toContain("filterShortRecordings");
  });

  it("自动导入与诊断分属两页，不再混在同一个选项卡里", () => {
    const inbox = source.slice(source.indexOf("renderImport(c) {"), source.indexOf("renderAbout(c) {"));
    expect(inbox).toContain("inboxFolder");
    expect(inbox).toContain("maxRetries");
    expect(inbox).not.toContain("diagnosticsLogFolder");

    const about = source.slice(source.indexOf("renderAbout(c) {"));
    expect(about).toContain("diagnosticsLogFolder");
    expect(about).toContain("autoCheckUpdates");
  });
});
