// 域边界检查：插件成员与域服务之间的引用必须真实存在。
//
// 为什么要有这条：src/main.ts 与各域服务都带 @ts-nocheck，`plugin.<已搬走的成员>`、
// `this.host.<未声明的能力>`、`this.host.<字段>.<不存在的成员>` 都不会被 tsc 报出来，
// 只在运行时静默失效（读不到就跳过）或抛 TypeError。拆分过程中这类缺陷一次出现过上百处，
// 靠人工 grep 容易漏，因此固化成脚本：CI 每次 push 跑，本地也可随时跑。
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// 插件对象上合法但不属于 LexVoicePlugin 的成员：Obsidian/Bases 的扩展点。
const PLUGIN_EXTENSION_POINTS = ["registerBasesView"];

// 这些文件里的 `plugin` 是 Obsidian 内部对象（例如日记插件的 internalPlugins 条目），不是本插件。
const FOREIGN_PLUGIN_FILES = ["src/shared/util-note.ts"];

function normalize(file) {
  return file.split(path.sep).join("/");
}

function collectSourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); continue; }
      if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(path.join(root, "src"));
  return out;
}

/** LexVoicePlugin 的成员集合：方法、属性，以及在类体内动态赋值的字段。 */
function pluginMembers(mainSource) {
  const sf = ts.createSourceFile("main.ts", mainSource, ts.ScriptTarget.ES2020, true);
  const cls = sf.statements.find((s) => ts.isClassDeclaration(s) && s.name && s.name.getText() === "LexVoicePlugin");
  if (!cls) throw new Error("src/main.ts 里找不到 LexVoicePlugin");
  const members = new Set([
    "app", "manifest", "loadData", "saveData", "register", "registerEvent", "registerInterval",
    "addCommand", "addRibbonIcon", "addStatusBarItem", "addSettingTab", "registerView",
    "registerMarkdownPostProcessor", "registerMarkdownCodeBlockProcessor", "addChild", "onload", "onunload",
    ...PLUGIN_EXTENSION_POINTS,
  ]);
  for (const m of cls.members) {
    if (m.name) members.add(m.name.getText(sf));
  }
  const walk = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword) {
        members.add(left.name.getText(sf));
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(cls);
  return members;
}

