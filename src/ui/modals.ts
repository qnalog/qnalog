/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- QnALog's settings/data layer is intentionally dynamically typed (files use @ts-nocheck and read untyped JSON from loadData); these type-only rules yield no actionable findings here and are tracked for incremental typing */
// @ts-nocheck — Modal/Widget class 密集（this.plugin.* 等无 TS 字段声明）；已用 tsc 确认无漏引用(TS2304=0)，余者皆类字段类型噪音，故与 main.ts 同档跳过。
// 由 main.ts 抽出（模块化拆解，提升工程稳定性；纯搬迁、零行为改动）。
import { NS_AUDIO_ALT } from "../shared/namespace";
import { t as i18nT } from '../shared/i18n';
import * as obsidian from "obsidian";
import { loadPeopleDirectory, normalizePeopleRelation, normalizePeopleSuggestion } from '../people';
import { diagnosticError } from '../shared/util-key-diag';
import { classifyImportTextFileForModal, enumerateAudioDevices, qnalogConfirm, makeImportTextCheckboxId } from './helpers';
import { formatElapsed, pad } from '../shared/util-common';
import { AUDIO_EXT, IMPORT_TEXT_CATEGORY_CONFIG, IMPORT_TEXT_CATEGORY_ORDER, TEXT_IMPORT_EXT } from '../shared/catalog-import';
import { callLlm } from '../llm/core';
import { mimeFromExt } from '../shared/util-audio';
import { getBuiltInVisiblePolishModeKeys, getCustomPromptModeTemplates, getEffectivePolishMode, getModeMeta, getVisibleModeEntries, isCustomPromptModeTemplate, makeCustomPromptModeId, sanitizePromptTemplate, setModePillIcon } from '../shared/mode-meta';
import { getActivityStagePosition } from '../shared/activity-progress';
import { getDesktopProcess } from '../shared/desktop-runtime';
import { isSpeakerDiarizationProvider, normalizeRequestedSpeakerCount } from '../asr/diarization';
import { isDashScopeFileTransProvider, resolveImportTranscribeProvider } from '../asr/long-audio-transcription';

function resolveImportSpeakerSelection(plugin) {
  const provider = resolveImportTranscribeProvider(plugin);
  const profile = plugin.profiles.getTranscribeProviderProfile(provider.id, provider);
  const supportsDiarization = !!(profile && profile.speakerDiarization)
    || isSpeakerDiarizationProvider(provider)
    || isDashScopeFileTransProvider(provider);
  const supportsExactCount = supportsDiarization && isDashScopeFileTransProvider(provider);
  const enabled = supportsDiarization && plugin.settings.importSpeakerDiarization !== false;
  return {
    supportsDiarization,
    supportsExactCount,
    enabled,
    count: enabled && supportsExactCount
      ? normalizeRequestedSpeakerCount(plugin.settings.importSpeakerCount)
      : 0,
  };
}

function renderImportSpeakerControl(parent, owner) {
  const box = parent.createDiv({ cls: "qnalog-import-mode qnalog-import-speaker" });
  const copy = box.createDiv();
  copy.createDiv({ cls: "qnalog-import-mode-title", text: i18nT("Speaker") });
  const hint = copy.createDiv({ cls: "qnalog-import-mode-hint" });
  const control = box.createDiv({ cls: "qnalog-import-speaker-control" });

  const toggleLabel = control.createEl("label", { cls: "qnalog-import-speaker-toggle" });
  const toggle = toggleLabel.createEl("input", { type: "checkbox" });
  toggleLabel.createSpan({ text: i18nT("Distinguish Speakers") });
  toggle.checked = owner.selectedSpeakerDiarization;
  toggle.disabled = !owner.speakerSelection.supportsDiarization;

  let countInput = null;
  if (owner.speakerSelection.supportsExactCount) {
    const numberControl = control.createDiv({ cls: "qnalog-import-number-control" });
    countInput = numberControl.createEl("input", {
      cls: "qnalog-import-number-input is-compact",
      attr: {
        type: "number",
        min: "2",
        max: "100",
        step: "1",
        inputmode: "numeric",
        placeholder: i18nT("Auto"),
        "aria-label": i18nT("Number of Speakers"),
      },
    });
    countInput.value = owner.selectedSpeakerCount > 0 ? String(owner.selectedSpeakerCount) : "";
    countInput.disabled = !owner.selectedSpeakerDiarization;
    numberControl.createSpan({ cls: "qnalog-import-number-unit", text: i18nT("People") });
    countInput.oninput = () => {
      const normalized = normalizeRequestedSpeakerCount(countInput.value);
      owner.selectedSpeakerCount = normalized;
      if (normalized > 0 && !toggle.checked) {
        toggle.checked = true;
        owner.selectedSpeakerDiarization = true;
        countInput.disabled = false;
      }
    };
  } else {
    control.createSpan({ cls: "qnalog-import-speaker-auto", text: i18nT("Auto-detect speaker count") });
  }

  if (!owner.speakerSelection.supportsDiarization) {
    hint.setText(i18nT("The current import transcription model does not support speaker separation."));
  } else if (owner.speakerSelection.supportsExactCount) {
    hint.setText(i18nT("Enter the number of speakers to reduce merging of similar voices; leave empty to detect automatically."));
  } else {
    hint.setText(i18nT("The current model supports speaker separation, but the number of speakers is detected automatically."));
  }

  toggle.onchange = () => {
    owner.selectedSpeakerDiarization = toggle.checked;
    if (!toggle.checked) owner.selectedSpeakerCount = 0;
    if (countInput) {
      countInput.disabled = !toggle.checked;
      if (!toggle.checked) countInput.value = "";
    }
  };
}
export function pickReportAccentColor(app, defaultHex = null) {
  return new Promise((resolve) => {
    const modal = new obsidian.Modal(app);
    modal.titleEl.setText(i18nT("Choose report colour scheme"));
    let chosen = defaultHex || "#E85F28";
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; resolve(val); try { modal.close(); } catch { /* intentionally empty */ } };
    const wrap = modal.contentEl.createDiv({ cls: "qnalog-color-pick" });
    wrap.createEl("p", { cls: "qnalog-color-hint", text: i18nT("The report uses the chosen colors and keeps the layout unchanged. You can regenerate it repeatedly; existing files are not overwritten.") });
    const sw = wrap.createDiv({ cls: "qnalog-color-swatches" });
    const presets = [[i18nT("Warm orange (default)"), "#E85F28"], [i18nT("Sapphire"), "#2F6BD8"], [i18nT("Ink teal"), "#138A8A"], [i18nT("Pine green"), "#3B9A4B"], [i18nT("Lotus purple"), "#7A4AD8"], [i18nT("Rose red"), "#D8407E"], [i18nT("Brown gold"), "#B5811A"], [i18nT("Graphite blue"), "#54627A"]];
    const swatchEls = [];
    let customInput;
    const select = (hex) => {
      chosen = hex;
      if (customInput) customInput.value = hex;
      for (const [el, h] of swatchEls) el.toggleClass("is-active", h.toLowerCase() === hex.toLowerCase());
    };
    for (const [name, hex] of presets) {
      const el = sw.createDiv({ cls: "qnalog-color-swatch" });
      el.style.backgroundColor = hex;
      el.setAttr("aria-label", name);
      el.setAttr("title", name);
      el.onclick = () => select(hex);
      swatchEls.push([el, hex]);
    }
    const crow = wrap.createDiv({ cls: "qnalog-color-custom" });
    crow.createEl("label", { text: i18nT("Custom") });
    customInput = crow.createEl("input");
    customInput.type = "color";
    customInput.value = chosen;
    customInput.oninput = () => select(customInput.value);
    const actions = wrap.createDiv({ cls: "qnalog-color-actions" });
    actions.createEl("button", { text: i18nT("Generate report"), cls: "mod-cta" }).onclick = () => finish(chosen);
    actions.createEl("button", { text: i18nT("Cancel") }).onclick = () => finish(null);
    modal.onClose = () => finish(null);
    select(chosen);
    modal.open();
  });
}

export class AudioTimeModal extends obsidian.Modal {
  constructor(app, file, startMs, label) {
    super(app);
    this.file = file;
    this.startMs = Math.max(0, Number(startMs) || 0);
    this.label = label || formatElapsed(this.startMs);
    this.objectUrl = "";
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("qnalog-audio-modal");
    contentEl.createEl("h3", { text: i18nT("Q&A Log listen back") });
    contentEl.createDiv({ cls: "qnalog-audio-modal-meta", text: `${this.file.path} · ${this.label}` });

    const playerWrap = contentEl.createDiv({ cls: "qnalog-audio-player-wrap" });
    const audio = playerWrap.createEl("audio", { attr: { controls: "true" } });
    audio.preload = "metadata";

    try {
      const ab = await this.app.vault.readBinary(this.file);
      const blob = new Blob([ab], { type: mimeFromExt(this.file.extension) });
      this.objectUrl = URL.createObjectURL(blob);
      audio.src = this.objectUrl;
      audio.addEventListener("loadedmetadata", () => {
        try {
          const target = Math.max(0, Math.min(audio.duration || 0, this.startMs / 1000));
          audio.currentTime = target;
          audio.play().catch(() => { /* intentionally empty */ });
        } catch { /* intentionally empty */ }
      });
    } catch (e) {
      console.error("[QnALog] audio time modal failed", e);
      contentEl.createDiv({ cls: "qnalog-audio-modal-error", text: `${i18nT("Could not read audio:")}${(e && e.message) || e}` });
    }

    const actions = contentEl.createDiv({ cls: "qnalog-audio-modal-actions" });
    actions.createEl("button", { text: i18nT("Open audio file") }).onclick = () => {
      void this.app.workspace.getLeaf(false).openFile(this.file);
    };
  }

  onClose() {
    this.contentEl.empty();
    if (this.objectUrl) {
      try { URL.revokeObjectURL(this.objectUrl); } catch { /* intentionally empty */ }
      this.objectUrl = "";
    }
  }
}

export class PeopleHotwordsConsentModal extends obsidian.Modal {
  constructor(app, onDone) {
    super(app);
    this.onDone = onDone;
    this.confirmed = false;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("qnalog-consent-modal");
    contentEl.createEl("h2", { text: i18nT("Please confirm before enabling name hotwords") });
    contentEl.createDiv({
      cls: "setting-item-description",
      text: i18nT("Once enabled, Q&A Log reads names and common forms of address from person profiles and sends these name hotwords with transcription or AI processing requests to the currently configured transcription and LLM services, to improve the accuracy of name recognition and form-of-address alignment."),
    });
    const list = contentEl.createEl("ul", { cls: "qnalog-consent-list" });
    list.createEl("li", { text: i18nT("Send only names and common forms of address, not roles, organizations, notes, sources, or person relationships.") });
    list.createEl("li", { text: i18nT("If ASR or LLM is a cloud service, these names and terms will leave your local device and be subject to the respective provider's data policy.") });
    list.createEl("li", { text: i18nT("If the recording content itself contains names, it will still be processed by the cloud service when using cloud ASR; this toggle controls the extra person-profile hotwords that are sent.") });
    list.createEl("li", { text: i18nT("This authorization is stored in local settings until the user revokes it or switches back to privacy-first.") });
    list.createEl("li", { text: i18nT("For confidential, private, client, medical, legal, HR and similar content, use \"Privacy First\" or \"Local Enhanced\".") });
    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = actions.createEl("button", { text: i18nT("Cancel") });
    cancelBtn.onclick = () => this.close();
    const okBtn = actions.createEl("button", { text: i18nT("I understand, enable name hotwords") });
    okBtn.addClass("mod-cta");
    okBtn.onclick = () => {
      this.confirmed = true;
      this.close();
    };
  }
  onClose() {
    this.contentEl.empty();
    if (typeof this.onDone === "function") this.onDone(!!this.confirmed);
  }
}

