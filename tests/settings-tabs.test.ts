import { afterEach, describe, expect, it, vi } from "vitest";
const transcribeAudioMock = vi.hoisted(() => vi.fn());

type TextControl = {
  inputEl: { addEventListener: (event: string, callback: () => void) => void };
  setValue: (value: string) => TextControl;
  setPlaceholder: (value: string) => TextControl;
  onChange: (callback: (value: string) => unknown) => TextControl;
};
type BooleanControl = {
  setValue: (value: boolean) => BooleanControl;
  onChange: (callback: (value: boolean) => unknown) => BooleanControl;
};
type DropdownControl = {
  addOption: (value: string, label: string) => DropdownControl;
  setValue: (value: string) => DropdownControl;
  onChange: (callback: (value: string) => unknown) => DropdownControl;
};
type ButtonControl = {
  setButtonText: (value: string) => ButtonControl;
  setCta: () => ButtonControl;
  setDisabled: (disabled: boolean) => ButtonControl;
  onClick: (callback: () => unknown) => ButtonControl;
};

vi.mock("obsidian", () => {
  class FakeElement {
    children: FakeElement[] = [];
    classes = new Set<string>();
    onclick?: () => void;
    onkeydown?: (event: { key: string; preventDefault: () => void }) => void;
    parentElement?: FakeElement;
    text = "";
    open = false;
    scrolled = false;
    attrs: Record<string, string> = {};

    constructor(text = "") { this.text = text; }
    get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
    addClass(...names: string[]) { for (const name of names) this.classes.add(name); }
    toggleClass(name: string, enabled: boolean) {
      if (enabled) this.classes.add(name);
      else this.classes.delete(name);
    }
    setAttr(name: string, value: string) { this.attrs[name] = value; }
    empty() { this.children = []; this.text = ""; }
    createDiv(options: { cls?: string; text?: string } = {}) {
      const element = new FakeElement(options.text || "");
      element.addClass(...(options.cls || "").split(/\s+/).filter(Boolean));
      element.parentElement = this;
      this.children.push(element);
      return element;
    }
    createEl(_tag: string, options: { text?: string; cls?: string } = {}) {
      const element = new FakeElement(options.text || "");
      element.addClass(...(options.cls || "").split(/\s+/).filter(Boolean));
      element.parentElement = this;
      this.children.push(element);
      return element;
    }
    createSpan(options: { cls?: string; text?: string } = {}) {
      return this.createDiv(options);
    }
  }

  class FakeSetting {
    private readonly row: FakeElement;
    readonly settingEl: FakeElement;
    constructor(parent: FakeElement) {
      this.row = parent.createDiv({ cls: "setting-item" });
      this.settingEl = this.row;
    }
    setName(name: string) { this.row.createDiv({ cls: "setting-item-name" }).text = name; return this; }
    setDesc(text: string) { this.row.createDiv({ cls: "setting-item-description" }).text = text; return this; }
    setHeading() { this.row.addClass("setting-item-heading"); return this; }
    addText(build: (component: TextControl) => void) {
      let component: TextControl;
      component = {
        inputEl: { addEventListener: () => undefined },
        setValue: () => component,
        setPlaceholder: () => component,
        onChange: () => component,
      };
      build(component);
      return this;
    }
    addToggle(build: (component: BooleanControl) => void) {
      let component: BooleanControl;
      component = { setValue: () => component, onChange: () => component };
      build(component);
      return this;
    }
    addDropdown(build: (component: DropdownControl) => void) {
      let component: DropdownControl;
      component = {
        addOption: () => component,
        setValue: () => component,
        onChange: () => component,
      };
      build(component);
      return this;
    }
    addButton(build: (component: ButtonControl) => void) {
      let component: ButtonControl;
      component = {
        setButtonText: () => component,
        setCta: () => component,
        setDisabled: () => component,
        onClick: () => component,
      };
      build(component);
      return this;
    }
  }

  return {
    PluginSettingTab: class {
      containerEl = new FakeElement();
      constructor(public app: unknown, public plugin: unknown) {}
    },
    Setting: FakeSetting,
    Notice: class {},
    normalizePath: (value: string) => value.replace(/\\/g, "/"),
  };
});

import { resolveUiLanguage, setActiveUiLanguage } from "../src/shared/i18n";

