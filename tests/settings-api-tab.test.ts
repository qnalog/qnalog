import { beforeEach, describe, expect, it, vi } from "vitest";

// 最小的 DOM 替身：只实现 settings-api-tab 用到的部分。
// 断言的是用户看到的结果：有哪些卡片、哪些区块显示、动作之后哪一块被重画。
vi.mock("obsidian", () => {
  class FakeElement {
    children: FakeElement[] = [];
    classes = new Set<string>();
    attrs: Record<string, string> = {};
    listeners: Record<string, Array<() => void>> = {};
    parentElement: FakeElement | null = null;
    text = "";
    open = false;
    value = "";
    type = "";
    setting?: FakeSetting;
    onclick?: () => void;
    constructor(public tagName = "div", text = "") { this.text = text; }
    get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
    get ownerDocument() { return { activeElement: null }; }
    addClass(...names: string[]) { for (const name of names) this.classes.add(name); }
    hasClass(name: string) { return this.classes.has(name); }
    setAttribute(name: string, value: string) { this.attrs[name] = value; }
    getAttribute(name: string) { return this.attrs[name] ?? null; }
    addEventListener(event: string, callback: () => void) { (this.listeners[event] ||= []).push(callback); }
    contains(other: FakeElement): boolean { return other === this || this.children.some((child) => child.contains(other)); }
    focus() {}
    empty() { this.children = []; this.text = ""; }
    querySelector() { return null; }
    createEl(tag: string, options: { text?: string; cls?: string } = {}) {
      const element = new FakeElement(tag, options.text || "");
      element.addClass(...(options.cls || "").split(/\s+/).filter(Boolean));
      element.parentElement = this;
      this.children.push(element);
      return element;
    }
    createDiv(options: { text?: string; cls?: string } = {}) { return this.createEl("div", options); }
    createSpan(options: { text?: string; cls?: string } = {}) { return this.createEl("span", options); }
  }

  class FakeSetting {
    static all: FakeSetting[] = [];
    readonly settingEl: FakeElement;
    name = "";
    dropdown?: { onChange?: (value: string) => unknown; options: string[]; value: string };
    texts: Array<{ onChange?: (value: string) => unknown; value: string }> = [];
    buttons: Array<{ text: string; click?: () => unknown }> = [];
    constructor(parent: FakeElement) {
      this.settingEl = parent.createDiv({ cls: "setting-item" });
      this.settingEl.setting = this;
      FakeSetting.all.push(this);
    }
    setName(name: string) { this.name = name; this.settingEl.createDiv({ cls: "setting-item-name", text: name }); return this; }
    setDesc(text: string) { this.settingEl.createDiv({ cls: "setting-item-description", text }); return this; }
    addDropdown(build: (component: unknown) => void) {
      const state = { options: [] as string[], value: "", onChange: undefined as ((value: string) => unknown) | undefined };
      const component = {
        selectEl: new FakeElement("select"),
        addOption: (value: string) => { state.options.push(value); return component; },
        setValue: (value: string) => { state.value = value; return component; },
        onChange: (callback: (value: string) => unknown) => { state.onChange = callback; return component; },
      };
      this.dropdown = state;
      build(component);
      return this;
    }
    addText(build: (component: unknown) => void) {
      const state = { value: "", onChange: undefined as ((value: string) => unknown) | undefined };
      const component = {
        inputEl: new FakeElement("input"),
        setValue: (value: string) => { state.value = value; return component; },
        setPlaceholder: () => component,
        onChange: (callback: (value: string) => unknown) => { state.onChange = callback; return component; },
      };
      this.texts.push(state);
      build(component);
      return this;
    }
    addToggle(build: (component: unknown) => void) {
      const component = { setValue: () => component, onChange: () => component };
      build(component);
      return this;
    }
    addButton(build: (component: unknown) => void) {
      const state = { text: "", click: undefined as (() => unknown) | undefined };
      const component = {
        buttonEl: new FakeElement("button"),
        setButtonText: (text: string) => { state.text = text; return component; },
        setDisabled: () => component,
        onClick: (callback: () => unknown) => { state.click = callback; return component; },
      };
      this.buttons.push(state);
      build(component);
      return this;
    }
    addExtraButton(build: (component: unknown) => void) {
      const state = { text: "extra", click: undefined as (() => unknown) | undefined };
      const component = {
        setIcon: () => component,
        setTooltip: (text: string) => { state.text = text; return component; },
        onClick: (callback: () => unknown) => { state.click = callback; return component; },
      };
      this.buttons.push(state);
      build(component);
      return this;
    }
  }

  return {
    Setting: FakeSetting,
    FakeElement,
    Notice: class { constructor(public message: string) {} },
    normalizePath: (value: string) => value,
    TFile: class {},
    TFolder: class {},
  };
});
vi.mock("../src/ui/helpers", () => ({ openExternalUrl: vi.fn(), openPickListModal: vi.fn() }));
vi.mock("../src/shared/util-platform", () => ({ isMobileRuntime: () => false }));

