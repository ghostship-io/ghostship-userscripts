import { createBoot } from "../core/boot.js";
import { createRuntime } from "../core/runtime.js";
import { chatgptAdapter } from "./adapter.js";
import { DryRunDispatcher } from "./queue/dispatch.js";
import { createQueueUi } from "./queue/controller.js";
import { createRail } from "./rail/rail.js";
import { createTurnBackend } from "./virtualization/backend.js";

// No live transport exists yet: the queue always runs against the dry-run
// dispatcher, whatever `config.dryRun` says, and the panel is labelled as such.
const queueUi = ({ win, adapter, diagnostics, config }) => {
  if (!config.dryRun) diagnostics.warnOnce("queue-live", "live queue transport is not available; running the queue in dry-run mode");
  return createQueueUi({ win, adapter, diagnostics, dispatcher: new DryRunDispatcher() });
};

// The layout renders after the script starts and changes with every in-app navigation,
// so the boot controller starts, restarts and gives up (visibly) around one mount.
const boot = createBoot({
  win: window,
  adapter: chatgptAdapter,
  version: __GS_VERSION__,
  mount() {
    const runtime = createRuntime({ win: window, adapter: chatgptAdapter, backend: createTurnBackend(), queueUi });
    const rail = runtime.mode === "active" || runtime.mode === "composer-only" ? createRail({ win: window, adapter: chatgptAdapter, runtime }) : null;
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
