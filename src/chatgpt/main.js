import { createRuntime } from "../core/runtime.js";
import { chatgptAdapter } from "./adapter.js";
import { DryRunDispatcher } from "./queue/dispatch.js";
import { createQueueUi } from "./queue/controller.js";
import { createTurnBackend } from "./virtualization/backend.js";

// No live transport exists yet: the queue always runs against the dry-run
// dispatcher, whatever `config.dryRun` says, and the panel is labelled as such.
const queueUi = ({ win, adapter, diagnostics, config }) => {
  if (!config.dryRun) diagnostics.warnOnce("queue-live", "live queue transport is not available; running the queue in dry-run mode");
  return createQueueUi({ win, adapter, diagnostics, dispatcher: new DryRunDispatcher() });
};

const runtime = createRuntime({ win: window, adapter: chatgptAdapter, backend: createTurnBackend(), queueUi });
// Non-sensitive health only: mode and counters.
window.__ghostshipUserscripts = { mode: runtime.mode, diagnostics: () => runtime.diagnostics.snapshot() };
