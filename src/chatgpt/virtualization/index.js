import { createScrollController } from "./scroll-controller.js";
import { computeWindow, groupTurns } from "./turn-window.js";

export { computeWindow, groupTurns, createScrollController };

export const DEFAULT_SELECTORS = {
  turn: '[data-testid^="conversation-turn-"]',
  role: "[data-message-author-role]",
  roleAttribute: "data-message-author-role",
};

const STATE = "data-gs-state";
const HEIGHT_VAR = "--gs-h";
const STYLE_ID = "gs-virtualization-style";
const CSS = `
[data-gs-scroller]{overflow-anchor:none}
[${STATE}="inactive"]{content-visibility:hidden;contain-intrinsic-block-size:var(${HEIGHT_VAR})}
`;

function nearestScroller(el) {
  const win = el.ownerDocument.defaultView;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = win.getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
  }
  return null;
}

/** Locate turns, their container and the scroller; any surprise returns a reason to fail open. */
export function discover(doc, selectors, scrollerOverride) {
  const els = [...doc.querySelectorAll(selectors.turn)];
  if (!els.length) return { reason: "no-turns" };
  const parent = els[0].parentElement;
  if (!parent || els.some((e) => e.parentElement !== parent)) return { reason: "turns-not-siblings" };
  const roleOf = (el) => {
    const holder = el.matches(selectors.role) ? el : el.querySelector(selectors.role);
    return holder?.getAttribute(selectors.roleAttribute) || null;
  };
  const turns = groupTurns(els, roleOf);
  if (!turns) return { reason: "unknown-role" };
  const scroller = scrollerOverride ?? nearestScroller(parent);
  if (!scroller) return { reason: "no-scroller" };
  return { parent, scroller, turns };
}

/**
 * Keep the latest `size` complete turns rendered and skip rendering of older
 * ones with content-visibility plus a measured placeholder height. Nothing is
 * detached from the DOM, so React stays in charge of the tree; every write is
 * an attribute that `dispose()` removes. Falls back to native rendering
 * (returns `{ active: false, reason }` without touching the page) when markup
 * does not match, and disposes itself if it later stops matching.
 *
 * @param {object} [o]
 * @param {Document} [o.document]
 * @param {Partial<typeof DEFAULT_SELECTORS>} [o.selectors]
 * @param {number} [o.size] active complete turns
 * @param {number} [o.prefetch] extra turns kept live past the leading edge
 * @param {Element} [o.scroller]
 * @param {{ now(): number }} [o.clock]
 * @param {(reason: string) => void} [o.onFallback]
 */
export function createVirtualizer(o = {}) {
  const doc = o.document ?? globalThis.document;
  const win = doc.defaultView;
  const selectors = { ...DEFAULT_SELECTORS, ...o.selectors };
  const size = o.size ?? 10;
  const prefetch = o.prefetch ?? 2;

  const found = discover(doc, selectors, o.scroller);
  if (!found.parent) {
    o.onFallback?.(found.reason);
    return { active: false, reason: found.reason, dispose() {}, sync() {}, navigateToTurn: () => false };
  }

  const { parent, scroller } = found;
  let turns = found.turns;
  let windowStart = Math.max(0, turns.length - size);
  let direction = 0;
  let lastTop = null;
  let focusIndex = turns.length - 1;
  let disposed = false;
  let scheduled = false;
  const observed = new Set();
  const stats = { syncs: 0, pinned: 0, fallbackReason: null };

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

  const controller = createScrollController({
    scroller,
    clock: o.clock,
    anchors: allElements,
    resolveAnchor: (key) => parent.querySelector(`[data-testid="${CSS_escape(key)}"]`),
    onScroll: () => schedule(),
  });

  const ro = new win.ResizeObserver(() => {
    controller.restore();
    schedule();
  });
  const mo = new win.MutationObserver(() => refresh());
  mo.observe(parent, { childList: true });

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
    const base = scroller.getBoundingClientRect().top;
    for (const el of allElements()) {
      if (el.getBoundingClientRect().bottom > base + 0.01) return turnOf.get(el);
    }
    return turns.length - 1;
  }

  function sync() {
    if (disposed) return;
    stats.syncs++;
    try {
      const top = controller.scrollTop();
      if (lastTop !== null && top !== lastTop) direction = top > lastTop ? 1 : -1;
      lastTop = top;
      focusIndex = firstVisibleTurn();
      const w = computeWindow({ count: turns.length, size, prefetch, start: windowStart, focus: focusIndex, direction });
      windowStart = w.start;
      const pins = pinnedTurns();
      stats.pinned = 0;
      const active = new Set();
      for (const t of turns) {
        const pinned = pins.has(t.index);
        if (pinned && (t.index < w.extraStart || t.index > w.extraEnd)) stats.pinned++;
        if ((t.index >= w.extraStart && t.index <= w.extraEnd) || pinned) active.add(t.index);
      }
      applyActive(active);
    } catch (err) {
      fallback(`error:${err?.message ?? err}`);
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
          if (h > 0) {
            writes.push([el, false, h]);
          }
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
    controller.restore();
  }

  /** Turn list changed (new message, React re-render/remount): re-group and re-apply. */
  function refresh() {
    if (disposed) return;
    const next = discover(doc, selectors, scroller);
    if (!next.parent || next.parent !== parent) return fallback(next.reason ?? "container-changed");
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
    controller.restore();
    schedule();
  }

  function fallback(reason) {
    stats.fallbackReason = reason;
    api.dispose();
    o.onFallback?.(reason);
  }

  for (const el of allElements()) {
    el.setAttribute(STATE, "active");
    observe(el, true);
  }

  const api = {
    active: true,
    controller,
    stats,
    sync,
    turnCount: () => turns.length,
    activeTurnCount: () => turns.filter((t) => t.elements.some((e) => e.getAttribute(STATE) === "active")).length,
    observerStats: () => ({ resizeTargets: observed.size, mutationObservers: 1 }),
    /** Explicit navigation: activate the window around a turn, then move the viewport. */
    navigateToTurn(i, { offset = 0 } = {}) {
      const t = turns[i];
      if (!t) return false;
      direction = 0;
      const w = computeWindow({ count: turns.length, size, prefetch, start: windowStart, focus: i, direction: 0 });
      windowStart = w.start;
      const active = new Set();
      for (let k = w.start; k <= w.end; k++) active.add(k);
      for (const p of pinnedTurns()) active.add(p);
      applyActive(active);
      const ok = controller.navigateTo(t.elements[0], { offset });
      sync();
      return ok;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mo.disconnect();
      ro.disconnect();
      controller.dispose();
      for (const el of allElements()) {
        el.removeAttribute(STATE);
        el.style.removeProperty(HEIGHT_VAR);
        if (!el.getAttribute("style")) el.removeAttribute("style");
      }
      scroller.removeAttribute("data-gs-scroller");
      style.remove();
    },
  };
  api.sync();
  return api;
}

function CSS_escape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}
