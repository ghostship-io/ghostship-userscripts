// Expands ChatGPT's collapsed thinking traces ("Thought for 12s", "Worked for 1m 5s", "Stopped thinking") as soon as
// they are in view, so they never need a manual click. It presses ChatGPT's own disclosure control, nothing else:
// never Send, Stop or anything outside a conversation turn. This, the live dispatcher and the load-error recovery are
// the only files in src/ allowed to click (see the banned-primitive test). Each trace is expanded at most once per
// conversation visit, so one the owner collapses again stays collapsed; traces above the viewport or in turns the
// virtualizer skipped are left alone, so nothing moves under the reader.
export const THINKING_DEFAULTS = Object.freeze({
  debounceMs: 120, // after the last scroll or page change
  maxPerPass: 8,
});

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {object} o.adapter thinkingToggles(doc), scroller(doc), turnId(el, i)
 * @param {object} o.runtime onIndexChange(fn), scroll.onScroll(fn), isTurnActive(el)
 * @param {object} [o.diagnostics]
 * @param {object} [o.options] overrides of THINKING_DEFAULTS
 */
export function createThinkingExpander({ win, adapter, runtime, diagnostics, options = {} }) {
  const doc = win.document;
  const opts = { ...THINKING_DEFAULTS, ...options };
  const done = new Set(); // `${turn id}#${nth toggle in the turn}`, expanded once
  let timer = null;
  let disposed = false;

  /** Where the conversation is on screen: the scroller clipped to the window. */
  function viewport() {
    const r = adapter.scroller(doc).getBoundingClientRect();
    return { top: Math.max(r.top, 0), bottom: Math.min(r.bottom, win.innerHeight || Infinity) };
  }

  function pass() {
    timer = null;
    if (disposed) return;
    const view = viewport();
    const due = [];
    for (const { button, turn, key } of adapter.thinkingToggles(doc)) {
      if (done.has(key) || button.getAttribute("aria-expanded") !== "false" || !runtime.isTurnActive(turn)) continue;
      const r = button.getBoundingClientRect();
      if (!r.height || r.bottom <= view.top || r.top >= view.bottom) continue;
      due.push({ button, key, top: r.top });
    }
    // Bottom first: opening one pushes only what is below it, so the positions measured above stay true.
    due.sort((a, b) => b.top - a.top);
    for (const { button, key } of due.slice(0, opts.maxPerPass)) {
      done.add(key);
      button.click();
      diagnostics?.count("thinking.expanded");
    }
    if (due.length > opts.maxPerPass) schedule(); // the rest on the next pass
  }

  function schedule() {
    if (timer !== null || disposed) return;
    timer = win.setTimeout(pass, opts.debounceMs);
  }

  const stops = [runtime.onIndexChange?.(schedule), runtime.scroll?.onScroll?.(schedule)].filter((fn) => typeof fn === "function");
  schedule();

  return {
    dispose() {
      disposed = true;
      if (timer !== null) win.clearTimeout(timer);
      for (const stop of stops) stop();
    },
  };
}
