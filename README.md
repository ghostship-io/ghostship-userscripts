# ghostship-userscripts

GitHub-managed Chrome userscripts for the GhostShip owner browser (ChatGPT interface and extension replacements). This repository is public: it holds code and non-secret configuration only.

## Design

- **Manager: Violentmonkey** (Chrome Web Store build 2.49.0, Manifest V3). It installs and runs on current Chrome once its "Allow User Scripts" toggle is on, is open source with no telemetry, and honours `@updateURL`/`@downloadURL` version checks. Tampermonkey is the fallback.
- **Source of truth:** `manifest.json` (id, version, `@match`, `@grant`) and `src/`. `npm run build` bundles each script into `dist/` with its metadata header, plus `dist/manifest.json` carrying every artifact's version and sha256.
- **Shared runtime** (`src/core/`): one scroll manager (only explicit user or navigation sources may move the viewport), a bounded observer hub (one shared `MutationObserver` per root, capped, batched), a durable queue state machine with an injected transport (the live dispatcher by default), a prompt index, and a virtualization backend contract. `src/chatgpt/adapter.js` holds every ChatGPT selector; if its self-check fails the runtime stays in safe mode and leaves the page untouched.
- **Reserved:** `src/chatgpt/queue/` (#630) and `src/chatgpt/virtualization/` (#629); the right rail (#628) plugs into the prompt index and scroll manager.
- **Right pane** (`src/chatgpt/rail/`, #628): one pinned pane in ChatGPT's own style. Where ChatGPT mounts its summary pane (Outputs / Sources) the script appends its sections to it, after Sources: a collapsible "Overview" minimap (a silhouette of the turn's real rendered layout in ChatGPT's own tokens: the prompt bubble, text as faint lines, code as the code-surface band, tables and images as their real boxes, the viewport box in the native accent; a turn that is not rendered is estimated from its content) above the chronological prompt list (oldest first, newest last, resting at the newest), and adds a disclosure to the native Outputs title row that collapses and expands the whole Outputs list; nothing native is moved, removed or re-created, and Sources is never touched. Where it is not mounted, one docked fallback pane of the same shape stands in and yields as soon as the native pane appears. The column is reserved once, by `rail-layout.js`: nothing when ChatGPT's pane already takes its width, otherwise only what still overlaps it (the 320px fallback column on windows at least 1024px wide; the page column that holds the header, conversation, queue panel and composer gets right padding, so they shift left and never overlap it). If the shifted conversation would be narrower than 560px, or the window is narrower than 1024px, the fallback collapses to a toggle above the composer and the page is left untouched. Each conversation keeps its own search, filter, section and Outputs collapse state, prompt-list scroll, selected prompt and reading position for the life of the page (collapse choices also across reloads, as booleans in `localStorage`). `window.__ghostshipUserscripts.pane` reports the structure only (host kind, mode, whether Outputs is collapsible). On opening a conversation (#629) the scroll controller scrolls once so the start of its latest prompt is at the top of the viewport (`runtime.open`): not when a saved reading position is restored, never after the user scrolled, never repeated while streaming.
- **Configuration:** non-secret preferences in the browser's `localStorage` (`ghostship:userscripts:config`, see `src/core/config.js`). No tokens or session data in code, URLs or logs.

## Install (owner browser)

1. Install Violentmonkey from the Chrome Web Store. In `chrome://extensions`, open its Details and turn on **Allow User Scripts** (the extension cannot run scripts without it).
2. Open the raw URL below and confirm **Install** (installing from this URL is what makes the manager update from it):

`https://raw.githubusercontent.com/ghostship-io/ghostship-userscripts/main/dist/ghostship-chatgpt.user.js`

3. Reload chatgpt.com and check `window.__ghostshipUserscripts` in the page: `version` is the running build and `mode` is `active` (or `safe` when ChatGPT's markup is not recognised; the script then changes nothing).

The queue is live: queued messages are sent through ChatGPT's own composer, and Interrupt & Send Next clicks Stop and then sends the next message. Set `{"dryRun":true}` in the config (`ghostship:userscripts:config` in localStorage) to test without sending; the panel then shows a "Dry run" badge.

## Update

The script's `@updateURL` points at `dist/<id>.meta.js` on `main` and the manager installs a new `dist/<id>.user.js` when its `@version` is higher. To release: change `src/`, run `npm run bump -- <id> <patch|minor|major>`, `npm run build`, commit `dist/`, merge to `main`. The update channel is GitHub over HTTPS only; verify an artifact against `dist/manifest.json` (`sha256sum`).

Violentmonkey checks for updates every **1 day** (Settings, "Check for script updates every N day(s)"; the smallest non-zero value, left at the default). GitHub's raw host may serve a cached file for a few minutes after a merge. To update immediately: Violentmonkey dashboard, Installed scripts, the refresh icon on the script (or the toolbar refresh button for all scripts), then reload chatgpt.com.

## Rollback and pinning

Managers only move to a strictly higher `@version`, so roll back by `git revert` of the bad change, then bump and build as above; the manager picks the fix up on its next check.

To pin a build, install from an immutable tag or commit URL (`https://raw.githubusercontent.com/ghostship-io/ghostship-userscripts/<tag-or-sha>/dist/<id>.user.js`) and turn off that script's automatic update (Violentmonkey, script settings, uncheck "Update"). To follow `main` again, reinstall from the `main` URL above.

To switch the script off without removing it, use the Violentmonkey toggle for the script; removing the script removes its stored settings.

## Local validation

```sh
npm ci
npm test
```

Run `npm run gate` for the dry-run acceptance gate (bundled script against fixtures, queue fault injection; no live traffic) and see `docs/profiling.md` for the read-only real-thread profiling procedure.

`npm test` builds, then runs unit tests and DOM-fixture tests (jsdom) and the repository checks (manifest, dist freshness and hashes, no network primitives, public-repo hygiene). No test contacts chatgpt.com.
