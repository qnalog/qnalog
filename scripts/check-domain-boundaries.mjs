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

// 插件对象上合法但不属于 QnALogPlugin 的成员：Obsidian/Bases 的扩展点。
const PLUGIN_EXTENSION_POINTS = ["registerBasesView"];

// 这些文件里的 `plugin` 是 Obsidian 内部对象（例如日记插件的 internalPlugins 条目），不是本插件。
const FOREIGN_PLUGIN_FILES = ["src/shared/util-note.ts"];

// 域服务模块的判据：声明了 `XxxHost` 接口的文件。这些文件里的 `this` 是服务自身，不是插件对象。
function isDomainModule(source) {
  return /export interface [A-Za-z_$][A-Za-z0-9_$]*Host\b/.test(source);
}

/**
 * 哪些函数/类把某个参数当作插件对象使用。
 *
 * 判据：参数 P 的成员访问里出现插件才有的一批字段（settings / app / manifest / loadData / saveData …），
 * 或函数体把 P 原样传给另一个已知「取插件对象」的函数（如 clearCommittedBriefingCheckpoint）。
 * 后者需要迭代到不动点：转发型辅助函数自己不看 settings，但最终会把参数交给看 settings 的函数。
 */
function pluginObjectConsumers(files) {
  const consumers = new Set();      // 函数名：首个参数是插件对象
  const classConsumers = new Set(); // 类名：构造函数里某个参数是插件对象
  const PLUGIN_FIELDS = new Set([
    "settings", "app", "manifest", "loadData", "saveData", "registerEvent", "registerInterval",
    "addChild", "addCommand", "addRibbonIcon", "addStatusBarItem", "registerView", "vault",
  ]);
  const parsers = [];
  for (const [file, content] of Object.entries(files)) {
    const sf = ts.createSourceFile(file, content, ts.ScriptTarget.ES2020, true);
    const check = (node, paramNames) => {
      let found = null;
      const walk = (n) => {
        if (found) return;
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && paramNames.has(n.expression.getText(sf))) {
          const prop = n.name.getText(sf);
          if (PLUGIN_FIELDS.has(prop) || prop.startsWith("_")) { found = n.expression.getText(sf); return; }
        }
        // 转发：把该参数原样交给已知取插件对象的函数
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && consumers.has(n.expression.getText(sf))) {
          const arg = n.arguments[0];
          if (arg && ts.isIdentifier(arg) && paramNames.has(arg.getText(sf))) { found = arg.getText(sf); return; }
        }
        ts.forEachChild(n, walk);
      };
      walk(node.body || node);
      return found;
    };
    parsers.push({ file, sf, check });
  }
  // 迭代到不动点：转发型函数在下一轮才被发现
  for (let round = 0; round < 5; round++) {
    let changed = false;
    for (const { file, sf, check } of parsers) {
      const sfText = files[file];
      const visit = (node) => {
        if (ts.isFunctionDeclaration(node) && node.name) {
          const name = node.name.getText(sf);
          if (!consumers.has(name) && check(node, new Set([node.parameters[0]?.name?.getText?.(sf)].filter(Boolean)))) {
            consumers.add(name); changed = true;
          }
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
            && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
          const name = node.name.getText(sf);
          const first = node.initializer.parameters[0];
          if (!consumers.has(name) && first && first.name && check(node.initializer, new Set([first.name.getText(sf)]))) {
            consumers.add(name); changed = true;
          }
        }
        if (ts.isClassDeclaration(node) && node.name) {
          const name = node.name.getText(sf);
          if (!classConsumers.has(name)) {
            const ctor = node.members.find((m) => ts.isConstructorDeclaration(m));
            const names = new Set((ctor?.parameters || []).map((p) => p.name && p.name.getText && p.name.getText(sf)).filter(Boolean));
            if (names.size && check(ctor || node, names)) { classConsumers.add(name); changed = true; }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      void sfText;
    }
    if (!changed) break;
  }
  return { consumers, classConsumers };
}


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

/** QnALogPlugin 的成员集合：方法、属性，以及在类体内动态赋值的字段。 */
function pluginMembers(mainSource) {
  const sf = ts.createSourceFile("main.ts", mainSource, ts.ScriptTarget.ES2020, true);
  const cls = sf.statements.find((s) => ts.isClassDeclaration(s) && s.name && s.name.getText() === "QnALogPlugin");
  if (!cls) throw new Error("src/main.ts 里找不到 QnALogPlugin");
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
  const { consumers, classConsumers } = pluginObjectConsumers(files);
  const problems = [];

  for (const [file, content] of Object.entries(files)) {
    if (normalize(file) === "src/main.ts") continue;

    // 0) 域服务把自身 `this` 当作插件对象传给辅助函数。
    // 辅助函数读的是 plugin.settings / plugin.app，传服务实例会读到 undefined：
    // 一部分直接抛 TypeError（如读 settings.briefingStructureLevel），一部分被 try/catch 吞掉后静默失效。
    if (isDomainModule(String(content))) {
      const sf = ts.createSourceFile(file, String(content), ts.ScriptTarget.ES2020, true);
      const lineOfNode = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && consumers.has(node.expression.getText(sf))) {
          node.arguments.forEach((arg, index) => {
            if (arg.kind === ts.SyntaxKind.ThisKeyword) {
              problems.push(`${file}:${lineOfNode(node)} ${node.expression.getText(sf)}(…) 第 ${index + 1} 个实参传了服务自身 this，该函数要的是插件对象，应为 this.host`);
            }
          });
        }
        if (ts.isNewExpression(node) && classConsumers.has(node.expression.getText(sf))) {
          (node.arguments || []).forEach((arg, index) => {
            if (arg.kind === ts.SyntaxKind.ThisKeyword) {
              problems.push(`${file}:${lineOfNode(node)} new ${node.expression.getText(sf)}(…) 第 ${index + 1} 个实参传了服务自身 this，该构造函数要的是插件对象，应为 this.host`);
            }
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

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