export class PeopleDirectorySuggestionModal extends obsidian.Modal {
  constructor(app, plugin, sourceFile, suggestions, options = {}) {
    super(app);
    this.plugin = plugin;
    this.sourceFile = sourceFile;
    this.options = options || {};
    const defaultSelected = this.options.fromIgnored ? false : true;
    this.suggestions = (suggestions || []).map(item => Object.assign({ selected: defaultSelected }, item, {
      matchPath: (item.match && item.match.path) || item.matchPath || "",
    }));
    this.rows = [];
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: i18nT("Confirm person attribution") });
    contentEl.createDiv({
      cls: "setting-item-description",
      text: this.sourceFile
        ? i18nT("Q&A Log only sends the content of the current note to the configured LLM to generate candidate person suggestions; existing person profiles are used only locally for matching and deduplication and are not sent with the request. Once confirmed, the speaker attributions for this meeting are written back to the minutes and the corresponding person pages are maintained.")
        : this.options.fromIgnored
          ? `${i18nT("These are the ones already ignored: ")}${this.options.ignoredCount || this.suggestions.length}${i18nT(" people suggestions. Suggestions ignored by mistake can be restored to pending first, or edited and saved into the person profiles directly; once saved they are removed from the ignored list automatically.")}`
        : this.options.fromCache
          ? `${i18nT("These are the ones not yet processed since the last scan: ")}${this.options.cachedCount || this.suggestions.length}${i18nT(" people suggestions. They stay in the local settings until you save, ignore, or clear them, so you can continue later.")}`
        : `${i18nT("Q&A Log scanned ")}${this.options.scannedCount || 0}${i18nT(" notes scanned")}，只显示需要确认的人员建议。已有人员资料仅在本地用于匹配和去重，不随请求发送。${this.options.remainingCount ? `本轮后仍有 ${this.options.remainingCount} 篇待扫描。` : ""}`,
    });
    contentEl.createDiv({
      cls: "setting-item-description qnalog-people-suggestion-guide",
      text: i18nT("First decide who this name belongs to: merge into an existing person, or create a record for someone new; this attribution distinguishes attendees, mentioned people, and to-do assignees. The details below are supplementary only — no renaming is needed to merge."),
    });
    let peopleEntries = [];
    try {
      peopleEntries = await loadPeopleDirectory(this.plugin);
    } catch (e) {
      console.warn("[QnALog] load people directory for suggestion modal failed", e);
    }
    const peopleByPath = new Map((peopleEntries || []).map(person => [obsidian.normalizePath(person.path || ""), person]));
    const getPathBasename = (path) => String(path || "").split("/").pop().replace(/\.md$/i, "");
    const getPersonOptionLabel = (person) => {
      const main = String((person && person.name) || getPathBasename(person && person.path) || i18nT("Unnamed person")).trim();
      const parts = [
        main,
        person && person.role,
        person && person.organization,
      ].map(value => String(value || "").trim()).filter(Boolean);
      return parts.join(" · ");
    };
    const getPersonHint = (person) => {
      if (!person) return "";
      const aliases = (person.aliases || []).filter(Boolean).slice(0, 4).join("、");
      return [
        person.role ? `${i18nT("Role:")}${person.role}` : "",
        person.organization ? `${i18nT("Organization:")}${person.organization}` : "",
        aliases ? `${i18nT("Common aliases:")}${aliases}` : "",
      ].filter(Boolean).join(" · ");
    };

    const list = contentEl.createDiv({ cls: "qnalog-people-suggestion-list" });
    this.rows = [];
    for (const item of this.suggestions) {
      const box = list.createDiv({ cls: "qnalog-people-suggestion-card" });
      const top = box.createDiv({ cls: "qnalog-people-suggestion-top" });
      const checkbox = top.createEl("input", { type: "checkbox" });
      checkbox.checked = item.selected !== false;
      const badge = top.createSpan({ text: this.options.fromIgnored ? "已忽略" : (item.matchPath ? "合并到已有人员" : i18nT("New person")), cls: "qnalog-people-suggestion-badge" });
      top.createSpan({ text: `${i18nT("Confidence:")}${item.confidence || i18nT("Medium")}`, cls: "setting-item-description" });
      const matchMeta = top.createSpan({ text: item.matchPath ? ` · ${item.matchPath}` : "", cls: "setting-item-description" });
      if (!this.sourceFile && item.sourceBasename) top.createSpan({ text: `${i18nT(" · Source: ")}${item.sourceBasename}`, cls: "setting-item-description" });
      let rowRef = null;
      const ignoreBtn = top.createEl("button", { text: this.options.fromIgnored ? i18nT("Restore pending confirmation") : i18nT("Ignore") });
      ignoreBtn.addClass("qnalog-people-suggestion-ignore");
      if (this.options.fromIgnored) {
        ignoreBtn.onclick = async () => {
          try {
            const removed = await this.plugin.people.restoreIgnoredPeopleDirectorySuggestion(item);
            if (!removed) {
              new obsidian.Notice(i18nT("This suggestion cannot be restored right now"));
              return;
            }
            this.rows = this.rows.filter(row => row !== rowRef);
            box.remove();
            new obsidian.Notice(`${i18nT("Restored to pending confirmation:")}${item.name || i18nT("this suggestion")}`);
          } catch (e) {
            console.error("[QnALog] restore ignored people suggestion failed", e);
            new obsidian.Notice(`${i18nT("Restore failed:")}${(e && e.message) || e}`, 8000);
          }
        };
      } else {
        ignoreBtn.onclick = async () => {
          try {
            const ok = await this.plugin.people.ignorePeopleDirectorySuggestion(item);
            if (!ok) {
              new obsidian.Notice(i18nT("This suggestion cannot be ignored right now"));
              return;
            }
            this.rows = this.rows.filter(row => row !== rowRef);
            box.remove();
            new obsidian.Notice(`${i18nT("Ignored:")}${item.name || i18nT("this suggestion")}`);
          } catch (e) {
            console.error("[QnALog] ignore people suggestion failed", e);
            new obsidian.Notice(`${i18nT("Ignore failed:")}${(e && e.message) || e}`, 8000);
          }
        };
      }

      const targetBox = box.createDiv({ cls: "qnalog-people-suggestion-target" });
      targetBox.createDiv({ cls: "qnalog-people-suggestion-target-label", text: i18nT("Assign to") });
      const targetSelect = targetBox.createEl("select", { cls: "dropdown qnalog-people-suggestion-target-select" });
      targetSelect.createEl("option", { value: "", text: i18nT("New person profile") });
      const currentPath = obsidian.normalizePath(item.matchPath || "");
      if (currentPath && !peopleByPath.has(currentPath)) {
        targetSelect.createEl("option", { value: currentPath, text: `${getPathBasename(currentPath)}${i18nT("(current match)")}` });
      }
      for (const person of peopleEntries || []) {
        const path = obsidian.normalizePath(person.path || "");
        if (!path) continue;
        targetSelect.createEl("option", { value: path, text: getPersonOptionLabel(person) });
      }
      targetSelect.value = currentPath || "";
      const targetHint = targetBox.createDiv({ cls: "qnalog-people-suggestion-target-hint" });
      const updateTargetUi = () => {
        const path = obsidian.normalizePath(targetSelect.value || "");
        item.matchPath = path;
        if (rowRef) rowRef.item.matchPath = path;
        const person = path ? peopleByPath.get(path) : null;
        if (this.options.fromIgnored) badge.setText(path ? i18nT("Ignored · Merged into existing person") : i18nT("Ignored · New"));
        else badge.setText(path ? "合并到已有人员" : i18nT("New person"));
        matchMeta.setText(path ? ` · ${path}` : "");
        if (path && person) {
          targetHint.setText(getPersonHint(person) || i18nT("This suggestion will be added as a mention in this meeting and attached to the selected person's profile."));
        } else if (path) {
          targetHint.setText(i18nT("This suggestion will be recorded as mentioned in this meeting and attached to the currently matched people record."));
        } else {
          targetHint.setText(i18nT("A new people record will be created with the candidate name."));
        }
      };
      targetSelect.addEventListener("change", updateTargetUi);
      updateTargetUi();

      let relationSelect;
      new obsidian.Setting(box).setName(i18nT("Attendance for This Session"))
        .setDesc(i18nT("Used to write back to meeting notes: attendees, mentioned people, and action-item owners go into different fields, and person pages then aggregate the related meetings in reverse."))
        .addDropdown(d => {
          relationSelect = d;
          d.addOption("mentioned", i18nT("Mentioned people"));
          d.addOption("participant", i18nT("Participants"));
          d.addOption("todo_owner", i18nT("To-do assignee"));
          d.setValue(normalizePeopleRelation(item.relation) || "mentioned");
        });

      let nameInput;
      let aliasInput;
      let roleInput;
      let orgInput;
      new obsidian.Setting(box).setName(i18nT("Name"))
        .addText(t => { nameInput = t; t.setValue(item.name || ""); });
      new obsidian.Setting(box).setName(i18nT("Common Aliases"))
        .setDesc(i18nT("Separate multiple aliases with commas or enumeration commas (、)."))
        .addText(t => { aliasInput = t; t.setValue((item.aliases || []).join("、")); });
      new obsidian.Setting(box).setName(i18nT("Role"))
        .addText(t => { roleInput = t; t.setValue(item.role || ""); });
      new obsidian.Setting(box).setName(i18nT("Organization"))
        .addText(t => { orgInput = t; t.setValue(item.organization || ""); });
      const noteArea = box.createEl("textarea", {
        cls: "qnalog-people-suggestion-note",
        text: item.note || "",
      });
      noteArea.placeholder = i18nT("Note");
      if (item.evidence && item.evidence.length) {
        box.createDiv({
          cls: "setting-item-description",
          text: i18nT("Basis:") + item.evidence.slice(0, 3).join("；"),
        });
      }
      rowRef = { item, checkbox, nameInput, aliasInput, roleInput, orgInput, relationSelect, noteArea };
      this.rows.push(rowRef);
    }

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = actions.createEl("button", { text: i18nT("Cancel") });
    cancelBtn.onclick = () => this.close();
    const openBtn = actions.createEl("button", { text: i18nT("Open person profile") });
    openBtn.onclick = async () => {
      try {
        const file = await this.plugin.people.ensurePeopleDirectoryFiles({ overwrite: false });
        if (file instanceof obsidian.TFile) await this.plugin.app.workspace.getLeaf(false).openFile(file);
      } catch (e) {
        new obsidian.Notice(`${i18nT("Failed to open person profile:")}${(e && e.message) || e}`);
      }
    };
    const saveBtn = actions.createEl("button", { text: i18nT("Confirm attribution") });
    saveBtn.addClass("mod-cta");
    saveBtn.onclick = async () => {
      const selected = this.rows
        .filter(row => row.checkbox.checked)
        .map(row => {
          const name = row.nameInput.getValue().trim();
          const normalized = normalizePeopleSuggestion({
            name,
            aliases: row.aliasInput.getValue(),
            role: row.roleInput.getValue(),
            organization: row.orgInput.getValue(),
            note: row.noteArea.value,
            relation: row.relationSelect ? row.relationSelect.getValue() : row.item.relation,
            confidence: row.item.confidence || i18nT("Medium"),
            evidence: row.item.evidence || [],
          });
          if (normalized) normalized.matchPath = row.item.matchPath || "";
          if (normalized) {
            normalized.sourcePath = row.item.sourcePath || "";
            normalized.sourceBasename = row.item.sourceBasename || "";
            normalized.cacheKey = row.item.cacheKey || "";
            normalized.ignoreKey = row.item.ignoreKey || "";
            normalized.ignoreTerms = row.item.ignoreTerms || [];
          }
          return normalized;
        })
        .filter(Boolean);
      if (!selected.length) {
        new obsidian.Notice(i18nT("No person suggestions selected to save"));
        return;
      }
      try {
        const grouped = new Map();
        for (const item of selected) {
          const sourcePath = item.sourcePath || (this.sourceFile && this.sourceFile.path) || "";
          if (!grouped.has(sourcePath)) grouped.set(sourcePath, []);
          grouped.get(sourcePath).push(item);
        }
        let created = 0;
        let updated = 0;
        for (const [sourcePath, items] of grouped.entries()) {
          const file = sourcePath ? this.plugin.app.vault.getAbstractFileByPath(sourcePath) : this.sourceFile;
          const result = await this.plugin.people.applyPeopleDirectorySuggestions(file instanceof obsidian.TFile ? file : null, items);
          created += result.created;
          updated += result.updated;
          if (file instanceof obsidian.TFile) this.plugin.knowledgeExtraction.markKnowledgeExtractionSource("people", file);
        }
        if (this.options.fromIgnored) this.plugin.people.removePeopleDirectorySuggestionIgnores(selected);
        else this.plugin.people.removeCachedPeopleSuggestions(selected);
        await this.plugin.saveSettings();
        new obsidian.Notice(`${i18nT("Person attribution confirmed: created ")}${created}${i18nT(", merged ")}${updated}`);
        this.close();
      } catch (e) {
        console.error("[QnALog] apply people suggestions failed", e);
        new obsidian.Notice(`${i18nT("Save failed: ")}${(e && e.message) || e}`, 8000);
      }
    };
  }
}

export class SpeakerNameConfirmModal extends obsidian.Modal {
  constructor(app, plugin, candidates, initialMappings, options = {}, onDone) {
    super(app);
    this.plugin = plugin;
    this.candidates = Array.isArray(candidates) ? candidates : [];
    this.initialMappings = initialMappings || {};
    this.options = options || {};
    this.onDone = onDone;
    this.rows = [];
    this.result = null;
    this.settled = false;
  }

  async onOpen() {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass("qnalog-speaker-confirm-modal");
    contentEl.createEl("h2", { text: i18nT("Confirm speaker") });
    contentEl.createDiv({
      cls: "qnalog-speaker-confirm-desc",
      text: i18nT("Transcription is complete. Once you enter names, the AI will organize the speech, conclusions, and to-dos by name. Leave it blank to keep using speaker numbers."),
    });
    if (this.options.unstableAcrossSegments) {
      contentEl.createDiv({
        cls: "qnalog-speaker-confirm-warning",
        text: i18nT("The current transcription was generated from multiple independent segments, so speaker numbers may change between segments. Please verify against the speech samples; if unsure, you can leave it blank for now."),
      });
    }

    let people = [];
    try { people = await loadPeopleDirectory(this.plugin); } catch { /* optional suggestions */ }
    const datalistId = `qnalog-speaker-name-options-${Date.now()}`;
    const datalist = contentEl.createEl("datalist", { attr: { id: datalistId } });
    const knownNames = new Set();
    for (const person of people || []) {
      const name = String(person && person.name || "").trim();
      if (!name || knownNames.has(name)) continue;
      knownNames.add(name);
      datalist.createEl("option", { value: name });
    }

    const list = contentEl.createDiv({ cls: "qnalog-speaker-confirm-list" });
    this.rows = [];
    for (const candidate of this.candidates) {
      const row = list.createDiv({ cls: "qnalog-speaker-confirm-row" });
      const copy = row.createDiv({ cls: "qnalog-speaker-confirm-copy" });
      copy.createDiv({ cls: "qnalog-speaker-confirm-label", text: candidate.label || candidate.id });
      const samples = Array.isArray(candidate.samples) ? candidate.samples.filter(Boolean) : [];
      copy.createDiv({
        cls: "qnalog-speaker-confirm-sample",
        text: samples.length ? samples.join(" / ") : i18nT("No speech samples to display yet"),
      });
      const input = row.createEl("input", {
        cls: "qnalog-speaker-confirm-input",
        type: "text",
        attr: {
          list: datalistId,
          placeholder: i18nT("Enter name"),
          "aria-label": `${candidate.label || candidate.id}${i18nT("'s name")}`,
        },
      });
      input.value = String(this.initialMappings[candidate.id] && this.initialMappings[candidate.id].personName || "");
      this.rows.push({ candidate, input });
    }

    const actions = contentEl.createDiv({ cls: "modal-button-container qnalog-speaker-confirm-actions" });
    const skip = actions.createEl("button", { text: i18nT("Leave blank for now") });
    skip.onclick = () => this.close();
    const confirm = actions.createEl("button", { text: i18nT("Confirm and continue") });
    confirm.addClass("mod-cta");
    confirm.onclick = () => {
      this.result = Object.fromEntries(this.rows.map(({ candidate, input }) => [candidate.id, input.value.trim()]));
      this.close();
    };
  }

  onClose() {
    this.contentEl.empty();
    if (this.settled) return;
    this.settled = true;
    if (typeof this.onDone === "function") this.onDone(this.result);
  }
}

