import { createBoot } from "../core/boot.js";
import { createRuntime } from "../core/runtime.js";
import { chatgptAdapter } from "./adapter.js";
import { selectDispatcher } from "./queue/select.js";
import { createQueueUi } from "./queue/controller.js";
import { persistentQueueUi } from "./queue/persistent.js";
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

// The layout renders after the script starts and changes with every in-app navigation,
// so the boot controller starts, restarts and gives up (visibly) around one mount.
const boot = createBoot({
  win: window,
  adapter: chatgptAdapter,
  version: __GS_VERSION__,
  onDispose: () => queueUi.shutdown(),
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
