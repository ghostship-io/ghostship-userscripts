import { createRuntime } from "../core/runtime.js";
import { chatgptAdapter } from "./adapter.js";
import { selectDispatcher } from "./queue/select.js";
import { createQueueUi } from "./queue/controller.js";
import { createRail } from "./rail/rail.js";
import { createTurnBackend } from "./virtualization/backend.js";

// Live by default; `config.dryRun` is an opt-in for testing (panel then shows "Dry run").
const queueUi = ({ win, adapter, diagnostics, config }) =>
  createQueueUi({ win, adapter, diagnostics, dispatcher: selectDispatcher({ config, win, adapter }) });

const runtime = createRuntime({ win: window, adapter: chatgptAdapter, backend: createTurnBackend(), queueUi });
if (runtime.mode === "active") createRail({ win: window, adapter: chatgptAdapter, runtime });
// Non-sensitive health only: build version, mode and counters.
// __GS_VERSION__ is replaced with the manifest version at build time (scripts/build.mjs).
window.__ghostshipUserscripts = { version: __GS_VERSION__, mode: runtime.mode, diagnostics: () => runtime.diagnostics.snapshot() };