import * as obsidian from "obsidian";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { PluginSettings } from "../src/shared/types";
import { renderApiTab } from "../src/ui/settings-api-tab";
import type { ApiTabHost } from "../src/ui/settings-api-tab";

type Fake = InstanceType<typeof obsidian.Setting> & {
  settingEl: any; name: string;
  dropdown?: { onChange?: (value: string) => unknown; options: string[]; value: string };
  texts: Array<{ onChange?: (value: string) => unknown; value: string }>;
  buttons: Array<{ text: string; click?: () => unknown }>;
};
const allSettings = () => (obsidian.Setting as unknown as { all: Fake[] }).all;

function sameNodes(actual: any[], expected: any[]) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((node, index) => expect(node === expected[index]).toBe(true));
}
function walk(root: any, visit: (el: any) => void) { visit(root); for (const child of root.children) walk(child, visit); }
function findByClass(root: any, cls: string): any[] {
  const out: any[] = [];
  walk(root, (el) => { if (el.classes.has(cls)) out.push(el); });
  return out;
}
/** 取某容器内的某个设置行（按名称）。 */
function rowIn(container: any, name: string): Fake {
  const rows: Fake[] = [];
  walk(container, (el) => { if (el.setting && el.setting.name === name) rows.push(el.setting); });
  if (!rows.length) throw new Error(`no setting row "${name}"`);
  return rows[0];
}

function freshSettings(): PluginSettings {
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as PluginSettings;
  s.transcribeProviders["dashscope-flash"].apiKey = "sk-asr";
  s.activeTranscribeProvider = "dashscope-flash";
  s.llmEndpoint = "https://api.openai.com/v1";
  s.llmApiKey = "sk-openai";
  s.llmModel = "gpt-4.1-mini";
  s.llmServicePreset = "openai";
  return s;
}

function makeHost(settings: PluginSettings): ApiTabHost & { saves: number } {
  const host = {
    pickModel: () => undefined,
    settings,
    saves: 0,
    saveSettings: async () => { host.saves += 1; },
    probeResults: {},
    runProbe: async () => ({ ok: true, detail: "ok" }),
    testRecording: async () => "model",
    testLlm: async () => ({ model: "m", preview: "OK" }),
    testImport: async () => ({ model: "m", detail: "d" }),
    fetchImportModels: async () => [],
    getProfile: (id: string) => ({ title: id, requiresKey: true, transcribeMode: "segmented" }),
    renderRiskNotice: (parent: any) => { parent.createDiv({ cls: "qnalog-risk-notice" }); },
    uiState: { advancedOpen: false, guideOpen: {} },
  };
  return host as unknown as ApiTabHost & { saves: number };
}

function render(host: ApiTabHost) {
  const root: any = new (obsidian as any).FakeElement("div");
  renderApiTab(root, host);
  return root;
}

beforeEach(() => { allSettings().length = 0; });

