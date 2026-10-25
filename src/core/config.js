// Non-secret, per-browser preferences. Credentials never belong here.
export const CONFIG_KEY = "ghostship:userscripts:config";

export const DEFAULTS = Object.freeze({
  enabled: true,
  dryRun: false, // opt-in for testing only: the queue then talks to a no-side-effect dispatcher
  recovery: true, // retry ChatGPT's own "Try again" when a conversation fails to load
  windowTurns: 10,
  prefetchTurns: 2,
  maxObservers: 4,
  debug: false,
});

export function parseConfig(raw) {
  let stored = {};
  try {
    stored = raw ? JSON.parse(raw) : {};
  } catch {
    stored = {};
  }
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof stored[key] === typeof DEFAULTS[key]) out[key] = stored[key];
  }
  if (!Number.isInteger(out.windowTurns) || out.windowTurns < 1) out.windowTurns = DEFAULTS.windowTurns;
  if (!Number.isInteger(out.prefetchTurns) || out.prefetchTurns < 0) out.prefetchTurns = DEFAULTS.prefetchTurns;
  if (!Number.isInteger(out.maxObservers) || out.maxObservers < 1) out.maxObservers = DEFAULTS.maxObservers;
  return out;
}

export function loadConfig(storage) {
  try {
    return parseConfig(storage.getItem(CONFIG_KEY));
  } catch {
    return { ...DEFAULTS };
  }
}
