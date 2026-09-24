# Contributing

Q&A Log is an MIT-licensed Obsidian plugin: it records conversations and turns them into structured Markdown notes. Source lineage with the upstream project and the license boundary are recorded in `NOTICE` and `MAINTAINING.md`.

## Read first

- [MAINTAINING.md](MAINTAINING.md) is the working manual: architecture boundaries, license limits, project identity, versioning, and the release process. It is written in Chinese.
- [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md) describe features and setup for users.

## Development

```bash
npm ci            # locked install; byte-for-byte rebuildable artifacts depend on it
npm run verify    # lint + build + tests + isolation gates
npm run verify:push   # verify + bundle consistency; run this before every push
```

Facts to know before changing code:

- `main.js` is a committed build artifact. After changing `src/`, run `npm run build` and commit `main.js` in the same commit — CI rebuilds from a clean checkout and rejects any byte mismatch.
- The version number lives in four files (`manifest.json`, `package.json`, `package-lock.json`, `versions.json`); `npm run check:versions` fails the build if they drift.
- All project identifiers use the `qnalog` namespace (tags `qnalog/*`, folders `QnALog/`, CSS `qnalog-*`, frontmatter keys `qnalog_*`). References to the upstream repository or its update sources are rejected by CI (`check:mainline-isolation`).

## Pull requests

- Target `main`. One problem per PR.
- Describe what changed, why, and how you verified it; include the `npm run verify:push` result.
- Behavior changes need tests. Bug fixes need a test that fails before the fix.
- New settings keys must be registered in both `normalizePluginSettings` and `serializePluginSettings` (`src/shared/settings-io.ts`), or the next save drops them silently; add a round-trip test.

## Reporting bugs

Use the bug report template. When it asks for the diagnostic report: Settings → About → Diagnostics & Logs → **Copy diagnostic report**. The report automatically masks API keys, tokens, user directories, and the vault path; it never contains audio, transcript text, or prompt contents.
