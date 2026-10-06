import { describe, expect, it, vi } from "vitest";

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
    text = "";

    constructor(text = "") { this.text = text; }
    get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
    addClass(...names: string[]) { for (const name of names) this.classes.add(name); }
    toggleClass(name: string, enabled: boolean) {
      if (enabled) this.classes.add(name);
      else this.classes.delete(name);
    }
    empty() { this.children = []; this.text = ""; }
    createDiv(options: { cls?: string } = {}) {
      const element = new FakeElement();
      element.addClass(...(options.cls || "").split(/\s+/).filter(Boolean));
      this.children.push(element);
      return element;
    }
    createEl(_tag: string, options: { text?: string } = {}) {
      const element = new FakeElement(options.text || "");
      this.children.push(element);
      return element;
    }
  }

  class FakeSetting {
    private readonly row: FakeElement;
    constructor(parent: FakeElement) { this.row = parent.createDiv({ cls: "setting-item" }); }
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

vi.mock("../src/shared/defaults", () => ({
  DEFAULT_SETTINGS: {
    audioFolder: "QnALog/Audio",
    mdFolder: "QnALog/Transcripts",
    meetingMaterialsFolder: "QnALog/Materials",
  },
}));
vi.mock("../src/shared/util-platform", () => ({ isMobileRuntime: () => false }));
vi.mock("../src/shared/i18n", () => ({
  UI_LANGUAGES: [],
  getActiveUiLanguage: () => "en",
  t: (text: string) => text,
}));
vi.mock("../src/asr/transcribe", () => ({ normalizeAsrConcurrency: (value: unknown) => value }));
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
});
