import { computeWindow, groupTurns } from "../../core/virtualization.js";

const STATE = "data-gs-state";
const HEIGHT_VAR = "--gs-h";
const STYLE_ID = "gs-virtualization-style";
const CSS = `
[data-gs-scroller]{overflow-anchor:none}
[${STATE}="inactive"]{content-visibility:hidden;contain-intrinsic-block-size:var(${HEIGHT_VAR})}
`;

/** Locate and group turns through the adapter; any surprise returns a reason to fail open. */
export function discover(doc, adapter) {
  const els = adapter.turns(doc);
  if (!els.length) return { reason: "no-turns" };
  const parent = adapter.turnRoot(doc);
  if (!parent || els.some((e) => !parent.contains(e))) return { reason: "turns-outside-root", els };
  const scroller = adapter.scroller(doc);
  if (scroller !== doc.documentElement && scroller !== doc.scrollingElement && !scroller.contains(parent)) return { reason: "root-outside-scroller", els };
  const turns = groupTurns(els, adapter.role);
  if (!turns) return { reason: "unknown-role" };
  return { parent, turns, els };
}

/**
 * Content-visibility backend: keeps the latest `windowTurns` complete turns
 * rendered and skips rendering of older ones with a measured placeholder
 * height. Nothing is detached from the DOM, so React keeps owning the tree;
 * every write is an attribute that `unmount()` removes. Selection and focus pin
 * a turn active. Unknown markup returns `{ active: false, reason }` without
 * touching the page; if the markup stops matching later, or a sync throws, the
 * runtime's `fallback` is called.
 *
 * Observers: one hub subscription (childList of the turn root) plus one ResizeObserver that only watches active turn elements.
 */
export function createTurnBackend() {
  let api = null;
  return {
    name: "content-visibility",
    mount(ctx) {
      // A failure while mounting is returned, not reported through ctx.fallback.
      let early = null;
      const mounted = mountTurns({ ...ctx, fallback: (reason) => (api ? ctx.fallback(reason) : (early = reason)) });
      if (mounted.active === false) return mounted;
      api = mounted;
      if (early) {
        api.dispose();
        api = null;
        return { active: false, reason: early };
      }
      return mounted;
    },
    /** Explicit navigation (#628): activate the window around a turn, then scroll there. */
    setWindow(turn, options) {
      return api?.navigateToTurn(turn, options) ?? false;
    },
    /** True when `el` is a turn element whose content is currently rendered (not skipped). */
    isTurnActive: (el) => api?.turnIndexOf(el) !== undefined && el.getAttribute(STATE) !== "inactive",
    /** Navigate to the turn that owns `el`; false when `el` is not a known turn element. */
    navigateToElement(el, options) {
      const i = api?.turnIndexOf(el);
      return i === undefined ? false : api.navigateToTurn(i, options);
    },
    unmount() {
      api?.dispose();
      api = null;
    },
    api: () => api,
  };
}

