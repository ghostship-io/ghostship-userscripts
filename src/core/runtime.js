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

  const observers = createObserverHub({ max: config.maxObservers, MutationObserverCtor: win.MutationObserver, schedule: (fn) => win.setTimeout(fn, 16), diagnostics });
  const scroll = createScrollManager({ scroller: adapter.scroller(win.document), diagnostics });
  assertBackend(backend);

  // Independent of virtualization: a failure here removes only the queue panel.
  let queue = { dispose() {} };
  try {
    queue = queueUi?.({ win, adapter, config, diagnostics }) ?? queue;
  } catch (error) {
    diagnostics.count("queue.mount.failed");
    diagnostics.warnOnce("queue", `queue UI disabled (${error instanceof Error ? error.message : error})`);
  }

  // Fail open: drop every hook and leave native ChatGPT behaviour in place.
  let stop = () => {};
  const failOpen = (reason) => {
    stop();
    backend.unmount();
    observers.disposeAll();
    scroll.dispose();
    Object.assign(runtime, { mode: "safe", scroll: undefined, observers: undefined, dispose: () => queue.dispose() });
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
  };
  reindex();
  stop = observers.subscribe(win.document.body, reindex);

  Object.assign(runtime, {
    mode: "active",
    scroll,
    observers,
    queue,
    dispose() {
      queue.dispose();
      stop();
      observers.disposeAll();
      backend.unmount();
      scroll.dispose();
    },
  });
  return runtime;
}
