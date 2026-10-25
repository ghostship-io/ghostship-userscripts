// Counters and one-shot warnings. Never records message text, tokens or URLs.
export function createDiagnostics(log = console) {
  const counters = new Map();
  const warned = new Set();
  return {
    count(name, n = 1) {
      counters.set(name, (counters.get(name) ?? 0) + n);
    },
    warnOnce(key, message) {
      if (warned.has(key)) return;
      warned.add(key);
      log.warn(`[ghostship] ${message}`);
    },
    snapshot() {
      return Object.fromEntries(counters);
    },
  };
}
