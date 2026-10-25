// One shared MutationObserver per root, a hard cap on subscriptions and a
// single batched flush per frame, so features never compete with global DOM
// observers of their own.
export function createObserverHub({ max, MutationObserverCtor = globalThis.MutationObserver, schedule = (fn) => setTimeout(fn, 16), diagnostics }) {
  const roots = new Map();
  let subscriptions = 0;

  function ensure(root, options) {
    let entry = roots.get(root);
    if (entry) return entry;
    entry = { handlers: new Set(), pending: [], scheduled: false, observer: null };
    entry.observer = new MutationObserverCtor((records) => {
      entry.pending.push(...records);
      if (entry.scheduled) return;
      entry.scheduled = true;
      schedule(() => {
        entry.scheduled = false;
        const batch = entry.pending;
        entry.pending = [];
        diagnostics?.count("observer.flush");
        for (const handler of [...entry.handlers]) handler(batch);
      });
    });
    entry.observer.observe(root, options);
    roots.set(root, entry);
    return entry;
  }

  return {
    subscribe(root, handler, options = { childList: true, subtree: true }) {
      if (subscriptions >= max) throw new Error(`observer budget exceeded (max ${max})`);
      subscriptions += 1;
      const entry = ensure(root, options);
      entry.handlers.add(handler);
      return () => {
        if (!entry.handlers.delete(handler)) return;
        subscriptions -= 1;
        if (entry.handlers.size === 0) {
          entry.observer.disconnect();
          roots.delete(root);
        }
      };
    },
    size: () => subscriptions,
    disposeAll() {
      for (const entry of roots.values()) entry.observer.disconnect();
      roots.clear();
      subscriptions = 0;
    },
  };
}
