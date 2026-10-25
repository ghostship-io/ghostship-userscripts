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

/**
 * The single owner of the conversation scroller. Page-initiated scrolls
 * (scrollTop writes, scrollTo/scroll/scrollBy, scrollIntoView of descendants)
 * are blocked, any scroll that still arrives without user input or an explicit
 * navigation is reverted, and the visible anchor keeps its exact pixel offset
 * when content changes size. Programmatic movement is only possible through
 * `navigate` / `navigateTo`.
 *
 * @param {object} o
 * @param {Element} o.scroller
 * @param {() => Iterable<Element>} o.anchors ordered anchor candidates
 * @param {(key: string) => Element | null} [o.resolveAnchor] re-find an anchor after a re-render
 * @param {{ now(): number }} [o.clock]
 * @param {(kind: "user" | "navigation") => void} [o.onScroll]
 */
export function createScrollController({ scroller, anchors, resolveAnchor, clock, intentMs = 300, onScroll }) {
  const doc = scroller.ownerDocument;
  const win = doc.defaultView;
  const now = clock ? () => clock.now() : () => win.performance.now();
  const stats = {
    blocked: { scrollTop: 0, scrollTo: 0, scrollBy: 0, scrollIntoView: 0 },
    unexpected: 0,
    corrections: 0,
    userScrolls: 0,
    navigations: 0,
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
  const scrollerTop = () => scroller.getBoundingClientRect().top;

  function capture() {
    lastTop = rawGet();
    const base = scrollerTop();
    for (const el of anchors()) {
      const r = el.getBoundingClientRect();
      if (r.bottom > base + EPS) {
        anchor = { el, key: el.getAttribute("data-testid") ?? "", offset: r.top - base };
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
      onScroll?.("navigation");
    } else if (intentActive()) {
      intentUntil = now() + intentMs;
      stats.userScrolls++;
      capture();
      onScroll?.("user");
    } else if (anchor && Math.abs(top - lastTop) > EPS) {
      stats.unexpected++;
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
  const listeners = [
    [scroller, "scroll", handleScroll],
    [scroller, "wheel", markIntent],
    [scroller, "touchstart", markIntent],
    [scroller, "touchmove", markIntent],
    [scroller, "pointerdown", onPointer],
    [scroller, "pointermove", (e) => e.buttons && e.target === scroller && markIntent()],
    [doc, "keydown", onKey],
  ];
  for (const [t, n, f] of listeners) t.addEventListener(n, f, { capture: true, passive: true });

  // Block page-initiated programmatic scrolling.
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: rawGet,
    set(v) {
      if (navDepth) rawSet(v);
      else stats.blocked.scrollTop++;
    },
  });
  const patched = [];
  for (const [name, stat] of [["scrollTo", "scrollTo"], ["scroll", "scrollTo"], ["scrollBy", "scrollBy"]]) {
    const orig = scroller[name];
    if (typeof orig !== "function") continue;
    scroller[name] = function (...args) {
      if (navDepth) return orig.apply(scroller, args);
      stats.blocked[stat]++;
    };
    patched.push(name);
  }
  const protoSIV = win.Element.prototype.scrollIntoView;
  const ownSIV = Object.prototype.hasOwnProperty.call(win.Element.prototype, "scrollIntoView");
  if (typeof protoSIV === "function") {
    win.Element.prototype.scrollIntoView = function (...args) {
      if (!disposed && !navDepth && this !== scroller && scroller.contains(this)) {
        stats.blocked.scrollIntoView++;
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
    dispose() {
      disposed = true;
      for (const [t, n, f] of listeners) t.removeEventListener(n, f, { capture: true });
      if (ownScrollTop) Object.defineProperty(scroller, "scrollTop", ownScrollTop);
      else delete scroller.scrollTop;
      for (const name of patched) delete scroller[name];
      if (typeof protoSIV === "function") {
        if (ownSIV) win.Element.prototype.scrollIntoView = protoSIV;
        else delete win.Element.prototype.scrollIntoView;
      }
    },
  };
}
