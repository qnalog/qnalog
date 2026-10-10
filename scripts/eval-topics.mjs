#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

function randomGenerator(seed) {
  let state = seed;
  return () => {
    state |= 0;
    state = state + 0x6d2b79f5 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function makeFixture(count) {
  const noiseCount = Math.round(count * 0.15);
  const noteCount = count - noiseCount;
  const topicCount = count === 3000 ? 75 : count === 100 ? 20 : 40;
  const assignments = [];
  for (let topic = 0; topic < topicCount; topic++) {
    const size = Math.floor(noteCount / topicCount) + (topic < noteCount % topicCount ? 1 : 0);
    for (let index = 0; index < size; index++) assignments.push(topic);
  }
  for (let index = 0; index < noiseCount; index++) assignments.push(-1);
  const random = randomGenerator(71237 + count);
  for (let index = assignments.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [assignments[index], assignments[swap]] = [assignments[swap], assignments[index]];
  }

  const now = Date.now();
  const pathsByTopic = new Map();
  const cards = assignments.map((topic, index) => {
    const pathValue = `QnALog/synthetic/${String(index).padStart(5, "0")}.md`;
    if (topic >= 0) {
      const paths = pathsByTopic.get(topic) || [];
      paths.push(pathValue);
      pathsByTopic.set(topic, paths);
    }
    const label = topic < 0 ? `noise${index}x` : `Theme ${String(topic).padStart(2, "0")}`;
    return {
      path: pathValue,
      sourceId: pathValue,
      title: topic < 0 ? label : `2026-08-01 1200 · General-${label}-planning`,
      date: new Date(now - index * 86400000).toISOString().slice(0, 10),
      overview: topic < 0
        ? label
        : `${label} discusses its specific planning decision, evidence, constraints, implementation steps, and follow-up actions.`,
      overviewSource: "abstract",
      tags: topic < 0 ? [`noise${index}`] : [label],
      people: [],
      outLinks: [],
      inLinks: [],
      unresolvedTargets: [],
      mtime: now - index,
      precision: "full",
      expectedTopic: topic,
    };
  });
  const byPath = new Map(cards.map((card) => [card.path, card]));
  for (const card of cards) {
    if (card.expectedTopic < 0 || random() >= 0.03) continue;
    const topicPaths = pathsByTopic.get(card.expectedTopic) || [];
    const candidates = topicPaths.filter((target) => target !== card.path);
    const target = candidates[Math.floor(random() * candidates.length)];
    if (target) {
      card.outLinks = [target];
      byPath.get(target)?.inLinks.push(card.path);
    }
  }
  return { cards, noiseCount, noteCount, topicCount };
}

function evaluate(core, cards, noiseCount, noteCount) {
  const { suggestTopics } = core;
  const started = performance.now();
  const suggestions = suggestTopics(cards, new Map(), { limit: cards.length });
  const elapsedMs = performance.now() - started;
  let recoveredNotes = 0;
  let truePairs = 0;
  let allPairs = 0;
  let noiseJoined = 0;
  const expected = new Map(cards.map((card) => [card.path, card.expectedTopic]));
  for (const suggestion of suggestions) {
    const truthCounts = new Map();
    for (const pathValue of suggestion.memberPaths) {
      const topic = expected.get(pathValue) ?? -1;
      if (topic >= 0) truthCounts.set(topic, (truthCounts.get(topic) || 0) + 1);
    }
    for (const pathValue of suggestion.memberPaths) {
      const topic = expected.get(pathValue) ?? -1;
      if (topic < 0) noiseJoined++;
      else if ((truthCounts.get(topic) || 0) >= 2) recoveredNotes++;
    }
    for (let left = 0; left < suggestion.memberPaths.length; left++) {
      for (let right = left + 1; right < suggestion.memberPaths.length; right++) {
        allPairs++;
        const topic = expected.get(suggestion.memberPaths[left]) ?? -1;
        if (topic >= 0 && topic === expected.get(suggestion.memberPaths[right])) truePairs++;
      }
    }
  }
  return {
    elapsedMs: Number(elapsedMs.toFixed(1)),
    suggestions: suggestions.length,
    clusterRecall: Number((recoveredNotes / noteCount).toFixed(4)),
    pairwisePrecision: Number((allPairs ? truePairs / allPairs : 1).toFixed(4)),
    noiseJoined,
    noiseRate: Number((noiseJoined / noiseCount).toFixed(4)),
  };
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qnalog-topic-eval-"));
  const bundle = path.join(directory, "topic-suggestions.mjs");
  try {
    await build({
      entryPoints: [new URL("../src/topics/topic-suggestions.ts", import.meta.url).pathname],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
    });
    const core = await import(bundle);
    process.stdout.write("N\tthemes\tsuggestions\telapsed-ms\tcluster-recall\tpairwise-precision\tnoise-joined\tnoise-rate\n");
    for (const count of [100, 300, 1000, 3000]) {
      const fixture = makeFixture(count);
      const result = evaluate(core, fixture.cards, fixture.noiseCount, fixture.noteCount);
      process.stdout.write(`${count}\t${fixture.topicCount}\t${result.suggestions}\t${result.elapsedMs}\t${result.clusterRecall}\t${result.pairwisePrecision}\t${result.noiseJoined}\t${result.noiseRate}\n`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
