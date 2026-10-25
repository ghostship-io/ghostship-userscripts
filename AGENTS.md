# AGENTS.md

- Test command: `npm ci && npm test` (builds `dist/`, then runs every test; CI runs the same).
- **No live traffic.** Tests and local validation use DOM fixtures in `tests/fixtures/` only; never load chatgpt.com, send a prompt, or click native Send/Stop from a test or script. The queue transport is injected and dry-run by default; a banned-primitive test blocks `fetch`, `XMLHttpRequest`, `.click()` and similar in `src/`. Live ChatGPT tests need the owner's approved budget (#625) and run outside this repo's CI.
- Commit `dist/` with every source change (`npm run build`); CI fails on a stale `dist/`. Bump the version with `npm run bump -- <id> <patch|minor|major>`; managers ignore non-increasing versions.
- All scroll writes go through `src/core/scroll-manager.js`; all DOM observation through `src/core/observers.js`; all ChatGPT selectors live in `src/chatgpt/adapter.js`.
- Public repository: no private data, profile paths, account names, tokens or personal identifiers anywhere (code, fixtures, commits, issues).
- Keep `@grant none` unless a review justifies a grant.
