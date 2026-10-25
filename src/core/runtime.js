// Wires the shared modules. One runtime per page; features plug in here.
import { loadConfig } from "./config.js";
import { createDiagnostics } from "./diagnostics.js";
import { createObserverHub } from "./observers.js";
import { createScrollManager } from "./scroll-manager.js";
import { buildPromptIndex } from "./prompt-index.js";
import { assertBackend, createNoopBackend } from "./virtualization.js";

export function createRuntime({ win, adapter, backend = createNoopBackend(), config = loadConfig(win.localStorage) }) {
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
  backend.mount({ doc: win.document, scroll, observers, config, diagnostics });

  const reindex = () => {
    runtime.promptIndex = buildPromptIndex(win.document, adapter);
    diagnostics.count("index.rebuilt");
  };
  reindex();
  const stop = observers.subscribe(win.document.body, reindex);

  Object.assign(runtime, {
    mode: "active",
    scroll,
    observers,
    dispose() {
      stop();
      observers.disposeAll();
      backend.unmount();
    },
  });
  return runtime;
}
