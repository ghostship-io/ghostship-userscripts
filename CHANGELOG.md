# Changelog

Agents add entries under Unreleased and never touch version fields. After a merge, `scripts/release.mjs` moves the entries under a new `## [x.y.z] - date` heading (adding the PR number) and sets the version: patch by default, or minor/major with a standalone `Release: minor` / `Release: major` line in the Unreleased section.

## Unreleased

## [0.7.2] - 2026-10-25

- Fix the queue's false "could not place the text in the composer" error (#630): the staged text is read back after the editor has applied it instead of once, immediately; a composer that already holds exactly the queued text counts as placed and is sent; a genuinely missing placement is waited out twice before the prompt is held. A held prompt no longer disables Steer, Interrupt & Send Next or Pause, and Retry works without a reload.

## [0.7.1] - 2026-10-25

- Recover from ChatGPT's "Could not load this ChatGPT conversation" card (#796): the script presses ChatGPT's own "Try again" up to 3 times per conversation and route visit with a bounded backoff, never while the owner is typing, and shows a quiet status line if it still fails. It never reloads the page or sends anything. `{"recovery":false}` turns it off.
