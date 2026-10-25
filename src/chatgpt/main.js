import { createRuntime } from "../core/runtime.js";
import { chatgptAdapter } from "./adapter.js";
import { createRail } from "./rail/rail.js";
import { createTurnBackend } from "./virtualization/backend.js";

const runtime = createRuntime({ win: window, adapter: chatgptAdapter, backend: createTurnBackend() });
if (runtime.mode === "active") createRail({ win: window, adapter: chatgptAdapter, runtime });
// Non-sensitive health only: mode and counters.
window.__ghostshipUserscripts = { mode: runtime.mode, diagnostics: () => runtime.diagnostics.snapshot() };
