# AGENTS.md

- Test command: `npm ci && npm test` (builds `dist/`, then runs every test; CI runs the same).
- **The published script runs the queue live** (owner decision): `src/chatgpt/queue/live-dispatcher.js` fills the real composer and clicks Send/Stop through the adapter's selectors, and is the only file in `src/` allowed to `.click()`. `config.dryRun` is an opt-in for testing that swaps in the no-side-effect dispatcher. **You never send anything live yourself:** tests and local validation use DOM fixtures in `tests/fixtures/` only; never load chatgpt.com, send a prompt, or click native Send/Stop from a test or script. A banned-primitive test blocks `fetch`, `XMLHttpRequest`, `requestSubmit` and `.click()` outside the live dispatcher. Live ChatGPT tests need the owner's approved budget (#625) and run outside this repo's CI.
- Gate command: `npm run gate` (rebuilds, then runs `tests/gate/*.gate.js` against the bundled script and writes `build/gate-report.json`). It is the acceptance gate for #631 (fixtures and fault injection only, no live traffic); CI runs it. Never weaken or skip a gate case; a failing case blocks any live test.
- Profiling: `docs/profiling.md`. `profiling/measure.js` must stay read-only (a test scans it); run it against real threads only as that document says.
- Commit `dist/` with every source change (`npm run build`); CI fails on a stale `dist/`. Bump the version with `npm run bump -- <id> <patch|minor|major>`; managers ignore non-increasing versions.
- ResizeObserver is allowed only in `src/chatgpt/virtualization/backend.js` (active turn elements only); everything else observes through the hub.
- Startup is `src/core/boot.js`: it waits (one bounded observer, visible give-up) for the layout, restarts on route changes and root replacement, and a composer without turns (new chat) runs composer-only. Never add a one-shot layout check at script start.
- All scroll writes go through `src/core/scroll-manager.js`; all DOM observation through `src/core/observers.js`; all ChatGPT selectors live in `src/chatgpt/adapter.js`.
- Public repository: no private data, profile paths, account names, tokens or personal identifiers anywhere (code, fixtures, commits, issues).
- Keep `@grant none` unless a review justifies a grant.
