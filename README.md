# 🌙 pi-background-compaction

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://github.com/earendil-works/pi)
[![Install from Git](https://img.shields.io/badge/install-Git-blue)](https://github.com/AHGGG/pi-background-compaction)
[![MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Prepare a compaction checkpoint while Pi continues working, then apply it at a safe boundary.
This optional extension owns background scheduling, settings and UI; a compatible compaction engine owns provider requests and checkpoint validation.

## ✨ Features

- Start preparation after a completed turn when context usage reaches your chosen threshold.
- Reuse prepared work for compaction, with optional automatic application after a model/tool batch or at an idle boundary.
- Cancel stale work on session, model or settings changes; pause on genuine preparation/application failures.
- Preserve existing background preferences from `pi-codex-compact.json` without rewriting that file.

## 📦 Install

This is a Git-distributed package, not an npm release. Extensions run with Pi's permissions: install only code you trust.
Background preparation is experimental and can consume provider quota even if its result is never used.

Update the compatible engine in [AHGGG/pi-extensions](https://github.com/AHGGG/pi-extensions/tree/main/packages/pi-codex-compact), then install this companion:

```sh
pi install git:github.com/AHGGG/pi-background-compaction@master
```

Keep `packages/pi-codex-compact/src/index.ts` enabled in your `pi-extensions` package selection and add this package separately.
Do not enable the old built-in background controller alongside this companion: update both packages, then restart Pi.
A missing or incompatible engine does not trigger preparation; this package does not contain a second compaction engine.

For a local checkout, install dependencies before loading the source entrypoint; no generated build is required:

```sh
npm install
pi -e ./src/index.ts
```

The companion can be removed without removing manual compaction or the engine's saved-checkpoint replay support.

## 🚀 Quick start

1. Restart Pi after updating the engine and installing the companion.
2. Open `/background-compaction`, then **Settings**.
3. Enable **Background preparation**. Enable **Apply when ready** separately if desired.

Previously saved opt-ins are inherited automatically when the new settings file does not exist.
Use **Status** to see whether the current preferences came from the legacy file.

## 🧭 How it works

```text
Completed turn → threshold reached → prepare in background
                                           ↓
                                    checkpoint ready
                                           ↓
                     safe Pi boundary → engine validates → Pi commits
```

The engine remains the sole owner of the foreground compaction hook and opaque checkpoint format.
The companion chooses when to prepare and request application; it cannot bypass engine validation.
A readiness notification is not a committed compaction. Success is confirmed from Pi's persisted checkpoint.

## 💬 Commands

- `/background-compaction` opens Settings, Status and Help in TUI mode; in RPC it reports the settings path.
- `/background-compaction resume` clears the session-only failure pause so preparation can start after the next completed turn. It performs this direct operation in all modes without opening interactive UI.

Unknown or trailing arguments are rejected. The interactive menu is unavailable in print/JSON mode.
Manual `/compact` remains an engine/Pi operation, not a separate implementation in this package.

## ⚙️ Settings

User settings live at `<getAgentDir()>/pi-background-compaction.json` (normally `~/.pi/agent/pi-background-compaction.json`).
There are no project overrides or extension-specific environment variables.
Settings reload at session start, including `/reload`; menu changes apply immediately after a successful save.
Escape closes the menu without undoing changes already saved.

| Field | Default | Accepted values |
| --- | --- | --- |
| `asyncEnabled` | `false` | Boolean; opt in to preparation |
| `asyncAutoApply` | `false` | Boolean; apply ready work automatically |
| `asyncThresholdPercent` | `65` | Integer from 1 to 99 |
| `logCompaction` | `false` | Boolean; show lifecycle notices |

Request timeout, provider protocol, retry policy and checkpoint retention remain engine settings.

### Migration and persistence

If you previously used background controls inside `/codex-compact`, use `/background-compaction` for those controls and `/background-compaction resume` to clear a failure pause. Do not rely on `/codex-compact resume`: the engine does not own the companion's commands. `/codex-compact` still controls the engine's foreground compaction settings.

When the new file is absent, the companion reads only the four fields above from the adjacent `pi-codex-compact.json`.
It never changes or removes that legacy file. Do not delete the four legacy background fields before saving your preferences in the new menu. The first explicit save writes the inherited background preferences plus your change to the new file, without copying provider/authentication settings.
If both files exist, the new file wins entirely; missing fields use defaults rather than legacy values.

A missing file causes no filesystem writes. Invalid files are reported and block saving until repaired, rather than being overwritten with defaults.
Unknown fields in the new file are preserved. Saves use a private temporary file followed by rename and are ordered within this process; this is not a cross-process locking guarantee.
Failed saves keep the previous effective preferences.

## 🔒 Security and privacy

Preparation sends session context through the installed engine's existing provider route and authentication.
This package does not store credentials or make independent provider requests.
Lifecycle notices contain fixed diagnostic reasons rather than prompts or tokens.

## 🚧 Limitations

- Requires a compatible engine implementing the versioned prepared-compaction protocol. Installing this companion alone does not add provider support.
- A changed branch, model, provider identity, tool set or preparation-affecting settings can invalidate prepared work.
- Automatic application of a stale checkpoint cancels; it must not silently start a replacement inference request.
- Background work may not be useful when a session changes quickly or the unprepared tail grows too large.

## 🗂️ Package layout

- `src/index.ts`: Pi source entrypoint.
- `src/`: background controller, versioned engine protocol, settings and menu.
- `test/`: independent deterministic tests with a fake engine.
- `integration/`: relocated engine/companion integration regressions; see the integration runner.

From a checkout, run `npm run check` and `npm test` for the standalone package.
Run `npm run test:integration -- /path/to/pi-extensions` to test the pair against an explicit engine checkout.

## 🔎 Keywords

Pi, background compaction, asynchronous compaction, prepared checkpoints, safe boundaries.

## 📄 License

[MIT](LICENSE). Extracted from the MIT-licensed Pi extensions implementation; the original Narumi copyright notice is retained.
