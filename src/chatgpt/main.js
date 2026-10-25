import { createBoot } from "../core/boot.js";
import { loadConfig } from "../core/config.js";
import { createDiagnostics } from "../core/diagnostics.js";
import { createRuntime } from "../core/runtime.js";
import { chatgptAdapter } from "./adapter.js";
import { selectDispatcher } from "./queue/select.js";
import { createQueueUi } from "./queue/controller.js";
import { persistentQueueUi } from "./queue/persistent.js";
import { createRecovery } from "./recovery.js";
import { createRail } from "./rail/rail.js";
import { createRailStateStore } from "./rail/rail-state.js";
import { createTurnBackend } from "./virtualization/backend.js";

// Live by default; `config.dryRun` is an opt-in for testing (panel then shows "Dry run").
// Persistent: re-initializing the page features must not drop pending items or an in-flight send.
const queueUi = persistentQueueUi(({ win, adapter, diagnostics, config }) =>
  createQueueUi({ win, adapter, diagnostics, dispatcher: selectDispatcher({ config, win, adapter }) }),
);

// Per-conversation rail state outlives each mount, so A -> B -> A restores A.
const railState = createRailStateStore();

// ChatGPT's "Could not load this conversation" card has no turns and no layout for the boot controller to wait
// for, so recovery runs for the page's lifetime beside it (one bounded observer, a cheap check per batch).
const config = loadConfig(window.localStorage);
const recoveryDiagnostics = createDiagnostics(window.console);
const recovery = config.enabled && config.recovery ? createRecovery({ win: window, adapter: chatgptAdapter, diagnostics: recoveryDiagnostics }) : null;

// The layout renders after the script starts and changes with every in-app navigation,
// so the boot controller starts, restarts and gives up (visibly) around one mount.
const boot = createBoot({
  win: window,
  adapter: chatgptAdapter,
  version: __GS_VERSION__,
  extraDiagnostics: () => recoveryDiagnostics.snapshot(),
  onDispose: () => {
    queueUi.shutdown();
    recovery?.dispose();
  },
  mount() {
    const runtime = createRuntime({ win: window, adapter: chatgptAdapter, backend: createTurnBackend(), queueUi });
    const rail = runtime.mode === "active" || runtime.mode === "composer-only" ? createRail({ win: window, adapter: chatgptAdapter, runtime, store: railState }) : null;
    return {
      runtime,
      dispose() {
        rail?.dispose();
        runtime.dispose();
      },
    };
  },
});
// Non-sensitive health only: build version, mode, missing selectors, counters. No conversation ids or text.
// __GS_VERSION__ is replaced with the manifest version at build time (scripts/build.mjs).
window.__ghostshipUserscripts = boot.health;
