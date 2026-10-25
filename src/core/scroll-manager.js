const EPS = 0.01;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

function findDescriptor(obj, prop) {
  for (let o = obj; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, prop);
    if (d) return d;
  }
  return null;
}

const isEditable = (el) =>
  !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

// Only explicit user intent may move the viewport; other sources are refused.
export const MOVING_SOURCES = Object.freeze(["user", "prompt-nav", "minimap", "keyboard"]);

/**
 * The single owner of the conversation scroller. Page-initiated scrolls
 * (scrollTop writes, scrollTo/scroll/scrollBy, scrollIntoView of descendants)
 * are blocked, any scroll that still arrives without user input or an explicit
 * navigation is reverted, and the visible anchor keeps its exact pixel offset
 * when content changes size. Programmatic movement is only possible through
 * `navigate` / `navigateTo`.
 *
 * Anchor candidates and re-render lookup are supplied by the virtualization
 * backend through `setAnchors`; scroll notifications through `onScroll`.
 *
 * @param {object} o
 * @param {Element} o.scroller
 * @param {{ count(name: string): void }} [o.diagnostics]
 * @param {{ now(): number }} [o.clock]
 */
export function createScrollManager({ scroller, diagnostics, clock, intentMs = 300 }) {
  const doc = scroller.ownerDocument;
  const win = doc.defaultView;
  const pageScroller = scroller === doc.scrollingElement || scroller === doc.documentElement || scroller === doc.body;
  const scrollTarget = pageScroller ? doc : scroller;
  let anchors = () => [];
  let resolveAnchor = null;
  const listeners = new Set();
  const onScroll = (kind) => listeners.forEach((fn) => fn(kind));
  const now = clock ? () => clock.now() : () => win.performance.now();
  const stats = {
    blocked: { scrollTop: 0, scrollTo: 0, scrollBy: 0, scrollIntoView: 0 },
    unexpected: 0,
    corrections: 0,
    userScrolls: 0,
    navigations: 0,
  };
  const blockedCount = (kind) => {
    stats.blocked[kind]++;
    diagnostics?.count(`scroll.blocked.${kind}`);
  };

  const desc = findDescriptor(scroller, "scrollTop");
  const rawGet = () => desc.get.call(scroller);
  const rawSet = (v) => desc.set.call(scroller, v);
  const hadOwnScrollTop = Object.prototype.hasOwnProperty.call(scroller, "scrollTop");
  const ownScrollTop = hadOwnScrollTop ? Object.getOwnPropertyDescriptor(scroller, "scrollTop") : null;

  let navDepth = 0;
  let intentUntil = -Infinity;
  let expected = null;
  let anchor = null;
  let lastTop = rawGet();
  let disposed = false;

  const intentActive = () => now() <= intentUntil;
  const scrollerTop = () => (pageScroller ? 0 : scroller.getBoundingClientRect().top);

  function capture() {
    lastTop = rawGet();
    const base = scrollerTop();
    for (const el of anchors()) {
      const r = el.getBoundingClientRect();
      if (r.bottom > base + EPS) {
        anchor = { el, key: el.getAttribute("data-turn-key") ?? el.getAttribute("data-testid") ?? "", offset: r.top - base };
        return anchor;
      }
    }
    anchor = null;
    return null;
  }

  function write(value) {
    const before = rawGet();
    rawSet(value);
    const after = rawGet();
    if (after !== before) expected = after;
    lastTop = after;
  }

  /** Put the anchor back at its recorded offset. Returns true if it moved. */
  function restore() {
    if (disposed) return false;
    if (!anchor) {
      capture();
      return false;
    }
    if (rawGet() !== lastTop && (intentActive() || expected !== null)) {
      capture();
      return false;
    }
    let el = anchor.el;
    if (!el.isConnected) {
      el = anchor.key && resolveAnchor ? resolveAnchor(anchor.key) : null;
      if (!el) {
        capture();
        return false;
      }
      anchor.el = el;
    }
    const delta = el.getBoundingClientRect().top - scrollerTop() - anchor.offset;
    if (Math.abs(delta) <= EPS) return false;
    write(rawGet() + delta);
    stats.corrections++;
    diagnostics?.count("scroll.anchor-compensated");
    return true;
  }

  function markIntent() {
    intentUntil = now() + intentMs;
    expected = null;
  }

  function handleScroll() {
    const top = rawGet();
    if (expected !== null && Math.abs(top - expected) <= 0.5) {
      expected = null;
      capture();
      onScroll("navigation");
    } else if (intentActive()) {
      intentUntil = now() + intentMs;
      stats.userScrolls++;
      capture();
      onScroll("user");
    } else if (anchor && Math.abs(top - lastTop) > EPS) {
      stats.unexpected++;
      diagnostics?.count("scroll.unexpected-reverted");
      restore();
    } else {
      lastTop = top;
    }
  }

  const onKey = (e) => {
    if (SCROLL_KEYS.has(e.key) && !isEditable(e.target)) markIntent();
  };
  const onPointer = (e) => {
    if (e.target === scroller) markIntent();
  };
  const domListeners = [
    [scrollTarget, "scroll", handleScroll],
    [scroller, "wheel", markIntent],
    [scroller, "touchstart", markIntent],
    [scroller, "touchmove", markIntent],
    [scroller, "pointerdown", onPointer],
    [scroller, "pointermove", (e) => e.buttons && e.target === scroller && markIntent()],
    [doc, "keydown", onKey],
  ];
  for (const [t, n, f] of domListeners) t.addEventListener(n, f, { capture: true, passive: true });

  // Block page-initiated programmatic scrolling.
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: rawGet,
    set(v) {
      if (navDepth) rawSet(v);
      else blockedCount("scrollTop");
    },
  });
  // A page scroller is scrolled through window.scrollTo & co.
  const patchHost = pageScroller ? win : scroller;
  const patched = [];
  for (const [name, stat] of [["scrollTo", "scrollTo"], ["scroll", "scrollTo"], ["scrollBy", "scrollBy"]]) {
    const orig = patchHost[name];
    if (typeof orig !== "function") continue;
    patchHost[name] = function (...args) {
      if (navDepth) return orig.apply(patchHost, args);
      blockedCount(stat);
    };
    patched.push([name, orig, Object.prototype.hasOwnProperty.call(patchHost, name)]);
  }
  const protoSIV = win.Element.prototype.scrollIntoView;
  const ownSIV = Object.prototype.hasOwnProperty.call(win.Element.prototype, "scrollIntoView");
  if (typeof protoSIV === "function") {
    win.Element.prototype.scrollIntoView = function (...args) {
      if (!disposed && !navDepth && this !== scroller && scroller.contains(this)) {
        blockedCount("scrollIntoView");
        return;
      }
      return protoSIV.apply(this, args);
    };
  }

  capture();

  return {
    stats,
    capture,
    restore,
    /** The only programmatic scroll path: runs `fn` with page-scroll blocking lifted. */
    navigate(fn) {
      navDepth++;
      try {
        fn();
      } finally {
        navDepth--;
      }
      stats.navigations++;
      lastTop = rawGet();
      capture();
    },
    /** Scroll so that `target` sits `offset` px below the scroller's top edge. */
    navigateTo(target, { offset = 0 } = {}) {
      const el = typeof target === "string" ? resolveAnchor?.(target) : target;
      if (!el) return false;
      navDepth++;
      try {
        write(rawGet() + (el.getBoundingClientRect().top - scrollerTop() - offset));
      } finally {
        navDepth--;
      }
      stats.navigations++;
      capture();
      return true;
    },
    scrollTop: rawGet,
    setAnchors(candidates, resolve) {
      anchors = candidates;
      resolveAnchor = resolve ?? null;
      capture();
    },
    /** Subscribe to accepted (user / navigation) scrolls; returns an unsubscribe. */
    onScroll(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Explicit navigation by source; unsolicited sources are refused. */
    scrollTo(source, top) {
      if (!MOVING_SOURCES.includes(source)) {
        diagnostics?.count(`scroll.refused.${source}`);
        return false;
      }
      navDepth++;
      try {
        write(top);
      } finally {
        navDepth--;
      }
      stats.navigations++;
      diagnostics?.count(`scroll.moved.${source}`);
      capture();
      return true;
    },
    /** Run a DOM change while `anchorEl` keeps its viewport offset. Returns the compensated drift. */
    preserve(anchorEl, mutate) {
      const before = anchorEl.getBoundingClientRect().top;
      mutate();
      const drift = anchorEl.getBoundingClientRect().top - before;
      if (drift !== 0) {
        write(rawGet() + drift);
        diagnostics?.count("scroll.anchor-compensated");
      }
      capture();
      return drift;
    },
    dispose() {
      disposed = true;
      listeners.clear();
      for (const [t, n, f] of domListeners) t.removeEventListener(n, f, { capture: true });
      if (ownScrollTop) Object.defineProperty(scroller, "scrollTop", ownScrollTop);
      else delete scroller.scrollTop;
      for (const [name, orig, own] of patched) {
        if (own && pageScroller) patchHost[name] = orig;
        else delete patchHost[name];
      }
      if (typeof protoSIV === "function") {
        if (ownSIV) win.Element.prototype.scrollIntoView = protoSIV;
        else delete win.Element.prototype.scrollIntoView;
      }
    },
  };
}