describe("API tab layout", () => {
  it("shows the transcription card, the AI organizing card and a collapsed advanced section", () => {
    const root = render(makeHost(freshSettings()));
    const cards = findByClass(root, "qnalog-api-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("Speech transcription");
    expect(cards[1].textContent).toContain("AI organizing service");
    const advanced = findByClass(root, "qnalog-api-advanced")[0];
    expect(advanced.open).toBe(false);
    expect(advanced.textContent).toContain("Speaker recognition for imported audio");
    // old top scheme block and its temporary option are gone
    expect(root.textContent).not.toContain("API Configuration");
    expect(root.textContent).not.toContain("Temporary configuration");
    expect(root.textContent).not.toContain("Save configuration");
  });

  it("keeps the AI model row class used by the home-tab jump", () => {
    const root = render(makeHost(freshSettings()));
    const rows = findByClass(root, "qnalog-ai-model-setting");
    expect(rows).toHaveLength(1);
    expect(findByClass(root, "qnalog-api-card-ai")[0].contains(rows[0])).toBe(true);
  });

  it("hides saved configurations when there are none and lists them otherwise", () => {
    const empty = freshSettings();
    empty.llmProfiles = [];
    expect(render(makeHost(empty)).textContent).not.toContain("Saved configurations");

    allSettings().length = 0;
    const withProfiles = freshSettings();
    withProfiles.llmProfiles = [{ id: "llm-1", name: "Work setup", endpoint: "https://api.deepseek.com/v1", apiKey: "k", model: "deepseek-chat" }];
    const root = render(makeHost(withProfiles));
    const advanced = findByClass(root, "qnalog-api-advanced")[0];
    expect(advanced.textContent).toContain("Saved configurations");
    expect(advanced.textContent).toContain("Work setup");
    expect(allSettings().some((row) => row.buttons.some((b) => b.text === "Use this configuration"))).toBe(true);
  });
});

describe("API tab thinking row", () => {
  const thinkingRows = (root: any) => {
    const rows: Fake[] = [];
    walk(root, (el) => { if (el.setting && el.setting.name === "Thinking") rows.push(el.setting); });
    return rows;
  };

  it("is absent for a service that cannot adjust thinking", () => {
    expect(thinkingRows(render(makeHost(freshSettings())))).toHaveLength(0);
  });

  it("shows for a supported service, keeps the stored value, and saves without rebuilding", async () => {
    const settings = freshSettings();
    settings.llmModel = "gpt-6-luna";
    settings.thinkingMode = "fast";
    const host = makeHost(settings);
    const root = render(host);
    const rows = thinkingRows(root);
    expect(rows).toHaveLength(1);
    expect(rows[0].dropdown!.options).toEqual(["auto", "fast", "reasoning"]);
    expect(rows[0].dropdown!.value).toBe("fast");
    const [recording, ai] = findByClass(root, "qnalog-api-card");
    const before = [...recording.children, ...ai.children];
    await rows[0].dropdown!.onChange!("reasoning");
    expect(settings.thinkingMode).toBe("reasoning");
    expect(host.saves).toBe(1);
    sameNodes([...recording.children, ...ai.children], before);
  });

  it("follows the model field: appears and disappears without rebuilding the card", async () => {
    const settings = freshSettings();
    const host = makeHost(settings);
    const root = render(host);
    const ai = findByClass(root, "qnalog-api-card")[1];
    await rowIn(ai, "Model ID").texts[0].onChange!("gpt-6.1-sol");
    expect(thinkingRows(root)).toHaveLength(1);
    await rowIn(ai, "Model ID").texts[0].onChange!("gpt-4.1-mini");
    expect(thinkingRows(root)).toHaveLength(0);
    expect(settings.thinkingMode).toBe("auto");
  });
});

describe("API tab re-render scope", () => {
  it("switching the AI service rebuilds only the AI card", async () => {
    const settings = freshSettings();
    const host = makeHost(settings);
    const root = render(host);
    const [recording, ai] = findByClass(root, "qnalog-api-card");
    const advanced = findByClass(root, "qnalog-api-advanced")[0];
    const recordingChildren = [...recording.children];
    const advancedChildren = [...advanced.children];
    const aiChildren = [...ai.children];

    const dropdown = rowIn(ai, "Service Preset").dropdown!;
    expect(dropdown.value).toBe("openai");
    await dropdown.onChange!("deepseek");

    expect(settings.llmEndpoint).toContain("deepseek");
    expect(settings.llmApiKey).toBe(""); // new service starts with an empty key
    expect(host.saves).toBe(1);
    // same container nodes, rebuilt content only in the AI card
    expect(findByClass(root, "qnalog-api-card")[1]).toBe(ai);
    expect(ai.children.some((child: any, index: number) => child === aiChildren[index])).toBe(false);
    sameNodes(recording.children, recordingChildren);
    sameNodes(advanced.children, advancedChildren);
    expect(rowIn(ai, "Service Preset").dropdown!.value).toBe("deepseek");
  });

  it("typing in a field saves but does not rebuild anything", async () => {
    const settings = freshSettings();
    const host = makeHost(settings);
    const root = render(host);
    const [recording, ai] = findByClass(root, "qnalog-api-card");
    const before = [...recording.children, ...ai.children];

    await rowIn(ai, "Access Key").texts[0].onChange!("sk-new");
    await rowIn(recording, "API key").texts[0].onChange!("sk-asr-2");

    expect(settings.llmApiKey).toBe("sk-new");
    expect(settings.transcribeProviders["dashscope-flash"].apiKey).toBe("sk-asr-2");
    expect(host.saves).toBe(2);
    sameNodes([...recording.children, ...ai.children], before);
  });

  it("running the AI test updates only the AI card's badge", async () => {
    const settings = freshSettings();
    const host = makeHost(settings);
    host.runProbe = async (key, view) => {
      host.probeResults[key] = { ok: true, detail: "ok", signature: `${view.endpoint}|${view.model}|k` };
      return { ok: true, detail: "ok" };
    };
    const root = render(host);
    const [recording, ai] = findByClass(root, "qnalog-api-card");
    const recordingChildren = [...recording.children];
    const testButton = rowIn(ai, "LLM Connectivity Test").buttons[0];
    await testButton.click!();
    sameNodes(recording.children, recordingChildren);
    expect(ai.children[0].textContent).toContain("AI organizing service");
  });

  it("deleting the last saved configuration empties that block without touching the cards", async () => {
    const settings = freshSettings();
    settings.llmProfiles = [{ id: "llm-1", name: "Work setup", endpoint: "e", apiKey: "k", model: "m" }];
    settings.activeLlmProfile = "llm-1";
    const host = makeHost(settings);
    const root = render(host);
    const [recording, ai] = findByClass(root, "qnalog-api-card");
    const cardsBefore = [...recording.children, ...ai.children];
    const del = allSettings().flatMap((row) => row.buttons).find((b) => b.text === "Delete this configuration")!;
    await del.click!();
    expect(settings.llmProfiles).toEqual([]);
    expect(settings.activeLlmProfile).toBe("");
    const advanced = findByClass(root, "qnalog-api-advanced")[0];
    expect(advanced.textContent).not.toContain("Saved configurations");
    sameNodes([...recording.children, ...ai.children], cardsBefore);
  });

  it("switching to a saved configuration refreshes both cards", async () => {
    const settings = freshSettings();
    settings.llmProfiles = [{ id: "llm-1", name: "Work setup", endpoint: "https://api.deepseek.com/v1", apiKey: "dk", model: "deepseek-chat" }];
    const host = makeHost(settings);
    const root = render(host);
    const [recording, ai] = findByClass(root, "qnalog-api-card");
    const recordingChildren = [...recording.children];
    const use = allSettings().flatMap((row) => row.buttons).find((b) => b.text === "Use this configuration")!;
    await use.click!();
    expect(settings.llmEndpoint).toBe("https://api.deepseek.com/v1");
    expect(settings.activeLlmProfile).toBe("llm-1");
    expect(recording.children.some((child: any, index: number) => child === recordingChildren[index])).toBe(false);
    expect(rowIn(ai, "Model ID").texts[0].value).toBe("deepseek-chat");
  });
});
