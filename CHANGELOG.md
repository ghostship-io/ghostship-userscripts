# Changelog

Agents add an entry under Unreleased and do not touch version fields; release tooling sets the version on merge.

## Unreleased

- Recover from ChatGPT's "Could not load this ChatGPT conversation" card (#796): the script presses ChatGPT's own "Try again" up to 3 times per conversation and route visit with a bounded backoff, never while the owner is typing, and shows a quiet status line if it still fails. It never reloads the page or sends anything. `{"recovery":false}` turns it off.