export class QueueModal extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this._expandedStages = new Set();
    this._collapsedStages = new Set();
    this._expandedActivities = new Set();
    this._collapsedActivities = new Set();
    this._lastActiveStage = "";
    this._scrollTop = 0;
    this._lastScrollAt = 0;
  }
  onOpen() {
    const { contentEl } = this;
    // 静态 Modal 默认停在打开瞬间；处理中时定时重渲染让进度实时走动。先清旧定时器避免叠加。
    if (this._activityTimer) { window.clearInterval(this._activityTimer); this._activityTimer = null; }
    const previousList = contentEl.querySelector(".qnalog-progress-list");
    if (previousList) this._scrollTop = previousList.scrollTop;
    contentEl.empty();
    contentEl.addClass("qnalog-progress");
    try { if (this.modalEl) this.modalEl.addClass("qnalog-progress-modal"); } catch { /* intentionally empty */ }

    const allTasks = (this.plugin.queue && Array.isArray(this.plugin.queue.tasks)) ? this.plugin.queue.tasks : [];
    const running = allTasks.filter((t) => t && (t.status === "running" || t.status === "live"));
    const pending = allTasks.filter((t) => t && t.status !== "running" && t.status !== "live");
    const completed = Array.isArray(this.plugin.tasks.completedWorkLog) ? this.plugin.tasks.completedWorkLog : [];
    const detail = this.plugin.tasks.getCurrentActivityDetail ? this.plugin.tasks.getCurrentActivityDetail() : null;
    const activityLabel = this.plugin.tasks.getCurrentActivityLabel ? this.plugin.tasks.getCurrentActivityLabel() : null;
    const active = !!(detail || activityLabel);
    const activeLiveness = detail && detail.liveness ? String(detail.liveness) : (active ? "running" : "done");
    const sessionId = this.plugin.tasks._importBusy && this.plugin.tasks._importBusy.sessionId
      ? String(this.plugin.tasks._importBusy.sessionId)
      : this.plugin.session && this.plugin.session.id ? String(this.plugin.session.id) : "";
    const currentActivityIds = new Set(sessionId && active
      ? [`import:${sessionId}`, `finalize:${sessionId}`]
      : []);
    const taskActivities = (this.plugin.tasks.getTaskActivities
      ? this.plugin.tasks.getTaskActivities({ includeDone: true, includeCancelled: false })
      : [])
      .filter((task) => task && !String(task.kind || "").startsWith("queue-"))
      .filter((task) => !currentActivityIds.has(String(task.id || "")));
    // 当前处理链由顶部流程展示；这里只保留真正需要用户处理的后台异常，避免同一任务重复展开。
    const visibleTaskActivities = taskActivities.filter((task) => ["failed", "stalled"].includes(String(task.status || "")));
    const taskProblems = taskActivities.filter((task) => String(task.status || "") === "failed");
    const taskActive = taskActivities.filter((task) => ["queued", "running", "waiting", "slow", "stalled", "retrying"].includes(String(task.status || "")));
    const taskDone = taskActivities.filter((task) => task.status === "done");
    const headLiveness = taskProblems.length
      ? "failed"
      : active
        ? activeLiveness
        : taskActive.length
          ? String(taskActive[0].status || "running")
          : running.length
            ? "running"
            : pending.length
              ? "retrying" : "done";
    const headActive = active || taskActive.length > 0 || running.length > 0;
    const livenessLabel = (state) => ({
      queued: i18nT("Queued"),
      pending: i18nT("Not started"),
      running: i18nT("In progress"),
      waiting: i18nT("Waiting for service response"),
      slow: i18nT("Processing"),
      stalled: i18nT("Still processing"),
      retrying: i18nT("Waiting to retry"),
      failed: i18nT("Failed"),
      cancelled: i18nT("Cancelled"),
      done: i18nT("Completed"),
    }[state] || i18nT("Processing"));
    const livenessDetail = (state) => ({
      queued: i18nT("Task registered, waiting for a free processing slot"),
      pending: i18nT("Start automatically after prerequisites complete"),
      running: "",
      waiting: i18nT("The request has been sent, but the service has not returned a result yet"),
      slow: i18nT("The request has been sent and the service is processing it"),
      stalled: i18nT("This stage is taking longer than expected; the task is still running, so you can close the window and wait for the result in the background"),
      retrying: i18nT("This request failed; waiting for the next request per the backoff rule"),
      failed: i18nT("This stage produced no usable result"),
      cancelled: i18nT("The task was cancelled by the user"),
      done: i18nT("This stage is complete"),
    }[state] || "");

    // 时长用短单位（s/m/h）。与「分段间隔」的单位不同：后者是 min（分钟），
    // 若共用同一个词条，90 秒会渲染成 "1min30min"。单位符号不进词条表。
    const fmtDur = (ms) => { const s = Math.max(0, Math.round(Number(ms) / 1000)); if (s < 60) return `${s}s`; const m = Math.floor(s / 60), r = s % 60; if (m < 60) return r ? `${m}m${r}s` : `${m}m`; const h = Math.floor(m / 60), rm = m % 60; return rm ? `${h}h${rm}m` : `${h}h`; };
    const fmtTime = (ms) => { try { return window.moment ? window.moment(ms).format("HH:mm:ss") : new Date(ms).toLocaleTimeString(); } catch { return ""; } };
    const tokenLabel = (n, exact) => { const v = Number(n) || 0; if (v <= 0) return ""; const num = v >= 10000 ? (v / 10000).toFixed(1).replace(/\.0$/, "") + "万" : String(v); return `${exact ? "" : "≈"}${num}`; };
    const taskTitle = (t) => t.type === "transcribe" ? `${t.status === "live" ? i18nT("Live transcription") : i18nT("Transcription retry")}${i18nT(" · segment ")}${(t.segmentIndex || 0) + 1}`
      : t.type === "merge" ? `${i18nT("Merge retry · ")}${(t.segments || []).length}${i18nT(" segments")}`
      : t.type === "generate-prompt" ? "提示词生成" : (t.type || i18nT("Task"));

    // —— 头部：标题 + 状态 ——
    const activityText = [
      detail && detail.stage,
      detail && detail.step,
      detail && detail.kind,
      detail && detail.modeLabel,
      activityLabel,
    ].filter(Boolean).join(" ").toLowerCase();
    const activePipelineStage = detail && Array.isArray(detail.stages)
      ? detail.stages.find((stage) => stage && stage.status === "active") || null
      : null;
    const isTranscribing = activePipelineStage
      ? ["prepare", "transcribe", "persist"].includes(String(activePipelineStage.id || ""))
      : /(transcrib|asr|转写|音频|分段)/i.test(activityText);
    const headTitle = headLiveness === "done"
      ? i18nT("Processing complete")
      : headActive
        ? (isTranscribing ? "正在转写" : i18nT("Organizing note"))
      : taskProblems.length ? i18nT("Processing incomplete") : i18nT("Processing progress");
    const head = contentEl.createDiv({ cls: "qnalog-progress-head" });
    const titleRow = head.createDiv({ cls: "qnalog-progress-title-row" });
    titleRow.createSpan({ cls: "qnalog-progress-title", text: headTitle });
    titleRow.createSpan({
      cls: `qnalog-progress-state is-${headLiveness}${headActive ? " is-active" : ""}`,
      text: taskProblems.length
        ? `${taskProblems.length}${i18nT(" tasks need processing")}`
        : headActive
          ? livenessLabel(headLiveness)
          : i18nT("Idle"),
      attr: { "aria-live": "polite" },
    });

    if (!running.length && !pending.length && !completed.length && !active && !taskActivities.length) {
      contentEl.createDiv({ cls: "qnalog-progress-empty", text: i18nT("No tasks in progress. Progress for transcription, AI cleanup, and retry tasks will appear here.") });
      return;
    }

    // —— 进度链：转写 → AI 整理 → 完成 ——
    const doneCount = completed.length + taskDone.length;
    const activeCount = (active ? 1 : 0) + running.length + taskActive.length;
    const total = completed.length + (active ? 1 : 0) + running.length + pending.length + taskActivities.length;
    const stagePosition = getActivityStagePosition(detail && detail.stages);
    const hasStageProgress = stagePosition.total > 0;
    const hasNumericProgress = !!(detail && Number.isFinite(Number(detail.percent)));
    let percent = 0;
    let indeterminate = false;
    if (hasStageProgress) {
      const currentFraction = hasNumericProgress
        ? Math.max(0, Math.min(1, Number(detail.percent) / 100))
        : 0;
      percent = Math.round(Math.min(100, ((stagePosition.completed + currentFraction) / stagePosition.total) * 100));
      indeterminate = active && (!hasNumericProgress || Number(detail.percent) <= 0);
    } else {
      const taskProgressEquiv = taskActivities.reduce((sum, task) => {
        if (task.status === "done") return sum + 1;
        if (Number.isFinite(Number(task.progress))) {
          return sum + Math.max(0, Math.min(1, Number(task.progress) / 100));
        }
        return sum;
      }, 0);
      const doneEquiv = completed.length
        + taskProgressEquiv
        + (hasNumericProgress ? Math.max(0, Math.min(1, Number(detail.percent) / 100)) : 0);
      percent = total ? Math.round(Math.min(100, (doneEquiv / total) * 100)) : 0;
      indeterminate = activeCount > 0
        && !hasNumericProgress
        && !taskActivities.some((task) => Number.isFinite(Number(task.progress)));
    }
    const _tm = this.plugin.tasks._taskMeter;
    const tmTok = _tm ? (Number(_tm.exactTokens) > 0 ? Number(_tm.exactTokens) : Math.round(((Number(_tm.inChars) || 0) + (Number(_tm.outChars) || 0)) / 2)) : 0;
    const tmTokLabel = tokenLabel(tmTok, !!(_tm && _tm.hasExact && Number(_tm.exactTokens) > 0));

    const primaryActivity = taskActivities.find((task) => ["queued", "running", "waiting", "slow", "stalled", "retrying"].includes(String(task.status || "")))
      || taskActivities[0]
      || null;
    const progressStartedAt = detail && Number(detail.startedAt) > 0
      ? Number(detail.startedAt)
      : primaryActivity && Number(primaryActivity.startedAt) > 0
        ? Number(primaryActivity.startedAt)
        : _tm && Number(_tm.startedAt) > 0 ? Number(_tm.startedAt) : 0;
    const elapsedMs = progressStartedAt ? Math.max(0, Date.now() - progressStartedAt) : 0;
    const remainingText = percent > 0 && percent < 100
      ? `${i18nT("Est. remaining ")}${fmtDur(elapsedMs * ((100 - percent) / percent))}`
      : i18nT("Calculating remaining time");
    const timing = head.createDiv({ cls: "qnalog-progress-timing", attr: { "aria-live": "polite" } });
    timing.setText(progressStartedAt ? `已用 ${fmtDur(elapsedMs)} · ${remainingText}` : i18nT("Preparing to process"));

    const phaseText = [
      detail && detail.stage,
      detail && detail.step,
      detail && detail.kind,
      detail && detail.modeLabel,
      primaryActivity && primaryActivity.stageLabel,
      primaryActivity && primaryActivity.title,
    ].filter(Boolean).join(" ").toLowerCase();
    const phase = headActive || pending.length || running.length
      ? (/(transcrib|asr|转写|音频|分段)/i.test(phaseText) ? "transcribe" : "organize")
      : "complete";
    let phaseIndex = { transcribe: 0, organize: 1, complete: 2 }[phase] || 0;
    let pipelineSteps = [
      {
        key: "transcribe",
        label: i18nT("Transcription"),
        summary: detail && detail.count
          ? String(detail.count)
          : running.length || pending.length ? `${running.length + pending.length} 项待处理` : i18nT("Original transcription preserved"),
      },
      {
        key: "organize",
        label: i18nT("AI Organizing"),
        summary: phase === "organize" && taskActive.length ? `${taskActive.length}${i18nT(" in progress")}` : phase === "organize" ? (detail && detail.count ? String(detail.count) : i18nT("Organizing")) : phaseIndex > 1 ? "已完成" : i18nT("Waiting for transcription to complete"),
      },
      {
        key: "complete",
        label: i18nT("Done"),
        summary: phase === "complete" ? "已写入纪要" : i18nT("Write to note"),
      },
    ];
    const detailedStages = detail && Array.isArray(detail.stages) ? detail.stages : [];
    const activeDetailedStage = activePipelineStage
      || detailedStages.find((stage) => stage && stage.status === "active")
      || null;
    const isImportPipeline = detailedStages.some((stage) => stage && stage.id === "transcribe");
    const pipelineLiveness = new Map();
    if (isImportPipeline) {
      const stageById = (id) => detailedStages.find((stage) => stage && stage.id === id) || {};
      const activeId = activeDetailedStage ? String(activeDetailedStage.id || "prepare") : "";
      const allDone = detailedStages.length > 0 && detailedStages.every((stage) => stage && stage.status === "done");
      phaseIndex = allDone
        ? 3
        : activeId === "prepare" ? 0
          : activeId === "transcribe" || activeId === "persist" ? 1
            : activeId === "organize" ? 2 : 3;
      const transcribeStage = stageById("transcribe");
      const persistStage = stageById("persist");
      const organizeStage = stageById("organize");
      const writeStage = stageById("write");
      pipelineLiveness.set("prepare", String(stageById("prepare").liveness || ""));
      pipelineLiveness.set("transcribe", [transcribeStage, persistStage].some((stage) => String(stage.liveness || "") === "failed")
        ? "failed"
        : String((activeId === "persist" ? persistStage : transcribeStage).liveness || ""));
      pipelineLiveness.set("organize", String(organizeStage.liveness || ""));
      pipelineLiveness.set("complete", String(writeStage.liveness || ""));
      pipelineSteps = [
        { key: "prepare", label: i18nT("Prepare"), summary: String(stageById("prepare").summary || i18nT("Read audio")) },
        {
          key: "transcribe",
          label: i18nT("Transcription"),
          summary: String((activeId === "persist" ? persistStage.summary : transcribeStage.summary) || detail.count || i18nT("Queued")),
        },
        { key: "organize", label: i18nT("AI Organizing"), summary: String(organizeStage.summary || i18nT("Waiting for transcription to complete")) },
        { key: "complete", label: i18nT("Done"), summary: String(writeStage.summary || i18nT("Write to note")) },
      ];
    }
    const pipeline = head.createDiv({ cls: `qnalog-progress-pipeline is-${headLiveness}` });
    for (let index = 0; index < pipelineSteps.length; index++) {
      const step = pipelineSteps[index];
      const stepLiveness = pipelineLiveness.get(step.key) || "";
      const state = stepLiveness === "failed"
        ? "failed"
        : index < phaseIndex ? "done" : index === phaseIndex ? (headLiveness === "failed" ? "failed" : "active") : "pending";
      const stepEl = pipeline.createDiv({ cls: `qnalog-progress-pipeline-step is-${state}` });
      const marker = stepEl.createDiv({ cls: "qnalog-progress-pipeline-marker", attr: { "aria-hidden": "true" } });
      if (state === "done") {
        try { obsidian.setIcon(marker, "check"); } catch { marker.setText("✓"); }
      } else if (state === "active") {
        marker.createSpan({ cls: "qnalog-progress-pipeline-pulse" });
      }
      stepEl.createDiv({ cls: "qnalog-progress-pipeline-label", text: step.label });
      stepEl.createDiv({ cls: "qnalog-progress-pipeline-summary", text: step.summary });
    }

    const canAnimateProgress = headActive
      && !["failed", "done"].includes(headLiveness);
    const bar = head.createDiv({ cls: `qnalog-progress-bar is-${headLiveness}` });
    bar.createDiv({
      cls: `qnalog-progress-bar-fill is-${headLiveness}${canAnimateProgress ? " is-active" : ""}`,
    }).style.width = percent + "%";
    if (indeterminate && canAnimateProgress) {
      bar.createDiv({ cls: "qnalog-progress-bar-motion", attr: { "aria-hidden": "true" } });
    }
    const sum = head.createDiv({ cls: "qnalog-progress-summary" });
    sum.createSpan({
      cls: "qnalog-progress-summary-left",
      text: hasStageProgress
        ? `${"# "}${stagePosition.current} / ${stagePosition.total}${i18nT(" · ")}${detail.step || i18nT("Processing")}`
        : `${i18nT("Completed ")}${doneCount} / ${total}`,
    });
    const metaParts = [];
    if (detail && detail.count) metaParts.push(detail.count);
    else if (detail && detail.kind) metaParts.push(detail.kind);
    const activityStartedAt = detail && Number(detail.startedAt) > 0 ? Number(detail.startedAt) : (_tm && _tm.startedAt);
    if (activityStartedAt) metaParts.push(`${i18nT("Elapsed ")}${fmtDur(Date.now() - activityStartedAt)}`);
    if (tmTokLabel) metaParts.push(`${tmTokLabel} token`);
    if (metaParts.length) sum.createSpan({ cls: "qnalog-progress-summary-right", text: metaParts.join(" · ") });

    // —— 任务列表：已完成（✓）→ 处理中（转圈）→ 待处理（脉冲点）——
    const list = contentEl.createDiv({ cls: "qnalog-progress-list" });
    const restoreScrollTop = this._scrollTop;
    list.addEventListener("scroll", () => {
      this._scrollTop = list.scrollTop;
      this._lastScrollAt = Date.now();
    }, { passive: true });
    const makeRow = (kind, extraCls = "") => {
      const r = list.createDiv({ cls: `qnalog-progress-row is-${kind}${extraCls ? " " + extraCls : ""}` });
      return { row: r, ico: r.createDiv({ cls: "qnalog-progress-ico" }), body: r.createDiv({ cls: "qnalog-progress-body" }) };
    };
    const titleLine = (bodyEl, name, right, faint) => {
      const tl = bodyEl.createDiv({ cls: "qnalog-progress-line" });
      tl.createSpan({ cls: `qnalog-progress-name${faint ? " is-faint" : ""}`, text: name });
      if (right) tl.createSpan({ cls: `qnalog-progress-right${faint ? " is-faint" : ""}`, text: right });
    };
    const subLine = (bodyEl, text) => { if (text) bodyEl.createDiv({ cls: "qnalog-progress-sub", text }); };

    if (visibleTaskActivities.length) {
      list.createDiv({ cls: "qnalog-progress-section-title", text: i18nT("Task status") });
      const activityList = list.createDiv({ cls: "qnalog-progress-activity-list" });
      for (const activity of visibleTaskActivities) {
        const state = String(activity.status || "queued");
        const activityId = String(activity.id || "");
        const item = activityList.createEl("details", {
          cls: `qnalog-progress-activity is-${state}`,
        });
        item.open = this._expandedActivities.has(activityId);
        const summaryEl = item.createEl("summary", { cls: "qnalog-progress-activity-summary" });
        summaryEl.onclick = (event) => {
          event.preventDefault();
          if (item.open) {
            this._expandedActivities.delete(activityId);
            this._collapsedActivities.add(activityId);
            item.open = false;
          } else {
            this._expandedActivities.add(activityId);
            this._collapsedActivities.delete(activityId);
            item.open = true;
          }
        };

        const icon = summaryEl.createSpan({ cls: `qnalog-progress-activity-icon is-${state}`, attr: { "aria-hidden": "true" } });
        const iconName = state === "done" ? "circle-check"
          : state === "failed" ? "triangle-alert"
            : state === "retrying" ? "refresh-cw"
              : ["slow", "stalled"].includes(state) ? "clock-3"
                : state === "queued" ? "clock"
                  : state === "waiting" ? "hourglass" : "activity";
        try { obsidian.setIcon(icon, iconName); } catch { icon.setText(state === "failed" ? "!" : ""); }

        const summaryCopy = summaryEl.createSpan({ cls: "qnalog-progress-activity-copy" });
        summaryCopy.createSpan({ cls: "qnalog-progress-activity-title", text: activity.title || i18nT("Background tasks") });
        summaryCopy.createSpan({
          cls: "qnalog-progress-activity-stage",
          text: [activity.stageLabel, activity.count].filter(Boolean).join(" · ") || livenessDetail(state),
        });
        summaryEl.createSpan({ cls: `qnalog-progress-activity-state is-${state}`, text: livenessLabel(state) });

        const panel = item.createDiv({ cls: "qnalog-progress-activity-panel" });
        if (activity.detail) panel.createDiv({ cls: "qnalog-progress-activity-detail", text: activity.detail });

        if (Number.isFinite(Number(activity.progress))) {
          const taskProgress = Math.max(0, Math.min(100, Number(activity.progress)));
          const taskBar = panel.createDiv({ cls: `qnalog-progress-activity-progress is-${state}` });
          taskBar.createDiv({ cls: "qnalog-progress-activity-progress-fill" }).style.width = `${taskProgress}%`;
          panel.createDiv({ cls: "qnalog-progress-activity-progress-label", text: `${Math.round(taskProgress)}%` });
        }

        const facts = [];
        if (Number(activity.startedAt) > 0) facts.push([i18nT("Start"), fmtTime(Number(activity.startedAt))]);
        if (Number(activity.updatedAt) > 0) facts.push([i18nT("Recent activity"), `${fmtDur(Date.now() - Number(activity.updatedAt))}${i18nT(" ago")}`]);
        if (Number(activity.startedAt) > 0 && !["done", "cancelled"].includes(state)) {
          facts.push([i18nT("Running for"), fmtDur(Date.now() - Number(activity.startedAt))]);
        }
        if (Number(activity.retryAt) > Date.now()) facts.push([i18nT("Next retry"), `${fmtDur(Number(activity.retryAt) - Date.now())}${i18nT(" from now")}`]);
        if (Number(activity.attempt) > 0) {
          facts.push([i18nT("Attempts"), activity.maxAttempts > 0
            ? `${activity.attempt}/${activity.maxAttempts}`
            : String(activity.attempt)]);
        }
        if (activity.subject) {
          const subject = String(activity.subject);
          const shortSubject = subject.split(/[\\/]/).pop() || subject;
          facts.push([i18nT("Target"), shortSubject]);
        }
        if (facts.length) {
          const factGrid = panel.createDiv({ cls: "qnalog-progress-activity-facts" });
          for (const [label, value] of facts) {
            const fact = factGrid.createDiv({ cls: "qnalog-progress-activity-fact" });
            fact.createSpan({ cls: "qnalog-progress-activity-fact-label", text: label });
            fact.createSpan({ cls: "qnalog-progress-activity-fact-value", text: value });
          }
        }

        if (activity.error) {
          const errorBox = panel.createDiv({ cls: "qnalog-progress-activity-error", attr: { role: "alert" } });
          const rawError = String(activity.error).trim();
          const displayError = /file already exists|文件已存在|already exists/i.test(rawError)
            ? i18nT("The target version file already exists; not created again.")
            : rawError;
          const isFileExistsError = displayError !== rawError;
          if (rawError && rawError !== displayError) errorBox.setAttr("title", rawError);
          const errorHead = errorBox.createDiv({ cls: "qnalog-progress-activity-error-head" });
          const errorIcon = errorHead.createSpan({ cls: "qnalog-progress-activity-error-icon", attr: { "aria-hidden": "true" } });
          try { obsidian.setIcon(errorIcon, "triangle-alert"); } catch { errorIcon.setText("!"); }
          errorHead.createSpan({ text: i18nT("Processing incomplete") });
          errorBox.createDiv({ cls: "qnalog-progress-activity-error-message", text: displayError });
          const hint = this.plugin.tasks.getTaskActivityErrorHint
            ? this.plugin.tasks.getTaskActivityErrorHint(activity)
            : "";
          if (hint && hint !== displayError && !isFileExistsError) {
            errorBox.createDiv({ cls: "qnalog-progress-activity-error-hint", text: hint });
          }
        }

        if (Array.isArray(activity.events) && activity.events.length) {
          const chain = panel.createDiv({ cls: "qnalog-progress-activity-chain" });
          chain.createDiv({ cls: "qnalog-progress-section-label", text: i18nT("Recent chain") });
          for (const event of activity.events.slice(-5).reverse()) {
            const row = chain.createDiv({ cls: "qnalog-progress-event" });
            row.createSpan({ cls: "qnalog-progress-event-time", text: fmtTime(Number(event.at) || Date.now()) });
            const eventCopy = row.createSpan({ cls: "qnalog-progress-event-copy" });
            eventCopy.createSpan({ cls: "qnalog-progress-event-label", text: String(event.label || i18nT("Status updated")) });
            if (event.detail) eventCopy.createSpan({ cls: "qnalog-progress-event-detail", text: String(event.detail) });
          }
        }

        if (Array.isArray(activity.actions) && activity.actions.length) {
          const actions = panel.createDiv({ cls: "qnalog-progress-activity-actions" });
          for (const action of activity.actions) {
            const button = actions.createEl("button", {
              cls: `qnalog-progress-btn${action.primary ? " mod-cta" : ""}`,
              text: action.label,
              attr: { type: "button" },
            });
            button.onclick = async (event) => {
              event.preventDefault();
              event.stopPropagation();
              button.disabled = true;
              try {
                await this.plugin.tasks.handleTaskActivityAction(activity.id, action.id);
              } finally {
                this.onOpen();
              }
            };
          }
        }
      }
    }

    if (completed.length) list.createDiv({ cls: "qnalog-progress-section-title qnalog-progress-legacy-completed", text: i18nT("Recently completed") });
    for (const c of completed) {
      const { ico, body } = makeRow("done", "qnalog-progress-legacy-completed");
      try { obsidian.setIcon(ico.createSpan({ cls: "qnalog-progress-check" }), "check"); } catch { /* intentionally empty */ }
      const right = [(c.durationMs > 0 ? fmtDur(c.durationMs) : ""), tokenLabel(c.tokens, c.tokensExact)].filter(Boolean).join(" · ");
      titleLine(body, c.title || i18nT("Done"), right, false);
      subLine(body, `${i18nT("Completed")}${c.detail ? " · " + c.detail : ""}${c.at ? " · " + fmtTime(c.at) : ""}`);
    }

    if (active) {
      list.createDiv({ cls: "qnalog-progress-section-title qnalog-progress-legacy-current", text: i18nT("Current task") });
      const { ico, body } = makeRow("running", "qnalog-progress-legacy-current");
      if (activeLiveness === "failed") {
        const stateIcon = ico.createSpan({ cls: `qnalog-progress-task-state is-${activeLiveness}` });
        try { obsidian.setIcon(stateIcon, "triangle-alert"); } catch { stateIcon.setText("!"); }
      } else if (activeLiveness === "done") {
        const stateIcon = ico.createSpan({ cls: "qnalog-progress-task-state is-done" });
        try { obsidian.setIcon(stateIcon, "check"); } catch { stateIcon.setText("✓"); }
      } else {
        ico.createSpan({ cls: `qnalog-progress-spinner is-${activeLiveness}` });
      }
      const sess = this.plugin.session;
      const fileName = sess && sess.mdPath ? String(sess.mdPath).split(/[\\/]/).pop().replace(/\.md$/i, "") : "";
      const name = (detail && detail.sourceFile) || fileName || (detail ? [detail.kind, detail.modeLabel].filter(Boolean).join(" · ") : activityLabel) || i18nT("Processing");
      const detailStartedAt = detail && Number(detail.startedAt) > 0 ? Number(detail.startedAt) : (_tm && _tm.startedAt);
      const right = detailStartedAt ? [fmtDur(Date.now() - detailStartedAt), tmTokLabel].filter(Boolean).join(" · ") : "";
      titleLine(body, name, right, false);
      const stepBase = primaryActivity && primaryActivity.stageLabel
        ? String(primaryActivity.stageLabel)
        : detail ? (detail.step || detail.kind || i18nT("Processing")) : (activityLabel || i18nT("Processing"));
      const currentProgress = primaryActivity && Number.isFinite(Number(primaryActivity.progress))
        ? Number(primaryActivity.progress)
        : detail && Number.isFinite(Number(detail.percent)) ? Number(detail.percent) : null;
      const pctTxt = currentProgress !== null ? `（${Math.round(currentProgress)}%）` : "";
      subLine(body, `${stepBase}${pctTxt}${detail && detail.count ? " · " + detail.count : ""}`);
      if (detail && detail.stepDetail) {
        body.createDiv({ cls: "qnalog-progress-detail", text: detail.stepDetail });
      }

      if (detail) {
        const sourceModeLabel = String(detail.sourceModeLabel || "").trim();
        const targetModeLabel = String(detail.targetModeLabel || detail.modeLabel || "").trim();
        const modeChange = sourceModeLabel
          && sourceModeLabel !== "未标注"
          && targetModeLabel
          && sourceModeLabel !== targetModeLabel
          ? `${sourceModeLabel} → ${targetModeLabel}`
          : "";
        const taskFacts = [
          [i18nT("Source folder"), detail.sourceFolder],
          [i18nT("Audio duration"), Number(detail.durationMs) > 0 ? fmtDur(Number(detail.durationMs)) : ""],
          [i18nT("Mode"), modeChange],
        ].filter(([, value]) => String(value || "").trim());
        if (taskFacts.length) {
          const factGrid = body.createDiv({ cls: "qnalog-progress-current-facts" });
          for (const [label, value] of taskFacts) {
            const fact = factGrid.createDiv({ cls: "qnalog-progress-current-fact" });
            fact.createSpan({ cls: "qnalog-progress-current-fact-label", text: String(label) });
            const factValue = fact.createSpan({ cls: "qnalog-progress-current-fact-value", text: String(value) });
            factValue.setAttr("title", String(value));
          }
        }
      }

      if (detail && Array.isArray(detail.stages) && detail.stages.length) {
        const activeStage = detail.stages.find((stage) => stage && stage.status === "active");
        const activeStageId = activeStage ? String(activeStage.id || "") : "";
        if (activeStageId && activeStageId !== this._lastActiveStage) {
          this._lastActiveStage = activeStageId;
          this._expandedStages.add(activeStageId);
          this._collapsedStages.delete(activeStageId);
        }
        const stages = body.createDiv({
          cls: "qnalog-progress-stages",
          attr: { "aria-label": i18nT("Processing steps") },
        });
        for (let index = 0; index < detail.stages.length; index++) {
          const stage = detail.stages[index];
          const stageId = String(stage.id || `stage-${index}`);
          const stageLiveness = String(stage.liveness || (stage.status === "done" ? "done" : stage.status === "pending" ? "pending" : "running"));
          const item = stages.createEl("details", {
            cls: `qnalog-progress-stage is-${stage.status || "pending"} is-${stageLiveness}`,
          });
          const shouldAutoOpen = stage.status === "active"
            || ["failed", "stalled"].includes(stageLiveness);
          const shouldOpen = this._expandedStages.has(stageId)
            || (shouldAutoOpen && !this._collapsedStages.has(stageId));
          item.open = shouldOpen;
          const summaryEl = item.createEl("summary", { cls: "qnalog-progress-stage-summary" });
          summaryEl.onclick = (event) => {
            event.preventDefault();
            if (item.open) {
              this._expandedStages.delete(stageId);
              this._collapsedStages.add(stageId);
              item.open = false;
            } else {
              this._expandedStages.add(stageId);
              this._collapsedStages.delete(stageId);
              item.open = true;
            }
          };
          const marker = summaryEl.createSpan({ cls: "qnalog-progress-stage-marker", attr: { "aria-hidden": "true" } });
          const iconName = stageLiveness === "done" ? "check"
            : stageLiveness === "failed" ? "triangle-alert"
              : stageLiveness === "retrying" ? "refresh-cw"
                : ["slow", "stalled"].includes(stageLiveness) ? "clock-3" : "";
          if (iconName) {
            try { obsidian.setIcon(marker, iconName); } catch { marker.setText(stageLiveness === "done" ? "✓" : "!"); }
          } else if (stage.status === "active") {
            marker.createSpan({ cls: "qnalog-progress-stage-pulse" });
          } else {
            marker.setText(String(index + 1));
          }
          const stageCopy = summaryEl.createSpan({ cls: "qnalog-progress-stage-copy" });
          stageCopy.createSpan({ cls: "qnalog-progress-stage-label", text: stage.label || `${i18nT("Step ")}${index + 1}` });
          if (stage.summary) stageCopy.createSpan({ cls: "qnalog-progress-stage-summary-text", text: stage.summary });
          summaryEl.createSpan({
            cls: `qnalog-progress-stage-state is-${stageLiveness}`,
            text: livenessLabel(stageLiveness),
          });

          const panel = item.createDiv({ cls: "qnalog-progress-stage-panel" });
          if (stage.detail) panel.createDiv({ cls: "qnalog-progress-stage-description", text: stage.detail });
          const facts = [];
          if (Number(stage.startedAt) > 0) facts.push([i18nT("Start"), fmtTime(Number(stage.startedAt))]);
          if (Number(stage.updatedAt) > 0) facts.push([i18nT("Recent events"), `${fmtDur(Date.now() - Number(stage.updatedAt))}${i18nT(" ago")}`]);
          if (Number(stage.startedAt) > 0 && stage.status === "active") facts.push([i18nT("This stage"), fmtDur(Date.now() - Number(stage.startedAt))]);
          if (facts.length) {
            const factGrid = panel.createDiv({ cls: "qnalog-progress-stage-facts" });
            for (const [factLabel, factValue] of facts) {
              const fact = factGrid.createDiv({ cls: "qnalog-progress-stage-fact" });
              fact.createSpan({ cls: "qnalog-progress-stage-fact-label", text: factLabel });
              fact.createSpan({ cls: "qnalog-progress-stage-fact-value", text: factValue });
            }
          }

          if (Array.isArray(stage.requests) && stage.requests.length) {
            const requestSection = panel.createDiv({ cls: "qnalog-progress-requests" });
            requestSection.createDiv({ cls: "qnalog-progress-section-label", text: i18nT("Segment requests") });
            const requestList = requestSection.createDiv({ cls: "qnalog-progress-request-list" });
            for (const request of stage.requests) {
              const requestState = String(request.liveness || "pending");
              const requestRow = requestList.createDiv({ cls: `qnalog-progress-request is-${requestState}` });
              const requestHead = requestRow.createDiv({ cls: "qnalog-progress-request-head" });
              requestHead.createSpan({
                cls: "qnalog-progress-request-title",
                text: `${"# "}${Number(request.chunkIndex) + 1}/${Math.max(1, Number(request.chunkCount) || 1)}${i18nT(" segments")}`,
              });
              const attemptText = Number(request.attempt) > 0
                ? `${"# "}${Number(request.attempt)}/${Math.max(Number(request.attempt), Number(request.maxAttempts) || 1)}${i18nT(" times")}`
                : "";
              if (attemptText) requestHead.createSpan({ cls: "qnalog-progress-request-attempt", text: attemptText });
              requestHead.createSpan({
                cls: `qnalog-progress-request-state is-${requestState}`,
                text: livenessLabel(requestState),
              });
              const requestMeta = [];
              if (Number(request.startedAt) > 0 && !["pending", "done"].includes(requestState)) {
                requestMeta.push(`${i18nT("Waiting ")}${fmtDur(Date.now() - Number(request.startedAt))}`);
              }
              if (Number(request.receivedChars) > 0) requestMeta.push(`${i18nT("Received about ")}${Number(request.receivedChars)}${i18nT(" characters")}`);
              if (Number(request.retryAt) > Date.now()) requestMeta.push(`${fmtDur(Number(request.retryAt) - Date.now())}${i18nT(" to retry")}`);
              if (Number(request.deadlineAt) > 0 && !["done", "failed", "retrying"].includes(requestState)) {
                const deadlineDelta = Number(request.deadlineAt) - Date.now();
                requestMeta.push(deadlineDelta >= 0
                  ? i18nT("Expected back within {0}").replace("{0}", fmtDur(deadlineDelta))
                  : `${i18nT("Taking longer than expected by ")}${fmtDur(Math.abs(deadlineDelta))}`);
              }
              if (requestMeta.length) requestRow.createDiv({ cls: "qnalog-progress-request-meta", text: requestMeta.join(" · ") });
              if (request.error) requestRow.createDiv({ cls: "qnalog-progress-request-error", text: String(request.error) });
            }
          }

          if (Array.isArray(stage.events) && stage.events.length) {
            const hiddenEventLabels = new Set([
              i18nT("Start speech transcription"),
              i18nT("Uploading audio"),
              i18nT("Submitting transcription task"),
            ]);
            const visibleEvents = stage.events.filter((event, index, events) => {
              if (hiddenEventLabels.has(String(event.label || "").trim())) return false;
              const next = events[index + 1];
              if (!next) return true;
              return String(event.type || "") !== String(next.type || "")
                || String(event.label || "") !== String(next.label || "")
                || String(event.detail || "") !== String(next.detail || "");
            });
            if (visibleEvents.length) {
              const eventSection = panel.createDiv({ cls: "qnalog-progress-events" });
              eventSection.createDiv({ cls: "qnalog-progress-section-label", text: i18nT("Recent events") });
              for (const event of visibleEvents.slice(-10).reverse()) {
                const eventRow = eventSection.createDiv({ cls: "qnalog-progress-event" });
                eventRow.createSpan({ cls: "qnalog-progress-event-time", text: fmtTime(Number(event.at) || Date.now()) });
                const eventCopy = eventRow.createSpan({ cls: "qnalog-progress-event-copy" });
                eventCopy.createSpan({ cls: "qnalog-progress-event-label", text: String(event.label || i18nT("Status updated")) });
                if (event.detail) eventCopy.createSpan({ cls: "qnalog-progress-event-detail", text: String(event.detail) });
              }
            }
          }
        }
      }

      if (detail && String(detail.liveness || "running") !== "running") {
        const now = Date.now();
        const stageStartedAt = Number(detail.stageStartedAt) || Number(detail.startedAt) || 0;
        const updatedAt = Number(detail.updatedAt) || stageStartedAt;
        const liveState = String(detail.liveness || "running");
        const live = body.createDiv({ cls: `qnalog-progress-live is-${liveState}` });
        const liveIcon = live.createSpan({ cls: "qnalog-progress-live-icon", attr: { "aria-hidden": "true" } });
        const liveIconName = liveState === "done" ? "circle-check"
          : liveState === "failed" ? "triangle-alert"
            : liveState === "retrying" ? "refresh-cw"
              : ["slow", "stalled"].includes(liveState) ? "clock-3" : "activity";
        try { obsidian.setIcon(liveIcon, liveIconName); } catch { /* intentionally empty */ }
        const liveParts = [];
        if (stageStartedAt) liveParts.push(`${i18nT("This step has been running ")}${fmtDur(now - stageStartedAt)}`);
        if (updatedAt) liveParts.push(`${i18nT("Latest event ")}${fmtDur(now - updatedAt)}${i18nT(" ago")}`);
        const liveCopy = live.createSpan({ cls: "qnalog-progress-live-copy" });
        liveCopy.createSpan({ cls: "qnalog-progress-live-title", text: livenessLabel(liveState) });
        liveCopy.createSpan({
          cls: "qnalog-progress-live-text",
          text: [livenessDetail(liveState), liveParts.join(" · ")].filter(Boolean).join(" · "),
        });
        if (detail.backgroundHint) {
          body.createDiv({ cls: "qnalog-progress-background-hint", text: detail.backgroundHint });
        }
      }
    }

    if (running.length || pending.length) {
      const queueHead = list.createDiv({ cls: "qnalog-progress-queue-head" });
      const queueTitle = queueHead.createDiv({ cls: "qnalog-progress-queue-title" });
      queueTitle.createSpan({ text: i18nT("Queued") });
      queueTitle.createSpan({ cls: "qnalog-progress-queue-count", text: ` ${pending.length}${i18nT(" items · all audio preserved")}` });
      if (pending.length) {
        const retryAllBtn = queueHead.createEl("button", { cls: "qnalog-progress-queue-retry", text: i18nT("Retry all"), attr: { type: "button" } });
        retryAllBtn.onclick = async () => { retryAllBtn.disabled = true; await this.plugin.queueRetry.retryQueue(); this.onOpen(); };
      }
    }
    for (const t of running) {
      const { ico, body } = makeRow("running", "qnalog-progress-queue-row");
      ico.createSpan({ cls: "qnalog-progress-spinner" });
      titleLine(body, taskTitle(t), "", false);
      subLine(body, t.status === "live" ? `切片已落盘 · ${t.mdPath || "等待本场转写"}` : (t.mdPath || ""));
    }

    for (const t of pending) {
      const { row, ico, body } = makeRow("pending", "qnalog-progress-queue-row");
      ico.createSpan({ cls: "qnalog-progress-dot" });
      titleLine(body, taskTitle(t), "", false);
      subLine(body, `${t.lastError || i18nT("Waiting for the next attempt")}${i18nT(" · tried ")}${t.retries || 0}${i18nT(" times")}`);
      const acts = row.createDiv({ cls: "qnalog-progress-queue-actions" });
      const retryBtn = acts.createEl("button", { cls: "qnalog-progress-queue-retry", attr: { type: "button" }, text: i18nT("Retry") });
      retryBtn.onclick = async () => { try { await this.plugin.queue.processOne(t); } catch { /* intentionally empty */ } this.onOpen(); };
      const delBtn = acts.createEl("button", { cls: "qnalog-progress-queue-cancel", attr: { type: "button" }, text: i18nT("Cancel") });
      delBtn.onclick = async () => {
        await this.plugin.queue.remove(t.id);
        new obsidian.Notice(i18nT("Automatic retry cancelled. The cached audio is kept for now; you can still restart it from the note's context menu later."), 6000);
        this.onOpen();
      };
    }

    // —— 底部操作 ——
    const foot = contentEl.createDiv({ cls: "qnalog-progress-foot" });
    if (tmTokLabel) foot.createSpan({ cls: "qnalog-progress-foot-token", text: `${tmTokLabel} token` });
    const footActions = foot.createDiv({ cls: "qnalog-progress-foot-actions" });
    const logBtn = footActions.createEl("button", { cls: "qnalog-progress-foot-link", attr: { type: "button" }, text: i18nT("View log") });
    logBtn.onclick = async () => { try { await this.plugin.diagnostics.copyDiagnosticReport(); } catch { /* intentionally empty */ } };
    const backgroundBtn = footActions.createEl("button", { cls: "qnalog-progress-foot-link is-primary", attr: { type: "button" }, text: i18nT("Run in background") });
    backgroundBtn.onclick = () => this.close();
    if (pending.length) {
      const clearBtn = footActions.createEl("button", { cls: "qnalog-progress-foot-link", attr: { type: "button" }, text: i18nT("Cancel all") });
      clearBtn.onclick = async () => {
        const n = this.plugin.queue.tasks.filter((t) => t && t.status !== "running" && t.status !== "live").length;
        const ok = await qnalogConfirm(this.app, i18nT("Cancel all automatic retries?"),
          `${i18nT("After cancelling, these ")}${n}${i18nT(" tasks will no longer retry automatically, and the corresponding minutes will stay in their current state. Cached audio is kept for now; tasks already processing are unaffected.")}`,
          i18nT("Cancel retry"));
        if (!ok) return;
        const cancellable = this.plugin.queue.tasks.filter((t) => t && t.status !== "running" && t.status !== "live");
        for (const task of cancellable) {
          await this.plugin.queue.remove(task.id);
        }
        this.plugin.tasks.renderStatusBar();
        this.onOpen();
      };
    }

    // 在所有动态内容插入后再恢复滚动位置。提前设置时列表高度仍为 0，浏览器会把位置夹回顶部。
    window.requestAnimationFrame(() => {
      if (!list.isConnected) return;
      const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
      list.scrollTop = Math.min(restoreScrollTop, maxScrollTop);
    });

    // 处理中定时刷新；用户正在滚动时暂停重建，避免内容在手指/滚轮下跳动。
    if (active || running.length || taskActive.length) {
      this._activityTimer = window.setInterval(() => {
        if (Date.now() - this._lastScrollAt < 900) return;
        try { this.onOpen(); } catch { /* intentionally empty */ }
      }, 1200);
    }
  }
  onClose() {
    if (this._activityTimer) { window.clearInterval(this._activityTimer); this._activityTimer = null; }
    this.contentEl.empty();
  }
}

