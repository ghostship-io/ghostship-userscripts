# ghostship-userscripts

GitHub-managed Chrome userscripts for the GhostShip owner browser (ChatGPT interface and extension replacements). This repository is public: it holds code and non-secret configuration only.

## Design

- **Manager: Violentmonkey** (Chrome Web Store build 2.49.0, Manifest V3). It installs and runs on current Chrome once its "Allow User Scripts" toggle is on, is open source with no telemetry, and honours `@updateURL`/`@downloadURL` version checks. Tampermonkey is the fallback.
- **Source of truth:** `manifest.json` (id, version, `@match`, `@grant`) and `src/`. `npm run build` bundles each script into `dist/` with its metadata header, plus `dist/manifest.json` carrying every artifact's version and sha256.
- **Shared runtime** (`src/core/`): one scroll manager (only explicit user or navigation sources may move the viewport), a bounded observer hub (one shared `MutationObserver` per root, capped, batched), a durable queue (one accumulating prompt per conversation) with an injected transport (the live dispatcher by default), a prompt index, and a virtualization backend contract. `src/chatgpt/adapter.js` holds every ChatGPT selector; if its self-check fails the runtime stays in safe mode and leaves the page untouched.
- **Queue** (`src/chatgpt/queue/`, #630): ONE pending prompt per account + conversation, shown in a card directly above ChatGPT's native composer; the native composer is the only place text is entered or edited. While a response is running, plain Enter there (not Shift+Enter, not during IME composition) appends the composer text to that prompt, separated by exactly one blank line, instead of sending or steering; a form submit or native Send/steer click is treated the same. The card offers Queue (append), Edit (the whole text goes into the native composer; Enter saves it under the same id, Escape cancels and restores the previous draft), Delete, Steer (the native steer control when the page shows one, otherwise a confirmed Stop then one send), Interrupt & Send Next (confirmed Stop, then one send) and Pause/Resume, all acting on the whole text. Automatic dispatch waits until the response has settled and native Send is enabled, then sends the merged text once; waiting is not an attempt and nothing is retried. A send claims an immutable in-flight snapshot, so a later addition starts the next pending prompt; an unacknowledged send goes to review and is never resent. State lives in IndexedDB (`pending`, `inflight`, `state`, `locks` stores; the previous release's per-message `items` store is kept untouched as the recovery copy of its rows, which are folded in their original order on upgrade).
- **Reserved:** `src/chatgpt/virtualization/` (#629); the right rail (#628) plugs into the prompt index and scroll manager.
- **Right rail** (`src/chatgpt/rail/`): the "Conversation overview" minimap above the chronological prompt list (oldest first, newest last, resting at the newest). On windows at least 1024px wide its 320px column is reserved in the page: the page column that holds the header, conversation, queue panel and composer gets right padding, so they shift left by only what the rail needs (nothing when the natural right gutter already fits) and never overlap it; if the shifted conversation would be narrower than 560px, or the window is narrower than 1024px, the rail collapses to a toggle and the page is left untouched. Each conversation keeps its own search, filter, panel state, prompt-list scroll, selected prompt and reading position for the life of the page (in memory only; a conversation read at its newest message is not scrolled on return).
- **Configuration:** non-secret preferences in the browser's `localStorage` (`ghostship:userscripts:config`, see `src/core/config.js`). No tokens or session data in code, URLs or logs.

## Install (owner browser)

1. Install Violentmonkey from the Chrome Web Store. In `chrome://extensions`, open its Details and turn on **Allow User Scripts** (the extension cannot run scripts without it).
2. Open the raw URL below and confirm **Install** (installing from this URL is what makes the manager update from it):

`https://raw.githubusercontent.com/ghostship-io/ghostship-userscripts/main/dist/ghostship-chatgpt.user.js`

3. Reload chatgpt.com and check `window.__ghostshipUserscripts` in the page: `version` is the running build and `mode` is `active` (or `safe` when ChatGPT's markup is not recognised; the script then changes nothing).

The queue is live: the queued prompt is sent through ChatGPT's own composer, and Interrupt & Send Next clicks Stop and then sends the whole prompt once. Set `{"dryRun":true}` in the config (`ghostship:userscripts:config` in localStorage) to test without sending; the panel then shows a "Dry run" badge.

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
