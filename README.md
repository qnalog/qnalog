# Q&A Log

English | [简体中文](README.zh-CN.md)

**Turns conversations into structured knowledge.**

Open-source conversation intelligence for Obsidian: record, transcribe, and organize meetings, interviews, talks, and voice notes into Markdown you can reuse.

Q&A Log connects to no cloud service of its own and ships **no API keys**: you configure your own speech-to-text (ASR) service and, optionally, your own large language model (LLM). Recordings and generated notes stay in your vault.

Supports desktop and mobile Obsidian. Mobile recording uses the device microphone. System audio, virtual audio devices, multichannel capture, desktop device diagnostics, and realtime streaming ASR providers that need custom authentication headers require the desktop app.

## Origin

Q&A Log is derived from [LexVoice](https://github.com/Lynn-x/LexVoice) by Lynnx, based on its last MIT-licensed release (2.1.2). Upstream relicensed to a proprietary license from 2.2.0 onward; this project is an independent continuation of the MIT-licensed code, not of that release line. See [`NOTICE`](NOTICE) and [`MAINTAINING.md`](MAINTAINING.md).

## Relationship to LexVoice

Q&A Log is a separate project, not a newer version of LexVoice. It started from LexVoice's last MIT-licensed release and has since been reworked into a plugin with its own name, data namespace, and settings.

**There is no data path between the two.**

- **No migration.** Q&A Log has no import, export, or migration path for LexVoice data. It does not read LexVoice notes, markers, tags, folders, or settings, and it does not scan or rewrite your existing files on load.
- **No settings inheritance.** A new install starts from Q&A Log's own defaults. If you have used LexVoice, its API keys, service configuration, folders, and prompts are not carried over — configure Q&A Log from scratch.
- **Its own namespace.** Tags, markers, and folders written to your vault use the `qnalog` / `QnALog` namespace only.
- **Its own plugin id.** The id is `qnalog`, different from LexVoice's `lexvoice`, so Obsidian manages them as two separate plugins.

## Features

### Live outline
Chapters grow as you record. After recording, chapters link to the player — click a chapter to jump to that position in the audio. When recording stops, AI completes the chapters into a full set of notes.

### In-meeting notes
While recording, jot live notes under the outline. The first character can trigger different handling:

Trigger the AI assistant:
- `#term` — the AI explains the term in the context of the current discussion.
- `?question` — the AI answers using the current transcript and outline.
- `!highlight` — marks something important and has the final notes treat it accordingly.

Mark only (no AI call):
- `@assignee` — record "@alice follows up"; the final notes prefer assigning that todo to them.
- `/todo` — capture an explicit todo candidate.

Half-width and full-width symbols are both accepted. In-meeting notes are fed into the final summarization prompt as clearly-labeled "live supplementary material", never mixed into the raw transcript.

### Ask this note
Ask follow-up questions when the final notes miss a detail or you want to revisit a specific part of the discussion. Q&A Log answers from both the organized note and the preserved raw transcript. Useful answers can be written back to one compact **Ask this note** section in the Markdown file.

### Long meetings & recovery
In standard meeting and learning-note modes, long recordings are organized in recoverable parts instead of relying on one all-or-nothing LLM response. Q&A Log builds a global topic map, saves each completed part as a local checkpoint, and assembles the final note in time order.

If a request is interrupted or a model reaches its output limit, completed work is reused and only unfinished parts are retried. The raw transcript remains available, and an incomplete result is shown as **partially completed** rather than being saved as an empty note.

### Task progress
The processing panel separates transcription, AI organization, and Markdown writing. It shows the active stage, recent activity, failures, and retry or cancel actions. Failed transcription and failed AI organization remain distinct so you can resume from the step that actually failed.

### Sediment workflow
After each note, AI splits the content into three candidate groups you review in order — keep / merge / ignore:
- **People** — adjudicated one by one
- **Todos** — selected by default; edit owner, due date, sub-tasks
- **Hotwords** — names, organizations, brands, terms, to improve later ASR accuracy

### Object library
Q&A Log turns reusable meeting content into standalone Obsidian objects — people profiles, ASR hotwords, and a wall of todos assembled from the notes you confirmed. Everything lives in your own vault; the next time the same person comes up, it links to the existing profile.

<p align="center">
  <img width="220" alt="Q&A Log object" src="docs/images/object-library.webp" />
  <img width="220" alt="Generated people profile" src="docs/images/people-profile.webp" />
</p>

### Todo enhancements
Edit owner, due date and sub-tasks inline at the candidate stage — no dialogs. Stored todos use standard Markdown task syntax (recognized by plugins like Tasks). Source information is preserved on delete / redo for traceability.

### Recording reliability
- Level meters before and after recording show whether the mic and system audio are actually working.
- Audio inputs remain user-selectable; virtual or remote device names are shown as guidance rather than being selected or rejected automatically.
- A device check in settings diagnoses "recorded but silent" problems.
- Compatible independent multichannel input can be detected and transcribed by channel, with speaker labels that can be mapped to names. Separation stays off when independent channels cannot be verified.
- Deleting a transcript offers to delete its audio file too.

### Export
From one set of notes you can generate an HTML report, a PDF report, or an `.eml` email draft — same content, different presentation.

<p align="center">
  <img width="720" alt="Q&A Log export" src="docs/images/export-email-draft.webp" />
</p>

### Note list
The sidebar can organize recent notes by folder or by time. Folder groups can be collapsed, the open note is highlighted, and search and template filters remain available in either view.

## Basic usage

1. Open the Q&A Log sidebar.
2. Choose a template and an audio input.
3. Start recording; check that the level meter reacts.
4. Watch the live outline; add in-meeting notes if needed.
5. Stop recording and follow transcription and AI organization in **Task progress**.
6. Ask follow-up questions from **Ask this note**, or retry only the failed stage if processing was interrupted.
7. Open **Sediment** and review people, todos, and hotwords.
8. If you need to share, generate an HTML report, a PDF report, or an email draft.

<p align="center">
  <img width="720" alt="Q&A Log in the Obsidian sidebar" src="docs/images/sidebar.webp" />
</p>

Default folders (all configurable in settings):

| Content | Path |
|---|---|
| Recordings | `QnALog/录音` |
| Transcribed notes | `QnALog/转写纪要` |
| Meeting materials | `QnALog/会议资料` |
| People | `QnALog/资料库/人员` |
| Todo cards | `QnALog/资料库/待办` |
| Views | `QnALog/资料库/视图` |
| Glossary | `QnALog/资料库/词汇表.md` |
| Diagnostics log | `QnALog/系统/诊断日志` |
| Archive | `QnALog/资料库/归档` |
| HTML reports | `QnALog/HTML报告` |
| Email drafts | `QnALog/邮件草稿` |
| Segment cache | `QnALog/.cache/segments` |

> Default folders use the `QnALog/` prefix. They are ordinary paths and can be changed in settings at any time. Q&A Log is an independent project: it does not migrate data from other projects, and it does not scan or rewrite your existing notes.

## Requirements

Required:
- Obsidian 1.10.0 or later
- A speech-to-text service (cloud API or local)
- A vault folder for recordings and notes

Recommended:
- An LLM service — for the live outline, note organization, sediment, export, and template tuning
- A virtual audio device — to record system / online-meeting audio
- A real microphone — to mix in your own voice
- A domain glossary — improves recognition of names, products, organizations, and terms

## Audio input & real microphone

Capturing system audio cross-platform from the Obsidian desktop app is unreliable, so recording online meetings, web video, courses, or anything played by the computer usually needs a **virtual audio device**:

- Windows: VB-Cable
- macOS: BlackHole
- Linux: PulseAudio / PipeWire monitor source

On Windows with VB-Cable, mind the naming:
- Meeting apps, browsers, and system output → **CABLE Input**
- Q&A Log reads **CABLE Output** (a recording device)
- To also record yourself, the **real microphone must be your physical mic** — not CABLE Output, BlackHole, VoiceMeeter, or Stereo Mix

If the level meter does not move, run the device check before starting a long recording.

## Privacy, network, and file access

No ads, no analytics, no telemetry. Settings are stored locally in `.obsidian/plugins/qnalog/data.json`.

**Network use.** Q&A Log works offline unless you configure a service that needs the network. When you do, requests go only to the endpoints you configure:

- Speech-to-text requests send audio to the transcription service you configured.
- AI organization requests send transcript text and prompt context to the LLM service you configured.
- The update check requests `manifest.json` from this project's GitHub release page so the plugin can tell you a newer version exists. It never downloads or installs anything.

Recordings are saved to the local vault path you choose; there is no Q&A Log cloud and no Q&A Log server.

**Files outside your vault.** The optional external inbox feature can watch a folder outside your vault (an absolute path, for example a synced recordings directory) and import audio from it. That access happens only if you configure such a path, and it is limited to reading the files you point it at.

For sensitive content (client data, medical, legal, HR, recruiting, internal strategy), prefer local transcription with a local model, and obtain consent before recording. Details: [`PRIVACY.md`](PRIVACY.md).

## Installation

This plugin is not in the Obsidian community plugin directory. The directory's **LexVoice** entry is a different plugin — see [Relationship to LexVoice](#relationship-to-lexvoice).

### Option 1 — BRAT (works on desktop and mobile)

1. Install and enable **BRAT** from the community plugin directory.
2. In BRAT, choose **Add beta plugin** and enter `qnalog/qnalog`.
3. Install, then enable **Q&A Log** under **Settings → Community plugins**.

### Option 2 — build from source (desktop)

```bash
git clone https://github.com/qnalog/qnalog.git
cd qnalog
npm ci
npm run build
npm run install:vault -- "/path/to/your/vault"
```

`install:vault` copies `main.js`, `manifest.json`, `styles.css`, `LICENSE`, and `NOTICE` into `<vault>/.obsidian/plugins/qnalog/`, and snapshots anything it overwrites (including `data.json`) into `<vault>/.obsidian/qnalog-install-backups/<timestamp>/`. It only touches the `qnalog` folder: settings are never inherited from other plugins.

Then reload Obsidian (`Ctrl/Cmd + R`) and enable **Q&A Log**.

If the stored settings were written by a different version, the plugin discards them on first load and starts from its defaults, with a notice. Configure paths and API keys again in **Settings → Q&A Log**.

### Rolling back

Every install snapshots the plugin folder it is about to overwrite, so rollback is one command:

```bash
npm run restore:vault -- "<vault>/.obsidian/qnalog-install-backups/<timestamp>" "/path/to/your/vault"
```

`restore:vault` reads the plugin id and version from the backup's `manifest.json`, restores that folder, and snapshots your current folder first — so the rollback itself is undoable (the undo command is printed). It also tells you which plugin id Obsidian currently has enabled; add `--set-enabled` to rewrite `community-plugins.json` instead of switching in the UI. Pass the vault path explicitly when the backup lives outside a vault.

Note: the settings folder name follows the plugin id, so a build installed from source keeps its settings in `.obsidian/plugins/qnalog/` — the same folder BRAT installs into.

## Build & checks

```bash
npm ci
npm run build   # version alignment, symbol check, typecheck, esbuild bundle, mobile-load check
npm test        # vitest
npm run verify  # lint + build + test
```

## License & credits

MIT — see [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), and the maintenance policy in [`MAINTAINING.md`](MAINTAINING.md).

Copyright (c) 2026 Lynnx (original LexVoice work); modifications copyright (c) 2026 Q&A Log Team.
