import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../main.js", import.meta.url), "utf8");

class ObsidianBase {}

const noop = () => undefined;
const obsidian = {
  apiVersion: "1.13.7",
  BasesView: ObsidianBase,
  Component: ObsidianBase,
  FuzzySuggestModal: ObsidianBase,
  ItemView: ObsidianBase,
  Menu: ObsidianBase,
  Modal: ObsidianBase,
  Plugin: ObsidianBase,
  PluginSettingTab: ObsidianBase,
  Setting: ObsidianBase,
  TextComponent: ObsidianBase,
  TFile: ObsidianBase,
  TFolder: ObsidianBase,
  Platform: {
    isMobile: true,
    isMobileApp: true,
    isAndroidApp: true,
    isDesktopApp: false,
  },
  MarkdownRenderer: { render: async () => undefined },
  debounce: (fn) => fn,
  normalizePath: (value) => String(value || "").replace(/\\/g, "/"),
  Notice: function Notice() {},
  parseYaml: () => ({}),
  requestUrl: async () => ({}),
  sanitizeHTMLToDom: () => ({}),
  setIcon: noop,
  setTooltip: noop,
  stringifyYaml: () => "",
};

const sandbox = {
  module: { exports: {} },
  exports: {},
  require(id) {
    if (id === "obsidian") return obsidian;
    throw new Error(`Mobile bundle loaded unavailable module: ${id}`);
  },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  window: {},
  activeWindow: {},
  activeDocument: {},
  navigator: {},
};
sandbox.globalThis = sandbox;

vm.runInNewContext(code, sandbox, { filename: "main.js", timeout: 5000 });

const exported = sandbox.module.exports;
if (!(typeof exported === "function" || typeof exported?.default === "function")) {
  throw new Error("Mobile bundle did not expose the LexVoice plugin entrypoint");
}

console.log("[mobile-load] OK: bundle starts without Node, Electron, Buffer, or process globals");
