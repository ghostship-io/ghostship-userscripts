/**
 * The queue outlives page re-initialization. The boot controller tears features down and rebuilds them
 * when the route changes or turns appear (for example the first send of a new chat), but a send may be
 * in flight and items are pending; disposing the queue then would drop the in-flight outcome. This wraps a
 * queue factory so every mount reuses one instance (the instance itself follows navigation and re-homes
 * its panel above the current composer); only `shutdown()` disposes it.
 */
export function persistentQueueUi(create) {
  let shared = null;
  const mount = (ctx) => {
    if (!shared?.mounted) shared = create(ctx);
    else shared.wake?.(); // a route change or restart: the page behind the queue is new
    return { ...shared, dispose() {} };
  };
  mount.shutdown = () => {
    shared?.dispose();
    shared = null;
  };
  return mount;
}
