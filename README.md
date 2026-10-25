# ghostship-userscripts

GitHub-managed Chrome userscripts for the GhostShip owner browser (ChatGPT interface and extension replacements). This repository is public: it holds code and non-secret configuration only.

## Design

- **Manager: Violentmonkey.** Open source, no telemetry, honours `@updateURL`/`@downloadURL` version checks, per-script update toggle for pinning, and needs no account to sync. Tampermonkey is the fallback (closed source, more permissions). Chrome's MV3 userscript support is checked when the manager is installed in the personal browser (a later packet); nothing here depends on the manager beyond the standard metadata block.
- **Source of truth:** `manifest.json` (id, version, `@match`, `@grant`) and `src/`. `npm run build` bundles each script into `dist/` with its metadata header, plus `dist/manifest.json` carrying every artifact's version and sha256.
- **Shared runtime** (`src/core/`): one scroll manager (only explicit user or navigation sources may move the viewport), a bounded observer hub (one shared `MutationObserver` per root, capped, batched), a pure queue state machine with an injected, dry-run-by-default transport, a prompt index, and a virtualization backend contract. `src/chatgpt/adapter.js` holds every ChatGPT selector; if its self-check fails the runtime stays in safe mode and leaves the page untouched.
- **Reserved:** `src/chatgpt/queue/` (#630) and `src/chatgpt/virtualization/` (#629); the right rail (#628) plugs into the prompt index and scroll manager.
- **Configuration:** non-secret preferences in the browser's `localStorage` (`ghostship:userscripts:config`, see `src/core/config.js`). No tokens or session data in code, URLs or logs.

## Install

Open the raw URL in a browser with Violentmonkey installed and confirm the install:

`https://raw.githubusercontent.com/ghostship-io/ghostship-userscripts/main/dist/ghostship-chatgpt.user.js`

## Update

The script's `@updateURL` points at `dist/<id>.meta.js` on `main` and the manager installs a new `dist/<id>.user.js` when its `@version` is higher. To release: change `src/`, run `npm run bump -- <id> <patch|minor|major>`, `npm run build`, commit `dist/`, merge to `main`. The update channel is GitHub over HTTPS only; verify an artifact against `dist/manifest.json` (`sha256sum`).

## Rollback and pinning

Managers only move to a strictly higher `@version`, so roll back by `git revert` of the bad change, then bump and build as above.

To pin, install from an immutable tag or commit URL (`https://raw.githubusercontent.com/ghostship-io/ghostship-userscripts/<tag-or-sha>/dist/<id>.user.js`) and turn off that script's automatic update in the manager.

## Local validation

```sh
npm ci
npm test
```

Builds, then runs unit tests and DOM-fixture tests (jsdom) and the repository checks (manifest, dist freshness and hashes, no network primitives, public-repo hygiene). No test contacts chatgpt.com.