export class VirtualCableSetupModal extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.activePlatform = this.detectPlatform();
  }
  detectPlatform() {
    const p = getDesktopProcess()?.platform || "";
    if (p === "darwin") return "mac";
    if (p === "win32") return "win";
    return "linux";
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("qnalog-vcable-modal");

    contentEl.createEl("h2", { text: i18nT("Computer audio capture settings") });
    const desc = contentEl.createEl("p", { cls: "qnalog-vcable-desc" });
    desc.setText(i18nT("Q&A Log cannot listen directly to sound playing through your headphones or speakers. To record from a browser, a course, or the other side of a meeting, route that sound to a virtual audio device so Q&A Log recognizes it as computer-audio input, and monitor the same sound to your real speakers or headphones so you can still hear it. Configure once and it keeps working."));

    // 平台 tabs
    const tabs = contentEl.createDiv({ cls: "qnalog-vcable-tabs" });
    const platforms = [
      ["mac", "macOS"],
      ["win", "Windows"],
      ["linux", "Linux"],
    ];
    const tabBtns = {};
    for (const [k, label] of platforms) {
      const b = tabs.createEl("button", { text: label, cls: "qnalog-vcable-tab" });
      if (k === this.activePlatform) b.addClass("is-active");
      b.onclick = () => {
        this.activePlatform = k;
        for (const key in tabBtns) tabBtns[key].removeClass("is-active");
        b.addClass("is-active");
        this.renderContent();
      };
      tabBtns[k] = b;
    }
    this.tabBtns = tabBtns;
    this.contentBox = contentEl.createDiv({ cls: "qnalog-vcable-content" });
    this.renderContent();

    // 底部操作
    const actions = contentEl.createDiv({ cls: "modal-button-container qnalog-vcable-actions" });
    const closeBtn = actions.createEl("button", { text: i18nT("Close") });
    closeBtn.onclick = () => this.close();
    const recheckBtn = actions.createEl("button", { text: i18nT("Detect again"), cls: "mod-cta" });
    recheckBtn.onclick = async () => {
      // 用户点了「重新检测」，要设备名才能报出检测到哪些设备，申请权限是预期的。
      const info = await enumerateAudioDevices({ requestPermission: true });
      if (info.virtualCables.length > 0) {
        const labels = info.virtualCables.map(d => d.label).join("、");
        new obsidian.Notice(`${i18nT("Computer audio input detected:")}${labels}`);
        this.close();
      } else {
        new obsidian.Notice(i18nT("No computer audio input detected yet; make sure a virtual audio device is installed and restart Obsidian."));
      }
    };
  }
  renderContent() {
    this.contentBox.empty();
    if (this.activePlatform === "mac")   this.renderMacContent(this.contentBox);
    else if (this.activePlatform === "win") this.renderWinContent(this.contentBox);
    else this.renderLinuxContent(this.contentBox);
  }
  step(parent, n, title, body) {
    const s = parent.createDiv({ cls: "qnalog-vcable-step" });
    const head = s.createDiv({ cls: "qnalog-vcable-step-head" });
    head.createSpan({ text: `Step ${n}`, cls: "qnalog-vcable-step-num" });
    head.createSpan({ text: title, cls: "qnalog-vcable-step-title" });
    const b = s.createDiv({ cls: "qnalog-vcable-step-body" });
    if (typeof body === "function") body(b);
    else b.appendChild(obsidian.sanitizeHTMLToDom(String(body == null ? "" : body)));
    return s;
  }
  renderMacContent(parent) {
    this.step(parent, 1, i18nT("Install BlackHole (open source, free)"), (b) => {
      b.createEl("p", { text: i18nT("BlackHole 2ch is recommended (the stereo version is enough for meetings).") });
      const ul = b.createEl("ul");
      const li1 = ul.createEl("li");
      li1.createSpan({ text: i18nT("Download page:") });
      const a1 = li1.createEl("a", { text: "existential.audio/blackhole/", href: "https://existential.audio/blackhole/" });
      a1.target = "_blank";
      const li2 = ul.createEl("li");
      li2.createSpan({ text: i18nT("Or use Homebrew:") });
      li2.createEl("code", { text: "brew install blackhole-2ch" });
    });
    this.step(parent, 2, i18nT("Create Multi-Output Device"), (b) => {
      const ol = b.createEl("ol");
      ol.createEl("li", { text: i18nT("Launchpad → Audio MIDI Setup") });
      ol.createEl("li", { text: i18nT("Bottom-left \"+\" → Create Multi-Output Device") });
      ol.createEl("li", { text: i18nT("Check \"Built-in Speakers\" (or headphones) + \"BlackHole 2ch\"") });
      ol.createEl("li", { text: i18nT("For Master Device select your headphones or speakers; check Drift Correction for BlackHole") });
      const tip = b.createEl("p", { cls: "qnalog-vcable-tip" });
      tip.setText(i18nT("This makes system audio go to both your real speakers/headphones and BlackHole: the former for playback, the latter for Q&A Log to record."));
    });
    this.step(parent, 3, i18nT("Switch system or app output to this multi-output device"), (b) => {
      const ol = b.createEl("ol");
      ol.createEl("li", { text: i18nT("System Settings → Sound → Output") });
      ol.createEl("li", { text: i18nT("Select the \"Multi-Output Device\" you just created") });
      ol.createEl("li", { text: i18nT("Browser videos and most desktop video clients usually follow the system output; if meeting software has a separate speaker setting, also change it to this multi-output device") });
      const warn = b.createEl("p", { cls: "qnalog-vcable-warn" });
      warn.setText(i18nT("Meeting apps may need you to reselect the speaker after switching."));
    });
    this.step(parent, 4, i18nT("Select computer audio mode in Q&A Log"), (b) => {
      b.createEl("p", { text: i18nT("Choose \"Computer audio only\" when processing only videos, courses, or podcasts; choose \"Microphone + computer audio\" for online meetings or when explaining while listening.") });
    });
  }
  renderWinContent(parent) {
    this.step(parent, 1, i18nT("Install VB-Cable (free)"), (b) => {
      b.createEl("p", { text: i18nT("Download:") });
      const a = b.createEl("a", { text: "https://vb-audio.com/Cable/", href: "https://vb-audio.com/Cable/" });
      a.target = "_blank";
      const ol = b.createEl("ol");
      ol.createEl("li", { text: i18nT("Download the VB-Cable Driver Pack and unzip it") });
      ol.createEl("li", { text: i18nT("Right-click VBCABLE_Setup_x64.exe → Run as administrator") });
      ol.createEl("li", { text: i18nT("Click Install Driver → restart your computer") });
    });
    this.step(parent, 2, i18nT("Switch the audio you want to record to CABLE Input (playback device)"), (b) => {
      b.createEl("p", { text: i18nT("For online meetings, change the speaker in the audio settings of Feishu, Tencent Meeting, or Zoom; for desktop apps such as the Bilibili client, browser video, and media players, you can set the output device individually in the Windows volume mixer. Change the target output uniformly to:") });
      b.createEl("code", { text: "CABLE Input (VB-Audio Virtual Cable)" });
      b.createEl("p", { cls: "qnalog-vcable-tip" }).setText(i18nT("Note: CABLE Input is selected here. Although its name says Input, in Windows it is a playback/output device; Q&A Log records later from CABLE Output at the other end of the same virtual cable."));
      const ol = b.createEl("ol");
      ol.createEl("li", { text: i18nT("Recording meetings: select CABLE Input as the speaker/output device in your meeting app") });
      ol.createEl("li", { text: i18nT("Recording the Bilibili client: play a video first so the app appears in the volume mixer; Windows Settings → System → Sound → Volume mixer → find 哔哩哔哩/bilibili → select CABLE Input as the output device") });
      ol.createEl("li", { text: i18nT("Recording a browser: likewise find browsers such as Chrome, Edge, and Firefox in the volume mixer → select CABLE Input as the output device") });
      ol.createEl("li", { text: i18nT("Recording all system audio: change the system default output device directly to CABLE Input") });
      const warn = b.createEl("p", { cls: "qnalog-vcable-warn" });
      warn.setText(i18nT("This step temporarily stops system audio playing through your real headphones/speakers; listening is restored by the next step."));
    });
    this.step(parent, 3, i18nT("Use CABLE Output to monitor through your real speakers or headphones (important)"), (b) => {
      b.createEl("p", { text: i18nT("To restore local monitoring, monitor CABLE Output through your real headphones or speakers:") });
      const ol = b.createEl("ol");
      ol.createEl("li", { text: i18nT("Open: Control Panel → Sound → Recording (or right-click the taskbar speaker icon → Sound settings → More sound settings)") });
      ol.createEl("li", { text: i18nT("Find CABLE Output") });
      ol.createEl("li", { text: i18nT("Double-click → switch to the \"Listen\" tab") });
      ol.createEl("li", { text: i18nT("Check \"Listen to this device\"") });
      ol.createEl("li", { text: i18nT("Under \"Playback through this device\", choose your real headphones or speakers, not CABLE Input") });
      ol.createEl("li", { text: i18nT("Click \"Apply\"") });
      const tip = b.createEl("p", { cls: "qnalog-vcable-tip" });
      tip.setText(i18nT("The audio path is: app/browser → CABLE Input (playback) → CABLE Output (recording input, read by Q&A Log) → monitored to real headphones/speakers. If monitoring latency is noticeable, use a mixer such as VoiceMeeter for multiple outputs."));
    });
    this.step(parent, 4, i18nT("Switch the default input back to the real microphone"), (b) => {
      const ol = b.createEl("ol");
      ol.createEl("li", { text: i18nT("Windows Settings → System → Sound → Input") });
      ol.createEl("li", { text: i18nT("Select the real microphone, not CABLE Output") });
      ol.createEl("li", { text: i18nT("If other voice input software also has no sound, this is usually because it was changed to CABLE Output here") });
      const warn = b.createEl("p", { cls: "qnalog-vcable-warn" });
      warn.setText(i18nT("CABLE Output is what recording apps like Q&A Log read to capture computer audio; it is not suitable as your everyday microphone."));
    });
    this.step(parent, 5, i18nT("Select computer audio mode in Q&A Log"), (b) => {
      b.createEl("p", { text: i18nT("When watching Bilibili, YouTube, courses or podcasts, choose \"Computer audio only\"; for online meetings, or when you also need to record your own commentary, choose \"Microphone + computer audio\".") });
    });
  }
  renderLinuxContent(parent) {
    this.step(parent, 1, i18nT("PulseAudio: use the monitor source"), (b) => {
      b.createEl("p", { text: i18nT("Every real output device in PulseAudio comes with its own monitor source. Keep the system output on your headphones/speakers and select the corresponding Monitor of ... input in Q&A Log to play and record system audio at the same time.") });
      b.createEl("p", { text: i18nT("View available monitor source:") });
      const code = b.createEl("pre");
      code.createEl("code", { text: "pactl list sources short | grep monitor" });
    });
    this.step(parent, 2, i18nT("If using PipeWire (newer distributions)"), (b) => {
      b.createEl("p", { text: i18nT("PipeWire is compatible with the PulseAudio API, and the commands are the same. If the default monitor does not work, you can install pavucontrol and, on the “Recording” tab, switch the Q&A Log input to Monitor of <speaker name>.") });
    });
    this.step(parent, 3, i18nT("Select computer audio mode in Q&A Log"), (b) => {
      b.createEl("p", { text: i18nT("Q&A Log's device detection recognizes inputs named \"Monitor of ...\" as computer audio input. Choose \"Computer audio only\" when you only organize videos/courses; choose \"Microphone + computer audio\" when you also need to record your own voice.") });
    });
  }
  onClose() {
    this.contentEl.empty();
  }
}

