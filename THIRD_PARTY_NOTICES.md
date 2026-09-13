# Third-Party Notices

QnALog does not bundle third-party library source code or third-party media assets in this plugin folder. The plugin is shipped as a single `main.js` file plus stylesheet and manifest. No `node_modules` is included or required at runtime.

## Runtime platform

- Obsidian API: this build runs as an Obsidian plugin and uses Obsidian's plugin API. Obsidian and its API belong to the Obsidian team.
- Electron / browser APIs: desktop-only recording and external-link behavior may rely on APIs available in Obsidian's desktop runtime, including the `MediaRecorder`, `AudioContext`, and `WebSocket` interfaces, and the optional Node `ws` module exposed by Obsidian's renderer.

## Optional external services

QnALog can be configured to call external transcription or AI services. The plugin sends audio, transcript text, or prompt context to whichever endpoint the user configures. Supported integration shapes include:

- SiliconFlow audio transcription (HTTP, OpenAI-compatible)
- OpenAI audio transcription (HTTP, e.g. `gpt-4o-transcribe`)
- OpenAI Realtime API for streaming transcription (`gpt-realtime-whisper`) and live translation (`gpt-realtime-translate`)
- Alibaba Cloud Model Studio / DashScope `paraformer-realtime-v2` over WebSocket
- OpenAI-compatible chat completion endpoints for note organization
- Local transcription services that expose an OpenAI-compatible HTTP endpoint (e.g. faster-whisper-server, Xinference, whisper.cpp wrappers)

These services are not bundled with QnALog. Their trademarks, documentation, APIs, and terms belong to their respective owners. The plugin's protocol implementations were written based on the publicly available API documentation of each provider; no code was copied from those providers.

## Optional audio tools

The README and in-app guidance may mention virtual audio tools such as VB-Cable, BlackHole, PulseAudio, and PipeWire. These tools are not bundled with QnALog. Users should follow each project's own license and installation guidance.

## Design inspiration

QnALog's HTML PPT feature was inspired by the HTML-first slide-deck workflow and design principles documented in:

- Huashu Design: https://github.com/alchaincyf/huashu-design
- Notice requested by that project: `Derived from alchaincyf/huashu-design`
- Guizang PPT Skill: https://github.com/op7418/guizang-ppt-skill

QnALog does not bundle, copy, or redistribute Huashu Design or Guizang PPT Skill source code, scripts, assets, demos, generated media, templates, or starter components. The QnALog HTML/PPTX renderer and prompt workflow are implemented independently for this plugin.

Huashu Design is distributed under its own Personal Use License. That license applies to Huashu Design itself and any use of its protected work; QnALog's MIT License does not grant rights to Huashu Design. If future QnALog changes copy or adapt Huashu Design code, assets, scripts, demos, or other protected materials, those changes must be reviewed separately, carry the required notices, and obtain any authorization required by Huashu Design's license before publication.

Guizang PPT Skill is distributed under the MIT License. QnALog references its publicly documented design workflow ideas, including slide rhythm, fixed layout discipline, and visual checklist thinking, but does not copy its implementation.

QnALog's learning-card wall uses an independently written Obsidian Bases configuration inspired by the simple card-wall structure in PaperBell:

- Obsidian-PaperBell: https://github.com/PaperBell-Org/Obsidian-PaperBell
- Referenced file: `PaperBell/Cards/00. 概念墙.base`

Obsidian-PaperBell is distributed under the MIT License. QnALog does not bundle or redistribute PaperBell vault content, templates, media, or project files; the QnALog Base files are generated from the user's local settings and folders.

## AI assistance

This plugin was developed with AI-assisted programming. All third-party APIs were integrated from public documentation, not from copied source code. Any future contribution that adapts code from another project must document the source, license, and notice in this file before being merged.

## Trademarks

Names such as Obsidian, OpenAI, GPT, Whisper, Alibaba Cloud, Paraformer, SiliconFlow, BlackHole, VB-Cable, and Xinference are the trademarks of their respective owners and are used here only to describe interoperability. QnALog is not affiliated with, endorsed by, or sponsored by any of these projects or companies.
