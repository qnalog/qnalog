import esbuild from "esbuild";
import { readFileSync } from "fs";
import path from "path";

const production = process.argv[2] === "production";
// 构建时把当前 manifest 版本号注入 main.js（LEXVOICE_BUILD_VERSION），供运行时自检「版本错位」：
// 若它与磁盘 manifest.json 的版本不一致，说明上次更新只换了 manifest、没换 main.js。
const buildVersion = JSON.parse(readFileSync("./manifest.json", "utf8")).version || "0.0.0";

// 桌面端真正启用流式 ASR 时，懒加载 ws 的 Node 实现以设置 Authorization 请求头。
// 不能在模块顶层初始化 ws：Obsidian 移动端没有 Node/Buffer/process，顶层加载会让整个插件启动失败。
// 浏览器原生 WebSocket 不能设置握手请求头，因此移动端保留分段/整段转写，流式 ASR 仍限定桌面端。
const wsForceNodePlugin = {
  name: "ws-force-node",
  setup(build) {
    build.onResolve({ filter: /^ws$/ }, () => ({ path: path.resolve("node_modules/ws/index.js") }));
  },
};

const context = await esbuild.context({
  entryPoints: ["./src/main.ts"],
  bundle: true,
  // ws 打包进来但只在动态 import 执行时初始化；其 Node 内置模块由桌面 Electron 运行时提供。
  external: ["obsidian", "electron", "http", "https", "net", "tls", "crypto", "stream", "zlib", "events", "url", "util", "buffer", "bufferutil", "utf-8-validate"],
  plugins: [wsForceNodePlugin],
  format: "cjs",
  target: "es2018",
  define: {
    LEXVOICE_BUILD_VERSION: JSON.stringify(buildVersion),
  },
  charset: "utf8",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  banner: {
    js: [
      "/* QnALog - records and transcribes conversations into structured Markdown.",
      " * Derived from LexVoice (c) 2026 Lynnx, MIT licensed; modifications",
      " * (c) 2026 Q&A Log Team, MIT licensed. See LICENSE and NOTICE at",
      " * https://github.com/qnalog/qnalog - keep both with any copy.",
      " * Edit src/main.ts, then run npm run build. */",
    ].join("\n"),
  },
  outfile: "main.js",
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log("Watching LexVoice source files...");
}