afterEach(() => {
  setActiveUiLanguage(resolveUiLanguage("en", "en"));
});

vi.mock("../src/shared/defaults", () => ({
  DEFAULT_SETTINGS: {
    audioFolder: "QnALog/Audio",
    mdFolder: "QnALog/Transcripts",
    meetingMaterialsFolder: "QnALog/Materials",
  },
}));
vi.mock("../src/shared/util-platform", () => ({ isMobileRuntime: () => false }));
vi.mock("../src/asr/transcribe", () => ({
  normalizeAsrConcurrency: (value: unknown) => value,
  resolveTranscribeProvider: (plugin, providerId) => (plugin.settings.transcribeProviders || {})[providerId] || { model: "" },
  transcribeAudio: transcribeAudioMock,
}));
vi.mock("../src/ui/helpers", () => ({}));
vi.mock("../src/ui/modals", () => ({}));
vi.mock("../src/shared/util-common", () => ({}));
vi.mock("../src/shared/util-llm-endpoint", () => ({}));
vi.mock("../src/shared/util-note", () => ({}));
vi.mock("../src/shared/mode-meta", () => ({}));
vi.mock("../src/llm/config", () => ({}));
vi.mock("../src/llm/core", () => ({}));
vi.mock("../src/llm/asr-scheme", () => ({}));
vi.mock("../src/vocabulary", () => ({}));
vi.mock("../src/people", () => ({}));
vi.mock("../src/audio/audio-input", () => ({}));
vi.mock("../src/notes/recording-issues", () => ({}));
vi.mock("../src/audio/channel-speakers", () => ({}));
vi.mock("../src/asr/channel-transcription", () => ({}));
vi.mock("../src/asr/diarization", () => ({}));
vi.mock("../src/asr/long-audio-transcription", () => ({}));
vi.mock("../src/setup", () => ({}));
vi.mock("../src/shared/util-vault", () => ({}));

import { QnALogSettingTab } from "../src/ui/settings-tab";

