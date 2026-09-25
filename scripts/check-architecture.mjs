// 架构依赖检查：这个模块是否应该获得这项依赖？这次修改有没有扩大耦合？
//
// 与 check-domain-boundaries 的分工：那边回答「这个成员/能力/方法是否真实存在」，
// 这边回答「这条依赖本身是否被允许」。第一版只查三件已有明确证据的问题（基线见
// scripts/architecture-baseline.json，为什么这样设计见 MAINTAINING.md §13）：
//   A. 禁止新的模块直接依赖 src/main.ts / QnALogPlugin（三个 legacy 文件放行）；
//   B. 冻结 legacy 消费者的 plugin.* 能力面：实际使用集合必须与基线精确一致——
//      新增直接失败，删除则要求同步收缩基线（棘轮：债务只减不增）；
//   C. 服务依赖图：XxxHost 接口成员 → main.ts 装配的服务类，构成 service→service 边。
//      新增边一律失败（即使尚未构成环）；用 Tarjan 求强连通分量，同时报告
//      service count / edge count / cyclic SCC count / largest SCC size，
//      并拦住「新增边形成新环」与「新增边扩大既有 SCC」。
// 基线更新是架构决策，不是修检查失败的步骤——因此本脚本不提供 npm 刷新命令，
// 失败信息也不提示刷新方式（流程见 MAINTAINING.md §13）。
//
// 本脚本自身只读源码与基线：不访问网络、不读构建产物、不依赖 git。
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const BASELINE_FILE = "scripts/architecture-baseline.json";
const MAIN_MODULE = "src/main";

function normalize(file) {
  return file.split(path.sep).join("/");
}

function lineOf(content, index) {
  return String(content).slice(0, index).split("\n").length;
}

function parse(file, content) {
  return ts.createSourceFile(file, content, ts.ScriptTarget.ES2020, true);
}

/** 把 import 说明符解析成项目内路径（去掉扩展名）；非相对说明符按 baseUrl "." 从根解析。 */
function resolveSpecifier(fromFile, spec) {
  const target = spec.startsWith(".")
    ? path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec))
    : path.posix.normalize(spec);
  return target.replace(/\.(ts|tsx|js|mjs)$/, "");
}

function isMainModule(fromFile, spec) {
  return resolveSpecifier(fromFile, spec) === MAIN_MODULE;
}

