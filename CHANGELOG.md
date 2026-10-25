# Changelog

Agents add entries under Unreleased and never touch version fields. After a merge, `scripts/release.mjs` moves the entries under a new `## [x.y.z] - date` heading (adding the PR number) and sets the version: patch by default, or minor/major with a standalone `Release: minor` / `Release: major` line in the Unreleased section.

## Unreleased

- The right-hand pane is replaced by two panels in ChatGPT's own style: the conversation view (minimap) pinned top-right, growing down, and the prompt list pinned bottom-left, growing up, with the conversation and composer re-centered in the space between them, around any side pane and with the sidebar open or closed. Each panel collapses to a button in ChatGPT's header button area and the same button restores it (remembered per browser); when there is no room the panels become drawers opened by those buttons (#628).
- The minimap keeps the conversation's real aspect ratio inside a bordered frame on a recessed track (the "Conversation view"), with the viewport box inside the frame, instead of stretching to the pane width (#628).

## [0.7.1] - 2026-10-25

- Recover from ChatGPT's "Could not load this ChatGPT conversation" card (#796): the script presses ChatGPT's own "Try again" up to 3 times per conversation and route visit with a bounded backoff, never while the owner is typing, and shows a quiet status line if it still fails. It never reloads the page or sends anything. `{"recovery":false}` turns it off.
