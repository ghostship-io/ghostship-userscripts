// Wires the shared modules. One runtime per page; features plug in here.
import { loadConfig } from "./config.js";
import { createDiagnostics } from "./diagnostics.js";
import { createObserverHub } from "./observers.js";
import { createScrollManager } from "./scroll-manager.js";
import { buildPromptIndex } from "./prompt-index.js";
import { assertBackend, createNoopBackend } from "./virtualization.js";

export function createRuntime({ win, adapter, backend = createNoopBackend(), queueUi, config = loadConfig(win.localStorage) }) {
  const diagnostics = createDiagnostics(win.console);
  const runtime = { config, diagnostics, mode: "off", promptIndex: [], dispose() {} };
  if (!config.enabled) return runtime;

  const check = adapter.selfCheck(win.document);
  if (!check.ok) {
    // Safe fallback: no DOM changes, native ChatGPT behaviour untouched.
    runtime.mode = "safe";
    diagnostics.count("selfcheck.failed");
    diagnostics.warnOnce("selfcheck", `ChatGPT layout not recognised (${check.missing.join(", ")}); running in safe mode`);
    return runtime;
  }

  // Independent of virtualization: a failure here removes only the queue panel.
  const mountQueue = () => {
    try {
      return queueUi?.({ win, adapter, config, diagnostics }) ?? { dispose() {} };
    } catch (error) {
      diagnostics.count("queue.mount.failed");
      diagnostics.warnOnce("queue", `queue UI disabled (${error instanceof Error ? error.message : error})`);
      return { dispose() {} };
    }
  };

  // A new chat has a composer but no turns: queue only, and an inert scroll/index surface for the rail.
  if (!check.hasTurns) {
    const queue = mountQueue();

    const none = () => () => {};
    Object.assign(runtime, {
      mode: "composer-only",
      queue,
      scroll: { onScroll: none, scrollTo: () => false, navigateTo: () => false, stats: {} },
      onIndexChange: none,
      onFallback: none,
      navigateTo: () => false,
      dispose: () => queue.dispose(),
    });
    diagnostics.count("runtime.composer-only");
    return runtime;
  }

  const observers = createObserverHub({ max: config.maxObservers, MutationObserverCtor: win.MutationObserver, schedule: (fn) => win.setTimeout(fn, 16), diagnostics });
  const scroll = createScrollManager({ scroller: adapter.scroller(win.document), diagnostics });
  assertBackend(backend);

  const queue = mountQueue();

  // Fail open: drop every hook and leave native ChatGPT behaviour in place.
  let stop = () => {};
  const indexListeners = new Set();
  const fallbackListeners = new Set();
  const failOpen = (reason) => {
    stop();
    indexListeners.clear();
    fallbackListeners.forEach((fn) => fn(reason));
    fallbackListeners.clear();
    backend.unmount();
    observers.disposeAll();
    scroll.dispose();
    Object.assign(runtime, { mode: "safe", scroll: undefined, observers: undefined, navigateTo: undefined, onIndexChange: undefined, dispose: () => queue.dispose() });
    diagnostics.count("virtualization.fallback");
    diagnostics.warnOnce("virtualization", `virtualization disabled (${reason}); running in safe mode`);
  };
  const mounted = backend.mount({ doc: win.document, adapter, scroll, observers, config, diagnostics, fallback: failOpen });
  if (mounted?.active === false) {
    failOpen(mounted.reason);
    return runtime;
  }

  const reindex = () => {
    runtime.promptIndex = buildPromptIndex(win.document, adapter);
    diagnostics.count("index.rebuilt");
    indexListeners.forEach((fn) => fn(runtime.promptIndex));
  };
  reindex();
  stop = observers.subscribe(win.document.body, reindex);

  Object.assign(runtime, {
    mode: "active",
    scroll,
    /** Subscribe to prompt-index rebuilds; returns an unsubscribe. */
    onIndexChange(fn) {
      indexListeners.add(fn);
      return () => indexListeners.delete(fn);
    },
    /** Subscribe to fail-open (the runtime dropped to safe mode); returns an unsubscribe. */
    onFallback(fn) {
      fallbackListeners.add(fn);
      return () => fallbackListeners.delete(fn);
    },
    /** The one explicit navigation entry: activates a virtualized-out turn, then scrolls to it. */
    navigateTo(el, options) {
      return backend.navigateToElement?.(el, options) || scroll.navigateTo(el, options);
    },
    observers,
    queue,
    dispose() {
      queue.dispose();
      stop();
      indexListeners.clear();
      observers.disposeAll();
      backend.unmount();
      scroll.dispose();
    },
  });
  return runtime;
}
