# Changelog

Agents add entries under Unreleased and never touch version fields. After a merge, `scripts/release.mjs` moves the entries under a new `## [x.y.z] - date` heading (adding the PR number) and sets the version: patch by default, or minor/major with a standalone `Release: minor` / `Release: major` line in the Unreleased section.

## Unreleased

- The panels are one column on the right (#969): the conversation view on top, the prompts at the bottom growing up, both shown by default, in ChatGPT's own card style (its elevated surface, ring and radius), under the page header and left of any pane. ONE button in the header button area shows and hides both; the conversation moves over when they show and back to the center when they hide, at its own width. The old two floating buttons that overlapped the card, the left-hand prompts panel that could sit under ChatGPT's sidebar and the "only prompts in view" button are gone; the search box is now "Filter prompts...". The header is now found on the live page (it is a plain `<header>`), so the button sits beside Share instead of floating over the card, and floats left of a pane that covers the header.
- The conversation view keeps one fixed width (its track) at one scale; a long turn slides under the frame as you scroll instead of shrinking to a sliver, and it is hidden on a new chat instead of showing an empty frame (#969).
- Fix the panels vanishing or squeezing the conversation (#969): a new chat now gets its column and room, a native pane that moves with our padding is no longer counted twice on resize, and whatever ChatGPT's re-render removes (the column, the button, the style) is put back on the next page change.
- A thread with no prompt of yours (a scheduled task's runs) lists each reply, so the Prompts list and the conversation view are no longer empty there (#969).
- While a response runs, Send goes to the queue by default, also on pages where ChatGPT shows only its Steer control and no Stop control: that control now counts as a running response, so Enter and the native Send/Steer button append to the pending prompt instead of steering (#969).
- ChatGPT's collapsed thinking traces open by themselves when they scroll into view, once each (one you close stays closed); turn off with `{"expandThinking":false}`.

## [0.7.5] - 2026-10-25

- The right-hand pane is replaced by two panels in ChatGPT's own style: the conversation view (minimap) pinned top-right, growing down, and the prompt list pinned bottom-left, growing up, with the conversation and composer re-centered in the space between them, around any side pane and with the sidebar open or closed. Each panel collapses to a button in ChatGPT's header button area and the same button restores it (remembered per browser); when there is no room the panels become drawers opened by those buttons (#628).
- ChatGPT's own summary pane is now recognised on the real page (its `data-summary-panel-*` markup and plain-element section titles, including threads that show only a Scheduled section), so the minimap sits beside it instead of over it and the Outputs disclosure works; threads inside a project (`/g/<project>/c/<id>`) are their own conversation instead of sharing the "new chat" state, queue and panel preferences (#628).

## [0.7.4] - 2026-10-25

- On opening a conversation the script now waits for the page to settle, then selects the last prompt in the Prompts list like a click on it, and keeps re-targeting the newest last prompt while more prompts load until the list settles; any scroll, click, key or touch from the user ends it (#629).

## [0.7.3] - 2026-10-25

- The minimap keeps the conversation's real aspect ratio inside a bordered frame on a recessed track (the "Conversation view"), with the viewport box inside the frame, instead of stretching to the pane width (#628).

## [0.7.2] - 2026-10-25

- Fix the queue's false "could not place the text in the composer" error (#630): the staged text is read back after the editor has applied it instead of once, immediately; a composer that already holds exactly the queued text counts as placed and is sent; a genuinely missing placement is waited out twice before the prompt is held. A held prompt no longer disables Steer, Interrupt & Send Next or Pause, and Retry works without a reload.

## [0.7.1] - 2026-10-25

- Recover from ChatGPT's "Could not load this ChatGPT conversation" card (#796): the script presses ChatGPT's own "Try again" up to 3 times per conversation and route visit with a bounded backoff, never while the owner is typing, and shows a quiet status line if it still fails. It never reloads the page or sends anything. `{"recovery":false}` turns it off.