/** 服务类索引：类名 → 成员名集合，用于校验 this.host.<字段>.<成员>。 */
function serviceClassMembers(files, readFile) {
  const index = new Map();
  for (const file of files) {
    const text = readFile(file);
    for (const m of text.matchAll(/export class ([A-Za-z_$][A-Za-z0-9_$]*)[^{]*\{/g)) {
      const body = text.slice(m.index + m[0].length);
      let depth = 1;
      let i = 0;
      for (; i < body.length && depth > 0; i++) {
        if (body[i] === "{") depth++;
        else if (body[i] === "}") depth--;
      }
      const inner = body.slice(0, i);
      const names = new Set();
      for (const mem of inner.matchAll(/^\s{2}(?:declare\s+|async\s+|static\s+|readonly\s+|private\s+|public\s+)*(?:get\s+|set\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*[(:;=]/gm)) {
        names.add(mem[1]);
      }
      // 构造函数与其它方法里动态赋值的字段（this.x = ...）也算成员
      for (const mem of inner.matchAll(/this\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) names.add(mem[1]);
      index.set(m[1], names);
    }
  }
  return index;
}

/**
 * 返回违规项（空数组表示通过）。
 * files 为 { 相对路径: 内容 }，便于单测注入。
 */
export function checkDomainBoundaries(files) {
  const mainSource = files["src/main.ts"];
  if (mainSource === undefined) return ["src/main.ts 缺失：无法取得插件成员清单"];

  const members = pluginMembers(mainSource);
  // 域字段 → 服务类：来自 main.ts 里的 this.<字段> = new <类>(this) 装配语句
  const fieldClass = new Map();
  for (const m of mainSource.matchAll(/this\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*new\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    fieldClass.set(m[1], m[2]);
  }
  // 其它模块也会在插件对象上懒创建字段（plugin.X = ...），视为合法成员
  for (const [file, content] of Object.entries(files)) {
    if (normalize(file) === "src/main.ts") continue;
    for (const m of String(content).matchAll(/\bplugin\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=[^=]/g)) members.add(m[1]);
  }
  const names = Object.keys(files);
  const classMembers = serviceClassMembers(names, (f) => files[f]);
  const problems = [];

  for (const [file, content] of Object.entries(files)) {
    if (normalize(file) === "src/main.ts") continue;

    // 1) plugin.<成员> 必须真的在插件对象上
    if (!FOREIGN_PLUGIN_FILES.includes(normalize(file))) {
      for (const m of String(content).matchAll(/\bplugin\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
        const name = m[1];
        if (members.has(name) || classMembers.has(name)) continue;
        problems.push(`${file}${lineOf(content, m.index)}: plugin.${name} 不在插件对象上（可能已搬到域服务，改为 plugin.<域>.<成员>）`);
      }
    }

    // 1b) plugin.<域字段>.<成员>：域服务上必须真有该成员
    if (!FOREIGN_PLUGIN_FILES.includes(normalize(file))) {
      for (const m of String(content).matchAll(/\bplugin\.([A-Za-z_$][A-Za-z0-9_$]*)((?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)/g)) {
        const field = m[1];
        const member = m[2].slice(1).split(".")[0];
        const cls = fieldClass.get(field);
        if (!cls) continue;
        const known = classMembers.get(cls);
        if (known && !known.has(member)) {
          problems.push(`${file}${lineOf(content, m.index)}: plugin.${field}.${member} 不在 ${cls} 上`);
        }
      }
    }

    // 2) this.host.<能力> 必须在本文件声明的 Host 接口里，且该能力由插件提供
    const text = String(content);
    const hostUses = [...text.matchAll(/\bthis\.host\.([A-Za-z_$][A-Za-z0-9_$]*)/g)];
    if (!hostUses.length) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);
    const iface = sf.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.getText().endsWith("Host"));
    if (!iface) {
      problems.push(`${file}: 用到 this.host 但没有声明 Host 接口`);
      continue;
    }
    const declared = new Map();
    for (const m of iface.members) {
      if (m.name) declared.set(m.name.getText(sf), m);
    }
    for (const m of hostUses) {
      const name = m[1];
      if (!declared.has(name)) {
        problems.push(`${file}${lineOf(content, m.index)}: this.host.${name} 未在 Host 接口里声明`);
        continue;
      }
      if (!members.has(name) && !classMembers.has(name)) {
        problems.push(`${file}${lineOf(content, m.index)}: this.host.${name} 不在插件对象上（能力可能已搬走）`);
      }
    }

    // 3) this.host.<字段>.<成员>：字段类型上必须真有该成员
    for (const m of text.matchAll(/\bthis\.host\.([A-Za-z_$][A-Za-z0-9_$]*)((?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)/g)) {
      const [, field, rest] = m;
      const member = rest.slice(1).split(".")[0];
      const decl = declared.get(field);
      if (!decl || !decl.type) continue;
      // 字段本身指向某个域服务（main.ts 里 this.<字段> = new <类>(this)）时以那个服务类为准：
      // 接口里写的内联类型是手抄的，可能声明了服务上并不存在的成员，只信类本身。
      const ownerClass = fieldClass.get(field);
      if (ownerClass) {
        const known = classMembers.get(ownerClass);
        if (known && !known.has(member)) {
          problems.push(`${file}${lineOf(content, m.index)}: this.host.${field}.${member} 不在 ${ownerClass} 上（字段指向该服务）`);
        }
        for (const item of (ts.isTypeLiteralNode(decl.type) ? decl.type.members : [])) {
          const name = item.name ? item.name.getText(sf) : "";
          if (name && known && !known.has(name)) {
            problems.push(`${file}${lineOf(content, m.index)}: Host 接口声明的 ${field}.${name} 不在 ${ownerClass} 上`);
          }
        }
        continue;
      }
      if (ts.isTypeLiteralNode(decl.type)) {
        const inner = new Set(decl.type.members.map((x) => (x.name ? x.name.getText(sf) : "")).filter(Boolean));
        if (!inner.has(member)) problems.push(`${file}${lineOf(content, m.index)}: this.host.${field}.${member} 不在内联类型里`);
        continue;
      }
      const typeName = decl.type.getText(sf).trim().split(/[<|]/)[0].trim();
      const known = classMembers.get(typeName);
      if (known && !known.has(member)) problems.push(`${file}${lineOf(content, m.index)}: this.host.${field}.${member} 不在 ${typeName} 上`);
    }
  }

  return problems;
}

function lineOf(content, index) {
  return `:${String(content).slice(0, index).split("\n").length}`;
}

function main() {
  const files = {};
  for (const file of collectSourceFiles(process.cwd())) {
    files[normalize(path.relative(process.cwd(), file))] = readFileSync(file, "utf8");
  }
  const problems = checkDomainBoundaries(files);
  if (!problems.length) {
    console.log(`[domain-boundaries] OK: 检查 ${Object.keys(files).length} 个文件，插件成员与域服务引用一致`);
    return;
  }
  console.error("[domain-boundaries] 发现引用不一致：");
  for (const p of problems) console.error("  " + p);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