function mountTurns({ doc, adapter, scroll, observers, config, fallback, onLayout }) {
  const win = doc.defaultView;
  const size = config.windowTurns ?? 10;
  const prefetch = config.prefetchTurns ?? 2;
  const found = discover(doc, adapter);
  if (!found.parent) return { active: false, reason: found.reason };

  const { parent } = found;
  const scroller = adapter.scroller(doc);
  let turns = found.turns;
  let windowStart = Math.max(0, turns.length - size);
  let direction = 0;
  let lastTop = null;
  let disposed = false;
  let scheduled = false;
  const observed = new Set();
  const stats = { syncs: 0, pinned: 0 };

  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
  scroller.setAttribute("data-gs-scroller", "");

  const turnOf = new Map();
  const index = () => {
    turnOf.clear();
    for (const t of turns) for (const el of t.elements) turnOf.set(el, t.index);
  };
  index();
  const allElements = () => turns.flatMap((t) => t.elements);
  const viewportTop = () => (scroller === doc.scrollingElement || scroller === doc.documentElement ? 0 : scroller.getBoundingClientRect().top);

  scroll.setAnchors(allElements, (key) => allElements().find((el) => adapter.turnId(el, -1) === key) ?? null);
  const offScroll = scroll.onScroll(() => schedule());

  const ro = new win.ResizeObserver(() => {
    scroll.restore();
    schedule();
    onLayout?.(); // a turn changed size: the page column may have moved (sidebar, window)
  });
  const stopObserving = observers.subscribe(parent, () => refresh(), { childList: true, subtree: true });

  function observe(el, on) {
    if (on && !observed.has(el)) {
      observed.add(el);
      ro.observe(el);
    } else if (!on && observed.has(el)) {
      observed.delete(el);
      ro.unobserve(el);
    }
  }

  function schedule() {
    if (scheduled || disposed) return;
    scheduled = true;
    win.requestAnimationFrame(() => {
      scheduled = false;
      sync();
    });
  }

  function pinnedTurns() {
    const pins = new Set();
    const sel = doc.getSelection?.();
    for (const n of [sel?.anchorNode, sel?.focusNode, doc.activeElement]) {
      for (let p = n; p; p = p.parentNode) {
        if (turnOf.has(p)) {
          pins.add(turnOf.get(p));
          break;
        }
      }
    }
    return pins;
  }

  function firstVisibleTurn() {
    const base = viewportTop();
    for (const el of allElements()) {
      if (el.getBoundingClientRect().bottom > base + 0.01) return turnOf.get(el);
    }
    return turns.length - 1;
  }

  function sync() {
    if (disposed) return;
    stats.syncs++;
    try {
      const top = scroll.scrollTop();
      if (lastTop !== null && top !== lastTop) direction = top > lastTop ? 1 : -1;
      lastTop = top;
      const w = computeWindow({ count: turns.length, size, prefetch, start: windowStart, focus: firstVisibleTurn(), direction });
      windowStart = w.start;
      const pins = pinnedTurns();
      stats.pinned = 0;
      const active = new Set();
      for (const t of turns) {
        const inWindow = t.index >= w.extraStart && t.index <= w.extraEnd;
        if (pins.has(t.index) && !inWindow) stats.pinned++;
        if (inWindow || pins.has(t.index)) active.add(t.index);
      }
      applyActive(active);
    } catch (err) {
      fallback?.(`error:${err?.message ?? err}`);
    }
  }

  function applyActive(active) {
    // Read pass: measure everything about to be skipped; then write pass.
    const writes = [];
    for (const t of turns) {
      for (const el of t.elements) {
        const on = active.has(t.index);
        const isInactive = el.getAttribute(STATE) === "inactive";
        if (on) {
          if (isInactive || !el.hasAttribute(STATE)) writes.push([el, true]);
        } else if (!isInactive) {
          const h = el.getBoundingClientRect().height;
          if (h > 0) writes.push([el, false, h]);
        }
      }
    }
    for (const [el, on, h] of writes) {
      if (on) {
        el.setAttribute(STATE, "active");
        el.style.removeProperty(HEIGHT_VAR);
        observe(el, true);
      } else {
        el.style.setProperty(HEIGHT_VAR, `${h}px`);
        el.setAttribute(STATE, "inactive");
        observe(el, false);
      }
    }
    scroll.restore();
  }

  /** Turn list changed (new message, React re-render/remount): re-group and re-apply. */
  function refresh() {
    if (disposed) return;
    // Streaming mutates the subtree constantly; only a changed turn list needs regrouping.
    const current = adapter.turns(doc);
    const flat = allElements();
    if (current.length === flat.length && current.every((el, i) => el === flat[i]) && adapter.turnRoot(doc) === parent) return;
    const next = discover(doc, adapter);
    if (!next.parent || next.parent !== parent) return fallback?.(next.reason ?? "container-changed");
    const wasAtLatest = windowStart + size >= turns.length;
    turns = next.turns;
    index();
    if (wasAtLatest) windowStart = Math.max(0, turns.length - size);
    for (const el of [...observed]) if (!el.isConnected) observe(el, false);
    for (const el of allElements()) {
      if (el.hasAttribute(STATE)) continue;
      el.setAttribute(STATE, "active");
      observe(el, true);
    }
    scroll.restore();
    schedule();
  }

  for (const el of allElements()) {
    el.setAttribute(STATE, "active");
    observe(el, true);
  }

  const self = {
    active: true,
    stats,
    sync,
    turnCount: () => turns.length,
    turnIndexOf: (el) => turnOf.get(el),
    activeTurnCount: () => turns.filter((t) => t.elements.some((e) => e.getAttribute(STATE) === "active")).length,
    observerStats: () => ({ resizeTargets: observed.size, hubSubscriptions: observers.size() }),
    navigateToTurn(i, { offset = 0 } = {}) {
      const t = turns[i];
      if (!t) return false;
      direction = 0;
      const w = computeWindow({ count: turns.length, size, prefetch, start: windowStart, focus: i, direction: 0 });
      windowStart = w.start;
      const active = new Set(pinnedTurns());
      for (let k = w.start; k <= w.end; k++) active.add(k);
      applyActive(active);
      const ok = scroll.navigateTo(t.elements[0], { offset });
      sync();
      return ok;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopObserving();
      ro.disconnect();
      offScroll();
      for (const el of allElements()) {
        el.removeAttribute(STATE);
        el.style.removeProperty(HEIGHT_VAR);
        if (!el.getAttribute("style")) el.removeAttribute("style");
      }
      scroller.removeAttribute("data-gs-scroller");
      style.remove();
    },
  };
  self.sync();
  return self;
}
