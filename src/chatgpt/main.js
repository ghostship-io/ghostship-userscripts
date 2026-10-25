import { createRuntime } from "../core/runtime.js";
import { chatgptAdapter } from "./adapter.js";

const runtime = createRuntime({ win: window, adapter: chatgptAdapter });
// Non-sensitive health only: mode and counters.
window.__ghostshipUserscripts = { mode: runtime.mode, diagnostics: () => runtime.diagnostics.snapshot() };
