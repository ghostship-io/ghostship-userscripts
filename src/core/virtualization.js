// Virtualization backend contract and the pure turn-window policy. A backend
// implements mount/setWindow/unmount; it moves scroll only through the scroll
// manager and observes DOM only through the observer hub.
export const BACKEND_METHODS = Object.freeze(["mount", "setWindow", "unmount"]);

export function assertBackend(backend) {
  for (const method of BACKEND_METHODS) {
    if (typeof backend?.[method] !== "function") throw new Error(`virtualization backend missing ${method}()`);
  }
  return backend;
}

// Leaves the page untouched; the safe fallback.
export function createNoopBackend() {
  return { name: "noop", mount() {}, setWindow() {}, unmount() {} };
}

/**
 * Group message elements into prompt/response turns. A "user" message starts a
 * turn; every other recognised role continues the current one. Returns null
 * when any element has no recognisable role, so the caller can fail open.
 */
export function groupTurns(elements, roleOf) {
  const turns = [];
  for (const el of elements) {
    const role = roleOf(el);
    if (!role) return null;
    if (role === "user" || turns.length === 0) turns.push({ index: turns.length, elements: [] });
    turns[turns.length - 1].elements.push(el);
  }
  return turns;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Pure window policy. `start` is the previous window start, `focus` the turn
 * index at the top of the viewport and `direction` the last scroll direction
 * (-1 up, 1 down, 0 unknown). The core window is `size` turns; up to
 * `prefetch` extra turns are kept live past its leading edge. The window only
 * moves when focus leaves the safe zone inside the core, so small scrolls do
 * not churn DOM state.
 */
export function computeWindow({ count, size, prefetch, start, focus, direction }) {
  if (count <= 0) return { start: 0, end: -1, extraStart: 0, extraEnd: -1 };
  const span = Math.min(size, count);
  const maxStart = count - span;
  let s = clamp(start, 0, maxStart);
  const f = clamp(focus, 0, count - 1);
  const e = s + span - 1;
  const lowSafe = s === 0 ? 0 : s + prefetch;
  const highSafe = e === count - 1 ? count - 1 : e - prefetch;
  if (f < lowSafe || f > highSafe) {
    s = direction < 0 ? clamp(f + prefetch - span + 1, 0, maxStart) : clamp(f - prefetch, 0, maxStart);
    if (f < s || f > s + span - 1) s = clamp(f - Math.floor(span / 2), 0, maxStart);
  }
  const end = s + span - 1;
  let extraStart = s;
  let extraEnd = end;
  if (direction < 0) extraStart = Math.max(0, s - prefetch);
  else if (direction > 0) extraEnd = Math.min(count - 1, end + prefetch);
  return { start: s, end, extraStart, extraEnd };
}
