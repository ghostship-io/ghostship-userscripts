// Starts the page features once the layout is really there and keeps them
// matched to it. ChatGPT is a single-page app: the composer and turns render
// after the script starts, a new chat has no turns at all, and conversations
// are switched without a page load. One bounded MutationObserver (debounced to
// a cheap layout check) plus history/popstate hooks drive start, restart and
// visible give-up; nothing here reads message text.
import { createDiagnostics } from "./diagnostics.js";

export const BOOT_DEFAULTS = Object.freeze({ maxWaitMs: 30000, settleMs: 100 });

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {object} o.adapter selfCheck(doc), layout(doc, win)
 * @param {() => { runtime: object, dispose(): void }} o.mount builds one feature set; a throw is contained
 * @param {string} o.version
 * @param {{ setTimeout: Function, clearTimeout: Function, now(): number }} [o.timers]
 */
export function createBoot({ win, adapter, mount, version, maxWaitMs = BOOT_DEFAULTS.maxWaitMs, settleMs = BOOT_DEFAULTS.settleMs, timers }) {
  const doc = win.document;
  const t = timers ?? {
    setTimeout: (fn, ms) => win.setTimeout(fn, ms),
    clearTimeout: (id) => win.clearTimeout(id),
    now: () => win.performance.now(),
  };
  const diagnostics = createDiagnostics(win.console);
  const state = { phase: "waiting", reason: null, missing: [], attempts: 0, waitStart: t.now(), route: "new", turns: false };
  let current = null; // { handle, layout }
  let failedLayout = null; // layout that mounted into safe mode or threw: not retried until it changes
  let observer = null;
  let debounce = null;
  let giveUpTimer = null;
  let disposed = false;

  const sameLayout = (a, b) =>
    !!a && !!b && a.route === b.route && a.composer === b.composer && a.container === b.container && a.scroller === b.scroller;

  function watch(on) {
    if (on && !observer && !disposed) {
      observer = new win.MutationObserver(() => schedule());
      observer.observe(doc.body, { childList: true, subtree: true });
    } else if (!on && observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function schedule() {
    if (debounce !== null || disposed) return;
    debounce = t.setTimeout(() => {
      debounce = null;
      tick();
    }, settleMs);
  }

  function teardown() {
    const old = current;
    current = null;
    try {
      old?.handle.dispose();
    } catch (error) {
      diagnostics.count("boot.dispose.failed");
    }
  }

  function startWaiting(reason) {
    state.phase = "waiting";
    state.reason = reason;
    state.waitStart = t.now();
    state.attempts = 0;
    t.clearTimeout(giveUpTimer);
    giveUpTimer = t.setTimeout(giveUp, maxWaitMs);
    watch(true);
  }

  function giveUp() {
    giveUpTimer = null;
    if (disposed || current) return;
    const check = adapter.selfCheck(doc);
    if (check.ok) return tick();
    state.phase = "timeout";
    state.reason = "timeout";
    state.missing = check.missing;
    diagnostics.count("boot.timeout");
    diagnostics.warnOnce("boot-timeout", `ChatGPT layout not found after ${Math.round(maxWaitMs / 1000)}s (${check.missing.join(", ")}); the script stays idle until the page route changes`);
    watch(false); // bounded: no observer while idle; a route change re-arms the wait
  }

  function start(layout, check) {
    state.attempts++;
    try {
      const handle = mount();
      current = { handle, layout };
      const mode = handle.runtime.mode;
      state.reason = null;
      if (mode === "off") {
        state.phase = "off";
        watch(false);
      } else if (mode === "safe") {
        // The runtime rejected this layout (for example unknown markup): do not retry until it changes.
        failedLayout = layout;
        state.phase = "running";
      } else {
        state.phase = "running";
      }
      t.clearTimeout(giveUpTimer);
      giveUpTimer = null;
    } catch (error) {
      failedLayout = layout;
      state.phase = "error";
      state.reason = "mount-error";
      diagnostics.count("boot.mount.failed");
      diagnostics.warnOnce("boot-mount", `startup failed (${error instanceof Error ? error.message : error}); running without the script`);
    }
    state.missing = check.missing;
  }

  function tick() {
    if (disposed) return;
    const layout = adapter.layout(doc, win);
    const check = adapter.selfCheck(doc);
    state.route = layout.route === "new" ? "new" : "conversation";
    state.turns = check.hasTurns;
    if (state.phase === "off") return;

    if (current) {
      state.missing = check.missing;
      if (sameLayout(current.layout, layout)) {
        // The runtime may have dropped itself to safe mode since: that is final for this layout.
        if (current.handle.runtime.mode === "safe") failedLayout = layout;
        return;
      }
      // Route change, conversation root replaced, turns appeared in a new chat, or the composer was swapped.
      diagnostics.count("boot.restart");
      teardown();
      failedLayout = null;
      startWaiting("restart");
    }
    if (sameLayout(failedLayout, layout)) return;
    failedLayout = null;
    if (!check.ok) {
      state.missing = check.missing;
      return;
    }
    start(layout, check);
  }

  const onRoute = () => {
    if (state.phase === "timeout") startWaiting("route");
    schedule();
  };

  // History API hooks: SPA navigations do not reload the page.
  const history = win.history;
  const originals = {};
  for (const name of ["pushState", "replaceState"]) {
    originals[name] = history[name];
    const wrapped = function (...args) {
      const result = originals[name].apply(this, args);
      onRoute();
      return result;
    };
    history[name] = wrapped;
    originals[name + "Wrapped"] = wrapped;
  }
  win.addEventListener("popstate", onRoute);
  win.addEventListener("hashchange", onRoute);

  startWaiting(null);
  tick();

  const health = {
    version,
    get mode() {
      if (current) return current.handle.runtime.mode;
      return state.phase === "timeout" || state.phase === "error" ? "safe" : state.phase === "off" ? "off" : "waiting";
    },
    get missing() {
      return [...state.missing];
    },
    get reason() {
      return state.reason;
    },
    get route() {
      return state.route;
    },
    get attempts() {
      return state.attempts;
    },
    diagnostics: () => ({ ...diagnostics.snapshot(), ...(current?.handle.runtime.diagnostics.snapshot() ?? {}) }),
  };

  return {
    health,
    runtime: () => current?.handle.runtime ?? null,
    dispose() {
      if (disposed) return;
      disposed = true;
      watch(false);
      t.clearTimeout(debounce);
      t.clearTimeout(giveUpTimer);
      win.removeEventListener("popstate", onRoute);
      win.removeEventListener("hashchange", onRoute);
      for (const name of ["pushState", "replaceState"]) if (history[name] === originals[name + "Wrapped"]) history[name] = originals[name];
      teardown();
    },
  };
}