/** main.ts 里的 `this.<字段> = new <类>(...)` 装配语句：plugin 字段 → 具体服务类。 */
function fieldClassMap(mainSource) {
  const map = new Map();
  if (mainSource === undefined) return map;
  for (const m of mainSource.matchAll(/this\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*new\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

/** `this.plugin.X` 或构造参数 `plugin.X`（三个 legacy 文件两种都有）→ 能力名 X。 */
function isPluginObject(expr) {
  if (ts.isPropertyAccessExpression(expr)) {
    return expr.expression.kind === ts.SyntaxKind.ThisKeyword && expr.name.getText() === "plugin";
  }
  return ts.isIdentifier(expr) && expr.text === "plugin";
}

/** 类型文本里的标识符列表，用于成员名匹配不到时按类型名兜底。 */
function typeIdentifiers(text) {
  return text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
}

function uniquePush(list, value) {
  if (!list.includes(value)) list.push(value);
}

/**
 * 单次遍历收集三件事：main.ts 的 import、插件能力面、Host 接口及其消费类。
 * files 为 { 相对路径: 内容 }，便于单测注入。
 */
function analyze(files) {
  const normalized = {};
  for (const [file, content] of Object.entries(files)) normalized[normalize(file)] = content;

  const facts = {
    files: normalized,
    mainMissing: normalized["src/main.ts"] === undefined,
    fieldClass: fieldClassMap(normalized["src/main.ts"]),
    mainImporters: new Set(),          // 引用了 src/main 的文件
    mainImportLines: new Map(),        // 文件 → 引用行号（用于失败信息）
    pluginCaps: new Map(),             // 文件 → 实际使用的 plugin 能力集合
    fileClassNames: new Map(),         // 文件 → 首个导出类名（用于失败信息）
    hosts: [],                         // { file, hostName, className|null, members: [{ name, typeText }] }
    consumerClasses: new Set(),        // 声明了 host 的服务类（统计用）
  };

  for (const [file, content] of Object.entries(normalized)) {
    const sf = parse(file, content);
    const caps = new Set();
    const lines = [];
    const fileHosts = [];
    const fileConsumers = new Map();   // hostName → 消费它的类名（同文件内配对）
    let exportedClass = null;
    let firstClass = null;

    const visit = (node) => {
      // A：import / re-export / 动态 import 指向 src/main
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (isMainModule(file, node.moduleSpecifier.text)) {
          facts.mainImporters.add(file);
          uniquePush(lines, lineOf(content, node.moduleSpecifier.getStart(sf)));
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
        if (isMainModule(file, node.arguments[0].getText(sf).slice(1, -1))) {
          facts.mainImporters.add(file);
          uniquePush(lines, lineOf(content, node.arguments[0].getStart(sf)));
        }
      }
      // B：plugin 能力面（只对基线登记的 legacy 文件有意义，但对所有文件收集成本可忽略）
      if (ts.isPropertyAccessExpression(node) && node.name.kind === ts.SyntaxKind.Identifier && isPluginObject(node.expression)) {
        caps.add(node.name.getText(sf));
      }
      if (ts.isClassDeclaration(node)) {
        const className = node.name ? node.name.getText(sf) : null;
        if (className) {
          if (!firstClass) firstClass = className;
          if (node.modifiers && node.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
            if (!exportedClass) exportedClass = className;
          }
          // C：declare host: XxxHost 属性，或构造参数 host: XxxHost
          for (const mem of node.members) {
            if (ts.isPropertyDeclaration(mem) && mem.name && mem.name.getText(sf) === "host"
                && mem.type && ts.isTypeReferenceNode(mem.type)) {
              fileConsumers.set(mem.type.typeName.getText(sf), className);
            }
            if (ts.isConstructorDeclaration(mem)) {
              for (const p of mem.parameters) {
                if (p.type && ts.isTypeReferenceNode(p.type) && p.type.typeName.getText(sf).endsWith("Host")) {
                  fileConsumers.set(p.type.typeName.getText(sf), className);
                }
              }
            }
          }
        }
      }
      // C：XxxHost 接口成员
      if (ts.isInterfaceDeclaration(node) && node.name.text.endsWith("Host")) {
        const members = [];
        for (const m of node.members) {
          if (!m.name) continue;
          const name = (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : null;
          if (!name) continue;
          members.push({ name, typeText: m.type ? m.type.getText(sf) : "" });
        }
        fileHosts.push({ file, hostName: node.name.text, members });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    if (lines.length) facts.mainImportLines.set(file, lines.sort((a, b) => a - b));
    if (caps.size || facts.mainImporters.has(file)) facts.pluginCaps.set(file, caps);
    if (exportedClass || firstClass) facts.fileClassNames.set(file, exportedClass || firstClass);
    for (const host of fileHosts) {
      const className = fileConsumers.get(host.hostName) || null;
      if (className) facts.consumerClasses.add(className);
      facts.hosts.push({ ...host, className });
    }
  }
  return facts;
}

/**
 * 由 Host 接口成员推导服务依赖边：
 * 成员名 → main.ts 字段 → 服务类（主路径，能覆盖 `sessionFinalize: { … }` 这类内联类型）；
 * 成员名匹配不到时再按类型文本里的服务类名兜底。
 * 返回 { edges: [{from,to,sources:[…]}], orphans: [{file,hostName,members}] }。
 */
function serviceEdges(facts) {
  const { fieldClass, hosts } = facts;
  const serviceClasses = new Set(fieldClass.values());
  const byPair = new Map();
  const orphans = [];

  for (const host of hosts) {
    const worthy = host.members.filter((m) =>
      fieldClass.has(m.name) || typeIdentifiers(m.typeText).some((id) => serviceClasses.has(id)));
    if (!host.className) {
      if (worthy.length) orphans.push({ file: host.file, hostName: host.hostName, members: worthy });
      continue;
    }
    for (const member of host.members) {
      let target = fieldClass.get(member.name) || null;
      if (!target) target = typeIdentifiers(member.typeText).find((id) => serviceClasses.has(id)) || null;
      if (!target || target === host.className) continue;   // 自依赖不构成横向耦合
      const key = `${host.className}\u0000${target}`;
      let edge = byPair.get(key);
      if (!edge) { edge = { from: host.className, to: target, sources: [] }; byPair.set(key, edge); }
      uniquePush(edge.sources, `${host.hostName}.${member.name}`);
    }
  }
  const edges = [...byPair.values()].sort((a, b) =>
    a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  orphans.sort((a, b) => a.file.localeCompare(b.file) || a.hostName.localeCompare(b.hostName));
  return { edges, orphans };
}

// ---------- 强连通分量（Tarjan） ----------

function adjacency(nodes, edges) {
  const adj = new Map();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push(e.to);
  }
  for (const list of adj.values()) list.sort((a, b) => a.localeCompare(b));
  return adj;
}

function tarjan(nodes, adj) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  const strongconnect = (v) => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) || []) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component.sort((a, b) => a.localeCompare(b)));
    }
  };

  for (const v of [...nodes].sort()) if (!index.has(v)) strongconnect(v);
  return components;
}

