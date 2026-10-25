// Recovers from ChatGPT's "Could not load this ChatGPT conversation" card by pressing ChatGPT's own "Try again"
// control, at most `maxAttempts` times per conversation and route visit, with a bounded backoff, never while the
// owner is typing. It never reloads the page, never sends anything and uses no internal API. This and the live
// dispatcher are the only files in src/ allowed to click (see the banned-primitive test); the single click below
// is on the control the adapter found inside the failure card.
import { createObserverHub } from "../core/observers.js";

export const RECOVERY_DEFAULTS = Object.freeze({
  maxAttempts: 3,
  delaysMs: [800, 4000, 12000], // before attempt 1, 2, 3 (counted from detection / the previous failure)
  verifyMs: 6000, // how long a retry gets to make the card go away
  typingQuietMs: 3000,
  busyRecheckMs: 1500,
  debounceMs: 500,
});

const STATUS_ATTR = "data-gs-recovery";

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {object} o.adapter loadError(doc), composerInput(doc)
 * @param {object} [o.diagnostics]
 * @param {object} [o.options] overrides of RECOVERY_DEFAULTS
 * @param {{ setTimeout: Function, clearTimeout: Function, now(): number }} [o.timers]
 */
export function createRecovery({ win, adapter, diagnostics, options = {}, timers }) {
  const doc = win.document;
  const opts = { ...RECOVERY_DEFAULTS, ...options };
  const t = timers ?? { setTimeout: (fn, ms) => win.setTimeout(fn, ms), clearTimeout: (id) => win.clearTimeout(id), now: () => win.performance.now() };
  const hub = createObserverHub({ max: 1, MutationObserverCtor: win.MutationObserver, schedule: (fn) => t.setTimeout(fn, opts.debounceMs), diagnostics });

  let route = win.location.pathname;
  let attempts = 0;
  let phase = "idle"; // idle | waiting (attempt scheduled) | verifying (clicked) | gave-up
  let timer = null;
  let lastTyping = -Infinity;
  let statusEl = null;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) t.clearTimeout(timer);
    timer = null;
  };
  const later = (fn, ms) => {
    clearTimer();
    timer = t.setTimeout(() => {
      timer = null;
      if (!disposed) fn();
    }, ms);
  };

  function showStatus(text) {
    if (!statusEl) {
      statusEl = doc.createElement("div");
      statusEl.setAttribute(STATUS_ATTR, "");
      statusEl.setAttribute("role", "status");
      statusEl.style.cssText = "position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:2147483000;max-width:90vw;padding:4px 12px;border:1px solid rgba(127,127,127,.4);border-radius:999px;background:var(--main-surface-secondary,rgba(127,127,127,.15));color:inherit;font:12px/1.4 system-ui,sans-serif;opacity:.85";
      doc.body.append(statusEl);
    }
    statusEl.textContent = text;
  }
  function hideStatus() {
    statusEl?.remove();
    statusEl = null;
  }

  function reset() {
    clearTimer();
    attempts = 0;
    phase = "idle";
    hideStatus();
  }

  /** The owner is typing: a key or input moments ago, or text sitting in the focused composer. */
  function typing() {
    if (t.now() - lastTyping < opts.typingQuietMs) return true;
    const input = adapter.composerInput(doc);
    if (!input || doc.activeElement !== input) return false;
    return (input.value ?? input.textContent ?? "").trim() !== "";
  }
  const onTyping = () => {
    lastTyping = t.now();
  };
  win.addEventListener("keydown", onTyping, true);
  win.addEventListener("input", onTyping, true);

  function recovered() {
    diagnostics?.count("recovery.recovered");
    reset();
  }

  function schedule() {
    phase = "waiting";
    later(attempt, opts.delaysMs[Math.min(attempts, opts.delaysMs.length - 1)]);
  }

  function attempt() {
    if (win.location.pathname !== route) return check();
    const found = adapter.loadError(doc);
    if (!found) return recovered();
    if (typing()) {
      diagnostics?.count("recovery.deferred");
      return later(attempt, opts.busyRecheckMs); // not an attempt
    }
    attempts += 1;
    phase = "verifying";
    diagnostics?.count("recovery.retry");
    found.control.click();
    later(verify, opts.verifyMs);
  }

  function verify() {
    if (win.location.pathname !== route) return check();
    if (!adapter.loadError(doc)) return recovered();
    if (attempts >= opts.maxAttempts) {
      phase = "gave-up";
      diagnostics?.count("recovery.gave-up");
      showStatus(`ChatGPT still could not load this conversation after ${attempts} tries. Reload the page to try again.`);
      return;
    }
    schedule();
  }

  /** One cheap pass: follow the route, notice a card, notice that it went away. */
  function check() {
    if (disposed) return;
    if (win.location.pathname !== route) {
      route = win.location.pathname;
      reset(); // a new visit gets its own budget
    }
    const found = adapter.loadError(doc);
    if (!found) {
      if (phase === "waiting" || phase === "verifying") recovered();
      return;
    }
    if (phase === "idle") {
      diagnostics?.count("recovery.detected");
      schedule();
    }
  }

  const unsubscribe = hub.subscribe(doc.body, check);
  check();

  return {
    get phase() {
      return phase;
    },
    get attempts() {
      return attempts;
    },
    check,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      clearTimer();
      win.removeEventListener("keydown", onTyping, true);
      win.removeEventListener("input", onTyping, true);
      hideStatus();
    },
  };
}
