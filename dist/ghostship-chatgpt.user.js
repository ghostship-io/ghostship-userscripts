// ==UserScript==
// @name         GhostShip ChatGPT
// @namespace    https://github.com/ghostship-io/ghostship-userscripts
// @version      0.2.0
// @description  Fast, queue-aware ChatGPT interface for the owner browser.
// @match        https://chatgpt.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/ghostship-io/ghostship-userscripts/main/dist/ghostship-chatgpt.meta.js
// @downloadURL  https://raw.githubusercontent.com/ghostship-io/ghostship-userscripts/main/dist/ghostship-chatgpt.user.js
// ==/UserScript==

(() => {
  // src/core/config.js
  var CONFIG_KEY = "ghostship:userscripts:config";
  var DEFAULTS = Object.freeze({
    enabled: true,
    dryRun: true,
    windowTurns: 10,
    prefetchTurns: 2,
    maxObservers: 4,
    debug: false
  });
  function parseConfig(raw) {
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
    if (!Number.isInteger(out.prefetchTurns) || out.prefetchTurns < 0) out.prefetchTurns = DEFAULTS.prefetchTurns;
    if (!Number.isInteger(out.maxObservers) || out.maxObservers < 1) out.maxObservers = DEFAULTS.maxObservers;
    return out;
  }
  function loadConfig(storage) {
    try {
      return parseConfig(storage.getItem(CONFIG_KEY));
    } catch {
      return { ...DEFAULTS };
    }
  }

  // src/core/diagnostics.js
  function createDiagnostics(log = console) {
    const counters = /* @__PURE__ */ new Map();
    const warned = /* @__PURE__ */ new Set();
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
      }
    };
  }

  // src/core/observers.js
  function createObserverHub({ max, MutationObserverCtor = globalThis.MutationObserver, schedule = (fn) => setTimeout(fn, 16), diagnostics }) {
    const roots = /* @__PURE__ */ new Map();
    let subscriptions = 0;
    function ensure(root, options) {
      let entry = roots.get(root);
      if (entry) return entry;
      entry = { handlers: /* @__PURE__ */ new Set(), pending: [], scheduled: false, observer: null };
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
      }
    };
  }

  // src/core/scroll-manager.js
  var EPS = 0.01;
  var SCROLL_KEYS = /* @__PURE__ */ new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
  function findDescriptor(obj, prop) {
    for (let o = obj; o; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, prop);
      if (d) return d;
    }
    return null;
  }
  var isEditable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  var MOVING_SOURCES = Object.freeze(["user", "prompt-nav", "minimap", "keyboard"]);
  function createScrollManager({ scroller, diagnostics, clock, intentMs = 300 }) {
    const doc = scroller.ownerDocument;
    const win = doc.defaultView;
    const pageScroller = scroller === doc.scrollingElement || scroller === doc.documentElement || scroller === doc.body;
    const scrollTarget = pageScroller ? doc : scroller;
    let anchors = () => [];
    let resolveAnchor = null;
    const listeners = /* @__PURE__ */ new Set();
    const onScroll = (kind) => listeners.forEach((fn) => fn(kind));
    const now = clock ? () => clock.now() : () => win.performance.now();
    const stats = {
      blocked: { scrollTop: 0, scrollTo: 0, scrollBy: 0, scrollIntoView: 0 },
      unexpected: 0,
      corrections: 0,
      userScrolls: 0,
      navigations: 0
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
    const scrollerTop = () => pageScroller ? 0 : scroller.getBoundingClientRect().top;
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
      [doc, "keydown", onKey]
    ];
    for (const [t, n, f] of domListeners) t.addEventListener(n, f, { capture: true, passive: true });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: rawGet,
      set(v) {
        if (navDepth) rawSet(v);
        else blockedCount("scrollTop");
      }
    });
    const patchHost = pageScroller ? win : scroller;
    const patched = [];
    for (const [name, stat] of [["scrollTo", "scrollTo"], ["scroll", "scrollTo"], ["scrollBy", "scrollBy"]]) {
      const orig = patchHost[name];
      if (typeof orig !== "function") continue;
      patchHost[name] = function(...args) {
        if (navDepth) return orig.apply(patchHost, args);
        blockedCount(stat);
      };
      patched.push([name, orig, Object.prototype.hasOwnProperty.call(patchHost, name)]);
    }
    const protoSIV = win.Element.prototype.scrollIntoView;
    const ownSIV = Object.prototype.hasOwnProperty.call(win.Element.prototype, "scrollIntoView");
    if (typeof protoSIV === "function") {
      win.Element.prototype.scrollIntoView = function(...args) {
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
      }
    };
  }

  // src/core/prompt-index.js
  var PREVIEW_LENGTH = 120;
  function buildPromptIndex(root, adapter) {
    const prompts = [];
    adapter.turns(root).forEach((turn, turnIndex) => {
      const el = adapter.userMessage(turn);
      if (!el) return;
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      prompts.push({ id: adapter.turnId(turn, turnIndex), turnIndex, preview: text.slice(0, PREVIEW_LENGTH), text });
    });
    return prompts;
  }

  // src/core/virtualization.js
  var BACKEND_METHODS = Object.freeze(["mount", "setWindow", "unmount"]);
  function assertBackend(backend) {
    for (const method of BACKEND_METHODS) {
      if (typeof backend?.[method] !== "function") throw new Error(`virtualization backend missing ${method}()`);
    }
    return backend;
  }
  function createNoopBackend() {
    return { name: "noop", mount() {
    }, setWindow() {
    }, unmount() {
    } };
  }
  function groupTurns(elements, roleOf) {
    const turns = [];
    for (const el of elements) {
      const role = roleOf(el);
      if (!role) return null;
      if (role === "user" || turns.length === 0) turns.push({ index: turns.length, elements: [] });
      turns[turns.length - 1].elements.push(el);
    }
    return turns;
  }
  var clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function computeWindow({ count, size, prefetch, start, focus, direction }) {
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

  // src/core/runtime.js
  function createRuntime({ win, adapter, backend = createNoopBackend(), config = loadConfig(win.localStorage) }) {
    const diagnostics = createDiagnostics(win.console);
    const runtime2 = { config, diagnostics, mode: "off", promptIndex: [], dispose() {
    } };
    if (!config.enabled) return runtime2;
    const check = adapter.selfCheck(win.document);
    if (!check.ok) {
      runtime2.mode = "safe";
      diagnostics.count("selfcheck.failed");
      diagnostics.warnOnce("selfcheck", `ChatGPT layout not recognised (${check.missing.join(", ")}); running in safe mode`);
      return runtime2;
    }
    const observers = createObserverHub({ max: config.maxObservers, MutationObserverCtor: win.MutationObserver, schedule: (fn) => win.setTimeout(fn, 16), diagnostics });
    const scroll = createScrollManager({ scroller: adapter.scroller(win.document), diagnostics });
    assertBackend(backend);
    let stop = () => {
    };
    const failOpen = (reason) => {
      stop();
      backend.unmount();
      observers.disposeAll();
      scroll.dispose();
      Object.assign(runtime2, { mode: "safe", scroll: void 0, observers: void 0, dispose() {
      } });
      diagnostics.count("virtualization.fallback");
      diagnostics.warnOnce("virtualization", `virtualization disabled (${reason}); running in safe mode`);
    };
    const mounted = backend.mount({ doc: win.document, adapter, scroll, observers, config, diagnostics, fallback: failOpen });
    if (mounted?.active === false) {
      failOpen(mounted.reason);
      return runtime2;
    }
    const reindex = () => {
      runtime2.promptIndex = buildPromptIndex(win.document, adapter);
      diagnostics.count("index.rebuilt");
    };
    reindex();
    stop = observers.subscribe(win.document.body, reindex);
    Object.assign(runtime2, {
      mode: "active",
      scroll,
      observers,
      dispose() {
        stop();
        observers.disposeAll();
        backend.unmount();
        scroll.dispose();
      }
    });
    return runtime2;
  }

  // src/chatgpt/adapter.js
  var TURN = '[data-testid^="conversation-turn-"]';
  var ROLE = "[data-message-author-role]";
  var USER = '[data-message-author-role="user"]';
  var COMPOSER = "#prompt-textarea";
  var chatgptAdapter = {
    turns: (root) => [...root.querySelectorAll(TURN)],
    role: (turn) => (turn.matches(ROLE) ? turn : turn.querySelector(ROLE))?.getAttribute("data-message-author-role") || null,
    userMessage: (turn) => turn.querySelector(USER),
    turnId: (turn, index) => turn.getAttribute("data-testid") ?? `turn-${index}`,
    scroller: (doc) => doc.querySelector("[data-scroll-root]") ?? doc.scrollingElement ?? doc.documentElement,
    selfCheck(doc) {
      const missing = [];
      if (!doc.querySelector(TURN)) missing.push("turns");
      if (!doc.querySelector(COMPOSER)) missing.push("composer");
      return { ok: missing.length === 0, missing };
    }
  };

  // src/chatgpt/virtualization/backend.js
  var STATE = "data-gs-state";
  var HEIGHT_VAR = "--gs-h";
  var STYLE_ID = "gs-virtualization-style";
  var CSS = `
[data-gs-scroller]{overflow-anchor:none}
[${STATE}="inactive"]{content-visibility:hidden;contain-intrinsic-block-size:var(${HEIGHT_VAR})}
`;
  function discover(doc, adapter) {
    const els = adapter.turns(doc);
    if (!els.length) return { reason: "no-turns" };
    const parent = els[0].parentElement;
    if (!parent || els.some((e) => e.parentElement !== parent)) return { reason: "turns-not-siblings" };
    const turns = groupTurns(els, adapter.role);
    if (!turns) return { reason: "unknown-role" };
    return { parent, turns };
  }
  function createTurnBackend() {
    let api = null;
    return {
      name: "content-visibility",
      mount(ctx) {
        let early = null;
        const mounted = mountTurns({ ...ctx, fallback: (reason) => api ? ctx.fallback(reason) : early = reason });
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
      unmount() {
        api?.dispose();
        api = null;
      },
      api: () => api
    };
  }
  function mountTurns({ doc, adapter, scroll, observers, config, fallback }) {
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
    const observed = /* @__PURE__ */ new Set();
    const stats = { syncs: 0, pinned: 0 };
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
    scroller.setAttribute("data-gs-scroller", "");
    const turnOf = /* @__PURE__ */ new Map();
    const index = () => {
      turnOf.clear();
      for (const t of turns) for (const el of t.elements) turnOf.set(el, t.index);
    };
    index();
    const allElements = () => turns.flatMap((t) => t.elements);
    const viewportTop = () => scroller === doc.scrollingElement || scroller === doc.documentElement ? 0 : scroller.getBoundingClientRect().top;
    scroll.setAnchors(allElements, (key) => allElements().find((el) => adapter.turnId(el, -1) === key) ?? null);
    const offScroll = scroll.onScroll(() => schedule());
    const ro = new win.ResizeObserver(() => {
      scroll.restore();
      schedule();
    });
    const stopObserving = observers.subscribe(parent, () => refresh(), { childList: true });
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
      const pins = /* @__PURE__ */ new Set();
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
        const active = /* @__PURE__ */ new Set();
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
    function refresh() {
      if (disposed) return;
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
      }
    };
    self.sync();
    return self;
  }

  // src/chatgpt/main.js
  var runtime = createRuntime({ win: window, adapter: chatgptAdapter, backend: createTurnBackend() });
  window.__ghostshipUserscripts = { mode: runtime.mode, diagnostics: () => runtime.diagnostics.snapshot() };
})();
