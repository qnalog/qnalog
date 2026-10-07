# QnALog

English | [简体中文](README.zh-CN.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/qnalog-lockup-reversed.svg">
    <img src="docs/brand/qnalog-lockup.svg" alt="QnALog" width="298" height="96">
  </picture>
</p>

Record or import audio, transcribe it, and organize the conversation into Markdown notes in Obsidian. QnALog includes no API keys, requires no QnALog account, and uses services you choose. Requires Obsidian 1.11.4 or later.

[Installation](#installation) · [First-time setup](#first-time-setup) · [Basic usage](#basic-usage) · [Features](#features) · [Files and folders](#files-and-folders) · [Privacy and network](#privacy-network-and-updates)

## Installation

### Community plugin directory (recommended)

1. In Obsidian, open **Settings → Community plugins** and browse the directory.
2. Search for **QnALog**, install it, then enable it.

### BRAT

1. Install and enable **BRAT** from the community plugin directory.
2. In BRAT, choose **Add beta plugin** and enter `qnalog/qnalog`.
3. Install, then enable **QnALog** under **Settings → Community plugins**.

### Manual release installation

Download `main.js`, `manifest.json`, `styles.css`, `LICENSE`, and `NOTICE` from the [releases page](https://github.com/qnalog/qnalog/releases) into `<vault>/.obsidian/plugins/qnalog/`. This manual method does not create an installation backup. For source installation and rollback, see [Source installation and rollback](#source-installation-and-rollback).

## First-time setup

1. Open **Settings → QnALog**. Choose **Setup Wizard** to select a preset, enter the required API key and model details, test the services, then choose **Apply and start**.
2. Open **Settings → QnALog → Open sidebar**. The wizard may appear automatically on first enable when setup is incomplete; reopen it from the settings home at any time.
3. **Quick config** is a separate shortcut for a preset configuration. If a setup is already present, confirm before replacing it. To configure services individually, open **Settings → QnALog → API**.

Recording transcription needs a configured speech-to-text (ASR) service. Importing a complete audio file may use a separate transcription service. AI organization, questions, knowledge extraction, and generated reports need a configured large language model (LLM); an ASR key alone does not enable those features. You can use local services where supported.

## Basic usage

1. Open the **QnALog live minutes panel** from the left ribbon. The Obsidian toolbar shows a monochrome Q icon that follows the theme.

   <picture>
     <source media="(prefers-color-scheme: dark)" srcset="docs/brand/qnalog-mark-reversed.svg">
     <img src="docs/brand/qnalog-mark.svg" alt="QnALog panel icon" width="32" height="32">
   </picture>

2. Choose a template and audio input, then check that the level meter reacts.
3. Start recording. Follow the live outline and add markers or notes as needed.
4. Stop recording and follow transcription, AI organization, and Markdown writing in **Task progress**. Retry from the failed step if processing stops.
5. Use the **Distill** and **Q&A** tabs as needed, or generate a report from a completed note.

The sidebar tabs are **Outline**, **Distill**, **Q&A**, and **Notes**. They show the live outline and markers, reviewable knowledge candidates, questions about a note, and the note list. **Minutes Board** is a separate view, opened with its command or the button in the panel; it is not a fifth tab.

The 1.6.1 interface follows the active light or dark theme and supports narrow panels, visible keyboard focus, and reduced-motion preferences.

## Features

### Outline and live markers

Chapters grow during recording and link to the audio position. After recording, AI can complete the outline. To rebuild only an outline, choose **Rebuild outline from all transcripts** in the completed note's sidebar. QnALog saves a backup at `<vault>/<configDir>/qnalog-outline-backups/<timestamp>/<filename>` before replacing outline details. If generation fails or is incomplete, or the note changes during generation, the existing note is not replaced. The action does not change the note body.

During recording, markers support `#term` (explain a term), `?question` (ask about the current discussion), `!highlight` (mark an important point), `@assignee` (suggest a todo owner), and `/todo` (mark a todo candidate). Half-width and full-width symbols are accepted. These notes are labeled supplementary material in the organization prompt; they are not presented as transcript text.

### Continue a recording and preserve its sources

Choose **Append recording to this note** from the open note's sidebar, the file menu, or the floating control. QnALog verifies the target note, records into a separate pending note, and waits for active processing and transcription tasks before merging. If a merge fails, the staged note and audio remain available for retry. If the target disappears or its transcript identity changes, the separate recording is kept rather than written to a different note. Continued recordings accumulate audio sources and retain their source references and continuous numbering.

Transcribed notes preserve the original speech-to-text text and revision history. Decisions, actions, questions, and topics can link to transcript passages; changed passages are marked stale. Evidence is included with existing organization requests rather than sent in a separate extraction request.

<details>
<summary>Original, derived, and clean-copy versions</summary>

Before the first derived version, QnALog caches recoverable original text. If the snapshot or its index cannot be saved or verified, it does not replace the source. **Generate Clean Copy** creates a separate file and activates that version in the source note. Regular reorganization creates a derived Markdown file and a `minutes` cache but does not activate the derived version automatically. The `.versions` cache is not a substitute for Obsidian file history.

</details>

### Long content, task progress, and recovery

For standard meeting and learning-note modes, long recordings are organized in parts with local checkpoints, then assembled in time order. If a request is interrupted or the model reaches its output limit, completed parts are reused and unfinished parts can be retried. Incomplete work is shown as partially completed, not as an empty note.

The processing panel separates transcription, AI organization, and Markdown writing, and shows the active stage, failures, and retry or cancel actions. Supported failed tasks can resume from the failed step. Unknown or damaged queue records are paused with their original data and references retained; inspect the pending queue for the reason. A paused damaged record is not automatically repaired by retry.

### Distill and the knowledge library

Knowledge extraction is user-initiated by default. Optional automatic extraction is off by default; when enabled, it automatically writes todo candidates only. People and glossary candidates still require review or maintenance.

People can be kept, merged, or ignored. Confirmed todos become standalone cards; terms can be maintained in the glossary. The sidebar can assemble confirmed todos into a todo wall, and knowledge items retain source links. Candidate todos support inline edits to owner, due date, and subtasks.

### Notes, board, and deliverables

The note list can group recent notes by folder or time, with search and template filters. **Minutes Board** is a separate view for saved meeting materials.

HTML and PDF reports are generated from a note by calling the configured LLM; they do not modify the original note. HTML and PDF are available from commands and the note list's context menu under **Generate**. PDF generation requires desktop Obsidian and very tall single-page reports have a height limit; use HTML for complete reading.

The note list's **Generate** menu can also create an `.eml` email draft. It can contain a summary and attachments including the original Markdown, a generated PDF, or existing exported files; recipients can be matched from the people library. Review and send the draft in your email client. QnALog does not send email automatically.

### Recording reliability

- Level meters help check microphone and system audio input before and during recording. Device checks are available in settings.
- Inputs remain user-selectable. Compatible independent multichannel inputs can be transcribed by channel; separation stays off when independent channels cannot be verified.
- Deleting a transcript offers to delete its audio file too.
- Short-recording filtering is on by default. A new recording under 3 seconds is discarded; one from 3 to under 10 seconds keeps audio only. You can import audio manually. If filtering is turned off, short recordings follow the ordinary processing flow. Imported audio bypasses this filter. Continued recordings still discard audio under 3 seconds, while 3 to under 10 seconds is appended normally.

## Files and folders

These are default locations; folders and files are created as needed. The segment cache is temporary processing storage, not a place to organize notes.

| Content | Default path |
|---|---|
| Recordings | `QnALog/Recordings` |
| Transcribed notes | `QnALog/Transcribed notes` |
| Meeting materials | `QnALog/Meeting materials` |
| People | `QnALog/Library/People` |
| Todo cards | `QnALog/Library/Todos` |
| Views | `QnALog/Library/Views` |
| Glossary | `QnALog/Library/Glossary.md` |
| Diagnostics log | `QnALog/System/Diagnostics log` |
| Archive | `QnALog/Library/Archive` |
| HTML reports | `QnALog/HTML reports` |
| Email drafts | `QnALog/Email drafts` |
| Segment cache | `QnALog/.cache/segments` |

Saved configurable paths do not change when the interface language changes, and existing files are not moved. Unset paths and computed defaults such as the email-draft location use the current resolved interface language: Chinese uses Chinese directory names; other resolved languages use English names. Obsidian determines the interface language by default. The email-draft location has no separate setting. Cache locations are not user-configurable folder settings.

## Platform and audio setup

QnALog supports desktop and mobile Obsidian. Mobile recording uses the device microphone and transcription can use segmented or whole-file HTTP requests. System audio, virtual devices, multichannel capture, desktop device diagnostics, and realtime WebSocket transcription require the desktop app.

Capturing computer audio usually needs a virtual audio device:

- Windows: VB-Cable
- macOS: BlackHole
- Linux: PulseAudio / PipeWire monitor source

With VB-Cable, meeting apps, browsers, and system output go to **CABLE Input**; QnALog reads **CABLE Output** as a recording device. To record yourself as well, select your physical microphone as the microphone input. See **Settings → QnALog → Recording** for device selection and checks.

## Privacy, network, and updates

QnALog requires no QnALog account and has no QnALog-operated backend, ads, analytics, or telemetry. Settings, queue items, and context are stored in `.obsidian/plugins/qnalog/data.json`. Current API keys use Obsidian SecretStorage; older data and install backups may still contain plaintext or obfuscated keys. SecretStorage behavior across installations or sync is not guaranteed, so re-enter keys that are missing. See [`PRIVACY.md`](PRIVACY.md) and [`SECURITY.md`](SECURITY.md).

Network requests depend on the feature you use:

- Transcription sends audio to the configured speech-to-text service.
- Organization, Q&A, knowledge extraction, and report generation send relevant text and prompts to the configured LLM. Manual service tests and model-list retrieval can also make requests.
- When you click **Check for updates** in Settings → About or run **Check for Updates** from the command palette, QnALog reads this repository's `main` branch `manifest.json` from raw GitHub or jsDelivr mirrors. There is no background update check; QnALog does not download or install plugin files. Obsidian or BRAT manages installation.

The optional desktop external-import feature reads audio from the one directory you select, copies it into the vault's QnALog cache, and stores import state in the plugin directory. It leaves source files in place. Transcription and organization of imported audio still use your configured services.

For sensitive content, use local services where practical and obtain consent before recording. Provider terms apply to content you send to a third-party service.

## Source installation and rollback

Source installation is for desktop. It builds the committed source and backs up the existing plugin directory before copying files, including `data.json`:

```bash
git clone https://github.com/qnalog/qnalog.git
cd qnalog
npm ci
npm run build
npm run install:vault -- "/path/to/your/vault"
```

The installer copies `main.js`, `manifest.json`, `styles.css`, `LICENSE`, and `NOTICE` into `<vault>/.obsidian/plugins/qnalog/`. Its backup is stored under `<vault>/.obsidian/qnalog-install-backups/<timestamp>/`. The community directory and BRAT manage their own installations.

Settings with the same schema version are read as-is. Recognized releases from version 1 onward migrate forward when a migration path exists, preserving user configuration. A higher on-disk version is read-only and is not overwritten. If the source version cannot be identified, the original file is backed up under `<plugin folder>/settings-backups/` before defaults are used. These rules do not guarantee migration from every older version.

To restore an installation backup:

```bash
npm run restore:vault -- "<vault>/.obsidian/qnalog-install-backups/<timestamp>" "/path/to/your/vault"
```

`restore:vault` saves the current plugin directory before restoring, making the restore reversible. It rejects unsafe plugin ids and linked or overlapping restore paths. Add `--set-enabled` to update `community-plugins.json`; otherwise switch plugins in Obsidian. Pass the vault path when the backup is outside a vault. Restoring an older build may leave newer settings read-only, and restoring files does not guarantee recovery of SecretStorage keys from another installation.

## Project background

QnALog is derived from [LexVoice](https://github.com/Lynn-x/LexVoice), based on its last MIT-licensed release (2.1.2). It is independently maintained. See [`NOTICE`](NOTICE) and [`MAINTAINING.md`](MAINTAINING.md) for origin and licensing details.

QnALog does not inherit settings or migrate notes from the predecessor project. It does not scan or rewrite existing notes on load. The plugin id is `qnalog`, distinct from the predecessor's id, and written data uses the QnALog namespace.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development commands and contribution guidance. The maintenance workflow and validation requirements are in [`MAINTAINING.md`](MAINTAINING.md).

## License & credits

MIT — see [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), and [`MAINTAINING.md`](MAINTAINING.md).

Copyright (c) 2026 Lynnx (original work); modifications copyright (c) 2026 Q&A Log Team.
