#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
import { createRelatedNoteEvalFixture } from "./related-notes-fixture.mjs";
import { fileURLToPath } from "node:url";

const ALLOWED_VAULT = "/Users/herald/Documents/obsidian/fresh";
const NOISE_DIRS = { ".versions": true, diagnostics: true, queue: true, cache: true };
const AUDIO_EXTENSIONS = { m4a: true, mp3: true, mp4: true, aac: true, wav: true, ogg: true, oga: true, flac: true, webm: true };
function parseFrontmatter(markdown) {
  const block = /^---\s*\n([\s\S]*?)\n---/m.exec(markdown)?.[1] || "";
  const fields = {};
  for (const line of block.split("\n")) {
    const match = /^([^:\n]+):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^['"]|['"]$/g, "");
    fields[match[1]] = value === "false" ? false : value === "true" ? true : value;
  }
  return fields;
}
function parseDocument(notePath, markdown, mtime, minBodyChars, namespace) {
  const frontmatter = parseFrontmatter(markdown);
  const readFrontmatter = (field) => namespace.readNamespaceFrontmatter(frontmatter, field);
  const type = readFrontmatter("type");
  const sourcePath = readFrontmatter("sourcePath");
  const sourceId = readFrontmatter("sourceId");
  const containsRaw = readFrontmatter("containsRaw");
  const variantKind = readFrontmatter("variantKind");
  const derived = containsRaw === false || type === "QnALog派生版本" || /派生版本|版本缓存/.test(String(type || ""))
    || (typeof sourcePath === "string" && Boolean(sourcePath.trim()))
    || (typeof variantKind === "string" && Boolean(variantKind.trim()));
  const legacyAliasDerived = derived && ["type", "sourcePath", "sourceId", "containsRaw", "variantKind"].some((field) =>
    namespace.hasNamespaceFrontmatter(frontmatter, field) && !Object.hasOwn(frontmatter, namespace.NS_FM[field]));
  const indexBlock = /<!--\s*qnalog-note-index\s*-->\s*<details>[\s\S]*?```json\s*\n([\s\S]*?)\n```[\s\S]*?<!--\s*qnalog-note-index-end\s*-->/i.exec(markdown);
  let index = null;
  try { index = indexBlock ? JSON.parse(indexBlock[1]) : null; } catch { index = null; }
  const title = index?.core?.title || path.basename(notePath, ".md");
  const links = [...markdown.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map((match) => match[1].trim());
  const list = (value) => String(value || "").split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
  const values = (items) => Array.isArray(items) ? items.flatMap((item) => typeof item === "string" ? [item] : item && typeof item.id === "string" ? [item.id] : []) : [];
  const timeValue = Date.parse(frontmatter.qnalog_time || frontmatter.date || frontmatter.created || "");
  const readableBody = markdown
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "")
    .replace(/<!--\s*qnalog-note-index\s*-->[\s\S]*?<!--\s*qnalog-note-index-end\s*-->/gi, "")
    .replace(/<!--\s*qnalog-session-knowledge[\s\S]*?-->/gi, "")
    .replace(/<!--\s*[a-z0-9-]+-transcript-start:[^>]*-->[\s\S]*?<!--\s*[a-z0-9-]+-transcript-end:[^>]*-->/gi, "")
    .replace(/<!--\s*qnalog-segments-start[\s\S]*?qnalog-segments-end\s*-->/gi, "")
    .replace(/^(?:##\s+)(?:原始材料|原始转写|逐字稿|录音原文|分段原始转写|Raw transcript|Original material)[^\n]*[\s\S]*$/im, "")
    .replace(/<!--[^>]*-->/g, "")
    .slice(0, 1200);
  const sessionId = /<!--\s*qnalog-session:\s*([^>\s]+)\s*-->/i.exec(markdown)?.[1];
  return {
    path: notePath,
    sourceId: typeof sourceId === "string" && sourceId.trim() ? sourceId.trim() : sessionId || sourcePath || notePath,
    title,
    timestamp: Number.isFinite(timeValue) ? timeValue : mtime,
    tags: list(frontmatter.tags), people: list(frontmatter.qnalog_people),
    topics: [...list(frontmatter.qnalog_topic), ...(Array.isArray(index?.topics) ? index.topics.flatMap((item) => typeof item?.title === "string" ? [item.title] : []) : [])],
    summary: typeof index?.core?.summary === "string" ? index.core.summary : "",
    decisions: values(index?.knowledge?.decisions),
    actions: values(index?.knowledge?.actions),
    questions: values(index?.knowledge?.questions),
    bodyExcerpt: readableBody,
    outLinks: [], inLinks: [], inLinkOutDegrees: {}, unresolvedTargets: [], rawLinks: links,
    precision: index ? "full" : "body-only",
    hasIndexCard: Boolean(index),
    tooShort: !index && readableBody.length < minBodyChars,
    merge: /(?:·|\s)Merge\s*$/i.test(title) || /<!--\s*qnalog-merge[\s\S]*?qnalog-merge-end\s*-->/i.test(markdown),
    derived,
    legacyAliasDerived,
  };
}
async function walk(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name.startsWith(".") || NOISE_DIRS[entry.name.toLowerCase()] === true)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(full);
    }
  }
  await visit(root);
  return files;
}
async function readDefaultNotesRoot(vault) {
  for (const relative of ["QnALog/转写纪要", "QnALog/Transcribed notes"]) {
    const root = path.resolve(vault, relative);
    try { if ((await fs.stat(root)).isDirectory()) return root; } catch {}
  }
  throw new Error("Default QnALog notes folder not found.");
}
async function loadCore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qnalog-related-eval-"));
  const bundle = path.join(directory, "related-notes.mjs");
  const namespaceBundle = path.join(directory, "namespace.mjs");
  await build({ entryPoints: [new URL("../src/indexing/related-notes.ts", import.meta.url).pathname], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node22" });
  await build({ entryPoints: [new URL("../src/shared/namespace.ts", import.meta.url).pathname], outfile: namespaceBundle, bundle: true, platform: "node", format: "esm", target: "node22" });
  return { core: await import(bundle), namespace: await import(namespaceBundle), cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}
function metrics(core, source, groups, mode) {
  const corpus = source.map((note) => {
    const result = { ...note };
    if (mode === "lexical") { result.outLinks = []; result.inLinks = []; result.unresolvedTargets = []; }
    if (mode === "links") {
      result.title = ""; result.tags = []; result.people = []; result.topics = []; result.summary = "";
      result.decisions = []; result.actions = []; result.questions = []; result.bodyExcerpt = "";
    }
    return result;
  });
  const groupResults = groups.map((group) => {
    let recall3 = 0, recall5 = 0, precision5 = 0, noiseErrors = 0;
    for (const queryPath of group) {
      const current = corpus.find((note) => note.path === queryPath);
      const queryCurrent = mode === "links" ? source.find((note) => note.path === queryPath) : current;
      const top3 = core.findRelatedNotes(corpus, queryCurrent, { limit: 3 });
      const top5 = core.findRelatedNotes(corpus, queryCurrent, { limit: 5 });
      const gold = new Set(group.filter((item) => item !== queryPath));
      recall3 += top3.filter((item) => gold.has(item.path)).length / gold.size;
      recall5 += top5.filter((item) => gold.has(item.path)).length / gold.size;
      precision5 += top5.filter((item) => gold.has(item.path)).length / 5;
      noiseErrors += top5.filter((item) => item.path.startsWith("noise/")).length;
    }
    return { recall3: recall3 / group.length, recall5: recall5 / group.length, precision5: precision5 / group.length, noiseErrors };
  });
  return { groups: groupResults, overall: {
    recall3: groupResults.reduce((sum, item) => sum + item.recall3, 0) / groupResults.length,
    recall5: groupResults.reduce((sum, item) => sum + item.recall5, 0) / groupResults.length,
    precision5: groupResults.reduce((sum, item) => sum + item.precision5, 0) / groupResults.length,
    noiseErrors: groupResults.reduce((sum, item) => sum + item.noiseErrors, 0),
  } };
}

function writeCommonTermsTable(core, corpus) {
  const terms = core.getCommonRelatedNoteTerms(corpus).slice(0, 20);
  process.stdout.write("\n### Filtered common terms (top 20)\n| Term | Documents |\n|---|---:|\n");
  if (!terms.length) process.stdout.write("| (none) | 0 |\n");
  for (const { term, documentFrequency } of terms) process.stdout.write(`| ${term} | ${documentFrequency} |\n`);
}
async function evaluateSynthetic(core) {
  const fixture = createRelatedNoteEvalFixture();
  const { corpus, goldGroups, linkPaths } = fixture;
  const [linkA, linkB, linkC, linkD, linkE, linkF] = linkPaths.map((notePath) => corpus.find((note) => note.path === notePath));
  if (core.findRelatedNotes(corpus, fixture.shortNoteQuery).some((item) => item.path === fixture.shortNotePath)) throw new Error("Short title-only note entered synthetic results.");
  if (core.findRelatedNotes(fixture.sparseCorpus, fixture.sparseQuery).length !== 0) throw new Error("Weak synthetic overlap was not removed by the score floor.");
  const [boilerplateA, boilerplateB] = fixture.boilerplatePaths.map((notePath) => corpus.find((item) => item.path === notePath));
  if (core.findRelatedNotes(corpus, boilerplateA).some((item) => item.path === boilerplateB.path)) throw new Error("Summary boilerplate caused a synthetic false match.");
  writeCommonTermsTable(core, corpus);
  const linkOnly = core.findRelatedNotes(corpus, linkA).find((item) => item.path === linkB.path);
  if (!linkOnly?.reasons.includes("shared-unresolved") || !linkOnly.reasons.includes("link-only")) throw new Error("Synthetic shared-unresolved retrieval did not pass.");
  if (core.findRelatedNotes(corpus, linkC).some((item) => item.path === linkD.path)) throw new Error("Ubiquitous index link caused a synthetic false match.");
  if (!core.findRelatedNotes(corpus, linkE).find((item) => item.path === linkF.path)?.reasons.includes("direct-link")) throw new Error("Synthetic direct-link retrieval did not pass.");
  if (linkE.inLinks.includes("derived.md")) throw new Error("Synthetic derived-note links changed source backlinks.");
  for (const mode of ["lexical", "links", "combined"]) {
    const report = metrics(core, corpus, goldGroups, mode);
    for (const [index, stats] of report.groups.entries()) {
      process.stdout.write(`${mode}\ttopic-${index + 1}\trecall@3=${stats.recall3.toFixed(3)}\trecall@5=${stats.recall5.toFixed(3)}\tprecision@5=${stats.precision5.toFixed(3)}\tnoise-errors=${stats.noiseErrors}\n`);
    }
    const stats = report.overall;
    process.stdout.write(`${mode}\tall-topics\trecall@3=${stats.recall3.toFixed(3)}\trecall@5=${stats.recall5.toFixed(3)}\tprecision@5=${stats.precision5.toFixed(3)}\tnoise-errors=${stats.noiseErrors}\n`);
  }
}
async function evaluateVault(vault) {
  if (path.resolve(vault) !== ALLOWED_VAULT) throw new Error(`Only the explicitly authorized read-only vault is allowed: ${ALLOWED_VAULT}`);
  const { core, namespace, cleanup } = await loadCore();
  try {
  const notesRoot = await readDefaultNotesRoot(vault);
  const startedAt = performance.now();
  const files = await walk(notesRoot);
  const corpus = [], excludedDerivedPaths = new Set(), excludedNoiseBasenames = new Set(), tooShortPaths = [];
  let excludedDerived = 0, excludedDerivedLegacyAliases = 0, excludedMerge = 0, tooShort = 0, bodyOnly = 0, noiseLinks = 0, noOutgoing = 0;
  let audioNoiseLinks = 0, internalPathNoiseLinks = 0, selfLinks = 0, excludedNoteLinks = 0;
  for (const file of files) {
    const notePath = path.relative(vault, file).split(path.sep).join("/");
    const markdown = await fs.readFile(file, "utf8");
    const note = parseDocument(notePath, markdown, (await fs.stat(file)).mtimeMs, core.RELATED_NOTE_MIN_BODY_CHARS, namespace);
    if (note.derived) { excludedDerived++; if (note.legacyAliasDerived) excludedDerivedLegacyAliases++; excludedDerivedPaths.add(notePath); excludedNoiseBasenames.add(path.basename(notePath, ".md").toLocaleLowerCase()); continue; }
    if (note.merge) { excludedMerge++; excludedNoiseBasenames.add(path.basename(notePath, ".md").toLocaleLowerCase()); continue; }
    if (note.tooShort) { tooShort++; tooShortPaths.push(notePath); excludedNoiseBasenames.add(path.basename(notePath, ".md").toLocaleLowerCase()); continue; }
    if (note.precision === "body-only") bodyOnly++;
    corpus.push(note);
  }
  const byPath = new Map(corpus.map((note) => [note.path.replace(/\.md$/i, "").toLocaleLowerCase(), note]));
  const byBasename = new Map();
  for (const note of corpus) {
    const basename = path.basename(note.path, ".md").toLocaleLowerCase();
    byBasename.set(basename, [...(byBasename.get(basename) || []), note]);
  }
  for (const note of corpus) {
    for (const targetRaw of note.rawLinks) {
      const target = targetRaw.replace(/\\/g, "/").replace(/^\/+/, "");
      const extension = target.split(".").pop()?.toLocaleLowerCase() || "";
      if (AUDIO_EXTENSIONS[extension] === true) { noiseLinks++; audioNoiseLinks++; continue; }
      if (/(?:^|\/)(?:\.versions|diagnostics|queue|cache)(?:\/|$)/i.test(target)) { noiseLinks++; internalPathNoiseLinks++; continue; }
      if (path.basename(target.replace(/\.md$/i, "")).toLocaleLowerCase() === path.basename(note.path, ".md").toLocaleLowerCase()) { noiseLinks++; selfLinks++; continue; }
      const key = target.replace(/\.md$/i, "").toLocaleLowerCase();
      const currentFolderKey = path.posix.join(path.posix.dirname(note.path), key).toLocaleLowerCase();
      const rootRelativeKey = path.posix.join(path.relative(vault, notesRoot).split(path.sep).join("/"), key).toLocaleLowerCase();
      const matches = byPath.get(key) ? [byPath.get(key)] : (byPath.get(currentFolderKey) ? [byPath.get(currentFolderKey)] : byPath.get(rootRelativeKey) ? [byPath.get(rootRelativeKey)] : byBasename.get(path.basename(target, ".md").toLocaleLowerCase()) || []);
      const resolved = matches.length === 1 ? matches[0] : null;
      if (resolved && !excludedDerivedPaths.has(resolved.path)) note.outLinks.push(resolved.path);
      else if (!resolved && excludedNoiseBasenames.has(path.basename(target, ".md").toLocaleLowerCase())) { noiseLinks++; excludedNoteLinks++; }
      else if (!resolved) note.unresolvedTargets.push(target.split("#")[0].toLocaleLowerCase());
      else { noiseLinks++; excludedNoteLinks++; }
    }
    note.outLinks = [...new Set(note.outLinks)];
    if (!note.outLinks.length) noOutgoing++;
  }
  const reverse = new Map();
  for (const note of corpus) for (const target of note.outLinks) reverse.set(target, [...(reverse.get(target) || []), note.path]);
  for (const note of corpus) {
    note.inLinks = reverse.get(note.path) || [];
    note.inLinkOutDegrees = Object.fromEntries(note.inLinks.map((source) => [source, corpus.find((candidate) => candidate.path === source)?.outLinks.length || 0]));
  }
  const indexBuildMs = performance.now() - startedAt;
  const sharedUnresolvedTargets = new Set(corpus.flatMap((note) => note.unresolvedTargets).filter((target) => corpus.filter((note) => note.unresolvedTargets.includes(target)).length > 1)).size;
  const candidateCounts = Array.from({ length: 6 }, () => 0);
  const queryStartedAt = performance.now();
  const candidateResults = corpus.map((current) => {
    const results = core.findRelatedNotes(corpus, current, { limit: 5 });
    candidateCounts[results.length]++;
    return { current, results };
  });
  const queryMs = performance.now() - queryStartedAt;
  process.stdout.write(`Vault root: ${path.relative(vault, notesRoot)}\nCorpus: ${corpus.length}; body-only: ${bodyOnly}; derived excluded: ${excludedDerived} (legacy aliases: ${excludedDerivedLegacyAliases}); merge excluded: ${excludedMerge}; too-short: ${tooShort}; parsed noisy wiki-link occurrences: ${noiseLinks} (audio: ${audioNoiseLinks}, internal path: ${internalPathNoiseLinks}, self: ${selfLinks}, excluded derived/merge/short: ${excludedNoteLinks}); no outgoing links: ${noOutgoing}; shared unresolved targets: ${sharedUnresolvedTargets}; index build: ${indexBuildMs.toFixed(1)} ms; all-note query: ${queryMs.toFixed(1)} ms\n`);
  process.stdout.write("\n### Candidate count distribution\n| Candidates retained | Notes |\n|---:|---:|\n");
  for (let count = 0; count <= 5; count++) process.stdout.write(`| ${count} | ${candidateCounts[count]} |\n`);
  process.stdout.write("\n### Excluded too-short notes\n");
  for (const notePath of tooShortPaths) process.stdout.write(`- ${notePath}\n`);
  if (!tooShortPaths.length) process.stdout.write("- (none)\n");
  writeCommonTermsTable(core, corpus);
  for (const { current, results } of candidateResults) {
    process.stdout.write(`\n### ${current.title} (${current.path})\n| Candidate | Score | Forward | Reverse | Direction | Matched terms | Reasons |\n|---|---:|---:|---:|---|---|---|\n`);
    for (const result of results) {
      const title = corpus.find((note) => note.path === result.path)?.title || result.path;
      process.stdout.write(`| ${title.replace(/\|/g, "\\|")} | ${result.score.toFixed(3)} | ${result.forwardScore.toFixed(3)} | ${result.reverseScore.toFixed(3)} | ${result.direction} | ${result.matchedTerms.join(", ")} | ${result.reasons.join(", ")} |\n`);
    }
  }
  } finally { await cleanup(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const vaultArgument = process.argv.indexOf("--vault");
  if (vaultArgument >= 0) await evaluateVault(process.argv[vaultArgument + 1] || "");
  else {
    const { core, cleanup } = await loadCore();
    try { await evaluateSynthetic(core); } finally { await cleanup(); }
  }
}
