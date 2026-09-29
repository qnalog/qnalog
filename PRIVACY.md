# Privacy

This document describes QnALog (see [`README.md`](README.md) and [`NOTICE`](NOTICE) for its origin in LexVoice 2.1.2). LexVoice releases 2.2.0 and later are separate, proprietary builds whose data handling is outside the scope of this document.

QnALog is an Obsidian plugin for recording, transcription, and AI-assisted note organization. It runs on desktop and mobile.

## Local data

QnALog stores plugin settings locally in your vault under:

```
.obsidian/plugins/qnalog/data.json
```

This file may contain service addresses, model names, prompt templates, queue items, and user-entered context. It is intentionally excluded from the repository by `.gitignore` and should not be committed or shared. Current API keys are stored through Obsidian SecretStorage and are not written to `data.json` after migration. Older plugin data and install backups may still contain API keys in plaintext or obfuscated form. The Obsidian API reference does not specify whether SecretStorage syncs or how it stores values; verify key availability on each installation.

## Network access

QnALog does not include analytics, advertising, or telemetry. It may make network requests only when you use or enable features that require them:

- Speech-to-text requests send audio data to the transcription service configured by the user.
- AI organization requests send transcript text and prompt context to the large-language-model service configured by the user.
- Update checks request `manifest.json` only, from this repository's `main` branch (raw source and jsDelivr mirrors). The plugin compares the version and, if a newer one exists, points you at the GitHub release page. It never downloads or installs plugin files, and it does not update itself. The update source is a fixed constant and is not user-configurable.
- Documentation links in settings open external web pages in the system browser.

If recording is enabled, audio files are saved only to the local Obsidian vault path chosen by the user. The current version has no QnALog backend: it does not operate its own cloud storage service and does not upload recordings, transcripts, or notes to any server of its own.

An optional paid subscription may be added later for users who do not want to manage API keys: they sign in and transcription and AI organization run through that service without any provider setup. The subscription is optional. If a user turns it on, the audio and text of a recording are sent to that service instead of the user's own endpoints; recordings and notes are still written to the vault. If it stays off, only the requests listed above are made.

If you configure a third-party API provider, that provider's own terms and privacy policy apply to the content you send to it.

## Sensitive content

Recordings and transcripts may contain personal, confidential, or regulated information. Users are responsible for obtaining consent where required and for choosing appropriate API providers and retention practices.

If content is confidential, private, client-related, medical, legal, HR-related, or otherwise sensitive, use local speech-to-text and a local large-language model. Do not process sensitive content through cloud APIs unless you have confirmed that doing so is acceptable for your use case and compliance obligations.
