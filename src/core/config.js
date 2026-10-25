// Non-secret, per-browser preferences. Credentials never belong here.
export const CONFIG_KEY = "ghostship:userscripts:config";

export const DEFAULTS = Object.freeze({
  enabled: true,
  dryRun: true,
  windowTurns: 10,
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
