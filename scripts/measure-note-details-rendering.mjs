#!/usr/bin/env node
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = new Map(process.argv.slice(2).filter((value) => value.startsWith("--")).map((value) => {
  const at = value.indexOf("=");
  return [value.slice(2, at), value.slice(at + 1)];
}));
const vaultPath = args.get("vault");
const cdpUrl = args.get("cdp");
if (!vaultPath || !cdpUrl) {
  console.error("Usage: node scripts/measure-note-details-rendering.mjs --vault=/path/to/vault --cdp=ws://127.0.0.1:PORT/devtools/page/ID");
  process.exit(2);
}
console.log("需要 Obsidian 在前台。脚本会在 QnALog/转写纪要 下生成临时笔记，完成后删除。");
const vault = resolve(vaultPath);
const notes = join(vault, "QnALog", "转写纪要");
const temp = await mkdtemp(join(tmpdir(), "qnalog-details-measure-"));
const entry = join(temp, "fixture-entry.ts");
const bundle = join(temp, "fixture-entry.mjs");
const fixtureData = join(temp, "fixtures.json");
const obsidianShim = join(temp, "obsidian-shim.mjs");
const helper = `
import { attachTextTranscript } from ${JSON.stringify(resolve("src/transcript/session-transcript.ts"))};
import { serializeTranscriptBlock } from ${JSON.stringify(resolve("src/transcript/transcript-markdown.ts"))};
import { buildTextImportSourceDetails } from ${JSON.stringify(resolve("src/notes/note-transcript-materials.ts"))};
import { buildRealtimeOutlineDetails } from ${JSON.stringify(resolve("src/notes/note-session-materials.ts"))};
import { createRealtimeOutlineSourceCoverage } from ${JSON.stringify(resolve("src/notes/outline-coverage.ts"))};
import { writeFileSync } from "node:fs";
const sizes = [1700, 5400, 11200, 20500, 21500, 13300];
const make = (count, prefix) => {
  const segments = Array.from({length: count}, (_, index) => {
    const target = count === 6 ? sizes[index] : Math.round(sizes[index] / 2);
    let text = "甲";
    let segment = attachTextTranscript({index, startOffsetMs:index*160000, endOffsetMs:(index+1)*160000, text}, prefix, "text-import");
    for (let tries = 0; tries < 16; tries++) {
      const block = serializeTranscriptBlock(segment, \`### 段落 \${index+1}\`, text);
      const payload = block.match(/<!-- qnalog-transcript-data ([\\s\\S]*?) -->/)?.[1] || "";
      if (payload.length >= target) break;
      text += "甲".repeat(Math.max(1, Math.ceil((target-payload.length)/3)));
      segment = attachTextTranscript({index, startOffsetMs:index*160000, endOffsetMs:(index+1)*160000, text}, prefix, "text-import");
    }
    return {segment, text};
  });
  const allBlocks = segments.map(({segment,text}, index) => serializeTranscriptBlock(segment, \`### 段落 \${index+1}\`, text));
  const details = buildTextImportSourceDetails({id:prefix, source:"text-import", segments:segments.map(({segment})=>segment)});
  const outlineText = "- 合成实时大纲\\n  - 已处理六段转写";
  const outline = buildRealtimeOutlineDetails({
    realtimeOutline:outlineText,
    realtimeOutlineSourceCoverage:createRealtimeOutlineSourceCoverage(outlineText, segments.map(({segment})=>segment), count),
    realtimeOutlineCoverageScope:"current-recording",
    realtimeOutlineCoverage:{totalSegmentCount:count},
    segments:segments.map(({segment})=>segment),
  });
  const legacy = ["<details>", "<summary>分段原始转写</summary>", "<!-- qnalog-segments-start:test -->", ...allBlocks, "<!-- qnalog-segments-end:test -->", "</details>"].join("\\n");
  const coverageRecord = outline.match(/<!-- qnalog-realtime-outline-source-coverage:([^]*?) -->/)?.[1] || "";
  return {details, legacy, outline, coverageRecordLength:coverageRecord.length, total: segments.reduce((sum, {segment}) => sum + JSON.stringify(segment.transcript).length, 0)};
};
writeFileSync(${JSON.stringify(fixtureData)}, JSON.stringify({long:make(6,"qnalog-measure-long"), short:make(3,"qnalog-measure-short")}));
`;
await mkdir(notes, { recursive: true });
await writeFile(entry, helper);
await writeFile(obsidianShim, "export function normalizePath(value) { return String(value || '').replace(/\\\\/g, '/').replace(/\\/+/g, '/'); }\n");
await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", plugins: [{
  name: "obsidian-runtime-shim",
  setup(buildApi) { buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: obsidianShim })); },
}], logLevel: "silent" });
try {
  await import(`file://${bundle}`);
  const fixtures = JSON.parse(await readFile(fixtureData, "utf8"));
  console.log(`实时大纲来源覆盖数据字符数：长笔记 ${fixtures.long.coverageRecordLength}，短笔记 ${fixtures.short.coverageRecordLength}`);
  const variants = [
    ["V0-current-long", fixtures.long.legacy],
    ["V-new-long", fixtures.long.details.replace(/<!-- qnalog-transcript-data ([\\s\\S]*?) -->/g, "")],
    ["V0-current-short", fixtures.short.legacy],
    ["V-new-short", fixtures.short.details.replace(/<!-- qnalog-transcript-data ([\\s\\S]*?) -->/g, "")],
  ];
  const files = [];
  for (const [name, body] of variants) {
    const path = join(notes, `qnalog-render-measure-${name}.md`);
    const source = name.includes("short") ? fixtures.short : fixtures.long;
    await writeFile(path, `# 测量 ${name}\\n\\n## 概要\\n合成正文。\\n\\n## 详情\\n合成详情。\\n\\n- [ ] 待办\\n\\n---\\n\\n## 原始材料\\n\\n${source.outline}\\n\\n${body}\\n`);
    files.push(path);
  }
  const socket = new WebSocket(cdpUrl);
  await new Promise((ok, fail) => {
    socket.addEventListener("open", ok, { once: true });
    socket.addEventListener("error", () => fail(new Error("Could not connect to the supplied Obsidian CDP WebSocket URL")), { once: true });
  });
  let serial = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result); }
  });
  const cdp = (method, params = {}) => new Promise((ok, fail) => {
    const id = ++serial; pending.set(id, {resolve:ok,reject:fail}); socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", {expression, awaitPromise:true, returnByValue:true});
    if (result.result?.subtype === "error") throw new Error(result.result.description);
    return result.result?.value;
  };
  await cdp("Runtime.enable");
  const openFile = async (path) => {
    const file = path.replace(`${vault}/`, "").replace(/\\.md$/, "");
    const { execFileSync } = await import("node:child_process");
    const uri = `obsidian://open?vault=${encodeURIComponent(vault.split("/").at(-1))}&file=${encodeURIComponent(file)}`;
    await evaluate("document.querySelector('.workspace-leaf.mod-active .view-header-close')?.click()");
    execFileSync("open", [uri]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  };
  const measure = async (path) => {
    await openFile(path);
    const deadline = Date.now() + 15000;
    let initial;
    const factsExpression = `(() => {
      const e=document.querySelector('.markdown-source-view.mod-cm6 .cm-scroller');
      const ds=[...document.querySelectorAll('details')];
      const lines=[...document.querySelectorAll('.cm-line')];
      return {details:ds.length,open:ds.filter(x=>x.open).length,
        visibleCommentLines:lines.filter(x=>/qnalog-transcript-(?:data|start|end)|qnalog-segments-(?:start|end)/.test(x.textContent||'')).length,
        visibleHeadings:lines.filter(x=>/^\\s*### 段落/.test(x.textContent||'')).length,
        scrollHeight:e?.scrollHeight||0,clientHeight:e?.clientHeight||0};
    })()`;
    while (Date.now() < deadline) {
      initial = await evaluate(factsExpression);
      if (initial?.details) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    assert(initial?.details, `No details rendered for ${path}`);
    const rows = [initial];
    const scroller = await evaluate(`(() => { const e=document.querySelector('.markdown-source-view.mod-cm6 .cm-scroller'); return e ? {left:e.getBoundingClientRect().left+50,top:e.getBoundingClientRect().top+150}:null; })()`);
    for (let step=0; step<120; step++) {
      await cdp("Input.dispatchMouseEvent", {type:"mouseWheel", x:scroller.left, y:scroller.top, deltaX:0, deltaY:500});
      let previous = "";
      let stableCount = 0;
      let sample;
      for (let poll = 0; poll < 30 && stableCount < 2; poll++) {
        await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        sample = await evaluate(factsExpression);
        const signature = JSON.stringify(sample);
        stableCount = signature === previous ? stableCount + 1 : 0;
        previous = signature;
        if (stableCount < 2) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      rows.push(sample);
      const atBottom = await evaluate(`(() => { const e=document.querySelector('.markdown-source-view.mod-cm6 .cm-scroller'); return !e || e.scrollTop+e.clientHeight>=e.scrollHeight-2; })()`);
      if (atBottom) break;
    }
    const visible = rows.filter((row) => row.visibleCommentLines > 0).length;
    return {note:path.split("/").pop(), visibleSteps:visible, totalSteps:rows.length, firstDetails:rows.findIndex((row)=>row.details>0), rows};
  };
  console.log("变体写入完成。依次冷打开每篇笔记，保持 Obsidian 前台；测量进行时不要切换应用。");
  const results = [];
  for (const path of files) results.push(await measure(path));
  console.table(results.flatMap(({note,rows}) => rows.map((row,index) => ({note,step:index,details:row.details,open:row.open,visibleCommentLines:row.visibleCommentLines,visibleHeadings:row.visibleHeadings,scrollHeight:row.scrollHeight}))));
  console.log(JSON.stringify(results, null, 2));
  socket.close();
} finally {
  for (const name of ["V0-current-long", "V-new-long", "V0-current-short", "V-new-short"]) {
    await rm(join(notes, `qnalog-render-measure-${name}.md`), { force: true });
  }
  await rm(temp, { recursive: true, force: true });
}
