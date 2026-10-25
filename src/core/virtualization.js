// Virtualization backend contract and the pure window math. Backends (#629)
// implement mount/setWindow/unmount; they move DOM only through the scroll
// manager's preserve().
export function computeWindow(total, anchorIndex, size) {
  if (total <= size) return { start: 0, end: total };
  const half = Math.floor(size / 2);
  const start = Math.max(0, Math.min(anchorIndex - half, total - size));
  return { start, end: start + size };
}

export const BACKEND_METHODS = Object.freeze(["mount", "setWindow", "unmount"]);

export function assertBackend(backend) {
  for (const method of BACKEND_METHODS) {
    if (typeof backend?.[method] !== "function") throw new Error(`virtualization backend missing ${method}()`);
  }
  return backend;
}

// Leaves the page untouched; used until #629 lands and as the safe fallback.
export function createNoopBackend() {
  return { name: "noop", mount() {}, setWindow() {}, unmount() {} };
}
