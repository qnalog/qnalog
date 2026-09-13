# Security Policy

## Supported versions

QnALog is maintained on the `main` branch. It is based on LexVoice 2.1.2, the last release of that project published under the MIT License; LexVoice 2.2.0 and later are separate, proprietary builds and are not covered by this policy.

## Reporting a vulnerability

Report suspected vulnerabilities privately to this repository's maintainer rather than opening a public issue with exploit details. If a private reporting channel is not available, open a minimal public issue asking for a secure contact path. If the issue also affects upstream 2.2.0 or later, report it upstream as well.

## Notes for users

- Do not publish `.obsidian/plugins/qnalog/data.json`; it may contain API keys and prompt/context data.
- Use your own API keys and rotate them if they were ever committed or shared.
- Review configured transcription and AI endpoints before sending sensitive recordings.
