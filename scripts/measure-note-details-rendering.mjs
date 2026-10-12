#!/usr/bin/env node
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const textSizes = [274, 871, 1806, 3306, 3463, 2145];
const make = (count, prefix) => {
  const sizes = count === 6 ? textSizes : textSizes.slice(0, count);
  const segments = sizes.map((length, index) => {
    const text = "甲".repeat(length);
    const segment = attachTextTranscript({index, startOffsetMs:index*160000, endOffsetMs:(index+1)*160000, text}, prefix, "text-import");
    return {segment, text};
  });
  const allBlocks = segments.map(({segment,text}, index) => serializeTranscriptBlock(segment, \`### 段落 \${index+1}\`, text));
  const details = buildTextImportSourceDetails({id:prefix, source:"text-import", segments:segments.map(({segment})=>segment)});
  const originalJsons = segments.map(({segment,text}) => {
    const { transcript, ...storedSegment } = segment;
    const storedTranscript = {...transcript, revisions:transcript.revisions.map(revision => revision.revision === transcript.currentRevision ? {...revision, displayText:text} : revision)};
    return JSON.stringify({schemaVersion:2,segment:storedSegment,transcript:storedTranscript});
  });
  const currentParts = allBlocks.map((block, index) => {
    const inner = block.match(/<details\\b[^>]*>([\\s\\S]*?)<\\/details>/i)?.[1] || "";
    return [\`### 段落 \${index+1}\`, inner.replace(/<summary>[\\s\\S]*?<\\/summary>\\s*/i, "")].join("\\n");
  });
  const uriRows = originalJsons.map((json, index) => \`<span hidden data-qnalog-transcript-data="\${encodeURIComponent(json)}" data-qnalog-segment="\${encodeURIComponent(segments[index].segment.transcript.id)}"></span>\`).join("");
  const current = \`**分段原始转写（\${count} 段）**\\n\\n<details>\\n<summary>分段原始转写（\${count} 段）</summary>\\n\${currentParts.join("\\n")}\\n</details>\\n\${uriRows}\`;
  const outlineText = "- 合成实时大纲\\n  - 已处理六段转写";
  const outline = buildRealtimeOutlineDetails({
    realtimeOutline:outlineText,
    realtimeOutlineSourceCoverage:createRealtimeOutlineSourceCoverage(outlineText, segments.map(({segment})=>segment), count),
    realtimeOutlineCoverageScope:"current-recording",
    realtimeOutlineCoverage:{totalSegmentCount:count},
    segments:segments.map(({segment})=>segment),
  });
  const legacyParts = segments.map(({segment,text}, index) => {
    const record = segment.transcript;
    const { transcript, ...storedSegment } = segment;
    const payload = JSON.stringify({schemaVersion:2,segment:storedSegment,transcript});
    const id = record.id;
    return ["### 段落 "+(index+1), \`<!-- qnalog-transcript-start:\${id} -->\`, \`<!-- qnalog-transcript-text-start:\${id} -->\`, text, \`<!-- qnalog-transcript-text-end:\${id} -->\`, \`<!-- qnalog-transcript-data \${payload} -->\`, \`<!-- qnalog-transcript-end:\${id} -->\`].join("\\n");
  });
  const legacy = ["<details>", \`<summary>分段原始转写（\${count} 段）</summary>\`, "<!-- qnalog-segments-start:test -->", ...legacyParts, "<!-- qnalog-segments-end:test -->", "</details>"].join("\\n");
  const coverageRecord = outline.match(/<!-- qnalog-realtime-outline-source-coverage:([^]*?) -->/)?.[1] || "";
  const encodedPayloadLength = [...details.matchAll(/data-qnalog-transcript-data="([^"]+)"/g)].reduce((sum, match) => sum + Buffer.from(match[1], "base64").toString("utf8").length, 0);
  const encodedPayloadCharacters = [...details.matchAll(/data-qnalog-transcript-data="([^"]+)"/g)].reduce((sum, match) => sum + match[1].length, 0);
  const originalJsonCharacters = originalJsons.reduce((sum,json) => sum + json.length, 0);
  const detailsLengths = [...details.matchAll(/<details\\b[^>]*>([\\s\\S]*?)<\\/details>/gi)].map(match => match[1].length);
  const currentDetailsLengths = [...current.matchAll(/<details\\b[^>]*>([\\s\\S]*?)<\\/details>/gi)].map(match => match[1].length);
  return {details, current, legacy, outline, coverageRecordLength:coverageRecord.length, payloadLength:encodedPayloadLength, originalJsonCharacters, encodedPayloadCharacters, detailsLengths, currentDetailsLengths, total:segments.reduce((sum,{text})=>sum+text.length,0)};
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
  console.log(`转写文本字符数：长笔记 ${fixtures.long.total}，短笔记 ${fixtures.short.total}；解码后数据字符数：长笔记 ${fixtures.long.payloadLength}，短笔记 ${fixtures.short.payloadLength}`);
  console.log(`base64 数据字符数：长笔记 ${fixtures.long.encodedPayloadCharacters}，短笔记 ${fixtures.short.encodedPayloadCharacters}`);
  console.log(`未压缩来源 JSON 字符数：长笔记 ${fixtures.long.originalJsonCharacters}，短笔记 ${fixtures.short.originalJsonCharacters}`);
  if (fixtures.long.encodedPayloadCharacters > fixtures.long.originalJsonCharacters * 2) throw new Error('Long-note base64 data exceeds twice the source JSON character count');
  console.log(`新布局 details 内字符数：长笔记 ${fixtures.long.detailsLengths.join(",")}；短笔记 ${fixtures.short.detailsLengths.join(",")}`);
  console.log(`上一版 details 内字符数：长笔记 ${fixtures.long.currentDetailsLengths.join(",")}；短笔记 ${fixtures.short.currentDetailsLengths.join(",")}`);
  const variants = [
    ["V0-current-long", fixtures.long.current],
    ["V1-new-split-long", fixtures.long.details],
    ["V0-current-short", fixtures.short.current],
    ["V1-new-split-short", fixtures.short.details],
  ];
  const files = [];
  const fileSizes = new Map();
  for (const [name, body] of variants) {
    const path = join(notes, `qnalog-render-measure-${name}.md`);
    const source = name.includes("short") ? fixtures.short : fixtures.long;
    const content = `# 测量 ${name}\\n\\n## 概要\\n合成正文。\\n\\n## 详情\\n合成详情。\\n\\n- [ ] 待办\\n\\n---\\n\\n## 原始材料\\n\\n${source.outline}\\n\\n${body}\\n`;
    await writeFile(path, content);
    files.push(path);
    fileSizes.set(name, {characters: content.length, bytes: (await stat(path)).size});
  }
  console.table([...fileSizes.entries()].map(([note, size]) => ({note, ...size})));
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
      const view=document.querySelector('.workspace-leaf.mod-active .markdown-source-view.mod-cm6');
      const e=view?.querySelector('.cm-scroller');
      const content=view?.querySelector('.cm-content');
      const ds=[...(content||document).querySelectorAll('details')];
      const rect=e?.getBoundingClientRect();
      const lines=[...(content||document).querySelectorAll('.cm-line')].filter(line=>{const r=line.getBoundingClientRect();return !!rect&&r.bottom>rect.top&&r.top<rect.bottom;});
      return {details:ds.length,open:ds.filter(x=>x.open).length,
        visibleCommentLines:lines.filter(x=>/qnalog-transcript-(?:data|start|end)|qnalog-segments-(?:start|end)/.test(x.textContent||'')).length,
        visibleHeadings:lines.filter(x=>/^\\s*(?:### 段落|<summary>段落)/.test(x.textContent||'')).length,
        visibleRawLines:lines.filter(x=>/qnalog-transcript-|qnalog-segments-|### 段落|<details>|<summary>/.test(x.textContent||'')).length,
        scrollHeight:e?.scrollHeight||0,clientHeight:e?.clientHeight||0};
    })()`;
    while (Date.now() < deadline) {
      initial = await evaluate(factsExpression);
      if (initial?.details) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    assert(initial?.details, `No details rendered for ${path}`);
    const rows = [initial];
    const scroller = await evaluate(`(() => { const e=document.querySelector('.workspace-leaf.mod-active .markdown-source-view.mod-cm6 .cm-scroller'); return e ? {left:e.getBoundingClientRect().left+50,top:e.getBoundingClientRect().top+150}:null; })()`);
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
      const atBottom = await evaluate(`(() => { const e=document.querySelector('.workspace-leaf.mod-active .markdown-source-view.mod-cm6 .cm-scroller'); return !e || e.scrollTop+e.clientHeight>=e.scrollHeight-2; })()`);
      if (atBottom) break;
    }
    const visible = rows.filter((row) => row.visibleCommentLines > 0).length;
    return {note:path.split("/").pop(), visibleSteps:visible, totalSteps:rows.length, firstDetails:rows.findIndex((row)=>row.details>0), rows};
  };
  console.log("变体写入完成。依次冷打开每篇笔记，保持 Obsidian 前台；测量进行时不要切换应用。");
  const results = [];
  for (const path of files) results.push(await measure(path));
  console.table(results.flatMap(({note,rows}) => rows.map((row,index) => ({note,step:index,details:row.details,open:row.open,visibleRawLines:row.visibleRawLines,visibleCommentLines:row.visibleCommentLines,visibleHeadings:row.visibleHeadings,scrollHeight:row.scrollHeight}))));
  console.log(JSON.stringify(results, null, 2));
  socket.close();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  for (const name of ["V0-current-long", "V1-new-split-long", "V0-current-short", "V1-new-split-short"]) {
    await rm(join(notes, `qnalog-render-measure-${name}.md`), { force: true });
  }
  await rm(temp, { recursive: true, force: true });
}