describe("settings tabs render visible settings and switch pages", () => {
  it("shows recording controls, then switches to auto-import controls without mixing diagnostics", () => {
    const plugin = {
      settings: {
        activeTranscribeProvider: "siliconflow",
        transcribeProviders: {},
        enableInterimOutput: true,
        filterShortRecordings: true,
        segmentIntervalMinutes: 5,
        asrConcurrency: 1,
        keepSegmentAudioFiles: false,
        consolidatedLayout: true,
        autoRenameWithTitle: false,
        enableRealtimeOutline: true,
        autoOpenOutlineOnRecord: false,
        audioFolder: "QnALog/Audio",
        mdFolder: "QnALog/Transcripts",
        meetingMaterialsFolder: "QnALog/Materials",
        noteFileNameFormatNew: "YYYY-MM-DD HHmm",
        autoOpenNoteAfterFinish: true,
        showFloatingBall: true,
        bubbleSize: "large",
        inboxFolder: "",
        inboxAutoImport: false,
        inboxArchiveSubfolder: "processed",
        inboxStabilizeDelayMs: 3000,
        maxRetries: 3,
      },
      saveSettings: vi.fn(async () => undefined),
      shell: { syncBubbleVisibility: vi.fn() },
      externalInbox: { refreshExternalInboxWatcher: vi.fn() },
      cleanup: {},
      inbox: {},
      queue: { tasks: [] },
    };
    const tab = new QnALogSettingTab({}, plugin);
    tab.activeTab = "recording";
    tab.renderAudioInputSettings = () => undefined;
    tab.getTranscribeProviderProfile = () => ({ transcribeMode: "http" });
    tab.applySettingsSections = () => undefined;
    tab.renderSettings();
    expect(tab.containerEl.classes.has("qnalog-settings-root")).toBe(true);

    expect(tab.containerEl.textContent).toContain("Segment interval");
    expect(tab.containerEl.textContent).toContain("Concurrent transcriptions");
    expect(tab.containerEl.textContent).toContain("Filter very short recordings");

    const autoImportTab = tab.containerEl.children
      .flatMap((element) => element.children)
      .flatMap((element) => element.children)
      .find((element) => element.textContent === "Auto Import");
    expect(autoImportTab).toBeDefined();
    autoImportTab!.onclick?.();

    expect(tab.containerEl.textContent).toContain("Watched folder");
    expect(tab.containerEl.textContent).toContain("Maximum retry count");
    expect(tab.containerEl.textContent).toContain("Task queue");
    expect(tab.containerEl.textContent).not.toContain("Diagnostic Log Folder");
  });

  it("reports the configured model after a successful Flash probe", async () => {
    transcribeAudioMock.mockReset();
    class FakeAudioContext {
      sampleRate = 16_000;
      createBuffer() { return {}; }
      createMediaStreamDestination() { return { stream: {} }; }
      createBufferSource() { return { connect() {}, start() {} }; }
      async close() {}
    }
    class FakeMediaRecorder {
      mimeType = "audio/webm";
      state = "recording";
      ondataavailable?: (event: { data: Blob }) => void;
      onstop?: () => void;
      start() { this.ondataavailable?.({ data: new Blob(["silent sample"], { type: this.mimeType }) }); }
      stop() { this.state = "inactive"; this.onstop?.(); }
    }
    vi.stubGlobal("window", {
      AudioContext: FakeAudioContext,
      setTimeout: (callback: () => void) => { callback(); return 1; },
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const plugin = {
      settings: {
        activeTranscribeProvider: "dashscope-flash",
        transcribeProviders: {
          "dashscope-flash": { model: "qwen-audio-3.1-asr-flash" },
          siliconflow: { model: "sensevoice" },
        },
      },
    };
    const tab = new QnALogSettingTab({}, plugin);
    tab.getTranscribeProviderProfile = () => ({ transcribeMode: "http" });

    try {
      transcribeAudioMock.mockResolvedValueOnce({ text: "synthetic recognized text" });
      await expect(tab.runAsrConnectivityTest()).resolves.toBe("qwen-audio-3.1-asr-flash");

      transcribeAudioMock.mockRejectedValueOnce(new Error("HTTP 400: CLIENT_ERROR: ASR_RESPONSE_HAVE_NO_WORDS."));
      await expect(tab.runAsrConnectivityTest()).resolves.toBe("qwen-audio-3.1-asr-flash");

      plugin.settings.activeTranscribeProvider = "siliconflow";
      transcribeAudioMock.mockRejectedValueOnce(new Error("HTTP 400: CLIENT_ERROR: ASR_RESPONSE_HAVE_NO_WORDS."));
      await expect(tab.runAsrConnectivityTest()).rejects.toThrow("ASR_RESPONSE_HAVE_NO_WORDS");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("translates tab labels per render while keeping tab identity stable", () => {
    const tab = new QnALogSettingTab({}, { settings: {} });
    setActiveUiLanguage(resolveUiLanguage("en", "en"));
    expect(tab.getVisibleSettingsTabs().find(item => item.id === "ai")?.label).toBe("AI Briefing");
    expect(tab.getVisibleSettingsTabs().find(item => item.id === "knowledge")?.label).toBe("Knowledge");

    setActiveUiLanguage(resolveUiLanguage("zh", "en"));
    const chineseTabs = tab.getVisibleSettingsTabs();
    expect(chineseTabs.find(item => item.id === "ai")?.label).toBe("AI 整理");
    expect(chineseTabs.find(item => item.id === "knowledge")?.label).toBe("资料库");
    expect(chineseTabs.find(item => item.label === "AI 整理")?.id).toBe("ai");
    expect(resolveUiLanguage("", "zh").table["AI Briefing"]).toBe("AI 整理");
  });

  it("passes the status stage on click and keyboard navigation", () => {
    const tab = new QnALogSettingTab({}, { settings: {} });
    const targets: Array<[string, string]> = [];
    const parent = tab.containerEl.createDiv();
    const row = tab.buildStatusRow(parent, {
      stage: "llm",
      label: "AI Organize",
      value: "Configured",
      detail: "",
      icon: "",
      target: "api",
    }, (target, stage) => targets.push([target, stage]));
    row.onclick();
    let prevented = false;
    row.onkeydown({ key: "Enter", preventDefault: () => { prevented = true; } });
    row.onkeydown({ key: " ", preventDefault: () => { prevented = true; } });
    expect(targets).toEqual([["api", "llm"], ["api", "llm"], ["api", "llm"]]);
    expect(prevented).toBe(true);
  });
});