/** 只保留含环的分量（≥2 个节点；自环已被边过滤掉）。 */
function cyclicComponents(components) {
  return components.filter((c) => c.length > 1)
    .sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

function sameComponent(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** 在分量内找一条实际存在的环，打印成 `A -> B -> A`。 */
function findCycle(component, adj) {
  const inComponent = new Set(component);
  const start = component[0];
  const stack = [];
  const onPath = new Set();
  let found = null;

  const dfs = (v) => {
    stack.push(v);
    onPath.add(v);
    for (const w of adj.get(v) || []) {
      if (!inComponent.has(w)) continue;
      if (w === start) { found = [...stack, start]; return true; }
      if (onPath.has(w)) {
        found = [...stack.slice(stack.indexOf(w)), w];
        return true;
      }
      if (dfs(w)) return true;
    }
    stack.pop();
    onPath.delete(v);
    return false;
  };

  dfs(start);
  return found || [...component, start];
}

function edgeKeySet(edges) {
  return new Set(edges.map((e) => `${e.from}\u0000${e.to}`));
}

/**
 * 服务依赖图统计：服务数（声明 Host 的类 ∪ 边端点）、边数、
 * 环状强连通分量数、最大环状分量的节点数（无环时为 0）。
 */
export function serviceGraphStats(files) {
  const facts = analyze(files);
  const { edges } = serviceEdges(facts);
  const nodes = new Set(facts.consumerClasses);
  for (const e of edges) { nodes.add(e.from); nodes.add(e.to); }
  const adj = adjacency(nodes, edges);
  const cyclic = cyclicComponents(tarjan(nodes, adj));
  return {
    services: nodes.size,
    edges: edges.length,
    cyclicSccs: cyclic.length,
    largestScc: cyclic.reduce((max, c) => Math.max(max, c.length), 0),
  };
}

/**
 * 从源码提取事实基线（仅供人工重新生成 scripts/architecture-baseline.json 使用，
 * 见 MAINTAINING.md §13；不接入任何 npm 命令）。
 */
export function collectFacts(files) {
  const facts = analyze(files);
  const { edges } = serviceEdges(facts);
  const pluginConsumers = {};
  for (const file of [...facts.mainImporters].sort()) {
    pluginConsumers[file] = [...(facts.pluginCaps.get(file) || [])].sort();
  }
  return {
    pluginConsumers,
    serviceEdges: edges.map((e) => [e.from, e.to]),
  };
}

/**
 * 返回违规项（空数组表示通过）。files 为 { 相对路径: 内容 }，baseline 为
 * scripts/architecture-baseline.json 解析后的对象，均可注入，便于单测。
 */
export function checkArchitecture(files, baseline) {
  if (!baseline || typeof baseline !== "object") {
    return [`[architecture] ${BASELINE_FILE} 无效：无法解析为对象`];
  }
  if (!baseline.pluginConsumers || typeof baseline.pluginConsumers !== "object") {
    return [`[architecture] ${BASELINE_FILE} 缺少 pluginConsumers 对象`];
  }
  if (!Array.isArray(baseline.serviceEdges)) {
    return [`[architecture] ${BASELINE_FILE} 缺少 serviceEdges 数组`];
  }

  const facts = analyze(files);
  if (facts.mainMissing) return ["[architecture] src/main.ts 缺失：无法取得服务装配表"];

  const violations = [];

  // A：除 src/main.ts 与基线登记的 legacy 消费者外，任何模块不得引用 src/main。
  const allowlisted = new Set(Object.keys(baseline.pluginConsumers));
  for (const file of Object.keys(facts.files).sort()) {
    if (file === "src/main.ts" || allowlisted.has(file)) continue;
    for (const line of facts.mainImportLines.get(file) || []) {
      violations.push(`[architecture] ${file}:${line} 不得依赖 src/main.ts / QnALogPlugin。请通过显式 Host/capability 注入所需能力。`);
    }
  }

  // B：legacy 消费者的能力面与基线精确一致（双向棘轮）。
  const legacyFiles = Object.keys(baseline.pluginConsumers).sort();
  for (const file of legacyFiles) {
    const expected = Array.isArray(baseline.pluginConsumers[file]) ? baseline.pluginConsumers[file] : null;
    if (!Object.prototype.hasOwnProperty.call(facts.files, file)) {
      violations.push(`[architecture] 基线 pluginConsumers 登记的 ${file} 已不存在；请同步从 ${BASELINE_FILE} 删除该条目。`);
      continue;
    }
    if (expected === null) {
      violations.push(`[architecture] ${BASELINE_FILE} 中 ${file} 的能力面不是字符串数组`);
      continue;
    }
    const actual = [...(facts.pluginCaps.get(file) || [])].sort();
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const label = facts.fileClassNames.get(file) || file.replace(/\.ts$/, "");
    for (const cap of actual) {
      if (!expectedSet.has(cap)) {
        violations.push(`[architecture] ${file} 新增了 QnALogPlugin 能力 ${cap}。${label} 的 legacy plugin 能力面被冻结；请通过独立 controller/port 提供该能力。`);
      }
    }
    for (const cap of [...expected].sort()) {
      if (!actualSet.has(cap)) {
        violations.push(`[architecture] ${file} 的基线能力 ${cap} 已不再被使用；基线过期，请同步从 ${BASELINE_FILE} 删除该能力（棘轮只允许收缩）。`);
      }
    }
  }

  // C：服务依赖边与基线精确一致，且不得新增/扩大依赖环。
  const { edges, orphans } = serviceEdges(facts);
  const actualKeys = edgeKeySet(edges);
  const baselineKeys = new Set(baseline.serviceEdges.map((pair) =>
    Array.isArray(pair) && pair.length === 2 ? `${pair[0]}\u0000${pair[1]}` : `\u0000invalid:${JSON.stringify(pair)}`));

  for (const e of edges) {
    if (baselineKeys.has(`${e.from}\u0000${e.to}`)) continue;
    violations.push([
      "[architecture] 新增服务依赖：",
      `${e.from} -> ${e.to}`,
      `来源：${e.sources.join("、")}`,
      "现有架构基线中不存在该边。",
      "优先通过调用方协调、callback、port 或独立 workflow service 解决。",
    ].join("\n"));
  }
  for (const pair of [...baseline.serviceEdges].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
      violations.push(`[architecture] ${BASELINE_FILE} 的 serviceEdges 含无效条目：${JSON.stringify(pair)}`);
      continue;
    }
    if (!actualKeys.has(`${pair[0]}\u0000${pair[1]}`)) {
      violations.push(`[architecture] 基线中的服务依赖 ${pair[0]} -> ${pair[1]} 已不存在；请同步从 ${BASELINE_FILE} 删除该边（棘轮只允许收缩）。`);
    }
  }
  for (const orphan of orphans) {
    violations.push(`[architecture] ${orphan.file} 的 ${orphan.hostName} 声明了服务级成员（${orphan.members.map((m) => m.name).join("、")}），但找不到消费它的服务类（需要 declare host: ${orphan.hostName} 或构造参数 host: ${orphan.hostName}），这些依赖边无法纳入基线。`);
  }

  // 环的诊断与拦截：分别对实际图与基线图求强连通分量。
  const baselineEdgeObjects = baseline.serviceEdges
    .filter((p) => Array.isArray(p) && p.length === 2)
    .map(([from, to]) => ({ from, to }));
  const actualNodes = new Set();
  for (const e of edges) { actualNodes.add(e.from); actualNodes.add(e.to); }
  const baselineNodes = new Set();
  for (const e of baselineEdgeObjects) { baselineNodes.add(e.from); baselineNodes.add(e.to); }

  const actualAdj = adjacency(actualNodes, edges);
  const baselineAdj = adjacency(baselineNodes, baselineEdgeObjects);
  const actualCyclic = cyclicComponents(tarjan(actualNodes, actualAdj));
  const baselineCyclic = cyclicComponents(tarjan(baselineNodes, baselineAdj));

  for (const component of actualCyclic) {
    if (baselineCyclic.some((b) => sameComponent(b, component))) continue;
    const cycle = findCycle(component, actualAdj).join(" -> ");
    const grown = baselineCyclic.find((b) => b.length < component.length && b.every((x) => component.includes(x)));
    if (grown) {
      violations.push([
        `[architecture] 新增的服务依赖把既有依赖环扩大了：{ ${grown.join(", ")} } → { ${component.join(", ")} }。`,
        `环：${cycle}`,
        "扩大既有环同样需要显式架构决策；优先改为单向依赖。",
      ].join("\n"));
    } else {
      violations.push([
        `[architecture] 新增的服务依赖形成了新的依赖环：{ ${component.join(", ")} }。`,
        `环：${cycle}`,
        "优先通过调用方协调、callback、port 或独立 workflow service 解除这条依赖。",
      ].join("\n"));
    }
  }

  return violations;
}

// ---------- CLI ----------

function collectSourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
        continue;
      }
      if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(path.join(root, "src"));
  return out;
}

