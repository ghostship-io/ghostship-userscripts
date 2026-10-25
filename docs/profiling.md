# Read-only profiling of real long threads (#631)

Measures an existing long ChatGPT thread in the owner's personal Chrome profile before and after the userscript is enabled. It sends nothing: no prompt, no Send/Stop click, no typing, no setting change. Existing threads stay strictly read-only.

Run it only after `npm run gate` passes for the exact build being measured (`build/gate-report.json`, `bundleSha256` equals the sha256 of the installed script).

## What is recorded

`profiling/measure.js` installs passive recorders and returns numbers only (no text, titles, URLs or ids):

| Measure | Source |
|---|---|
| DOM nodes: total, rendered (excluding nodes under virtualized-out turns), scroller, turn elements | `getElementsByTagName` at start and stop |
| Long Animation Frames (count, total, blocking, max); falls back to long tasks | `PerformanceObserver` |
| Frame gaps over 50 ms, p95 gap | `requestAnimationFrame` |
| JS heap (start, end, max; Chrome only, coarse) | `performance.memory` |
| Scroll events: user-driven vs unsolicited (no wheel/touch/key/pointer within 500 ms) and their pixels | scroll + input listeners |
| Time from first user scroll input until the oldest turn is visible and rendered | scroll + rAF |
| Layout shift not caused by input | `PerformanceObserver` |

## Procedure

Use the Agent Desktop `personal` identity (skills `ghostship-agent-desktop`, `ghostship-browser`); claim one window, release it at the end.

1. **Pick threads** with the owner: 2-3 representative long existing threads (100+ turns, one with code/tables/images). Refer to them as `thread-A`, `thread-B`; never record titles or URLs outside the private session.
2. **Condition 1, script off.** Install state is the owner's current profile as-is. Navigate a tab to the thread, wait until the page is idle, and bring it to the bottom with a real `scroll` step.
3. `eval` the contents of `profiling/measure.js`, then `window.__gsProfile.start("thread-A")`.
4. **Drive identically every run** with `browser_op` `scroll` steps (real wheel input): `dy: -3000`, `wait 300 ms`, repeated until the oldest turn is reached (read `document.querySelector('[data-scroll-root]')?.scrollTop`), then 5 steps of `dy: +3000`, then `wait 1500 ms`. Do not click anything in the page.
5. `eval` `JSON.stringify(window.__gsProfile.stop())`, then `window.__gsProfile.dispose()`. Keep the JSON in the private session (or a scratch file outside the repository).
6. **Condition 2, script on.** Enable the userscript from a local dev install that cannot send (the gate proves the build has no send path): install `dist/ghostship-chatgpt.user.js` pinned to the gated commit (README, "Rollback and pinning") with automatic update off. Reload the tab, confirm `window.__ghostshipUserscripts.mode === "active"`, and repeat steps 3-5 with the same thread and the same drive.
7. `node profiling/compare.mjs before.json after.json` prints the table and exits non-zero on a regression (limits in `profiling/compare.mjs`; unsolicited scroll after must be 0, rendered nodes must drop, long-frame total, reveal time and heap may not regress beyond the stated slack).
8. Post only the aggregate table and verdict on the issue.

## Caveats to record with the result

- The profile also has other ChatGPT-page extensions (a table-of-contents extension and a DOM-trimming extension). Both runs include them. A clean comparison needs them temporarily off, which is a browser change that needs the owner's explicit approval; otherwise report "coexistence" numbers only.
- `performance.memory` is coarse and Chrome-only; compare heap trends, not exact values. Repeat each condition twice and use the worse run.
- Turning the userscript on and off is itself a manager setting change: do it only once the install packet is approved. Until then this procedure is validated on fixtures only (`tests/profiling.test.js`) and on a synthetic page in the agent profile.