export class PromptTemplateModal extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.editingId = null;
  }

  builtInModes() {
    return getBuiltInVisiblePolishModeKeys(this.plugin.settings);
  }

  newCustomScene(seed, baseMode, prompt) {
    const id = makeCustomPromptModeId(seed || "prompt");
    return {
      id,
      mode: id,
      name: seed || i18nT("New custom prompt"),
      description: "",
      baseMode: baseMode || "learning",
      prompt: prompt || [
        i18nT("You are a professional recording organizer. Following the rules below, turn the raw transcript into a Markdown note ready to save to Obsidian."),
        "",
        i18nT("Please complete this prompt first:"),
        i18nT("- Use case: explain what kind of task this recording usually comes from and who will keep using these notes."),
        i18nT("- Key content: explain which information must be identified, such as facts, conclusions, to-dos, risks, disputes, key verbatim quotes, terminology and foreign-language content; to-dos / action items must be output as `- [ ]` todo tasks."),
        i18nT("- Must output: explain which parts the final note must contain and which overly templated content should not appear."),
        i18nT("- To-do syntax: if there are to-dos, always write them as `- [ ] Item: <specific action>`; when it can be determined, add `Owner: <person>` and `Due: <time>` (omit the field if it cannot be determined, and do not write \"not mentioned\"); do not write them as a table or an ordinary list."),
        i18nT("- Writing requirements: specify the tone, level of detail, whether to translate, whether to keep the original text, and how to handle uncertain information."),
        i18nT("- Anti-hallucination: do not invent information that does not appear in the transcript, and mark anything uncertain as uncertain."),
        "",
        i18nT("Original transcription:"),
        "{{TRANSCRIPT}}"
      ].join("\n"),
      isBuiltin: false,
      customMode: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async saveScene(tpl, activate) {
    const clean = sanitizePromptTemplate(tpl, tpl && tpl.baseMode);
    this.plugin.settings.promptTemplates = Object.assign({}, this.plugin.settings.promptTemplates || {}, { [clean.id]: clean });
    this.plugin.settings.activeTemplateByMode = Object.assign({}, this.plugin.settings.activeTemplateByMode || {}, { [clean.id]: clean.id });
    if (activate) this.plugin.settings.polishMode = clean.id;
    await this.plugin.saveSettings();
    return clean;
  }

  getBuiltinOverride(mode) {
    const tpls = this.plugin.settings.promptTemplates || {};
    const activeId = (this.plugin.settings.activeTemplateByMode || {})[mode];
    const tpl = activeId && tpls[activeId];
    if (tpl && tpl.prompt && tpl.prompt.trim() && !isCustomPromptModeTemplate(tpl)) return tpl;
    return null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("qnalog-tpl-modal");
    contentEl.createEl("h2", { text: this.editingId ? "编辑提示词" : i18nT("1 (most stable)") });

    const desc = contentEl.createDiv({ cls: "setting-item-description qnalog-tpl-desc" });
    desc.setText(i18nT("This is where refinement rules are managed. Built-in prompts get you started quickly; create a custom prompt and set it as default when you need a fixed format, professional judgement, or a long-running workflow."));

    const body = contentEl.createDiv({ cls: "qnalog-tpl-body" });
    if (this.editingId) this.renderEditor(body, this.editingId);
    else this.renderList(body);
  }

  renderList(body) {
    const defaultMode = getEffectivePolishMode(this.plugin.settings, this.plugin.settings.polishMode, "meeting");
    const defaultMeta = getModeMeta(this.plugin.settings, defaultMode);
    const toolbar = body.createDiv({ cls: "qnalog-tpl-toolbar" });
    toolbar.createDiv({ cls: "qnalog-tpl-current", text: i18nT("Current default:") + (defaultMeta.prefix || defaultMeta.label || defaultMode) });
    const createBtn = toolbar.createEl("button", { text: i18nT("New custom prompt"), cls: "mod-cta" });
    createBtn.onclick = async () => {
      const tpl = this.newCustomScene(i18nT("New custom prompt"), "learning");
      await this.saveScene(tpl, true);
      this.editingId = tpl.id;
      this.onOpen();
    };

    const builtInSection = body.createDiv({ cls: "qnalog-tpl-section" });
    builtInSection.createDiv({ cls: "qnalog-tpl-section-title", text: i18nT("Built-in prompts") });
    builtInSection.createDiv({ cls: "qnalog-tpl-section-copy", text: i18nT("A default organizing rule provided by Q&A Log, suitable for setting as the default. When you need a fixed format or domain judgment, create a custom prompt instead.") });
    const list = builtInSection.createDiv({ cls: "qnalog-tpl-list" });
    for (const mode of this.builtInModes()) this.renderBuiltinRow(list, mode);

    const customSection = body.createDiv({ cls: "qnalog-tpl-section" });
    customSection.createDiv({ cls: "qnalog-tpl-section-title", text: i18nT("Custom prompt") });
    customSection.createDiv({ cls: "qnalog-tpl-section-copy", text: i18nT("Every custom prompt appears in the recording, audio import, and re-organize menus, and can also be set as default.") });
    const customList = customSection.createDiv({ cls: "qnalog-tpl-list" });
    const customs = getCustomPromptModeTemplates(this.plugin.settings);
    if (!customs.length) customList.createDiv({ cls: "qnalog-tpl-empty", text: i18nT("No custom prompts yet. Click the button above to create one.") });
    for (const tpl of customs) this.renderCustomRow(customList, tpl);
  }

  renderBuiltinRow(list, mode) {
    const meta = getModeMeta(this.plugin.settings, mode);
    const row = list.createDiv({ cls: "qnalog-tpl-row" });
    if (this.plugin.settings.polishMode === mode) row.addClass("is-active");
    const pill = row.createDiv({ cls: "qnalog-tpl-mode-pill" });
    setModePillIcon(pill, meta);
    pill.setAttr("aria-hidden", "true");
    const text = row.createDiv({ cls: "qnalog-tpl-row-meta" });
    text.createDiv({ cls: "qnalog-tpl-row-name", text: i18nT(meta.label || meta.prefix || mode) });
    const override = this.getBuiltinOverride(mode);
    const state = override ? "当前使用旧版自定义规则。" : i18nT("Built-in prompts");
    text.createDiv({ cls: "qnalog-tpl-row-sub", text: i18nT(meta.goal || "") + " · " + state });

    const actions = row.createDiv({ cls: "qnalog-tpl-row-actions" });
    const defaultBtn = actions.createEl("button", { text: this.plugin.settings.polishMode === mode ? "已默认" : i18nT("Set as default") });
    defaultBtn.onclick = async () => {
      this.plugin.settings.polishMode = mode;
      await this.plugin.saveSettings();
      this.onOpen();
    };
  }

  renderCustomRow(list, tpl) {
    const meta = getModeMeta(this.plugin.settings, tpl.id);
    const baseMeta = getModeMeta(this.plugin.settings, tpl.baseMode || "learning");
    const row = list.createDiv({ cls: "qnalog-tpl-row" });
    if (this.plugin.settings.polishMode === tpl.id) row.addClass("is-active");
    const pill = row.createDiv({ cls: "qnalog-tpl-mode-pill" });
    setModePillIcon(pill, meta, baseMeta);
    pill.setAttr("aria-hidden", "true");
    const text = row.createDiv({ cls: "qnalog-tpl-row-meta" });
    text.createDiv({ cls: "qnalog-tpl-row-name", text: tpl.name || i18nT("Custom prompt") });
    const updated = tpl.updatedAt && window.moment ? window.moment(tpl.updatedAt).format("YYYY-MM-DD HH:mm") : i18nT("Not recorded");
    text.createDiv({ cls: "qnalog-tpl-row-sub", text: i18nT("Custom · Updated on ") + updated });

    const actions = row.createDiv({ cls: "qnalog-tpl-row-actions" });
    const defaultBtn = actions.createEl("button", { text: this.plugin.settings.polishMode === tpl.id ? "已默认" : i18nT("Set as default") });
    defaultBtn.onclick = async () => {
      this.plugin.settings.polishMode = tpl.id;
      await this.plugin.saveSettings();
      this.onOpen();
    };
    const editBtn = actions.createEl("button", { text: i18nT("Edit") });
    editBtn.onclick = () => { this.editingId = tpl.id; this.onOpen(); };
    const delBtn = actions.createEl("button", { text: i18nT("Delete") });
    delBtn.addClass("mod-warning");
    delBtn.onclick = async () => {
      const ok = await qnalogConfirm(this.app, i18nT("Delete custom prompt"), i18nT("Delete custom prompt \"") + (tpl.name || tpl.id) + i18nT("\"? This action cannot be undone."), i18nT("Delete"));
      if (!ok) return;
      const tpls = Object.assign({}, this.plugin.settings.promptTemplates || {});
      delete tpls[tpl.id];
      const active = Object.assign({}, this.plugin.settings.activeTemplateByMode || {});
      delete active[tpl.id];
      this.plugin.settings.promptTemplates = tpls;
      this.plugin.settings.activeTemplateByMode = active;
      if (this.plugin.settings.polishMode === tpl.id) this.plugin.settings.polishMode = "learning";
      await this.plugin.saveSettings();
      this.onOpen();
    };
  }

  async optimizePromptDraft(tpl, draft) {
    const current = String(draft || "").trim();
    const seed = current || this.newCustomScene(tpl && tpl.name ? tpl.name : i18nT("Custom prompt"), tpl && tpl.baseMode ? tpl.baseMode : "learning").prompt;
    const sys = i18nT("You are a prompt optimization expert, specializing in rewriting user drafts into a stable, clear, and executable prompt for organizing recording transcripts.");
    const user = [
      i18nT("Please optimize the following Q&A Log transcription cleanup prompt."),
      "",
      i18nT("Requirements:"),
      i18nT("- Output only the complete optimized Prompt, with no explanation and no code blocks."),
      i18nT("- The {{TRANSCRIPT}} placeholder must be kept."),
      i18nT("- Specify the use case, key content, required output, writing style, translation requirements and anti-hallucination boundaries."),
      i18nT("- Do not force in a large number of callouts; structure is fine, but the body text should stay close to what was actually discussed."),
      i18nT("- Make it directly usable for recording, importing and re-organizing right after the user saves it."),
      "",
      i18nT("1. Open system settings and allow Obsidian to access the microphone.") + ((tpl && tpl.name) || i18nT("Custom prompt")),
      "",
      i18nT("Current draft:"),
      seed,
    ].join("\n");
    let result = await callLlm(this.plugin, sys, user);
    result = String(result || "").trim().replace(/^```(?:markdown|md|text)?\s*/i, "").replace(/```$/i, "").trim();
    if (!result.includes("{{TRANSCRIPT}}")) {
      result += i18nT("\n\nOriginal transcript:\n{{TRANSCRIPT}}");
    }
    return result;
  }

  renderEditor(body, id) {
    const tpls = this.plugin.settings.promptTemplates || {};
    const tpl = tpls[id];
    if (!tpl || !isCustomPromptModeTemplate(tpl)) {
      this.editingId = null;
      this.onOpen();
      return;
    }

    const back = body.createDiv({ cls: "qnalog-tpl-back" });
    const backBtn = back.createEl("button", { text: i18nT("Back to list") });
    backBtn.onclick = () => { this.editingId = null; this.onOpen(); };
    back.createSpan({ cls: "qnalog-tpl-builtin-tag", text: i18nT("Custom") });

    const editor = body.createDiv({ cls: "qnalog-tpl-editor" });
    new obsidian.Setting(editor).setName(i18nT("Prompt Name"))
      .setDesc(i18nT("This name appears in the Recording, Import Audio, and Re-polish menus."))
      .addText(t => {
        t.setValue(tpl.name || "");
        t.onChange(v => { tpl.name = v || i18nT("Custom prompt"); });
      });

    const promptSetting = new obsidian.Setting(editor).setName(i18nT("Prompt Content"));
    promptSetting.setDesc(i18nT("This is the polishing rule actually sent to the LLM. The content should define the use case, the key content, the required output, the writing style, translation requirements, and anti-hallucination boundaries, and must keep {{TRANSCRIPT}} as the placeholder for the raw transcript."));
    const ta = editor.createEl("textarea", { cls: "qnalog-textarea qnalog-textarea-mono qnalog-tpl-textarea" });
    ta.value = tpl.prompt || "";
    ta.placeholder = i18nT("For example: this prompt is for…; focus on identifying…; must output…; do not output…; foreign-language content…; uncertain information…; and finally keep {{TRANSCRIPT}}.");
    ta.rows = 18;
    ta.addEventListener("input", () => { tpl.prompt = ta.value; });

    const actions = editor.createDiv({ cls: "qnalog-tpl-edit-actions" });
    const cancelBtn = actions.createEl("button", { text: i18nT("Cancel") });
    cancelBtn.onclick = () => { this.editingId = null; this.onOpen(); };
    const optimizeBtn = actions.createEl("button", { text: i18nT("AI refine prompt") });
    optimizeBtn.onclick = async () => {
      try {
        optimizeBtn.disabled = true;
        optimizeBtn.setText(i18nT("Refining…"));
        const optimized = await this.optimizePromptDraft(tpl, ta.value);
        ta.value = optimized;
        tpl.prompt = optimized;
        new obsidian.Notice(i18nT("Refined draft generated; review it before saving"));
      } catch (e) {
        console.error(e);
        new obsidian.Notice(i18nT("AI optimization failed:") + ((e && e.message) || e));
      } finally {
        optimizeBtn.disabled = false;
        optimizeBtn.setText(i18nT("AI refine prompt"));
      }
    };
    const saveBtn = actions.createEl("button", { text: i18nT("Save and set as default"), cls: "mod-cta" });
    saveBtn.onclick = async () => {
      tpl.name = (tpl.name || i18nT("Custom prompt")).trim();
      tpl.description = "";
      tpl.baseMode = tpl.baseMode || "learning";
      tpl.mode = tpl.id;
      tpl.customMode = true;
      tpl.isBuiltin = false;
      tpl.prompt = ta.value.trim();
      if (!tpl.prompt) { new obsidian.Notice(i18nT("Please fill in the prompt content")); return; }
      if (!tpl.prompt.includes("{{TRANSCRIPT}}")) { new obsidian.Notice(i18nT("2. Return to Q&A Log and start a new recording.")); return; }
      tpl.updatedAt = new Date().toISOString();
      await this.saveScene(tpl, true);
      new obsidian.Notice(i18nT("Custom prompt saved"));
      this.editingId = null;
      this.onOpen();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class ImportTextModal extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.selected = new Set();
    this.files = [];
    this.fileCheckboxes = new Map();
    this.processBtn = null;
    this.selectionText = null;
    this.modeSelect = null;
    this.modeHint = null;
    this.searchInput = null;
    this.categoryFilter = "all";
    this.categoryFilterEl = null;
    this.categoryButtons = new Map();
    this.listEl = null;
    this.loadingFiles = false;
    this.selectedMode = getEffectivePolishMode(plugin.settings, plugin.settings.polishMode, "meeting");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("qnalog-import-modal");
    this.selected.clear();
    this.fileCheckboxes = new Map();
    contentEl.createEl("h2", { text: i18nT("Import text") });
    contentEl.createEl("p", { cls: "qnalog-import-desc" })
      .setText(i18nT("Choose existing Markdown, a dictation draft, or a text note. Q&A Log will not call speech transcription; it goes straight through the “AI briefing” LLM pipeline on the API tab and structures the text using the current template."));

    this.renderModeControl(contentEl);

    this.files = [];
    this.loadingFiles = true;
    const toolbar = contentEl.createDiv({ cls: "qnalog-import-toolbar" });
    this.searchInput = toolbar.createEl("input", {
      type: "text",
      cls: "qnalog-import-search",
      attr: { placeholder: i18nT("AI Organize Outline") },
    });
    this.searchInput.addEventListener("input", () => this.renderFileList());
    const activeFile = this.app.workspace.getActiveFile();
    const currentBtn = toolbar.createEl("button", { text: i18nT("Select the current document") });
    currentBtn.disabled = !(activeFile instanceof obsidian.TFile && TEXT_IMPORT_EXT.has(String(activeFile.extension || "").toLowerCase()));
    currentBtn.onclick = () => {
      if (!(activeFile instanceof obsidian.TFile)) return;
      this.selected.add(activeFile.path);
      this.renderFileList();
      this.updateButton();
    };
    const clearBtn = toolbar.createEl("button", { text: i18nT("Clear selection") });
    clearBtn.onclick = () => {
      this.selected.clear();
      this.syncCheckboxes();
      this.updateButton();
    };

    this.categoryFilterEl = contentEl.createDiv({ cls: "qnalog-import-category-filter" });
    this.renderCategoryFilters();

    this.listEl = contentEl.createDiv({ cls: "qnalog-import-list" });
    this.renderFileList();
    void this.loadTextFiles();

    const actions = contentEl.createDiv({ cls: "qnalog-import-actions" });
    this.processBtn = actions.createEl("button", { text: i18nT("Start transcription (0 files)"), cls: "mod-cta" });
    this.processBtn.disabled = true;
    this.processBtn.onclick = () => this.process();
    this.selectionText = actions.createSpan({ cls: "qnalog-import-selection", text: i18nT("No text selected") });
    const cancelBtn = actions.createEl("button", { text: i18nT("Cancel") });
    cancelBtn.onclick = () => this.close();
    this.updateButton();
  }

  async loadTextFiles() {
    this.loadingFiles = true;
    this.renderFileList();
    try {
      this.files = await this.collectTextFiles();
    } catch (e) {
      console.error("[QnALog] collect import text files failed", e);
      this.files = [];
      new obsidian.Notice(`${i18nT("Failed to read the text file list:")}${(e && e.message) || e}`, 8000);
    }
    this.loadingFiles = false;
    this.renderCategoryFilters();
    this.renderFileList();
    this.updateButton();
  }

  async collectTextFiles() {
    const files = this.app.vault.getFiles()
      .filter((file) => file instanceof obsidian.TFile && TEXT_IMPORT_EXT.has(String(file.extension || "").toLowerCase()))
      .filter((file) => !obsidian.normalizePath(file.path).startsWith(this.app.vault.configDir + "/"))
      .sort((a, b) => b.stat.mtime - a.stat.mtime || a.path.localeCompare(b.path));
    const items = [];
    for (const file of files) {
      let content = "";
      let classification = {
        category: "external",
        badge: i18nT("Not read"),
        reason: i18nT("Failed to read file contents"),
        statusTitle: i18nT("Failed to read file contents"),
      };
      try {
        content = typeof this.app.vault.cachedRead === "function"
          ? await this.app.vault.cachedRead(file)
          : await this.app.vault.read(file);
        classification = classifyImportTextFileForModal(file, content);
      } catch (e) {
        console.warn("[QnALog] import text classify failed", file.path, e);
      }
      items.push(Object.assign({ file }, classification));
    }
    return items;
  }

  getCategoryCounts(items = this.files) {
    const counts = { all: (items || []).length };
    for (const key of IMPORT_TEXT_CATEGORY_ORDER) counts[key] = 0;
    for (const item of items || []) {
      const key = item && item.category || "external";
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  renderCategoryFilters() {
    if (!this.categoryFilterEl) return;
    this.categoryFilterEl.empty();
    this.categoryButtons = new Map();
    const counts = this.getCategoryCounts();
    const filters = [
      { id: "all", label: i18nT("All"), desc: i18nT("Show all importable text") },
      ...IMPORT_TEXT_CATEGORY_ORDER.map((id) => ({
        id,
        label: i18nT(IMPORT_TEXT_CATEGORY_CONFIG[id].shortLabel),
        desc: i18nT(IMPORT_TEXT_CATEGORY_CONFIG[id].label),
      })),
    ];
    for (const filter of filters) {
      const btn = this.categoryFilterEl.createEl("button", {
        cls: "qnalog-import-category-button",
        attr: { type: "button", title: filter.desc },
      });
      btn.createSpan({ cls: "qnalog-import-category-label", text: filter.label });
      btn.createSpan({ cls: "qnalog-import-category-count", text: String(counts[filter.id] || 0) });
      if (this.categoryFilter === filter.id) btn.addClass("is-active");
      btn.onclick = () => {
        this.categoryFilter = filter.id;
        this.renderCategoryFilters();
        this.renderFileList();
      };
      this.categoryButtons.set(filter.id, btn);
    }
  }

  renderModeControl(parent) {
    this.selectedMode = getEffectivePolishMode(this.plugin.settings, this.selectedMode || this.plugin.settings.polishMode, "meeting");
    const box = parent.createDiv({ cls: "qnalog-import-mode" });
    const label = box.createDiv({ cls: "qnalog-import-mode-label" });
    label.createDiv({ cls: "qnalog-import-mode-title", text: i18nT("Organizing mode") });
    this.modeHint = label.createDiv({ cls: "qnalog-import-mode-hint" });
    this.modeSelect = box.createEl("select", { cls: "dropdown qnalog-import-mode-select" });
    for (const [key, name] of getVisibleModeEntries(this.plugin.settings, false)) {
      this.modeSelect.createEl("option", { value: key, text: name });
    }
    this.modeSelect.value = this.selectedMode;
    this.modeSelect.onchange = () => {
      this.selectedMode = getEffectivePolishMode(this.plugin.settings, this.modeSelect.value, "meeting");
      this.updateModeHint();
    };
    this.updateModeHint();
  }

  updateModeHint() {
    if (!this.modeHint) return;
    const meta = getModeMeta(this.plugin.settings, this.selectedMode);
    this.modeHint.setText(i18nT(meta.goal || "Used to generate structured meeting notes.") + i18nT(" This run processes text only and does not call the speech transcription service."));
  }

  renderFileList() {
    if (!this.listEl) return;
    this.listEl.empty();
    this.fileCheckboxes = new Map();
    if (this.loadingFiles) {
      this.listEl.createDiv({ cls: "qnalog-import-empty", text: i18nT("Scanning for importable text…") });
      return;
    }
    const q = String(this.searchInput && this.searchInput.value || "").trim().toLowerCase();
    const matched = this.files.filter((file) => {
      if (this.categoryFilter !== "all" && file.category !== this.categoryFilter) return false;
      const realFile = file.file || file;
      if (!q) return true;
      return String(realFile.path || "").toLowerCase().includes(q) || String(realFile.basename || "").toLowerCase().includes(q);
    });
    if (!matched.length) {
      this.listEl.createDiv({ cls: "qnalog-import-empty", text: q ? "没有匹配的文本文件" : i18nT("No Markdown or text files to import in the vault") });
      return;
    }
    let rendered = 0;
    for (const category of IMPORT_TEXT_CATEGORY_ORDER) {
      if (this.categoryFilter !== "all" && this.categoryFilter !== category) continue;
      const group = matched.filter((item) => item.category === category);
      if (!group.length) continue;
      const config = IMPORT_TEXT_CATEGORY_CONFIG[category] || IMPORT_TEXT_CATEGORY_CONFIG.external;
      const section = this.listEl.createDiv({ cls: `qnalog-import-section qnalog-import-section-${category}` });
      const head = section.createDiv({ cls: "qnalog-import-section-head" });
      const titleWrap = head.createDiv({ cls: "qnalog-import-section-copy" });
      titleWrap.createDiv({ cls: "qnalog-import-section-title", text: `${i18nT(config.label)}（${group.length}）` });
      titleWrap.createDiv({ cls: "qnalog-import-section-desc", text: i18nT(config.desc) });
      const shown = group.slice(0, Math.max(0, 240 - rendered));
      shown.forEach((item, index) => this.renderSingleFile(section, item, rendered + index));
      rendered += shown.length;
      if (group.length > shown.length) {
        section.createDiv({ cls: "qnalog-import-warn", text: `${i18nT("This group has many files, showing the most recent ")}${shown.length} / ${group.length}${i18nT(" items; you can keep searching by file name or path.")}` });
      }
      if (rendered >= 240) break;
    }
    if (matched.length > rendered) {
      this.listEl.createDiv({ cls: "qnalog-import-warn", text: i18nT("There are many files; type a file name or path to keep filtering.") });
    }
    this.syncCheckboxes();
  }

  formatFileMeta(file) {
    const size = Number(file.stat && file.stat.size || 0);
    const sizeText = size >= 1024 * 1024 ? (size / 1024 / 1024).toFixed(1) + " MB" : Math.max(0, Math.round(size / 1024)) + " KB";
    const time = window.moment(file.stat.mtime).format("MM-DD HH:mm");
    return `${sizeText} · ${time} · ${file.path}`;
  }

  renderSingleFile(parent, item, index = 0) {
    const file = item && item.file ? item.file : item;
    const row = parent.createDiv({ cls: "qnalog-import-row" });
    if (item && item.category) row.addClass(`is-${item.category}`);
    const id = makeImportTextCheckboxId(file.path, index);
    const cb = row.createEl("input", { type: "checkbox", attr: { id } });
    const label = row.createEl("label", { attr: { for: id }, cls: "qnalog-import-label" });
    const nameRow = label.createDiv({ cls: "qnalog-import-name-row" });
    nameRow.createSpan({ cls: "qnalog-import-name", text: file.basename });
    if (item && item.badge) {
      nameRow.createSpan({
        cls: `qnalog-import-badge qnalog-import-badge-${item.category || "external"}`,
        text: item.badge,
        attr: item.statusTitle ? { title: item.statusTitle } : {},
      });
    }
    label.createDiv({ cls: "qnalog-import-meta", text: this.formatFileMeta(file) });
    if (item && item.reason) {
      label.createDiv({ cls: "qnalog-import-reason", text: item.reason });
    }
    this.fileCheckboxes.set(file.path, cb);
    cb.onchange = () => {
      if (cb.checked) this.selected.add(file.path);
      else this.selected.delete(file.path);
      this.updateButton();
    };
  }

  syncCheckboxes() {
    for (const [path, cb] of this.fileCheckboxes.entries()) cb.checked = this.selected.has(path);
  }

  updateButton() {
    const count = this.selected.size;
    if (this.processBtn) {
      this.processBtn.setText(`${i18nT("Start processing (")}${count}${i18nT(" files)")}`);
      this.processBtn.disabled = count === 0;
    }
    if (this.selectionText) {
      this.selectionText.setText(count ? "将按文件名升序合并为一份 Q&A Log 纪要" : i18nT("No text selected"));
    }
  }

  async process() {
    const paths = Array.from(this.selected);
    if (!paths.length) return;
    const mode = getEffectivePolishMode(this.plugin.settings, this.selectedMode || this.plugin.settings.polishMode, "meeting");
    if (this.processBtn) {
      this.processBtn.disabled = true;
      this.processBtn.setText(i18nT("Processing…"));
    }
    try {
      this.close();
      await this.plugin.imports.importTextFiles(paths, mode);
    } catch (e) {
      console.error("[QnALog] import text failed", e);
      if (this.plugin && this.plugin.diagnostics) {
        try {
          await this.plugin.diagnostics.logDiagnostic("error", "text_import.failed", i18nT("Failed to organize imported text"), {
            mode,
            count: paths.length,
            error: diagnosticError(e),
          });
        } catch (logError) {
          console.warn("[QnALog] import text diagnostic failed", logError);
        }
      }
      new obsidian.Notice(`${i18nT("Failed to import text:")}${(e && e.message) || e}`, 8000);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class AudioImportOptionsModal extends obsidian.Modal {
  constructor(app, plugin, options = {}) {
    super(app);
    this.plugin = plugin;
    this.paths = Array.isArray(options.paths) ? options.paths.slice() : [];
    this.selectedMode = getEffectivePolishMode(
      plugin.settings,
      options.mode || plugin.settings.polishMode,
      "meeting",
    );
    this.speakerSelection = resolveImportSpeakerSelection(plugin);
    this.selectedSpeakerDiarization = this.speakerSelection.enabled;
    this.selectedSpeakerCount = this.speakerSelection.count;
    this.onConfirm = typeof options.onConfirm === "function" ? options.onConfirm : null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("qnalog-import-options-modal");
    contentEl.createEl("h2", { text: i18nT("Import audio") });
    contentEl.createDiv({
      cls: "qnalog-import-desc",
      text: this.paths.length > 1
        ? `${i18nT("Selected")} ${this.paths.length}${i18nT(" audio files. Confirm the organization method for this run.")}`
        : i18nT("Confirm the organization method for this run."),
    });

    const mode = contentEl.createDiv({ cls: "qnalog-import-mode" });
    const modeCopy = mode.createDiv();
    modeCopy.createDiv({ cls: "qnalog-import-mode-title", text: i18nT("Organizing mode") });
    modeCopy.createDiv({ cls: "qnalog-import-mode-hint", text: i18nT("After transcription is complete, generate minutes of the corresponding type.") });
    const modeSelect = mode.createEl("select", { cls: "dropdown qnalog-import-mode-select" });
    for (const [key, name] of getVisibleModeEntries(this.plugin.settings, false)) {
      modeSelect.createEl("option", { value: key, text: name });
    }
    modeSelect.value = this.selectedMode;
    modeSelect.onchange = () => {
      this.selectedMode = getEffectivePolishMode(this.plugin.settings, modeSelect.value, "meeting");
    };

    renderImportSpeakerControl(contentEl, this);

    contentEl.createDiv({
      cls: "qnalog-import-execution-note",
      text: i18nT("This choice only affects the current import task; the default transcription service can be changed on the \"Speakers\" page in settings."),
    });

    const actions = contentEl.createDiv({ cls: "qnalog-import-actions" });
    const cancel = actions.createEl("button", { text: i18nT("Cancel"), attr: { type: "button" } });
    cancel.onclick = () => this.close();
    const start = actions.createEl("button", { text: i18nT("Start transcription"), cls: "mod-cta", attr: { type: "button" } });
    start.onclick = async () => {
      start.disabled = true;
      const payload = {
        mode: this.selectedMode,
        speakerDiarization: this.selectedSpeakerDiarization,
        speakerCount: this.selectedSpeakerDiarization ? this.selectedSpeakerCount : 0,
      };
      this.close();
      if (this.onConfirm) await this.onConfirm(payload);
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class ImportAudioModal extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.selected = new Set();
    this.processBtn = null;
    this.selectionText = null;
    this.modeSelect = null;
    this.modeHint = null;
    this.selectedMode = getEffectivePolishMode(plugin.settings, plugin.settings.polishMode, "meeting");
    this.speakerSelection = resolveImportSpeakerSelection(plugin);
    this.selectedSpeakerDiarization = this.speakerSelection.enabled;
    this.selectedSpeakerCount = this.speakerSelection.count;
    this.batches = [];
    this.groupCheckboxes = new Map();
    this.fileCheckboxes = new Map();
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("qnalog-import-modal");
    this.selected.clear();
    this.groupCheckboxes = new Map();
    this.fileCheckboxes = new Map();
    contentEl.createEl("h2", { text: i18nT("Import audio") });
    const desc = contentEl.createEl("p", { cls: "qnalog-import-desc" });
    desc.setText(`${i18nT("From ")}${this.plugin.settings.audioFolder}${i18nT(" to choose audio. Supports WebM, M4A/MP4, MP3, WAV, AAC, OGG, FLAC, and other formats; segments from the same recording are merged in the display.")}`);

    this.renderModeControl(contentEl);
    renderImportSpeakerControl(contentEl, this);
    contentEl.createDiv({
      cls: "qnalog-import-execution-note",
      text: i18nT("This choice only affects the current import task."),
    });

    const folderPath = obsidian.normalizePath(this.plugin.settings.audioFolder);
    const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof obsidian.TFolder)) {
      contentEl.createEl("p", { text: `${i18nT("Audio folder does not exist:")}${folderPath}` });
      return;
    }
    const files = folder.children
      .filter((f) => f instanceof obsidian.TFile && AUDIO_EXT.has(f.extension.toLowerCase()))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    if (!files.length) {
      contentEl.createEl("p", { text: i18nT("No recognizable audio files in the audio folder") });
      return;
    }

    const grouped = this.buildBatches(files);
    this.batches = grouped.batches;

    const toolbar = contentEl.createDiv({ cls: "qnalog-import-toolbar" });
    const latestBtn = toolbar.createEl("button", { text: i18nT("Select the most recent group") });
    latestBtn.disabled = grouped.batches.length === 0;
    latestBtn.onclick = () => {
      if (!this.batches.length) return;
      this.selected.clear();
      this.setBatchSelected(this.batches[0], true);
      this.updateButton();
    };
    const clearBtn = toolbar.createEl("button", { text: i18nT("Clear selection") });
    clearBtn.onclick = () => {
      this.selected.clear();
      this.syncAllCheckboxes();
      this.updateButton();
    };

    const list = contentEl.createDiv({ cls: "qnalog-import-list" });
    if (grouped.batches.length) {
      list.createDiv({ cls: "qnalog-import-section-title", text: i18nT("Recording batch") });
      grouped.batches.forEach((batch) => this.renderBatch(list, batch));
    }
    if (grouped.singles.length) {
      list.createDiv({ cls: "qnalog-import-section-title", text: grouped.batches.length ? "独立音频" : i18nT("Audio files") });
      grouped.singles.forEach((file) => this.renderSingleFile(list, file));
    }

    const actions = contentEl.createDiv({ cls: "qnalog-import-actions" });
    this.processBtn = actions.createEl("button", { text: i18nT("Start processing (0 files)"), cls: "mod-cta" });
    this.processBtn.disabled = true;
    this.processBtn.onclick = () => this.process();
    this.selectionText = actions.createSpan({ cls: "qnalog-import-selection", text: i18nT("No audio selected") });
    const cancelBtn = actions.createEl("button", { text: i18nT("Cancel") });
    cancelBtn.onclick = () => this.close();
    this.updateButton();
  }
  renderModeControl(parent) {
    this.selectedMode = getEffectivePolishMode(this.plugin.settings, this.selectedMode || this.plugin.settings.polishMode, "meeting");
    const box = parent.createDiv({ cls: "qnalog-import-mode" });
    const label = box.createDiv({ cls: "qnalog-import-mode-label" });
    label.createDiv({ cls: "qnalog-import-mode-title", text: i18nT("Organizing mode") });
    this.modeHint = label.createDiv({ cls: "qnalog-import-mode-hint" });
    this.modeSelect = box.createEl("select", { cls: "dropdown qnalog-import-mode-select" });
    for (const [key, name] of getVisibleModeEntries(this.plugin.settings, false)) {
      this.modeSelect.createEl("option", { value: key, text: name });
    }
    this.modeSelect.value = this.selectedMode;
    this.modeSelect.onchange = () => {
      this.selectedMode = getEffectivePolishMode(this.plugin.settings, this.modeSelect.value, "meeting");
      this.updateModeHint();
    };
    this.updateModeHint();
  }
  updateModeHint() {
    if (!this.modeHint) return;
    const meta = getModeMeta(this.plugin.settings, this.selectedMode);
    this.modeHint.setText(i18nT(meta.goal || "Used to generate structured meeting notes.") + i18nT(" Can be switched temporarily for this import; the default prompt will not be modified."));
  }
  parseSegmentRef(file) {
    const match = String(file.name || "").match(new RegExp(`^${NS_AUDIO_ALT}-(\\d{8}-\\d{6})-seg(\\d+)\\.([a-z0-9]+)$`, "i"));
    if (!match) return null;
    return {
      stamp: match[1],
      seg: Number(match[2]),
      ext: match[3].toLowerCase(),
    };
  }
  buildBatches(files) {
    const byStamp = new Map();
    const singles = [];
    for (const file of files) {
      const info = this.parseSegmentRef(file);
      if (!info) {
        singles.push(file);
        continue;
      }
      if (!byStamp.has(info.stamp)) {
        byStamp.set(info.stamp, { id: info.stamp, stamp: info.stamp, items: [] });
      }
      byStamp.get(info.stamp).items.push({ file, seg: info.seg, ext: info.ext });
    }
    const batches = Array.from(byStamp.values())
      .map((batch) => {
        batch.items.sort((a, b) => a.seg - b.seg || a.file.name.localeCompare(b.file.name));
        batch.files = batch.items.map((x) => x.file);
        batch.totalSize = batch.files.reduce((sum, f) => sum + (f.stat && f.stat.size ? f.stat.size : 0), 0);
        batch.latestMtime = Math.max(...batch.files.map((f) => f.stat.mtime || 0));
        batch.earliestMtime = Math.min(...batch.files.map((f) => f.stat.mtime || 0));
        const segs = batch.items.map((x) => x.seg).filter(Number.isFinite);
        batch.firstSeg = Math.min(...segs);
        batch.lastSeg = Math.max(...segs);
        const present = new Set(segs);
        batch.missing = [];
        for (let i = batch.firstSeg; i <= batch.lastSeg; i++) if (!present.has(i)) batch.missing.push(i);
        batch.emptyCount = batch.files.filter((f) => (f.stat && f.stat.size || 0) <= 1024).length;
        batch.largeCount = batch.files.filter((f) => (f.stat && f.stat.size || 0) > 25 * 1024 * 1024).length;
        return batch;
      })
      .sort((a, b) => b.latestMtime - a.latestMtime || b.stamp.localeCompare(a.stamp));
    singles.sort((a, b) => b.stat.mtime - a.stat.mtime || a.name.localeCompare(b.name));
    return { batches, singles };
  }
  formatStamp(stamp) {
    const m = window.moment ? window.moment(stamp, "YYYYMMDD-HHmmss") : null;
    return m && m.isValid && m.isValid() ? m.format("YYYY-MM-DD HH:mm") : stamp;
  }
  formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return Math.max(0, Math.round(n / 1024)) + " KB";
  }
  formatFileMeta(file) {
    const mtime = window.moment(file.stat.mtime).format("MM-DD HH:mm");
    return `${this.formatSize(file.stat.size)} · ${mtime}`;
  }
  renderBatch(parent, batch) {
    const details = parent.createEl("details", { cls: "qnalog-import-batch" });
    const summary = details.createEl("summary", { cls: "qnalog-import-batch-summary" });
    const cb = summary.createEl("input", { type: "checkbox" });
    cb.addEventListener("click", (evt) => evt.stopPropagation());
    cb.onchange = () => {
      this.setBatchSelected(batch, cb.checked);
      this.updateButton();
    };
    this.groupCheckboxes.set(batch.id, cb);

    const text = summary.createDiv({ cls: "qnalog-import-batch-text" });
    text.createDiv({ cls: "qnalog-import-batch-name", text: `${this.formatStamp(batch.stamp)} · ${batch.files.length}${i18nT(" segments")}` });
    const range = `seg${pad(batch.firstSeg)}–seg${pad(batch.lastSeg)}`;
    const timeRange = `${window.moment(batch.earliestMtime).format("MM-DD HH:mm")}–${window.moment(batch.latestMtime).format("HH:mm")}`;
    text.createDiv({ cls: "qnalog-import-batch-meta", text: `${range} · ${this.formatSize(batch.totalSize)} · ${timeRange}` });

    const chip = summary.createSpan({ cls: "qnalog-import-batch-chip", text: i18nT("Whole batch") });
    chip.setAttr("aria-hidden", "true");

    if (batch.missing.length || batch.emptyCount || batch.largeCount) {
      const warns = [];
      if (batch.missing.length) warns.push(i18nT("May be missing ") + batch.missing.map((n) => "seg" + pad(n)).join("、"));
      if (batch.emptyCount) warns.push(`${batch.emptyCount}${i18nT(" segments are nearly empty files")}`);
      if (batch.largeCount) warns.push(`${batch.largeCount}${i18nT(" segments exceed 25 MB")}`);
      details.createDiv({ cls: "qnalog-import-warn", text: warns.join("；") });
    }

    const fileList = details.createDiv({ cls: "qnalog-import-batch-files" });
    for (const item of batch.items) {
      this.renderSingleFile(fileList, item.file, { compact: true, seg: item.seg, batch });
    }
  }
  renderSingleFile(parent, file, options = {}) {
    const compact = !!options.compact;
    const row = parent.createDiv({ cls: compact ? "qnalog-import-row is-compact" : "qnalog-import-row" });
    const cbId = `qnalog-import-${file.path.replace(/[^a-z0-9]/gi, "_")}`;
    const cb = row.createEl("input", { type: "checkbox", attr: { id: cbId } });
    const lbl = row.createEl("label", { attr: { for: cbId }, cls: "qnalog-import-label" });
    const name = options.seg ? `seg${pad(options.seg)} · ${file.name}` : file.name;
    lbl.createDiv({ cls: "qnalog-import-name", text: name });
    lbl.createDiv({ cls: "qnalog-import-meta", text: this.formatFileMeta(file) });
    if (file.stat.size > 25 * 1024 * 1024) {
      lbl.createDiv({ cls: "qnalog-import-warn", text: i18nT("The file exceeds 25 MB, and most transcription APIs will reject it. Lower the bitrate first.") });
    }
    this.fileCheckboxes.set(file.path, cb);
    cb.onchange = () => {
      if (cb.checked) this.selected.add(file.path);
      else this.selected.delete(file.path);
      this.syncAllCheckboxes();
      this.updateButton();
    };
  }
  setBatchSelected(batch, checked) {
    for (const file of batch.files || []) {
      if (checked) this.selected.add(file.path);
      else this.selected.delete(file.path);
    }
    this.syncAllCheckboxes();
  }
  syncAllCheckboxes() {
    for (const [path, cb] of this.fileCheckboxes.entries()) {
      cb.checked = this.selected.has(path);
    }
    for (const batch of this.batches || []) {
      const cb = this.groupCheckboxes.get(batch.id);
      if (!cb) continue;
      const count = batch.files.filter((f) => this.selected.has(f.path)).length;
      cb.checked = count > 0 && count === batch.files.length;
      cb.indeterminate = count > 0 && count < batch.files.length;
    }
  }
  updateButton() {
    if (!this.processBtn) return;
    const n = this.selected.size;
    const fullBatches = (this.batches || []).filter((batch) => batch.files.length && batch.files.every((f) => this.selected.has(f.path))).length;
    const label = fullBatches > 0 ? `${fullBatches}${i18nT(" groups / ")}${n}${i18nT(" files")}` : `${n}${i18nT(" files")}`;
    this.processBtn.setText(`${i18nT("Start transcription (")}${label}）`);
    this.processBtn.disabled = n === 0;
    if (this.selectionText) {
      this.selectionText.setText(n ? `将按文件名升序合并处理` : i18nT("No audio selected"));
    }
  }
  async process() {
    const paths = Array.from(this.selected);
    if (!paths.length) return;
    const mode = getEffectivePolishMode(this.plugin.settings, this.selectedMode || this.plugin.settings.polishMode, "meeting");
    this.close();
    await this.plugin.imports.importAudioFiles(paths, mode, {
      speakerDiarization: this.selectedSpeakerDiarization,
      speakerCount: this.selectedSpeakerDiarization ? this.selectedSpeakerCount : 0,
    });
  }
  onClose() { this.contentEl.empty(); }
}

export class BubbleWidget {
  /**
   * 悬浮气泡的外层容器；挂载前为 null。
   * 显式声明：TypeScript 不推断只在构造函数里赋值的属性，未声明时外部读 `bubble.wrapEl` 会报「属性不存在」。
   */
  declare wrapEl: HTMLElement | null;
  constructor(plugin) {
    this.plugin = plugin;
    this.wrapEl = null;
    this.el = null;
    this.drag = null;
    this.hideTimer = null;
    this.ribbonEl = null;
    this.ribbonHandlers = null;
    this.unsubscribe = null;
    this.resizeHandler = null;
  }
  mount(ribbonEl) {
    if (this.wrapEl) return;
    this.ribbonEl = ribbonEl || null;
    const wrapEl = activeDocument.body.createDiv({ cls: "qnalog-bubble-wrap" });
    const el = wrapEl.createDiv({ cls: "qnalog-bubble is-idle" });
    this.wrapEl = wrapEl;
    this.el = el;
    this._lastSig = "";
    this._renderRaf = 0;
    this.render();
    const pos = this.plugin.settings.floatingBallPos || null;
    if (pos && pos.userSet) {
      wrapEl.style.left = `${Math.max(0, pos.left || 0)}px`;
      wrapEl.style.top = `${Math.max(0, pos.top || 0)}px`;
      this.keepInViewport();
    } else {
      this.placeDefault();
    }
    this.updateDockTail();
    this.show();
    this.resizeHandler = () => {
      if (!this.wrapEl) return;
      if (!(this.plugin.settings.floatingBallPos || {}).userSet) this.placeDefault();
      else this.keepInViewport();
      this.updateDockTail();
    };
    window.addEventListener("resize", this.resizeHandler);
    this.attachHover();
    this.attachDrag();
    this.unsubscribe = this.plugin.recorder.on(() => this.scheduleUpdate());
    this.bindRibbon();
  }
  placeDefault() {
    if (!this.wrapEl) return;
    const rect = this.wrapEl.getBoundingClientRect();
    const width = rect.width || 168;
    const height = rect.height || 40;
    const margin = 18;
    this.wrapEl.style.left = `${Math.max(margin, window.innerWidth - width - margin)}px`;
    this.wrapEl.style.top = `${Math.max(72, window.innerHeight - height - 58)}px`;
  }
  keepInViewport() {
    if (!this.wrapEl) return;
    const rect = this.wrapEl.getBoundingClientRect();
    const width = rect.width || 168;
    const height = rect.height || 40;
    const margin = 8;
    const left = parseFloat(this.wrapEl.style.left) || 0;
    const top = parseFloat(this.wrapEl.style.top) || 0;
    this.wrapEl.style.left = `${Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin))}px`;
    this.wrapEl.style.top = `${Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin))}px`;
  }
  updateDockTail() {
    if (!this.wrapEl) return;
    this.wrapEl.removeClass("has-tail");
    this.wrapEl.removeClass("tail-left");
    this.wrapEl.removeClass("tail-right");
    this.wrapEl.removeClass("tail-top");
    this.wrapEl.removeClass("tail-bottom");
    const rect = this.wrapEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const threshold = 54;
    const bottomThreshold = 92;
    const top = rect.top;
    const left = rect.left;
    const right = window.innerWidth - rect.right;
    const bottom = window.innerHeight - rect.bottom;
    let tail = "";
    if (bottom <= bottomThreshold) tail = "bottom";
    else if (top <= threshold) tail = "top";
    else if (left <= threshold) tail = "left";
    else if (right <= threshold) tail = "right";
    if (!tail) return;
    this.wrapEl.addClass("has-tail");
    this.wrapEl.addClass("tail-" + tail);
  }
  unmount() {
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    if (this.hideTimer) { window.clearTimeout(this.hideTimer); this.hideTimer = null; }
    if (this._renderRaf) { cancelAnimationFrame(this._renderRaf); this._renderRaf = 0; }
    if (this.resizeHandler) { window.removeEventListener("resize", this.resizeHandler); this.resizeHandler = null; }
    this.unbindRibbon();
    if (this.wrapEl) { this.wrapEl.remove(); this.wrapEl = null; this.el = null; }
  }
  scheduleUpdate() {
    if (this._renderRaf) return;
    this._renderRaf = window.requestAnimationFrame(() => {
      this._renderRaf = 0;
      const info = this.plugin.recorder.getInfo();
      const queue = this.plugin.queue;
      const hasPromptJob = !!(queue && queue.hasPendingGeneratePrompt && queue.hasPendingGeneratePrompt());
      const sig = `${info.state}|${hasPromptJob ? "P" : ""}`;
      if (sig === this._lastSig) {
        const t = this.el && this.el.querySelector(".qnalog-bubble-timer");
        if (t) t.setText(formatElapsed(info.elapsed));
      } else {
        this._lastSig = sig;
        this.render();
        this.updateDockTail();
      }
    });
  }
  bindRibbon() {
    if (!this.ribbonEl) return;
    const enter = () => this.show();
    const leave = () => this.scheduleHide();
    this.ribbonEl.addEventListener("mouseenter", enter);
    this.ribbonEl.addEventListener("mouseleave", leave);
    this.ribbonHandlers = { enter, leave };
  }
  unbindRibbon() {
    if (!this.ribbonEl || !this.ribbonHandlers) return;
    this.ribbonEl.removeEventListener("mouseenter", this.ribbonHandlers.enter);
    this.ribbonEl.removeEventListener("mouseleave", this.ribbonHandlers.leave);
    this.ribbonHandlers = null;
  }
  show() {
    if (!this.wrapEl) return;
    this.wrapEl.addClass("is-visible");
    if (this.hideTimer) { window.clearTimeout(this.hideTimer); this.hideTimer = null; }
  }
  hide() {
    // 停靠式悬浮窗常驻显示；关闭由设置项控制。
    if (!this.wrapEl) return;
    this.show();
  }
  scheduleHide() {
    // 保持常驻，避免脱离侧边栏后找不到录音控制器。
    if (this.hideTimer) { window.clearTimeout(this.hideTimer); this.hideTimer = null; }
  }
  attachHover() {
    this.wrapEl.addEventListener("mouseenter", () => this.show());
    this.wrapEl.addEventListener("mouseleave", () => this.scheduleHide());
  }
  // 用候选名逐个尝试画 Lucide 图标；setIcon 对坏名静默不插 svg，故显式校验。
  _paintIcon(el, candidates) {
    let painted = false;
    for (const name of candidates) {
      try {
        el.empty();
        obsidian.setIcon(el, name);
        if (el.querySelector("svg")) { painted = true; break; }
      } catch { /* intentionally empty */ }
    }
    if (!painted) el.empty();
    return painted;
  }
  render() {
    if (!this.el) return;
    const info = this.plugin.recorder.getInfo();
    this.el.empty();
    this.el.removeClass("is-idle"); this.el.removeClass("is-recording"); this.el.removeClass("is-paused");
    // 悬浮窗大小（大/中/小）：每次渲染都重置三档尺寸类，再加回当前档，与状态无关。
    ["large", "medium", "small"].forEach(sz => this.el.removeClass("qnalog-bubble-size-" + sz));
    this.el.addClass("qnalog-bubble-size-" + (this.plugin.settings.bubbleSize || "large"));
    if (this.wrapEl) this.wrapEl.removeClass("is-recording-wrap");
    const makeDocButton = (title, handler) => {
      const jumpBtn = this.el.createEl("button", { cls: "qnalog-bubble-jump", attr: { title, "aria-label": title } });
      // 用 Lucide 图标替代之前 CSS 画的文档形状。
      // 关键：setIcon 对无效图标名通常静默不加 svg（不抛异常），会得到空按钮 → 图标"看不见"。
      // 所以逐个尝试候选图标名，并显式验证 svg 真的被插入；都失败再走 CSS fallback 形状。
      const painted = this._paintIcon(jumpBtn, ["file-text", "lucide-file-text", "file"]);
      if (!painted) jumpBtn.addClass("is-fallback-icon");  // CSS 画的文档轮廓兜底
      jumpBtn.onclick = (e) => { e.stopPropagation(); handler(); };
      return jumpBtn;
    };
    if (info.state === "idle") {
      this.el.addClass("is-idle");
      makeDocButton(i18nT(" This run processes text only; the speech transcription service is not called."), () => this.plugin.shell.openRecentNote());
      const micBtn = this.el.createEl("button", {
        cls: "qnalog-bubble-main",
        attr: { "aria-label": i18nT("Start meeting recording"), title: i18nT("Start meeting recording") },
      });
      obsidian.setTooltip(micBtn, i18nT("Start meeting recording"), { placement: "top" });
      this._paintIcon(micBtn, ["mic", "lucide-mic"]);
      micBtn.onclick = (e) => { e.stopPropagation(); this.plugin.recording.startRecording(); };
      if (this.plugin.queue && this.plugin.queue.hasPendingGeneratePrompt && this.plugin.queue.hasPendingGeneratePrompt()) {
        const chip = this.el.createDiv({ cls: "qnalog-bubble-chip" });
        chip.setText(i18nT("Refining prompt"));
        chip.setAttr("title", i18nT("Generating custom prompt in the background. When complete, it will appear in the prompt management and recording mode lists."));
      }
    } else {
      this.el.addClass(info.state === "paused" ? "is-paused" : "is-recording");
      if (info.state === "recording" && this.wrapEl) this.wrapEl.addClass("is-recording-wrap");
      this.show();
      makeDocButton(i18nT("Jump to the transcription position in the current recording note"), () => this.plugin.shell.openSessionNote());
      const ctrl = this.el.createDiv({ cls: "qnalog-bubble-ctrl" });
      const pauseBtn = ctrl.createEl("button", { cls: `qnalog-bubble-btn ${info.state === "paused" ? "is-play-icon" : "is-pause-icon"}`, attr: { title: info.state === "paused" ? "继续" : i18nT("Pause"), "aria-label": info.state === "paused" ? "继续" : i18nT("Pause") } });
      pauseBtn.onclick = (e) => { e.stopPropagation(); if (info.state === "paused") this.plugin.recorder.resume(); else this.plugin.recorder.pause(); };
      const stopBtn = ctrl.createEl("button", { cls: "qnalog-bubble-btn stop is-stop-icon", attr: { title: i18nT("Stop and merge polish"), "aria-label": i18nT("Stop and merge polish") } });
      stopBtn.onclick = (e) => { e.stopPropagation(); this.plugin.recording.stopRecording(); };
      const timer = this.el.createDiv({ cls: "qnalog-bubble-timer" });
      timer.setText(formatElapsed(info.elapsed));
    }
  }
  attachDrag() {
    const wrapEl = this.wrapEl;
    wrapEl.addEventListener("pointerdown", (e) => {
      if (e.target instanceof HTMLElement && e.target.tagName === "BUTTON") return;
      this.drag = {
        startX: e.clientX, startY: e.clientY,
        startLeft: parseFloat(wrapEl.style.left) || 60,
        startTop: parseFloat(wrapEl.style.top) || 120,
      };
      try { wrapEl.setPointerCapture(e.pointerId); } catch { /* intentionally empty */ }
    });
    wrapEl.addEventListener("pointermove", (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.startX;
      const dy = e.clientY - this.drag.startY;
      wrapEl.style.left = `${Math.max(0, this.drag.startLeft + dx)}px`;
      wrapEl.style.top = `${Math.max(0, this.drag.startTop + dy)}px`;
      this.keepInViewport();
      this.updateDockTail();
    });
    const endDrag = (e) => {
      if (!this.drag) return;
      this.keepInViewport();
      this.updateDockTail();
      this.plugin.settings.floatingBallPos = {
        left: parseFloat(wrapEl.style.left) || 60,
        top: parseFloat(wrapEl.style.top) || 120,
        userSet: true,
      };
      this.plugin.saveSettings();
      this.drag = null;
      try { wrapEl.releasePointerCapture(e.pointerId); } catch { /* intentionally empty */ }
    };
    wrapEl.addEventListener("pointerup", endDrag);
    wrapEl.addEventListener("pointercancel", endDrag);
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- end of QnALog dynamic-typing region */
