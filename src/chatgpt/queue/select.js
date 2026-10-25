import { DryRunDispatcher } from "./dispatch.js";
import { createLiveDispatcher } from "./live-dispatcher.js";

/** Live by default; `config.dryRun` is an opt-in for testing that swaps in the no-side-effect dispatcher. */
export function selectDispatcher({ config, win, adapter }) {
  return config.dryRun ? new DryRunDispatcher() : createLiveDispatcher({ win, adapter });
}