function readRepoFiles(root) {
  const files = {};
  for (const abs of collectSourceFiles(root)) {
    files[normalize(path.relative(root, abs))] = readFileSync(abs, "utf8");
  }
  return files;
}

function main() {
  const files = readRepoFiles(process.cwd());

  // 仅供人工维护基线时使用：打印事实、不写文件，也不接入 npm scripts。
  if (process.argv.includes("--print-baseline")) {
    console.log(JSON.stringify(collectFacts(files), null, 2));
    return;
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(new URL("./architecture-baseline.json", import.meta.url), "utf8"));
  } catch (error) {
    console.error(`[architecture] 无法读取 ${BASELINE_FILE}：${error.message}`);
    process.exitCode = 1;
    return;
  }

  const stats = serviceGraphStats(files);
  console.log(`[architecture] 服务依赖图：服务 ${stats.services}，依赖边 ${stats.edges}，环状分量 ${stats.cyclicSccs}，最大分量 ${stats.largestScc}`);

  const violations = checkArchitecture(files, baseline);
  if (!violations.length) {
    console.log(`[architecture] OK: main.ts 引用、legacy plugin 能力面、服务依赖边均与基线一致（扫描 ${Object.keys(files).length} 个文件）`);
    return;
  }
  console.error(`[architecture] 发现 ${violations.length} 项架构违规：`);
  for (const violation of violations) {
    console.error(violation.split("\n").map((l, i) => (i === 0 ? `  ${l}` : `    ${l}`)).join("\n"));
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
