// ==UserScript==
// @name         GhostShip ChatGPT
// @namespace    https://github.com/ghostship-io/ghostship-userscripts
// @version      0.7.0
// @description  Fast, queue-aware ChatGPT interface for the owner browser.
// @match        https://chatgpt.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/ghostship-io/ghostship-userscripts/main/dist/ghostship-chatgpt.meta.js
// @downloadURL  https://raw.githubusercontent.com/ghostship-io/ghostship-userscripts/main/dist/ghostship-chatgpt.user.js
// ==/UserScript==

(() => {
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

  // src/core/boot.js
  var BOOT_DEFAULTS = Object.freeze({ maxWaitMs: 3e4, settleMs: 100 });
  function createBoot({ win, adapter, mount, version, onDispose, extraDiagnostics, maxWaitMs = BOOT_DEFAULTS.maxWaitMs, settleMs = BOOT_DEFAULTS.settleMs, timers }) {
    const doc = win.document;
    const t = timers ?? {
      setTimeout: (fn, ms) => win.setTimeout(fn, ms),
      clearTimeout: (id) => win.clearTimeout(id),
      now: () => win.performance.now()
    };
    const diagnostics = createDiagnostics(win.console);
    const state = { phase: "waiting", reason: null, missing: [], attempts: 0, waitStart: t.now(), route: "new", turns: false };
    let current = null;
    let failedLayout = null;
    let observer = null;
    let debounce = null;
    let giveUpTimer = null;
    let disposed = false;
    const sameLayout = (a, b) => !!a && !!b && a.route === b.route && a.composer === b.composer && a.container === b.container && a.scroller === b.scroller;
    function watch(on) {
      if (on && !observer && !disposed) {
        observer = new win.MutationObserver(() => schedule());
        observer.observe(doc.body, { childList: true, subtree: true });
      } else if (!on && observer) {
        observer.disconnect();
        observer = null;
      }
    }
    function schedule() {
      if (debounce !== null || disposed) return;
      debounce = t.setTimeout(() => {
        debounce = null;
        tick();
      }, settleMs);
    }
    function teardown() {
      const old = current;
      current = null;
      try {
        old?.handle.dispose();
      } catch (error) {
        diagnostics.count("boot.dispose.failed");
      }
    }
    function startWaiting(reason) {
      state.phase = "waiting";
      state.reason = reason;
      state.waitStart = t.now();
      state.attempts = 0;
      t.clearTimeout(giveUpTimer);
      giveUpTimer = t.setTimeout(giveUp, maxWaitMs);
      watch(true);
    }
    function giveUp() {
      giveUpTimer = null;
      if (disposed || current) return;
      const check = adapter.selfCheck(doc);
      if (check.ok) return tick();
      state.phase = "timeout";
      state.reason = "timeout";
      state.missing = check.missing;
      diagnostics.count("boot.timeout");
      diagnostics.warnOnce("boot-timeout", `ChatGPT layout not found after ${Math.round(maxWaitMs / 1e3)}s (${check.missing.join(", ")}); the script stays idle until the page route changes`);
      watch(false);
    }
    function start(layout, check) {
      state.attempts++;
      try {
        const handle = mount();
        current = { handle, layout };
        const mode = handle.runtime.mode;
        state.reason = null;
        if (mode === "off") {
          state.phase = "off";
          watch(false);
        } else if (mode === "safe") {
          failedLayout = layout;
          state.phase = "running";
        } else {
          state.phase = "running";
        }
        t.clearTimeout(giveUpTimer);
        giveUpTimer = null;
      } catch (error) {
        failedLayout = layout;
        state.phase = "error";
        state.reason = "mount-error";
        diagnostics.count("boot.mount.failed");
        diagnostics.warnOnce("boot-mount", `startup failed (${error instanceof Error ? error.message : error}); running without the script`);
      }
      state.missing = check.missing;
    }
    function tick() {
      if (disposed) return;
      const layout = adapter.layout(doc, win);
      const check = adapter.selfCheck(doc);
      state.route = layout.route === "new" ? "new" : "conversation";
      state.turns = check.hasTurns;
      if (state.phase === "off") return;
      if (current) {
        state.missing = check.missing;
        if (sameLayout(current.layout, layout)) {
          if (current.handle.runtime.mode === "safe") failedLayout = layout;
          return;
        }
        diagnostics.count("boot.restart");
        teardown();
        failedLayout = null;
        startWaiting("restart");
      }
      if (sameLayout(failedLayout, layout)) return;
      failedLayout = null;
      if (!check.ok) {
        state.missing = check.missing;
        return;
      }
      start(layout, check);
    }
    const onRoute = () => {
      if (state.phase === "timeout") startWaiting("route");
      schedule();
    };
    const history = win.history;
    const originals = {};
    for (const name of ["pushState", "replaceState"]) {
      originals[name] = history[name];
      const wrapped = function(...args) {
        const result = originals[name].apply(this, args);
        onRoute();
        return result;
      };
      history[name] = wrapped;
      originals[name + "Wrapped"] = wrapped;
    }
    win.addEventListener("popstate", onRoute);
    win.addEventListener("hashchange", onRoute);
    startWaiting(null);
    tick();
    const health = {
      version,
      get mode() {
        if (current) return current.handle.runtime.mode;
        return state.phase === "timeout" || state.phase === "error" ? "safe" : state.phase === "off" ? "off" : "waiting";
      },
      get missing() {
        return [...state.missing];
      },
      get reason() {
        return state.reason;
      },
      get route() {
        return state.route;
      },
      get attempts() {
        return state.attempts;
      },
      diagnostics: () => ({ ...diagnostics.snapshot(), ...extraDiagnostics?.() ?? {}, ...current?.handle.runtime.diagnostics.snapshot() ?? {} })
    };
    return {
      health,
      runtime: () => current?.handle.runtime ?? null,
      dispose() {
        if (disposed) return;
        disposed = true;
        watch(false);
        t.clearTimeout(debounce);
        t.clearTimeout(giveUpTimer);
        win.removeEventListener("popstate", onRoute);
        win.removeEventListener("hashchange", onRoute);
        for (const name of ["pushState", "replaceState"]) if (history[name] === originals[name + "Wrapped"]) history[name] = originals[name];
        teardown();
        onDispose?.();
      }
    };
  }

  // src/core/config.js
  var CONFIG_KEY = "ghostship:userscripts:config";
  var DEFAULTS = Object.freeze({
    enabled: true,
    dryRun: false,
    // opt-in for testing only: the queue then talks to a no-side-effect dispatcher
    recovery: true,
    // retry ChatGPT's own "Try again" when a conversation fails to load
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
  var isEditable = (el2) => !!el2 && (el2.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el2.tagName));
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
      for (const el2 of anchors()) {
        const r = el2.getBoundingClientRect();
        if (r.bottom > base + EPS) {
          anchor = { el: el2, key: el2.getAttribute("data-turn-key") ?? el2.getAttribute("data-testid") ?? "", offset: r.top - base };
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
      let el2 = anchor.el;
      if (!el2.isConnected) {
        el2 = anchor.key && resolveAnchor ? resolveAnchor(anchor.key) : null;
        if (!el2) {
          capture();
          return false;
        }
        anchor.el = el2;
      }
      const delta = el2.getBoundingClientRect().top - scrollerTop() - anchor.offset;
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
      /** The element this manager owns: the conversation's actual scroller. */
      element: scroller,
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
        const el2 = typeof target === "string" ? resolveAnchor?.(target) : target;
        if (!el2) return false;
        navDepth++;
        try {
          write(rawGet() + (el2.getBoundingClientRect().top - scrollerTop() - offset));
        } finally {
          navDepth--;
        }
        stats.navigations++;
        capture();
        return true;
      },
      scrollTop: rawGet,
      /**
       * Whether the one scroll that positions a freshly opened conversation may still happen: false once the
       * user scrolled (or is scrolling), so that scroll always yields to the user.
       */
      mayOpen() {
        const ok = !disposed && !intentActive() && stats.userScrolls === 0;
        if (!ok) diagnostics?.count("scroll.open.yielded");
        return ok;
      },
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
      const el2 = adapter.userMessage(turn);
      if (!el2) return;
      const text = (el2.textContent ?? "").replace(/\s+/g, " ").trim();
      prompts.push({ id: adapter.turnId(turn, turnIndex), turnIndex, preview: text.slice(0, PREVIEW_LENGTH), text });
    });
    return prompts;
  }
  function searchPrompts(index, query) {
    const needle = query.trim().toLowerCase();
    if (!needle) return index;
    return index.filter((p) => p.text.toLowerCase().includes(needle));
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
    for (const el2 of elements) {
      const role = roleOf(el2);
      if (!role) return null;
      if (role === "user" || turns.length === 0) turns.push({ index: turns.length, elements: [] });
      turns[turns.length - 1].elements.push(el2);
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
  function createRuntime({ win, adapter, backend = createNoopBackend(), queueUi: queueUi2, config: config2 = loadConfig(win.localStorage) }) {
    const diagnostics = createDiagnostics(win.console);
    const runtime = { config: config2, diagnostics, mode: "off", promptIndex: [], dispose() {
    } };
    if (!config2.enabled) return runtime;
    const check = adapter.selfCheck(win.document);
    if (!check.ok) {
      runtime.mode = "safe";
      diagnostics.count("selfcheck.failed");
      diagnostics.warnOnce("selfcheck", `ChatGPT layout not recognised (${check.missing.join(", ")}); running in safe mode`);
      return runtime;
    }
    const mountQueue = () => {
      try {
        return queueUi2?.({ win, adapter, config: config2, diagnostics }) ?? { dispose() {
        } };
      } catch (error) {
        diagnostics.count("queue.mount.failed");
        diagnostics.warnOnce("queue", `queue UI disabled (${error instanceof Error ? error.message : error})`);
        return { dispose() {
        } };
      }
    };
    if (!check.hasTurns) {
      const queue2 = mountQueue();
      const none = () => () => {
      };
      Object.assign(runtime, {
        mode: "composer-only",
        queue: queue2,
        scroll: { onScroll: none, scrollTo: () => false, navigateTo: () => false, stats: {} },
        onIndexChange: none,
        onFallback: none,
        onLayoutChange: none,
        isTurnActive: () => true,
        navigateTo: () => false,
        open: () => false,
        dispose: () => queue2.dispose()
      });
      diagnostics.count("runtime.composer-only");
      return runtime;
    }
    const observers = createObserverHub({ max: config2.maxObservers, MutationObserverCtor: win.MutationObserver, schedule: (fn) => win.setTimeout(fn, 16), diagnostics });
    const scroll = createScrollManager({ scroller: adapter.scroller(win.document), diagnostics });
    assertBackend(backend);
    const queue = mountQueue();
    let stop = () => {
    };
    const indexListeners = /* @__PURE__ */ new Set();
    const fallbackListeners = /* @__PURE__ */ new Set();
    const layoutListeners = /* @__PURE__ */ new Set();
    const failOpen = (reason) => {
      stop();
      indexListeners.clear();
      layoutListeners.clear();
      fallbackListeners.forEach((fn) => fn(reason));
      fallbackListeners.clear();
      backend.unmount();
      observers.disposeAll();
      scroll.dispose();
      Object.assign(runtime, { mode: "safe", scroll: void 0, observers: void 0, navigateTo: void 0, open: void 0, onIndexChange: void 0, onLayoutChange: void 0, isTurnActive: void 0, dispose: () => queue.dispose() });
      diagnostics.count("virtualization.fallback");
      diagnostics.warnOnce("virtualization", `virtualization disabled (${reason}); running in safe mode`);
    };
    const mounted = backend.mount({ doc: win.document, adapter, scroll, observers, config: config2, diagnostics, fallback: failOpen, onLayout: () => layoutListeners.forEach((fn) => fn()) });
    if (mounted?.active === false) {
      failOpen(mounted.reason);
      return runtime;
    }
    const reindex = () => {
      runtime.promptIndex = buildPromptIndex(win.document, adapter);
      diagnostics.count("index.rebuilt");
      indexListeners.forEach((fn) => fn(runtime.promptIndex));
    };
    reindex();
    stop = observers.subscribe(win.document.body, reindex);
    Object.assign(runtime, {
      mode: "active",
      scroll,
      /** Subscribe to prompt-index rebuilds; returns an unsubscribe. */
      onIndexChange(fn) {
        indexListeners.add(fn);
        return () => indexListeners.delete(fn);
      },
      /** Subscribe to fail-open (the runtime dropped to safe mode); returns an unsubscribe. */
      onFallback(fn) {
        fallbackListeners.add(fn);
        return () => fallbackListeners.delete(fn);
      },
      /** Subscribe to page-layout hints (a rendered turn changed size); returns an unsubscribe. */
      onLayoutChange(fn) {
        layoutListeners.add(fn);
        return () => layoutListeners.delete(fn);
      },
      /** False for a turn the virtualizer currently skips (its height is a placeholder). */
      isTurnActive: (el2) => backend.isTurnActive?.(el2) ?? true,
      /** The one explicit navigation entry: activates a virtualized-out turn, then scrolls to it. */
      navigateTo(el2, options) {
        return backend.navigateToElement?.(el2, options) || scroll.navigateTo(el2, options);
      },
      /**
       * The one programmatic scroll on opening a conversation (the top of its latest prompt to the top of the
       * viewport): only while the user has not scrolled, so it yields to any user scroll. The caller makes it once.
       */
      open(el2, options) {
        if (!scroll.mayOpen()) return false;
        const moved = runtime.navigateTo(el2, options);
        if (moved) diagnostics.count("scroll.moved.open");
        return moved;
      },
      observers,
      queue,
      dispose() {
        queue.dispose();
        stop();
        indexListeners.clear();
        layoutListeners.clear();
        observers.disposeAll();
        backend.unmount();
        scroll.dispose();
      }
    });
    return runtime;
  }

  // src/chatgpt/adapter.js
  var TURN = '[data-turn-key], [data-testid^="conversation-turn-"]';
  var TURN_ROOT = '[data-thread-find-target="conversation"]';
  var ROLE = "[data-message-author-role]";
  var BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,pre,table,img,blockquote";
  var USER = '[data-message-author-role="user"], [data-user-message-bubble]';
  var REPLY = "[data-conversation-role]";
  var COMPOSER = '#prompt-textarea, [data-chatgpt-composer] [contenteditable="true"], form [contenteditable="true"][role="textbox"]';
  var SEND = 'button[data-testid="send-button"]';
  var STOP = 'button[data-testid="stop-button"]';
  var STOP_FALLBACK = 'button[aria-label^="Stop" i]';
  var STREAMING = ".result-streaming, [data-is-streaming='true']";
  var STEER = 'button[data-testid="steer-button"], button[aria-label^="Steer" i]';
  var PROFILE = '[data-testid="accounts-profile-button"], [data-testid="profile-button"]';
  var ATTACHMENT = '[data-testid*="attachment" i], [data-testid*="file-thumbnail" i]';
  var SCROLLER = "[data-scroll-root], [data-app-action-timeline-scroll]";
  var HEADER = "#page-header";
  var ASSISTANT = '[data-message-author-role="assistant"], [data-conversation-role="assistant"]';
  var SCROLLABLE = /* @__PURE__ */ new Set(["auto", "scroll", "overlay"]);
  var ABSOLUTE = /* @__PURE__ */ new Set(["absolute", "fixed"]);
  var ACTIVE_PAGE = '[data-app-shell-active-page="true"]';
  var scope = (root) => root.nodeType === 9 ? root.querySelector(ACTIVE_PAGE) ?? root : root;
  var SUMMARY_TITLE = /^(outputs?|sources?)$/i;
  var HEADINGS = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  var SUMMARY_REGION = 'aside,[role="complementary"],[role="region"],[aria-label*="summary" i],[data-testid*="summary" i]';
  var BUTTONS = 'button,[role="button"]';
  var BUTTON_REGION = 'aside,[role="complementary"],[role="region"]';
  var OWN_UI = "[data-gs-ui]";
  var commonAncestor = (a, b) => {
    for (let el2 = a; el2; el2 = el2.parentElement) if (el2.contains(b)) return el2;
    return null;
  };
  var nativeChildren = (el2) => [...el2.children].filter((c) => !c.matches(OWN_UI)).length;
  function summarySection(title, pane2) {
    let head = title;
    while (head.parentElement && head.parentElement !== pane2 && nativeChildren(head.parentElement) < 2) head = head.parentElement;
    const section = head.parentElement;
    return !section || section === pane2 || section === head ? null : { section, head };
  }
  var LOAD_ERROR = /could not load this chatgpt conversation/i;
  var RETRY_LABEL = /^try again$/i;
  var nonEmptyRole = (el2, sel, attr) => (el2.matches(sel) ? el2 : el2.querySelector(sel))?.getAttribute(attr) || null;
  var chatgptAdapter = {
    turns: (root) => [...scope(root).querySelectorAll(TURN)],
    role: (turn) => nonEmptyRole(turn, ROLE, "data-message-author-role") ?? (turn.querySelector("[data-user-message-bubble]") ? "user" : nonEmptyRole(turn, REPLY, "data-conversation-role")),
    blocks: (turnEls) => turnEls.flatMap((el2) => [...el2.querySelectorAll(BLOCKS)]),
    // Queue transport (live dispatcher): the editable composer input and its Send/Stop buttons.
    composerInput: (doc) => scope(doc).querySelector(COMPOSER),
    sendButton: (doc) => scope(doc).querySelector(SEND),
    // Inside the composer form only: the queue card has its own Steer button, which must never be mistaken for it.
    steerButton: (doc) => scope(doc).querySelector(COMPOSER)?.closest("form")?.querySelector(STEER) ?? null,
    stopButton(doc) {
      const page = scope(doc);
      return page.querySelector(STOP) ?? page.querySelector(COMPOSER)?.closest("form")?.querySelector(STOP_FALLBACK) ?? null;
    },
    /** A response is being produced: a Stop control is shown or the reply is still streaming. */
    generating(doc) {
      return this.stopButton(doc) !== null || scope(doc).querySelector(STREAMING) !== null;
    },
    /** Opaque, stable per signed-in profile ("unknown" when the page does not say); no label is kept. */
    accountId(doc) {
      const label = scope(doc).querySelector(PROFILE)?.textContent?.trim();
      if (!label) return "unknown";
      let h1 = 3735928559;
      let h2 = 1103547991;
      for (let i = 0; i < label.length; i++) {
        const c = label.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
      }
      h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
      h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
      return `acct-${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
    },
    /** Files on the message being composed; the queue cannot restore them, so it flags them. */
    composerAttachments(doc) {
      const form = scope(doc).querySelector(COMPOSER)?.closest("form");
      return [...form?.querySelectorAll(ATTACHMENT) ?? []].map((node) => ({
        name: node.getAttribute("aria-label")?.slice(0, 80) || "attachment",
        size: 0,
        type: "",
        restorable: false
      }));
    },
    userTurnCount: (doc) => scope(doc).querySelectorAll(USER).length,
    userMessage: (turn) => turn.querySelector(USER),
    turnId: (turn, index) => turn.getAttribute("data-turn-key") ?? turn.getAttribute("data-testid") ?? `turn-${index}`,
    /** The stable element whose subtree contains every turn; observed for new turns. */
    turnRoot: (doc) => scope(doc).querySelector(TURN_ROOT) ?? scope(doc).querySelector(TURN)?.parentElement ?? null,
    /** The element the queue panel is inserted directly before: the composer form, else the input itself. */
    composer: (doc) => scope(doc).querySelector(COMPOSER)?.closest("form") ?? scope(doc).querySelector(COMPOSER),
    conversationId: (win) => win.location.pathname.match(/^\/c\/([\w-]+)/)?.[1] ?? "new",
    /**
     * The element that actually scrolls the conversation. The known selector is trusted unless a nearer
     * ancestor of the turns is itself scrollable and overflowing (the markup moved the scroll owner inward).
     */
    scroller(doc) {
      const page = scope(doc);
      const known = page.querySelector(SCROLLER);
      const win = doc.defaultView;
      for (let el2 = page.querySelector(TURN)?.parentElement; el2 && el2 !== doc.body && el2 !== doc.documentElement; el2 = el2.parentElement) {
        if (el2 === known) break;
        if (SCROLLABLE.has(win.getComputedStyle(el2).overflowY) && el2.scrollHeight > el2.clientHeight && (!known || known.contains(el2))) return el2;
      }
      return known ?? doc.scrollingElement ?? doc.documentElement;
    },
    /**
     * The page column the right rail reserves space from: the smallest element holding the conversation
     * scroller, the composer and the page header, so that shrinking it shifts all three together.
     */
    column(doc) {
      const composer = this.composer(doc);
      const scroller = this.scroller(doc);
      if (!composer || !scroller) return null;
      const header = scope(doc).querySelector(HEADER);
      let node = scroller;
      while (node && !(node.contains(composer) && (!header || node.contains(header)))) node = node.parentElement;
      return !node || node === doc.documentElement ? doc.body : node;
    },
    /**
     * Everything the rail's reservation must be written to: the page column and, when the composer sits in an
     * absolutely positioned overlay inside it (chatgpt.com does), that overlay, which padding on the column
     * cannot move.
     */
    columns(doc) {
      const column = this.column(doc);
      if (!column) return [];
      const win = doc.defaultView;
      for (let el2 = this.composer(doc)?.parentElement; el2 && el2 !== column; el2 = el2.parentElement) {
        if (column.contains(el2) && ABSOLUTE.has(win.getComputedStyle(el2).position)) return [column, el2];
      }
      return [column];
    },
    /**
     * ChatGPT's mounted, visible summary pane, or null (the script then shows its one fallback pane).
     * `container` is where the script's own section is appended (a child of the pane's sections, after
     * Sources); `outputs` is the native Outputs section and its title row when its list can be collapsed
     * by hiding the section's other children, else null. Nothing here changes the page.
     */
    nativeSummary(doc) {
      const page = scope(doc);
      const win = doc.defaultView;
      const found = [];
      let outputs = null;
      const candidates = [...page.querySelectorAll(HEADINGS)];
      for (const region2 of page.querySelectorAll(BUTTON_REGION)) if (!region2.matches(TURN) && !region2.closest(TURN)) candidates.push(...region2.querySelectorAll(BUTTONS));
      for (const title of new Set(candidates)) {
        const name = title.textContent.trim();
        if (name.length > 12 || !SUMMARY_TITLE.test(name) || title.closest(TURN) || title.closest(ROLE) || title.closest(OWN_UI)) continue;
        const rect2 = title.getBoundingClientRect();
        if (!rect2.width || !rect2.height || rect2.right <= win.innerWidth / 2) continue;
        found.push(title);
        if (/^outputs?$/i.test(name) && !outputs) outputs = title;
      }
      if (!found.length) return null;
      const apart = (el2) => !el2.contains(this.composer(doc)) && !el2.querySelector(TURN) && !el2.matches(TURN);
      let lca = found[0];
      for (const t of found.slice(1)) lca = commonAncestor(lca, t) ?? lca;
      if (lca === found[0]) lca = found[0].parentElement;
      const region = lca?.closest(SUMMARY_REGION);
      const pane2 = region && apart(region) ? region : lca;
      if (!pane2 || !apart(pane2)) return null;
      const rect = pane2.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const sections = found.map((t) => summarySection(t, pane2)).filter(Boolean);
      let container = sections[0]?.section.parentElement ?? pane2;
      for (const s of sections.slice(1)) container = commonAncestor(container, s.section.parentElement) ?? container;
      const own = outputs && summarySection(outputs, pane2);
      const others = found.filter((t) => t !== outputs);
      const collapsible = !!own && nativeChildren(own.section) > 1 && !others.some((t) => own.section.contains(t));
      return { pane: pane2, container, left: rect.left, outputs: collapsible ? own : null };
    },
    /** Bottom edge of the page header (0 without one): the fallback pane docks below it. */
    headerBottom(doc) {
      return scope(doc).querySelector(HEADER)?.getBoundingClientRect().bottom ?? 0;
    },
    /** The assistant reply of turn `index` of `turns`: inside the turn element, else the next message element. */
    reply(turns, index) {
      const own = turns[index].querySelector(ASSISTANT);
      if (own) return own;
      const next = turns[index + 1];
      return next && this.role(next) !== "user" ? next : null;
    },
    /** Identity of the pieces the script attaches to; a change means the page re-rendered or navigated. */
    layout(doc, win) {
      const first = scope(doc).querySelector(TURN);
      return {
        route: this.conversationId(win),
        composer: scope(doc).querySelector(COMPOSER),
        container: first ? this.turnRoot(doc) : null,
        scroller: first ? this.scroller(doc) : null
      };
    },
    /**
     * The conversation-load failure card of the active page, or null: `{card, control}` where `control` is the
     * "Try again" button/link inside it. Only a page without turns can hold it, and a control inside a turn
     * (a per-message "Try again") never counts.
     */
    loadError(doc) {
      const page = scope(doc);
      if (page.querySelector(TURN)) return null;
      for (const control of page.querySelectorAll('button, a, [role="button"]')) {
        if (!RETRY_LABEL.test((control.textContent ?? "").trim())) continue;
        let card = control;
        for (let depth = 0; depth < 5 && card.parentElement && card !== page; depth++) {
          card = card.parentElement;
          const text = card.textContent ?? "";
          if (text.length < 600 && LOAD_ERROR.test(text)) return { card, control };
        }
      }
      return null;
    },
    /** `ok` means the composer is there (a new chat has no turns); `hasTurns` selects the full feature set. */
    selfCheck(doc) {
      const page = scope(doc);
      const hasTurns = !!page.querySelector(TURN);
      const missing = [];
      if (!page.querySelector(COMPOSER)) missing.push("composer");
      if (!hasTurns) missing.push("turns");
      return { ok: !missing.includes("composer"), hasTurns, missing };
    }
  };

  // src/chatgpt/queue/dispatch.js
  var TIMED_OUT = Symbol("timed-out");
  var DispatchBoundary = class {
    #adapter;
    #opts;
    constructor(adapter, opts) {
      this.#adapter = adapter;
      this.#opts = { submitTimeoutMs: 3e4, stopTimeoutMs: 1e4, ...opts };
    }
    async readState(target) {
      try {
        return await this.#adapter.readState(target);
      } catch {
        return "unknown";
      }
    }
    async readiness(target) {
      try {
        return await this.#adapter.readiness(target);
      } catch {
        return { state: "waiting", reason: "unknown-state" };
      }
    }
    submit(request2) {
      return this.#send("submit", request2);
    }
    async steer(request2) {
      if (typeof this.#adapter.steer !== "function") return { kind: "unsupported" };
      return this.#send("steer", request2);
    }
    async #send(type, request2) {
      this.#opts.onAction?.({ type, conversationId: request2.conversationId, itemId: request2.itemId });
      try {
        const result = await this.#race(this.#adapter[type === "steer" ? "steer" : "submit"](request2), this.#opts.submitTimeoutMs);
        if (result === TIMED_OUT) {
          return { kind: "uncertain", code: `${type}-timeout`, message: "No acknowledgment before the timeout." };
        }
        return result;
      } catch (error) {
        return { kind: "uncertain", code: `${type}-threw`, message: describe(error) };
      }
    }
    async stop(target) {
      this.#opts.onAction?.({ type: "stop", conversationId: target.conversationId });
      let result;
      try {
        result = await this.#race(this.#adapter.stop(target), this.#opts.stopTimeoutMs);
      } catch (error) {
        return { kind: "ambiguous", code: "stop-threw", message: describe(error) };
      }
      if (result === TIMED_OUT) {
        return { kind: "timeout", code: "stop-timeout", message: "No stop acknowledgment before the timeout." };
      }
      if (result.kind !== "confirmed") return result;
      const state = await this.readState(target);
      if (state !== "idle") {
        return {
          kind: "ambiguous",
          code: "stop-not-idle",
          message: `Stop was acknowledged but the conversation reads "${state}".`
        };
      }
      return result;
    }
    #race(work, ms) {
      return new Promise((resolve, reject) => {
        const cancel = this.#opts.clock.after(ms, () => resolve(TIMED_OUT));
        work.then(
          (value) => {
            cancel();
            resolve(value);
          },
          (error) => {
            cancel();
            reject(error);
          }
        );
      });
    }
  };
  function describe(error) {
    return error instanceof Error ? error.message : String(error);
  }
  var DryRunDispatcher = class {
    /** Lets the UI label the queue as not sending anything. */
    dryRun = true;
    log = [];
    state;
    /** False models a settled response whose native Send is not (yet) available. */
    sendReady = true;
    /** True models a positively detected native steer path. */
    steerAvailable = false;
    submitScript = [];
    steerScript = [];
    stopScript = [];
    /** Set to make `readState` throw (adapter cannot tell). */
    stateError = null;
    #stateOverrides = [];
    constructor(initial = "idle") {
      this.state = initial;
    }
    /** Queue one-shot answers for the next `readState` calls (race injection). */
    overrideState(...states) {
      this.#stateOverrides.push(...states);
    }
    async readState() {
      if (this.stateError) throw this.stateError;
      return this.#stateOverrides.shift() ?? this.state;
    }
    async readiness() {
      const state = await this.readState();
      if (state === "generating") return { state: "waiting", reason: "generating" };
      if (state !== "idle") return { state: "waiting", reason: "unknown-state" };
      if (!this.sendReady) return { state: "waiting", reason: "send-unavailable" };
      return { state: "ready" };
    }
    async submit(request2) {
      this.log.push({ type: "submit", request: request2 });
      const outcome = this.submitScript.shift() ?? { kind: "accepted" };
      const result = await play(outcome);
      if (result.kind === "accepted") this.state = "generating";
      return result;
    }
    async steer(request2) {
      if (!this.steerAvailable) return { kind: "unsupported" };
      this.log.push({ type: "steer", request: request2 });
      const outcome = this.steerScript.shift() ?? { kind: "accepted" };
      return play(outcome);
    }
    async stop(request2) {
      this.log.push({ type: "stop", request: request2 });
      const outcome = this.stopScript.shift() ?? { kind: "confirmed" };
      const result = await play(outcome);
      if (result.kind === "confirmed") this.state = "idle";
      return result;
    }
    /** The response finished on its own. */
    finishGeneration() {
      this.state = "idle";
    }
    actions() {
      return this.log.map((entry) => entry.type === "stop" ? "stop" : `${entry.type}:${entry.request.itemId}`);
    }
  };
  async function play(outcome) {
    if (outcome === "hang") return new Promise(() => void 0);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  // src/chatgpt/queue/composer.js
  var BLOCKS2 = /* @__PURE__ */ new Set(["P", "DIV", "LI", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"]);
  function textOf(node) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out += child.nodeValue;
      else if (child.nodeName === "BR") out += child.classList?.contains("ProseMirror-trailingBreak") ? "" : "\n";
      else out += textOf(child);
    }
    return out;
  }
  function createComposerIO(win) {
    const doc = win.document;
    const isField = (el2) => el2.tagName === "TEXTAREA" || el2.tagName === "INPUT";
    function read(el2) {
      if (isField(el2)) return el2.value;
      const blocks = [...el2.childNodes].filter((n) => n.nodeType === 1 && BLOCKS2.has(n.nodeName));
      if (!blocks.length) return textOf(el2);
      return blocks.map((block) => {
        const text = textOf(block);
        return block.childNodes.length === 1 && block.firstChild.nodeName === "BR" ? "" : text;
      }).join("\n");
    }
    const hasText = (el2) => read(el2).trim() !== "";
    function write(el2, text) {
      el2.focus?.();
      if (isField(el2)) {
        const proto = el2.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el2, text);
        el2.dispatchEvent(new win.Event("input", { bubbles: true }));
        return true;
      }
      const selection = win.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(el2);
      selection.removeAllRanges();
      selection.addRange(range);
      if (text === "") return doc.execCommand("delete");
      const lines = text.split("\n");
      let ok = doc.execCommand("delete") !== false;
      lines.forEach((line, index) => {
        if (index > 0) ok = doc.execCommand("insertParagraph") !== false && ok;
        if (line !== "") ok = doc.execCommand("insertText", false, line) !== false && ok;
      });
      return ok;
    }
    return { read, write, hasText };
  }

  // src/chatgpt/queue/live-dispatcher.js
  var norm = (text) => text.replace(/\s+/g, " ").trim();
  function createLiveDispatcher({
    win,
    adapter,
    pollMs = 50,
    settleMs = 600,
    sendWaitMs = 8e3,
    steerWaitMs = 1500,
    ackMs = 6e3,
    stopWaitMs = 5e3,
    composerLostMs = 15e3,
    now = () => Date.now()
  }) {
    const doc = win.document;
    const io = createComposerIO(win);
    const clicked = /* @__PURE__ */ new Set();
    let lastBusy = -Infinity;
    let composerMissingSince = null;
    const waitFor = (probe, ms) => new Promise((resolve) => {
      const started = Date.now();
      const poll = () => {
        const hit = probe();
        if (hit) return resolve(hit);
        if (Date.now() - started >= ms) return resolve(null);
        win.setTimeout(poll, pollMs);
      };
      poll();
    });
    const generating = () => adapter.generating(doc);
    const onTarget = (target) => adapter.conversationId(win) === target.conversationId && adapter.accountId(doc) === target.accountId;
    const enabled = (button2) => button2 && !button2.disabled && button2.getAttribute("aria-disabled") !== "true" ? button2 : null;
    function notReady(target, { allowGenerating = false } = {}) {
      if (!onTarget(target)) return { state: "waiting", reason: "other-conversation" };
      const input = adapter.composerInput(doc);
      if (!input) {
        composerMissingSince ??= now();
        if (now() - composerMissingSince >= composerLostMs) {
          return {
            state: "blocked",
            code: "composer-lost",
            message: "The ChatGPT composer has not been found for a while; nothing was sent.",
            action: "Reload the page or open the conversation again, then press Retry."
          };
        }
        return { state: "waiting", reason: "composer-missing" };
      }
      composerMissingSince = null;
      if (!allowGenerating) {
        if (generating()) {
          lastBusy = now();
          return { state: "waiting", reason: "generating" };
        }
        if (now() - lastBusy < settleMs) return { state: "waiting", reason: "settling" };
      }
      if (io.hasText(input)) return { state: "waiting", reason: "composer-has-draft" };
      return null;
    }
    const unstage = (input, text) => {
      if (norm(io.read(input)) === norm(text)) io.write(input, "");
    };
    async function stage(target, text, control, ms, { allowGenerating }) {
      const input = adapter.composerInput(doc);
      if (!io.write(input, text) || norm(io.read(input)) !== norm(text)) {
        unstage(input, text);
        return { failed: { kind: "rejected", code: "composer-fill-failed", message: "The text could not be placed in the composer; nothing was sent.", action: "Reload the page, then press Retry." } };
      }
      const button2 = await waitFor(() => {
        if (!onTarget(target)) return "left";
        if (!allowGenerating && generating()) return "busy";
        return enabled(control());
      }, ms);
      if (button2 === "left") {
        unstage(input, text);
        return { failed: { kind: "wait", reason: "other-conversation" } };
      }
      if (button2 === "busy") {
        unstage(input, text);
        return { failed: { kind: "wait", reason: "generating" } };
      }
      if (!button2) {
        unstage(input, text);
        return { missing: true };
      }
      return { input, button: button2 };
    }
    async function click(itemId, button2, turnsBefore, target, { steering = false } = {}) {
      if (!onTarget(target)) {
        return { kind: "wait", reason: "other-conversation" };
      }
      clicked.add(itemId);
      button2.click();
      const evidence = await waitFor(() => {
        const input = adapter.composerInput(doc);
        return adapter.userTurnCount(doc) > turnsBefore || !steering && generating() || input !== null && io.read(input) === "";
      }, ackMs);
      return evidence ? { kind: "accepted" } : { kind: "uncertain", code: "submit-unacknowledged", message: "Send was clicked but ChatGPT showed no sign of accepting it." };
    }
    const attachmentsRefused = {
      kind: "rejected",
      code: "attachments-unsupported",
      message: "Messages with attachments cannot be sent by the queue yet; nothing was sent.",
      action: "Send without the files, or delete the prompt and send it from ChatGPT."
    };
    return {
      async readState() {
        if (!adapter.composerInput(doc)) return "unknown";
        return generating() ? "generating" : "idle";
      },
      async readiness(target) {
        return notReady(target) ?? { state: "ready" };
      },
      async submit({ itemId, accountId, conversationId, text, attachments }) {
        const target = { accountId, conversationId };
        if (clicked.has(itemId)) {
          return { kind: "uncertain", code: "already-attempted", message: "This message was already submitted from this page." };
        }
        if (attachments.length) return attachmentsRefused;
        const not = notReady(target);
        if (not) return not.state === "blocked" ? { kind: "rejected", code: not.code, message: not.message, action: not.action } : { kind: "wait", reason: not.reason };
        const staged = await stage(target, text, () => adapter.sendButton(doc), sendWaitMs, { allowGenerating: false });
        if (staged.failed) return staged.failed;
        if (staged.missing) {
          return { kind: "rejected", code: "send-unavailable", message: "ChatGPT's Send button did not become available; nothing was sent.", action: "Check the page, then press Retry." };
        }
        return click(itemId, staged.button, adapter.userTurnCount(doc), target);
      },
      /** The native steer control, only if the page shows one once the text is in; otherwise `unsupported`. */
      async steer({ itemId, accountId, conversationId, text, attachments }) {
        const target = { accountId, conversationId };
        if (clicked.has(itemId)) {
          return { kind: "uncertain", code: "already-attempted", message: "This message was already submitted from this page." };
        }
        if (attachments.length) return attachmentsRefused;
        if (!generating()) return { kind: "wait", reason: "not-generating" };
        const not = notReady(target, { allowGenerating: true });
        if (not) return not.state === "blocked" ? { kind: "rejected", code: not.code, message: not.message, action: not.action } : { kind: "wait", reason: not.reason };
        const staged = await stage(target, text, () => adapter.steerButton(doc), steerWaitMs, { allowGenerating: true });
        if (staged.failed) return staged.failed;
        if (staged.missing) return { kind: "unsupported" };
        return click(itemId, staged.button, adapter.userTurnCount(doc), target, { steering: true });
      },
      async stop() {
        const button2 = adapter.stopButton(doc);
        if (!button2) return { kind: "failed", code: "stop-button-missing", message: "The Stop control was not found." };
        button2.click();
        const gone = await waitFor(() => !generating(), stopWaitMs);
        return gone ? { kind: "confirmed" } : { kind: "ambiguous", code: "stop-unconfirmed", message: "Stop was clicked but the response did not end." };
      }
    };
  }

  // src/chatgpt/queue/select.js
  function selectDispatcher({ config: config2, win, adapter }) {
    return config2.dryRun ? new DryRunDispatcher() : createLiveDispatcher({ win, adapter });
  }

  // src/chatgpt/queue/types.js
  var QueueError = class extends Error {
    code;
    constructor(code, message) {
      super(message);
      this.name = "QueueError";
      this.code = code;
    }
  };
  var systemClock = {
    now: () => Date.now(),
    after(ms, fn) {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    }
  };

  // src/chatgpt/queue/store.js
  var DB_NAME = "ghostship-chatgpt-queue";
  var DB_VERSION = 2;
  var LEGACY_ACCOUNT = "unknown";
  var keyOf = (target) => `${target.accountId}:${target.conversationId}`;
  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function migrateLegacy(items, legacyQueues, now) {
    const byConversation = /* @__PURE__ */ new Map();
    for (const item of [...items].sort((a, b) => a.position - b.position)) {
      if (!byConversation.has(item.conversationId)) byConversation.set(item.conversationId, []);
      byConversation.get(item.conversationId).push(item);
    }
    const paused = new Map(legacyQueues.map((q) => [q.conversationId, q.paused === true]));
    const out = { pending: [], inflight: [], state: [] };
    for (const [conversationId, rows] of byConversation) {
      const key = keyOf({ accountId: LEGACY_ACCOUNT, conversationId });
      const merge = [];
      let uncertain = null;
      let needsDecision = null;
      for (const row of rows) {
        if (row.status === "sent") continue;
        if (row.status === "sending" || row.status === "manual-review") {
          if (!uncertain) {
            uncertain = row;
            continue;
          }
          needsDecision = "legacy-uncertain";
        } else if (row.status === "failed") {
          needsDecision = "legacy-failed";
        } else if (row.status === "blocked") {
          needsDecision = row.lastError?.code ?? "attachments-not-restorable";
        }
        merge.push(row);
      }
      if (uncertain) {
        out.inflight.push({
          key,
          accountId: LEGACY_ACCOUNT,
          conversationId,
          id: uncertain.id,
          sourceId: uncertain.id,
          text: uncertain.text,
          attachments: uncertain.attachments ?? [],
          status: "manual-review",
          attempts: Math.max(1, uncertain.attempts ?? 1),
          leaseToken: null,
          claimedAt: uncertain.updatedAt ?? now,
          lastError: {
            code: "legacy-uncertain",
            message: "This message was in flight when the queue was upgraded, so its delivery is unknown.",
            action: "Check the conversation in ChatGPT. Mark it delivered if it is there, or restore it to the queue if it is not.",
            at: now
          }
        });
      }
      if (merge.length) {
        const attachments = merge.flatMap((row) => row.attachments ?? []);
        const lost = attachments.filter((a) => !a.restorable);
        const code = lost.length ? "attachments-not-restorable" : needsDecision;
        out.pending.push({
          key,
          id: merge[0].id,
          accountId: LEGACY_ACCOUNT,
          conversationId,
          text: merge.map((row) => row.text).join("\n\n"),
          attachments,
          status: code ? "blocked" : "pending",
          version: Math.max(...merge.map((row) => row.version ?? 1)) + 1,
          createdAt: merge[0].createdAt ?? now,
          updatedAt: now,
          lastError: code ? legacyError(code, lost, now) : null,
          ops: []
        });
      }
      if (paused.get(conversationId) && (merge.length || uncertain)) out.state.push({ key, paused: true, editBy: null, editUntil: 0 });
    }
    return out;
  }
  function legacyError(code, lost, now) {
    if (code === "attachments-not-restorable") {
      return { code, message: `Cannot restore ${lost.map((a) => a.name).join(", ")}.`, action: "Reattach the files, then retry.", at: now };
    }
    return {
      code,
      message: "Some of these messages needed a decision before the queue was upgraded (a failed, blocked or uncertain send).",
      action: "Read the combined text, edit it if needed, then press Retry.",
      at: now
    };
  }
  var Tx = class {
    #tx;
    constructor(tx) {
      this.#tx = tx;
    }
    getPending(key) {
      return request(this.#tx.objectStore("pending").get(key));
    }
    putPending(record) {
      return request(this.#tx.objectStore("pending").put(record));
    }
    deletePending(key) {
      return request(this.#tx.objectStore("pending").delete(key));
    }
    getInflight(key) {
      return request(this.#tx.objectStore("inflight").get(key));
    }
    putInflight(record) {
      return request(this.#tx.objectStore("inflight").put(record));
    }
    deleteInflight(key) {
      return request(this.#tx.objectStore("inflight").delete(key));
    }
    async getState(key) {
      return await request(this.#tx.objectStore("state").get(key)) ?? { key, paused: false, editBy: null, editUntil: 0 };
    }
    putState(state) {
      return request(this.#tx.objectStore("state").put(state));
    }
    getLease(key) {
      return request(this.#tx.objectStore("locks").get(key));
    }
    putLease(lease) {
      return request(this.#tx.objectStore("locks").put(lease));
    }
    deleteLease(key) {
      return request(this.#tx.objectStore("locks").delete(key));
    }
    pendingOf(conversationId) {
      return request(this.#tx.objectStore("pending").index("conversationId").getAll(conversationId));
    }
    inflightOf(conversationId) {
      return request(this.#tx.objectStore("inflight").index("conversationId").getAll(conversationId));
    }
  };
  var QueueStore = class _QueueStore {
    #db;
    constructor(db) {
      this.#db = db;
    }
    static async open(factory = globalThis.indexedDB, name = DB_NAME, now = () => Date.now()) {
      const open = factory.open(name, DB_VERSION);
      open.onupgradeneeded = (event) => {
        const db2 = open.result;
        const tx = open.transaction;
        const pending = db2.createObjectStore("pending", { keyPath: "key" });
        pending.createIndex("conversationId", "conversationId");
        const inflight = db2.createObjectStore("inflight", { keyPath: "key" });
        inflight.createIndex("conversationId", "conversationId");
        db2.createObjectStore("state", { keyPath: "key" });
        db2.createObjectStore("locks", { keyPath: "key" });
        if (event.oldVersion < 1) return;
        const rows = tx.objectStore("items").getAll();
        const queues = tx.objectStore("queues").getAll();
        queues.onsuccess = () => {
          const migrated = migrateLegacy(rows.result, queues.result, now());
          for (const record of migrated.pending) tx.objectStore("pending").put(record);
          for (const record of migrated.inflight) tx.objectStore("inflight").put(record);
          for (const record of migrated.state) tx.objectStore("state").put(record);
          db2.deleteObjectStore("queues");
          db2.deleteObjectStore("leases");
        };
      };
      const db = await request(open);
      db.onversionchange = () => db.close();
      return new _QueueStore(db);
    }
    close() {
      this.#db.close();
    }
    /** The untouched version 1 rows: the recovery copy of everything the migration folded. */
    async legacyItems() {
      if (!this.#db.objectStoreNames.contains("items")) return [];
      return request(this.#db.transaction("items").objectStore("items").getAll());
    }
    transact(fn) {
      return new Promise((resolve, reject) => {
        const tx = this.#db.transaction(["pending", "inflight", "state", "locks"], "readwrite");
        let result;
        let failure;
        let failed = false;
        tx.oncomplete = () => failed ? reject(failure) : resolve(result);
        tx.onabort = () => reject(failed ? failure : tx.error);
        tx.onerror = () => void 0;
        fn(new Tx(tx)).then(
          (value) => {
            result = value;
          },
          (error) => {
            failed = true;
            failure = error;
            try {
              tx.abort();
            } catch {
            }
          }
        );
      });
    }
    /** A read-only view of one transaction; used by the per-tick snapshot so a waiting queue writes nothing. */
    read(fn) {
      return new Promise((resolve, reject) => {
        const tx = this.#db.transaction(["pending", "inflight", "state", "locks"], "readonly");
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error);
        fn(new Tx(tx)).then(
          (value) => {
            result = value;
          },
          (error) => {
            try {
              tx.abort();
            } catch {
            }
            reject(error);
          }
        );
      });
    }
  };

  // src/chatgpt/queue/text.js
  var SEPARATOR = "\n\n";
  function normalizeContribution(text) {
    const unified = String(text ?? "").replace(/\r\n?/g, "\n");
    if (unified.trim() === "") return "";
    return unified.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
  }
  function joinContributions(...parts) {
    return parts.filter((part) => part !== "" && part != null).join(SEPARATOR);
  }

  // src/chatgpt/queue/queue.js
  var STOP_ACTIONS = {
    "stop-timeout": "ChatGPT did not confirm the stop. Check the response, then press Interrupt & Send Next again.",
    "stop-not-idle": "The response may still be running. Wait for it to finish or stop it manually, then try again.",
    "state-unknown": "Could not tell whether a response is running. Check ChatGPT, then try again."
  };
  var OPS_KEPT = 16;
  var QueueEngine = class {
    #store;
    #dispatch;
    #clock;
    #tabId;
    #newId;
    #leaseTtlMs;
    #editTtlMs;
    #tails = /* @__PURE__ */ new Map();
    constructor(opts) {
      this.#store = opts.store;
      this.#dispatch = opts.dispatch;
      this.#clock = opts.clock;
      this.#tabId = opts.tabId;
      this.#newId = opts.newId ?? (() => crypto.randomUUID());
      this.#leaseTtlMs = opts.leaseTtlMs ?? 45e3;
      this.#editTtlMs = opts.editTtlMs ?? 3e4;
    }
    // ---- reading -------------------------------------------------------------
    /** Read-only: a waiting queue costs no write. */
    view(target) {
      const key = keyOf(target);
      return this.#store.read(async (tx) => this.#viewOf(await tx.getPending(key), await tx.getInflight(key), await tx.getState(key)));
    }
    #viewOf(pending, inflight, state) {
      const editing = state.editBy !== null && state.editUntil > this.#clock.now();
      return { pending: pending ?? null, inflight: inflight ?? null, paused: state.paused === true, editing, editBy: editing ? state.editBy : null };
    }
    // ---- user-facing editing (any tab, no lease needed) -----------------------
    /**
     * Adds one contribution to the conversation's single pending prompt (creating it if there is none),
     * separated from the existing text by exactly one blank line. `opId` makes a repeated delivery of
     * the same keystroke or form event a no-op.
     */
    append(target, input) {
      const key = keyOf(target);
      const text = normalizeContribution(input.text);
      return this.#store.transact(async (tx) => {
        if (text === "") return { kind: "ignored" };
        const now = this.#clock.now();
        const existing = await tx.getPending(key);
        if (existing && input.opId && existing.ops.includes(input.opId)) return { kind: "duplicate", record: existing };
        const ops = (existing?.ops ?? []).concat(input.opId ? [input.opId] : []).slice(-OPS_KEPT);
        const record = existing ? { ...existing, text: joinContributions(existing.text, text), attachments: existing.attachments.concat(input.attachments ?? []), version: existing.version + 1, updatedAt: now, ops } : {
          key,
          id: this.#newId(),
          accountId: target.accountId,
          conversationId: target.conversationId,
          text,
          attachments: input.attachments ?? [],
          status: "pending",
          version: 1,
          createdAt: now,
          updatedAt: now,
          lastError: null,
          ops
        };
        applyAttachmentGate(record, now);
        await tx.putPending(record);
        return { kind: "appended", record, created: !existing };
      });
    }
    /** Claims the edit session for this tab: automatic dispatch stands aside while it is open. */
    beginEdit(target) {
      const key = keyOf(target);
      return this.#store.transact(async (tx) => {
        const pending = await tx.getPending(key);
        if (!pending) return { kind: "none" };
        const state = await tx.getState(key);
        const now = this.#clock.now();
        if (state.editBy && state.editBy !== this.#tabId && state.editUntil > now) return { kind: "busy", by: state.editBy };
        await tx.putState({ ...state, editBy: this.#tabId, editUntil: now + this.#editTtlMs });
        return { kind: "ok", record: pending };
      });
    }
    /** Keeps this tab's edit session alive; false when it was lost (the prompt was deleted or sent). */
    renewEdit(target) {
      const key = keyOf(target);
      return this.#store.transact(async (tx) => {
        const state = await tx.getState(key);
        if (state.editBy !== this.#tabId || !await tx.getPending(key)) return false;
        await tx.putState({ ...state, editUntil: this.#clock.now() + this.#editTtlMs });
        return true;
      });
    }
    endEdit(target) {
      const key = keyOf(target);
      return this.#store.transact(async (tx) => {
        const state = await tx.getState(key);
        if (state.editBy === this.#tabId) await tx.putState({ ...state, editBy: null, editUntil: 0 });
      });
    }
    /**
     * Replaces the whole pending text, keeping its identity. If other tabs appended while this edit was
     * open and the original text is intact, their additions are kept after the edited text (`rebased`);
     * any other divergence is a `conflict` and nothing is written.
     */
    saveEdit(target, edit) {
      const key = keyOf(target);
      const text = normalizeContribution(edit.text);
      return this.#store.transact(async (tx) => {
        const pending = await tx.getPending(key);
        const state = await tx.getState(key);
        const release = () => state.editBy === this.#tabId ? tx.putState({ ...state, editBy: null, editUntil: 0 }) : void 0;
        if (!pending) {
          await release();
          return { kind: "gone" };
        }
        if (text === "") return { kind: "empty" };
        let next;
        let kind = "saved";
        if (pending.version === edit.baseVersion) {
          next = text;
        } else if (pending.text.startsWith(edit.baseText)) {
          next = text + pending.text.slice(edit.baseText.length);
          kind = "rebased";
        } else {
          return { kind: "conflict", record: pending };
        }
        const now = this.#clock.now();
        const record = { ...pending, text: next, version: pending.version + 1, updatedAt: now };
        if (record.status === "blocked" && record.lastError?.code !== "attachments-not-restorable") {
          record.status = "pending";
          record.lastError = null;
        }
        applyAttachmentGate(record, now);
        await tx.putPending(record);
        await release();
        return { kind, record };
      });
    }
    /** Deletes the whole pending prompt. An in-flight snapshot is not touched. */
    remove(target) {
      const key = keyOf(target);
      return this.#store.transact(async (tx) => {
        const pending = await tx.getPending(key);
        if (!pending) return { kind: "none" };
        await tx.deletePending(key);
        const state = await tx.getState(key);
        if (state.editBy) await tx.putState({ ...state, editBy: null, editUntil: 0 });
        return { kind: "removed", record: pending };
      });
    }
    pause(target) {
      return this.#setPaused(target, true);
    }
    resume(target) {
      return this.#setPaused(target, false);
    }
    /** Lifts a hold the user has looked at; `dropAttachments` is the explicit consent to send without unrestorable files. */
    unblock(target, { dropAttachments = false } = {}) {
      const key = keyOf(target);
      return this.#store.transact(async (tx) => {
        const pending = await tx.getPending(key);
        if (!pending || pending.status !== "blocked") return { kind: "none" };
        const record = { ...pending, version: pending.version + 1, updatedAt: this.#clock.now() };
        if (dropAttachments) record.attachments = record.attachments.filter((a) => a.restorable);
        record.status = "pending";
        record.lastError = null;
        applyAttachmentGate(record, record.updatedAt);
        await tx.putPending(record);
        return { kind: "unblocked", record };
      });
    }
    /** The user saw in ChatGPT that an uncertain send did go out. */
    markDelivered(target) {
      const key = keyOf(target);
      return this.#store.transact(async (tx) => {
        const inflight = await tx.getInflight(key);
        if (!inflight || inflight.status !== "manual-review") throw new QueueError("invalid-state", "There is no uncertain send to confirm.");
        await tx.deleteInflight(key);
        return { kind: "delivered" };
      });
    }
    /** The user saw that an uncertain send did not go out: its text returns to the front of the pending prompt. */
    restoreInflight(target) {
      const key = keyOf(target);
      return this.#store.transact(async (tx) => {
        const inflight = await tx.getInflight(key);
        if (!inflight || inflight.status !== "manual-review") throw new QueueError("invalid-state", "There is no uncertain send to restore.");
        await tx.deleteInflight(key);
        const record = await this.#restore(tx, inflight, null);
        return { kind: "restored", record };
      });
    }
    /**
     * Versions before 2 stored queues without an account. The first account to open such a conversation
     * takes the legacy record over, once; nothing is copied, so no message can exist twice.
     */
    adoptLegacy(target) {
      if (target.accountId === LEGACY_ACCOUNT) return Promise.resolve(0);
      const key = keyOf(target);
      const legacy = keyOf({ accountId: LEGACY_ACCOUNT, conversationId: target.conversationId });
      return this.#store.transact(async (tx) => {
        if (await tx.getPending(key) || await tx.getInflight(key)) return 0;
        const [pending, inflight, state] = [await tx.getPending(legacy), await tx.getInflight(legacy), await tx.getState(legacy)];
        if (!pending && !inflight) return 0;
        if (pending) {
          await tx.deletePending(legacy);
          await tx.putPending({ ...pending, key, accountId: target.accountId });
        }
        if (inflight) {
          await tx.deleteInflight(legacy);
          await tx.putInflight({ ...inflight, key, accountId: target.accountId });
        }
        if (state.paused) {
          await tx.putState({ ...state, key });
          await tx.putState({ ...state, paused: false, editBy: null, editUntil: 0 });
        }
        return 1;
      });
    }
    // ---- sending (lease holder only) -----------------------------------------
    /**
     * Automatic dispatch, one step. Never stops a response and never retries: while the response is
     * running, settling, or Send is unavailable it answers `waiting` and changes nothing.
     */
    step(target) {
      return this.#serial(keyOf(target), async () => {
        if (target.conversationId === "new") return { kind: "waiting", reason: "unresolved-conversation" };
        let view = await this.view(target);
        if (view.inflight?.status === "sending") {
          const lease2 = await this.#acquire(target);
          if (!lease2.ok) return lease2.outcome;
          view = await this.view(target);
        }
        const gate = this.#gate(view, false);
        if (gate) return gate;
        const ready = await this.#dispatch.readiness(target);
        if (ready.state === "waiting") return { kind: "waiting", reason: ready.reason };
        if (ready.state === "blocked") return this.#hold(target, view.pending, ready);
        const lease = await this.#acquire(target);
        if (!lease.ok) return lease.outcome;
        const claimed = await this.#claim(target, lease.token, false);
        if (claimed.kind !== "claimed") return claimed;
        return this.#deliver(target, claimed.snapshot, "submit");
      });
    }
    /**
     * Explicit user action on the whole pending prompt. With `native` and a positively detected native
     * steer path it uses that; otherwise, if a response is running, it stops it and only once the stop
     * is confirmed submits the text once. Any doubt leaves the prompt pending with an actionable error.
     */
    steer(target, { native = true } = {}) {
      return this.#serial(keyOf(target), async () => {
        if (target.conversationId === "new") return { kind: "waiting", reason: "unresolved-conversation" };
        const view = await this.view(target);
        const gate = this.#gate(view, true);
        if (gate) return gate;
        const state = await this.#dispatch.readState(target);
        if (state === "unknown") return this.#interruptFailed(target, "state-unknown", "Could not read the conversation state.");
        let lease = await this.#acquire(target);
        if (!lease.ok) return lease.outcome;
        if (state === "generating") {
          if (native) {
            const claimed2 = await this.#claim(target, lease.token, true);
            if (claimed2.kind !== "claimed") return claimed2;
            const outcome = await this.#deliver(target, claimed2.snapshot, "steer");
            if (outcome.kind !== "unsupported") return outcome;
          }
          const stop = await this.#dispatch.stop(target);
          if (stop.kind !== "confirmed") return this.#interruptFailed(target, stop.code, stop.message);
          lease = await this.#acquire(target);
          if (!lease.ok) return lease.outcome;
        }
        const claimed = await this.#claim(target, lease.token, true);
        if (claimed.kind === "gone") return { kind: "interrupt-aborted", reason: "pending-changed" };
        if (claimed.kind !== "claimed") return claimed;
        return this.#deliver(target, claimed.snapshot, "submit");
      });
    }
    /** Renews the lease; call periodically while this tab is the active sender. */
    async heartbeat(target) {
      return (await this.#acquire(target)).ok;
    }
    release(target) {
      const key = keyOf(target);
      return this.#store.transact(async (tx) => {
        const lease = await tx.getLease(key);
        if (lease?.holder === this.#tabId) await tx.deleteLease(key);
      });
    }
    // ---- internals -----------------------------------------------------------
    #serial(key, fn) {
      const run = (this.#tails.get(key) ?? Promise.resolve()).then(fn, fn);
      this.#tails.set(
        key,
        run.catch(() => void 0)
      );
      return run;
    }
    #setPaused(target, paused) {
      const key = keyOf(target);
      return this.#store.transact(async (tx) => {
        await tx.putState({ ...await tx.getState(key), paused });
      });
    }
    /** Why nothing may be sent now, or null. `explicit` is a user action: pause does not stop it. */
    #gate(view, explicit) {
      const { pending, inflight } = view;
      if (inflight?.status === "manual-review") return { kind: "halted", itemId: inflight.id, status: "manual-review" };
      if (inflight) return { kind: "busy", itemId: inflight.id };
      if (!pending) return { kind: "idle" };
      if (pending.status !== "pending") return { kind: "halted", itemId: pending.id, status: pending.status };
      if (view.editing) return explicit ? { kind: "editing" } : { kind: "waiting", reason: "editing" };
      if (view.paused && !explicit) return { kind: "paused" };
      return null;
    }
    /** The dispatcher found the page unusable for a reason only the user can fix: hold the prompt, once. */
    async #hold(target, pending, blocked) {
      const key = keyOf(target);
      await this.#store.transact(async (tx) => {
        const record = await tx.getPending(key);
        if (!record || record.id !== pending.id || record.status !== "pending") return;
        await tx.putPending({ ...record, status: "blocked", lastError: errorOf(blocked, this.#clock.now()), updatedAt: this.#clock.now() });
      });
      return { kind: "halted", itemId: pending.id, status: "blocked" };
    }
    /**
     * Acquires or renews this tab's lease. A fresh acquisition (first, or after
     * expiry) gets a new fencing token and, in the same transaction, turns any
     * snapshot still `sending` under an older token into manual-review: its
     * sender is gone and we cannot know whether it was delivered.
     */
    #acquire(target) {
      const key = keyOf(target);
      return this.#store.transact(async (tx) => {
        const now = this.#clock.now();
        const current = await tx.getLease(key);
        if (current && current.expiresAt > now && current.holder !== this.#tabId) {
          return { ok: false, outcome: { kind: "not-leader", holder: current.holder, expiresAt: current.expiresAt } };
        }
        const keep = current !== void 0 && current.holder === this.#tabId && current.expiresAt > now;
        const token = keep ? current.token : (current?.token ?? 0) + 1;
        await tx.putLease({ key, holder: this.#tabId, token, expiresAt: now + this.#leaseTtlMs });
        if (!keep) {
          const inflight = await tx.getInflight(key);
          if (inflight?.status === "sending" && inflight.leaseToken !== token) {
            await tx.putInflight({ ...inflight, status: "manual-review", lastError: orphanError(now) });
          }
        }
        return { ok: true, token };
      });
    }
    /**
     * The only place the pending prompt becomes an in-flight snapshot: one transaction moves the text,
     * so every append lands either in this snapshot (committed before it) or in the next pending prompt.
     */
    async #claim(target, token, explicit) {
      const key = keyOf(target);
      return this.#store.transact(async (tx) => {
        const lease = await tx.getLease(key);
        const now = this.#clock.now();
        if (!lease || lease.holder !== this.#tabId || lease.token !== token || lease.expiresAt <= now) {
          throw new QueueError("lease-lost", "Another tab holds the sender lease.");
        }
        const view = this.#viewOf(await tx.getPending(key), await tx.getInflight(key), await tx.getState(key));
        const gate = this.#gate(view, explicit);
        if (gate) return gate.kind === "idle" ? { kind: "gone" } : gate;
        const { pending } = view;
        const snapshot = {
          key,
          id: this.#newId(),
          sourceId: pending.id,
          accountId: pending.accountId,
          conversationId: pending.conversationId,
          text: pending.text,
          attachments: pending.attachments,
          version: pending.version,
          status: "sending",
          attempts: 1,
          leaseToken: token,
          claimedAt: now,
          lastError: null
        };
        await tx.putInflight(snapshot);
        await tx.deletePending(key);
        await tx.putLease({ ...lease, expiresAt: now + this.#leaseTtlMs });
        return { kind: "claimed", snapshot };
      }).catch(async (error) => {
        if (error instanceof QueueError && error.code === "lease-lost") return this.#notLeader(key);
        throw error;
      });
    }
    async #notLeader(key) {
      const lease = await this.#store.transact((tx) => tx.getLease(key));
      return { kind: "not-leader", holder: lease?.holder ?? "unknown", expiresAt: lease?.expiresAt ?? 0 };
    }
    async #deliver(target, snapshot, via) {
      const request2 = {
        itemId: snapshot.id,
        sourceId: snapshot.sourceId,
        accountId: snapshot.accountId,
        conversationId: snapshot.conversationId,
        text: snapshot.text,
        attachments: snapshot.attachments
      };
      const result = await this.#dispatch[via](request2);
      return this.#record(snapshot, result);
    }
    /** Records a send result; compare-and-set on the snapshot id so stale results are dropped. */
    #record(snapshot, result) {
      return this.#store.transact(async (tx) => {
        const current = await tx.getInflight(snapshot.key);
        if (!current || current.id !== snapshot.id || current.status !== "sending" && current.status !== "manual-review") {
          return { kind: "busy", itemId: snapshot.id };
        }
        const now = this.#clock.now();
        if (result.kind === "accepted") {
          await tx.deleteInflight(snapshot.key);
          return { kind: "sent", itemId: snapshot.id };
        }
        if (result.kind === "uncertain") {
          await tx.putInflight({
            ...current,
            status: "manual-review",
            lastError: {
              code: result.code,
              message: result.message,
              action: "Check the conversation in ChatGPT. Mark the message delivered if it is there, or restore it to the queue if it is not.",
              at: now
            }
          });
          return { kind: "manual-review", itemId: snapshot.id };
        }
        await tx.deleteInflight(snapshot.key);
        if (result.kind === "rejected") {
          const record = await this.#restore(tx, current, { code: result.code, message: result.message, action: result.action ?? "Fix the problem in ChatGPT, then press Retry.", at: now });
          return { kind: "rejected", itemId: snapshot.id, error: record.lastError };
        }
        await this.#restore(tx, current, null);
        return result.kind === "unsupported" ? { kind: "unsupported" } : { kind: "waiting", reason: result.reason ?? "not-ready" };
      });
    }
    async #restore(tx, snapshot, error) {
      const now = this.#clock.now();
      const later = await tx.getPending(snapshot.key);
      const record = {
        key: snapshot.key,
        id: snapshot.sourceId,
        accountId: snapshot.accountId,
        conversationId: snapshot.conversationId,
        text: joinContributions(snapshot.text, later?.text),
        attachments: snapshot.attachments.concat(later?.attachments ?? []),
        status: error ? "blocked" : later?.status ?? "pending",
        version: Math.max(later?.version ?? 0, snapshot.version ?? 0) + 1,
        createdAt: later?.createdAt ?? now,
        updatedAt: now,
        lastError: error ?? later?.lastError ?? null,
        ops: later?.ops ?? []
      };
      applyAttachmentGate(record, now);
      await tx.putPending(record);
      return record;
    }
    async #interruptFailed(target, code, message) {
      const key = keyOf(target);
      const error = {
        code,
        message,
        action: STOP_ACTIONS[code] ?? "The response was not confirmed stopped. Nothing was sent; check ChatGPT and try again.",
        at: this.#clock.now()
      };
      await this.#store.transact(async (tx) => {
        const pending = await tx.getPending(key);
        if (pending?.status === "pending") await tx.putPending({ ...pending, lastError: error });
      });
      return { kind: "interrupt-failed", error };
    }
  };
  function errorOf(blocked, at) {
    return { code: blocked.code, message: blocked.message, action: blocked.action ?? "Fix the problem in ChatGPT, then press Retry.", at };
  }
  function applyAttachmentGate(record, now) {
    const lost = record.attachments.filter((a) => !a.restorable);
    if (lost.length) {
      record.status = "blocked";
      record.lastError = {
        code: "attachments-not-restorable",
        message: `Cannot restore ${lost.map((a) => a.name).join(", ")}.`,
        action: "Send without the files, or delete the prompt and reattach them.",
        at: now
      };
    } else if (record.lastError?.code === "attachments-not-restorable") {
      record.status = "pending";
      record.lastError = null;
    }
  }
  function orphanError(now) {
    return {
      code: "orphaned-send",
      message: "The tab that was sending this message stopped before reporting the result.",
      action: "Check the conversation in ChatGPT. Mark the message delivered if it is there, or restore it to the queue if it is not.",
      at: now
    };
  }

  // src/chatgpt/queue/view.js
  var STYLE_ID = "gs-queue-style";
  var CSS = `
.gs-q{box-sizing:border-box;width:100%;max-width:100%;min-width:0;margin:0 0 8px;padding:6px 8px;border:1px solid rgba(127,127,127,.3);border-radius:16px;background:var(--main-surface-secondary,rgba(127,127,127,.1));color:inherit;font:inherit;font-size:14px;line-height:1.35}
.gs-q[hidden]{display:none}
.gs-q *{box-sizing:border-box;min-width:0}
.gs-q svg{width:1.1em;height:1.1em;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.gs-q button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:4px 10px;border:1px solid rgba(127,127,127,.45);border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.gs-q button:hover:not(:disabled){background:rgba(127,127,127,.15)}
.gs-q button:disabled{opacity:.45;cursor:not-allowed}
.gs-q button:focus-visible{outline:2px solid #2563eb;outline-offset:1px}
.gs-q-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.gs-q-title{font-weight:600}
.gs-q-status{opacity:.75;font-size:12px}
.gs-q-badge{padding:1px 8px;border:1px solid currentColor;border-radius:999px;font-size:12px;opacity:.8}
.gs-q-spacer{flex:1 1 0}
.gs-q-actions{display:flex;flex-wrap:wrap;gap:6px}
.gs-q .gs-q-primary{border-color:currentColor;font-weight:600}
.gs-q-note{margin:6px 0 0;padding:6px 8px;border-radius:8px;border:1px solid rgba(127,127,127,.4);overflow-wrap:anywhere}
.gs-q-note[role="alert"]{border-color:#b91c1c;color:#b91c1c}
.gs-q-text{margin:6px 0 0;padding:6px 8px;max-height:9em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border-top:1px solid rgba(127,127,127,.18)}
.gs-q-inflight{margin:6px 0 0;display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center}
@media (max-width:560px){
.gs-q-actions{flex:1 1 100%}
.gs-q-actions button{flex:1 1 auto}
.gs-q button{min-height:36px}
}
`;
  var ICONS = {
    interrupt: ["M5 5l7 7-7 7", "M13 5l7 7-7 7"],
    steer: ["M5 12h14", "M13 6l6 6-6 6"],
    pause: ["M9 5v14", "M15 5v14"],
    play: ["M7 5l12 7-12 7z"],
    trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
    pencil: ["M4 20l4-1 11-11-3-3L5 16z", "M14 7l3 3"],
    queue: ["M12 5v14", "M5 12h14"]
  };
  function icon(doc, name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const d of ICONS[name]) {
      const path = doc.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }
  var present = (value) => value !== null && value !== void 0 && value !== false;
  function el(doc, tag, attrs = {}, children = []) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (!present(value)) continue;
      node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of [].concat(children)) if (present(child)) node.append(child);
    return node;
  }
  function button(doc, key, content, onClick, { label, disabled, className, title } = {}) {
    const node = el(doc, "button", { type: "button", "data-gs-key": key, "aria-label": label, disabled, class: className, title }, content);
    node.addEventListener("click", onClick);
    return node;
  }
  var WAITING = {
    generating: "Waiting for response",
    settling: "Waiting for response",
    "send-unavailable": "Waiting for Send",
    "composer-has-draft": "Waiting for the composer to be empty",
    "composer-missing": "Waiting for ChatGPT",
    "unknown-state": "Waiting for ChatGPT",
    "unresolved-conversation": "Open the conversation to send",
    editing: "Editing"
  };
  function statusOf(model) {
    if (model.edit) return "Editing";
    if (model.busy === "interrupting") return "Stopping the response";
    if (model.busy === "steering") return "Steering";
    if (model.inflight?.status === "sending") return "Sending";
    if (model.inflight?.status === "manual-review") return "Needs review";
    if (!model.pending) return null;
    if (model.pending.status === "blocked") return "Blocked";
    if (model.paused) return "Paused";
    if (model.editingElsewhere) return "Being edited in another tab";
    return WAITING[model.waiting] ?? "Queued";
  }
  function actionBlocker(model) {
    if (model.busy) return "Working on it.";
    if (model.edit) return "Save or cancel the edit first.";
    if (!model.pending) return "Nothing is queued.";
    if (model.inflight) return model.inflight.status === "sending" ? "The previous message is still being sent." : "Resolve the message that needs review first.";
    if (model.pending.status !== "pending") return "Resolve the hold on the queued prompt first.";
    return null;
  }
  function renderPanel(doc, root, model, on) {
    const { pending, inflight } = model;
    const canQueue = model.generating && !model.edit;
    const visible = pending || inflight || model.error || model.note || model.edit || canQueue && model.composerHasText;
    root.hidden = !visible;
    if (!visible) {
      root.replaceChildren();
      return;
    }
    const blocker = actionBlocker(model);
    const status = statusOf(model);
    const children = [];
    const actions = [];
    if (canQueue) {
      actions.push(
        button(doc, "head:queue", [icon(doc, "queue"), "Queue"], () => on.queueDraft(), {
          label: "Add the composer text to the queued prompt",
          disabled: !model.composerHasText || model.busy
        })
      );
    }
    if (model.edit) {
      actions.push(
        button(doc, "head:save", "Save", () => on.saveEdit(), { className: "gs-q-primary", label: "Save the edited prompt" }),
        button(doc, "head:cancel", "Cancel", () => on.cancelEdit(), { label: "Cancel the edit" }),
        button(doc, "head:delete", [icon(doc, "trash"), "Delete"], () => on.remove(), { label: "Delete the queued prompt", disabled: model.busy })
      );
    } else if (pending) {
      actions.push(
        button(doc, "head:edit", [icon(doc, "pencil"), "Edit"], () => on.startEdit(), { label: "Edit the queued prompt", disabled: model.busy || model.editingElsewhere }),
        button(doc, "head:delete", [icon(doc, "trash"), "Delete"], () => on.remove(), { label: "Delete the queued prompt", disabled: model.busy }),
        button(doc, "head:steer", [icon(doc, "steer"), "Steer"], () => on.steer(), {
          label: "Steer: send the queued prompt now",
          disabled: blocker !== null,
          title: blocker
        }),
        button(doc, "head:interrupt", [icon(doc, "interrupt"), "Interrupt & Send Next"], () => on.interrupt(), {
          className: "gs-q-primary",
          disabled: blocker !== null,
          title: blocker
        }),
        button(doc, "head:pause", [icon(doc, model.paused ? "play" : "pause"), model.paused ? "Resume" : "Pause"], () => on.togglePause(), {
          label: model.paused ? "Resume the queue" : "Pause the queue",
          disabled: pending.status !== "pending"
        })
      );
    }
    children.push(
      el(doc, "div", { class: "gs-q-head" }, [
        el(doc, "span", { class: "gs-q-title" }, `Queue (${pending ? 1 : 0})`),
        el(doc, "span", { class: "gs-q-status", role: "status", "aria-live": "polite" }, status),
        model.dryRun ? el(doc, "span", { class: "gs-q-badge", title: "Dry run: nothing is sent to ChatGPT" }, "Dry run") : null,
        el(doc, "span", { class: "gs-q-spacer" }),
        el(doc, "div", { class: "gs-q-actions", role: "group", "aria-label": "Queue actions" }, actions)
      ])
    );
    const message = model.error ?? pending?.lastError ?? inflight?.lastError ?? (model.note ? { message: model.note, action: "" } : null);
    if (message) {
      const alert = Boolean(model.error ?? pending?.lastError ?? inflight?.lastError);
      children.push(el(doc, "p", { class: "gs-q-note", role: alert ? "alert" : "status", "data-gs-note": message.code }, `${message.message ?? ""} ${message.action ?? ""}`.trim()));
    }
    if (inflight?.status === "manual-review") {
      children.push(
        el(doc, "div", { class: "gs-q-inflight" }, [
          button(doc, "inflight:delivered", "Mark delivered", () => on.markDelivered(), { label: "The message did reach ChatGPT" }),
          button(doc, "inflight:restore", "Restore to queue", () => on.restoreInflight(), { label: "The message did not reach ChatGPT; put it back in the queue" })
        ])
      );
    }
    if (pending) {
      if (pending.status === "blocked") {
        const files = pending.lastError?.code === "attachments-not-restorable";
        children.push(
          el(doc, "div", { class: "gs-q-inflight" }, [
            files ? button(doc, "head:drop-files", "Send without files", () => on.unblock(true), { label: "Drop the files that cannot be restored and queue the text" }) : button(doc, "head:retry", "Retry", () => on.unblock(false), { label: "Try sending the queued prompt again" })
          ])
        );
      }
      children.push(el(doc, "div", { class: "gs-q-text", "data-gs-key": "queued-text", "data-id": pending.id, "data-version": pending.version }, pending.text));
    }
    root.replaceChildren(...children);
  }

  // src/chatgpt/queue/controller.js
  var MESSAGES = {
    "not-leader": "Another tab is sending for this conversation.",
    "interrupt-aborted": "The queued prompt changed while the response was stopping, so nothing was sent.",
    editing: "Save or cancel the edit first."
  };
  var CHANNEL = "ghostship-chatgpt-queue";
  var RELOAD_EVERY = 5;
  function createQueueUi({
    win,
    adapter,
    dispatcher,
    diagnostics,
    indexedDB = win.indexedDB,
    clock = systemClock,
    tabId = globalThis.crypto.randomUUID(),
    pollMs = 1e3,
    engineOptions = {},
    BroadcastChannelCtor = win.BroadcastChannel ?? globalThis.BroadcastChannel
  }) {
    const doc = win.document;
    const composer = adapter.composer(doc);
    if (!composer || !indexedDB) {
      diagnostics?.count("queue.unmounted");
      return { mounted: false, reason: composer ? "no-indexeddb" : "no-composer", dispose() {
      } };
    }
    const io = createComposerIO(win);
    let lastAccount = null;
    const targetNow = () => {
      const read = adapter.accountId(doc);
      const accountId = read === "unknown" && lastAccount ? lastAccount : read;
      lastAccount = accountId;
      return { accountId, conversationId: adapter.conversationId(win) };
    };
    let target = targetNow();
    const model = {
      pending: null,
      inflight: null,
      paused: false,
      editingElsewhere: false,
      edit: null,
      // {target, input, baseVersion, baseText, draft}
      busy: null,
      waiting: null,
      error: null,
      note: null,
      generating: false,
      composerHasText: false,
      dryRun: dispatcher.dryRun === true
    };
    let engine = null;
    let store = null;
    let channel = null;
    let disposed = false;
    let dispatching = false;
    let submitting = false;
    let timer = null;
    let ticks = 0;
    let reloadSeq = 0;
    let opSeq = 0;
    let dispatchChain = Promise.resolve();
    let actionChain = Promise.resolve();
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      doc.head.append(style);
    }
    const root = doc.createElement("section");
    root.className = "gs-q";
    root.hidden = true;
    root.setAttribute("data-gs-queue", "");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Message queue");
    composer.before(root);
    const fail = (error) => {
      diagnostics?.count("queue.action.failed");
      model.error = { message: error instanceof Error ? error.message : String(error), action: "" };
      render();
    };
    const chained = (which) => (fn) => {
      const next = (which === "action" ? actionChain : dispatchChain).then(fn).catch(fail);
      if (which === "action") actionChain = next;
      else dispatchChain = next;
      return next;
    };
    const act = chained("action");
    const dispatch = chained("dispatch");
    let painted = null;
    function render(focusKey) {
      const { pending, inflight, paused, editingElsewhere, edit, busy, waiting, error, note, generating, composerHasText, dryRun } = model;
      const signature = JSON.stringify({ pending, inflight, paused, editingElsewhere, editing: edit?.baseVersion ?? null, busy, waiting, error, note, generating, composerHasText, dryRun });
      if (signature === painted && !focusKey) return;
      painted = signature;
      const active = doc.activeElement;
      const key = focusKey ?? (root.contains(active) ? active.getAttribute("data-gs-key") : null);
      renderPanel(doc, root, model, handlers);
      if (!key) return;
      const wanted = root.querySelector(`[data-gs-key="${CSS_ESCAPE(key)}"]`);
      (wanted && !wanted.disabled ? wanted : root.querySelector("button:not(:disabled)"))?.focus({ preventScroll: true });
    }
    const notify = () => {
      try {
        channel?.postMessage({ from: tabId, key: `${target.accountId}:${target.conversationId}` });
      } catch {
      }
    };
    async function reload() {
      const seq = ++reloadSeq;
      const asked = target;
      const view = await engine.view(asked);
      if (seq !== reloadSeq || asked !== target) return;
      model.pending = view.pending;
      model.inflight = view.inflight;
      model.paused = view.paused;
      model.editingElsewhere = view.editing && view.editBy !== tabId;
      if (!view.pending) model.waiting = null;
      if (!view.pending && !view.inflight && !model.edit) model.error = null;
      if (model.edit && !view.pending) endEditLocally("gone");
      render();
    }
    function readDom() {
      model.generating = adapter.generating(doc);
      const input = adapter.composerInput(doc);
      model.composerHasText = Boolean(input) && io.hasText(input);
    }
    function endEditLocally(why) {
      const edit = model.edit;
      if (!edit) return;
      model.edit = null;
      const typed = edit.input.isConnected ? io.read(edit.input) : "";
      io.write(edit.input, why === "gone" ? joinContributions(edit.draft, typed) : edit.draft);
      if (why === "gone") model.error = { message: "The queued prompt was sent or deleted while you were editing.", action: "Your text is in the composer." };
    }
    async function startEdit() {
      if (model.edit || !engine || !model.pending) return;
      const t = target;
      const input = adapter.composerInput(doc);
      if (!input) return;
      const begun = await engine.beginEdit(t);
      if (begun.kind === "busy") {
        model.note = "Another tab is editing this prompt.";
        return render();
      }
      if (begun.kind !== "ok") return reload();
      model.error = null;
      model.note = null;
      model.edit = { target: t, input, baseVersion: begun.record.version, baseText: begun.record.text, draft: io.read(input) };
      io.write(input, begun.record.text);
      input.focus?.();
      await reload();
      render("head:save");
      input.focus?.();
      notify();
    }
    async function saveEdit() {
      const edit = model.edit;
      if (!edit || submitting) return;
      submitting = true;
      try {
        const result = await engine.saveEdit(edit.target, { baseVersion: edit.baseVersion, baseText: edit.baseText, text: io.read(edit.input) });
        if (result.kind === "saved" || result.kind === "rebased") {
          model.edit = null;
          io.write(edit.input, edit.draft);
          model.note = result.kind === "rebased" ? "Text added from another tab while you were editing was kept." : null;
          model.error = null;
        } else if (result.kind === "conflict") {
          model.pending = result.record;
          model.error = {
            message: "The queued prompt changed in another tab while you were editing.",
            action: "Your edit is still in the composer. Cancel to discard it and edit the new text."
          };
        } else if (result.kind === "empty") {
          model.note = "An empty prompt is not saved. Use Delete to remove the queued prompt.";
        } else {
          endEditLocally("gone");
        }
        await reload();
        notify();
      } finally {
        submitting = false;
      }
    }
    async function cancelEdit() {
      const edit = model.edit;
      if (!edit) return;
      model.edit = null;
      io.write(edit.input, edit.draft);
      model.error = null;
      model.note = null;
      await engine.endEdit(edit.target);
      await reload();
    }
    async function appendFromComposer(source) {
      const t = target;
      const input = adapter.composerInput(doc);
      if (!input || submitting) return;
      const text = io.read(input);
      if (text.trim() === "") return;
      submitting = true;
      try {
        model.error = null;
        model.note = null;
        const result = await engine.append(t, { text, attachments: adapter.composerAttachments?.(doc) ?? [], opId: `${tabId}:${++opSeq}` });
        diagnostics?.count(`queue.append.${source}`);
        if (result.kind !== "ignored" && input.isConnected && io.read(input) === text) io.write(input, "");
        await reload();
        notify();
      } finally {
        submitting = false;
      }
    }
    const submitComposer = (source) => {
      if (dispatching) {
        model.note = "Sending the queued prompt; try again in a moment.";
        return render();
      }
      if (!engine) {
        model.note = "The queue is starting; your text is still in the composer.";
        return render();
      }
      return act(() => model.edit ? saveEdit() : appendFromComposer(source));
    };
    const inComposer = (event) => {
      const input = adapter.composerInput(doc);
      return input && event.target instanceof win.Node && (input === event.target || input.contains(event.target));
    };
    const hijacking = () => dispatching || model.edit !== null || adapter.generating(doc) && target.conversationId !== "new";
    function onKeydown(event) {
      if (!inComposer(event)) return;
      if (event.key === "Escape" && model.edit) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void act(cancelEdit);
        return;
      }
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      if (!hijacking()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void submitComposer("enter");
    }
    function onSubmit(event) {
      const input = adapter.composerInput(doc);
      if (!input || !event.target?.contains?.(input) || !hijacking()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void submitComposer("submit");
    }
    function onClick(event) {
      if (dispatching || !hijacking()) return;
      const hit = event.target?.closest?.("button");
      const input = adapter.composerInput(doc);
      if (!hit || !input || !hit.closest("form")?.contains(input)) return;
      if (hit !== adapter.sendButton(doc) && hit !== adapter.steerButton(doc)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void submitComposer("button");
    }
    function onInput(event) {
      if (!inComposer(event)) return;
      if (!model.generating && !model.composerHasText && !adapter.generating(doc)) return;
      const had = model.composerHasText;
      readDom();
      if (had !== model.composerHasText) render();
    }
    win.addEventListener("keydown", onKeydown, true);
    win.addEventListener("submit", onSubmit, true);
    win.addEventListener("click", onClick, true);
    win.addEventListener("input", onInput, true);
    const outcomeNote = (outcome) => {
      if (outcome.kind === "interrupt-failed") return { message: outcome.error.message, action: outcome.error.action };
      if (outcome.kind === "rejected") return { message: outcome.error.message, action: outcome.error.action };
      if (outcome.kind === "halted") return { message: `The queued prompt is ${outcome.status}.`, action: "Resolve it first." };
      if (outcome.kind === "manual-review") return { message: "Send was clicked but ChatGPT showed no sign of accepting it.", action: "Check the conversation, then mark it delivered or restore it." };
      if (outcome.kind === "waiting" && outcome.reason !== "editing") return { message: `Not sent yet: ${outcome.reason}.`, action: "It will go out when the page is ready." };
      const message = MESSAGES[outcome.kind] ?? (outcome.kind === "waiting" ? MESSAGES.editing : null);
      return message ? { message, action: "" } : null;
    };
    const explicit = (busy, run) => () => {
      if (!engine || model.edit) return void 0;
      const t = target;
      model.busy = busy;
      model.error = null;
      model.note = null;
      render(busy === "interrupting" ? "head:interrupt" : "head:steer");
      return dispatch(async () => {
        try {
          const outcome = await run(t);
          const note = outcomeNote(outcome);
          model.error = note && { ...note, source: "action" };
          diagnostics?.count(`queue.${busy}.${outcome.kind}`);
        } finally {
          model.busy = null;
          dispatching = false;
        }
        await reload();
        notify();
      });
    };
    const handlers = {
      queueDraft: () => submitComposer("button"),
      startEdit: () => act(startEdit),
      saveEdit: () => act(saveEdit),
      cancelEdit: () => act(cancelEdit),
      remove: () => act(async () => {
        const t = target;
        model.error = null;
        if (model.edit) {
          const edit = model.edit;
          model.edit = null;
          io.write(edit.input, edit.draft);
        }
        await engine.remove(t);
        await reload();
        notify();
      }),
      togglePause: () => act(async () => {
        await (model.paused ? engine.resume(target) : engine.pause(target));
        await reload();
        notify();
      }),
      unblock: (dropAttachments) => act(async () => {
        await engine.unblock(target, { dropAttachments });
        await reload();
        notify();
      }),
      markDelivered: () => act(async () => {
        await engine.markDelivered(target);
        await reload();
        notify();
      }),
      restoreInflight: () => act(async () => {
        await engine.restoreInflight(target);
        await reload();
        notify();
      }),
      steer: explicit("steering", (t) => engine.steer(t, { native: true })),
      interrupt: explicit("interrupting", (t) => engine.steer(t, { native: false }))
    };
    async function followNavigation() {
      const now = targetNow();
      if (now.accountId === target.accountId && now.conversationId === target.conversationId) return false;
      const previous = target;
      if (model.edit) endEditLocally("cancel");
      await engine.release(previous).catch(() => void 0);
      target = now;
      Object.assign(model, { pending: null, inflight: null, paused: false, editingElsewhere: false, waiting: null, error: null, note: null });
      await engine.adoptLegacy(now).catch(() => 0);
      ticks = RELOAD_EVERY;
      return true;
    }
    function tick() {
      return dispatch(async () => {
        if (!engine || model.busy) return;
        await followNavigation();
        readDom();
        const home = adapter.composer(doc);
        if (home && (!root.isConnected || root.nextElementSibling !== home)) home.before(root);
        if (model.edit && !await engine.renewEdit(model.edit.target)) endEditLocally("gone");
        if (model.pending || model.inflight) {
          let outcome;
          try {
            outcome = await engine.step(target);
          } finally {
            dispatching = false;
          }
          model.waiting = outcome.kind === "waiting" ? outcome.reason : null;
          if (outcome.kind === "not-leader") model.note = MESSAGES["not-leader"];
          else if (model.note === MESSAGES["not-leader"]) model.note = null;
          if (outcome.kind === "sent") notify();
          if (outcome.kind === "rejected" || outcome.kind === "manual-review") model.error = { ...outcomeNote(outcome), source: "auto" };
          else if (model.error?.source === "auto") model.error = null;
          await reload();
        } else if (++ticks >= RELOAD_EVERY) {
          ticks = 0;
          await reload();
        } else {
          render();
        }
      });
    }
    const ready = QueueStore.open(indexedDB, void 0, () => clock.now()).then(async (opened) => {
      if (disposed) return opened.close();
      store = opened;
      engine = new QueueEngine({
        store,
        dispatch: new DispatchBoundary(dispatcher, { clock, onAction: () => dispatching = true }),
        clock,
        tabId,
        ...engineOptions
      });
      try {
        channel = BroadcastChannelCtor ? new BroadcastChannelCtor(CHANNEL) : null;
        channel?.unref?.();
        if (channel) {
          channel.onmessage = (event) => {
            if (event.data?.from !== tabId && event.data?.key === `${target.accountId}:${target.conversationId}`) void act(reload);
          };
        }
      } catch {
        channel = null;
      }
      await engine.adoptLegacy(target).catch(() => 0);
      readDom();
      await act(reload);
      if (pollMs > 0) timer = win.setInterval(tick, pollMs);
    });
    ready.catch(() => {
      diagnostics?.count("queue.store.failed");
      model.error = { message: "The queue could not open its storage.", action: "Reload the page; queued messages are kept." };
      render();
    });
    render();
    const onPageHide = () => engine?.release(target).catch(() => void 0);
    win.addEventListener("pagehide", onPageHide);
    return {
      mounted: true,
      root,
      ready,
      tick,
      /** Resolves when every queued UI action and dispatch pass has finished. */
      settled: () => Promise.all([actionChain, dispatchChain]).then(() => void 0),
      dispose() {
        disposed = true;
        if (timer) win.clearInterval(timer);
        for (const [name, fn] of [["keydown", onKeydown], ["submit", onSubmit], ["click", onClick], ["input", onInput], ["pagehide", onPageHide]]) {
          win.removeEventListener(name, fn, name === "pagehide" ? void 0 : true);
        }
        if (model.edit) endEditLocally("cancel");
        channel?.close();
        root.remove();
        doc.getElementById(STYLE_ID)?.remove();
        engine?.release(target).catch(() => void 0).finally(() => store?.close());
      }
    };
  }
  var CSS_ESCAPE = (value) => value.replace(/["\\]/g, "\\$&");

  // src/chatgpt/queue/persistent.js
  function persistentQueueUi(create) {
    let shared = null;
    const mount = (ctx) => {
      if (!shared?.mounted) shared = create(ctx);
      return { ...shared, dispose() {
      } };
    };
    mount.shutdown = () => {
      shared?.dispose();
      shared = null;
    };
    return mount;
  }

  // src/chatgpt/recovery.js
  var RECOVERY_DEFAULTS = Object.freeze({
    maxAttempts: 3,
    delaysMs: [800, 4e3, 12e3],
    // before attempt 1, 2, 3 (counted from detection / the previous failure)
    verifyMs: 6e3,
    // how long a retry gets to make the card go away
    typingQuietMs: 3e3,
    busyRecheckMs: 1500,
    debounceMs: 500
  });
  var STATUS_ATTR = "data-gs-recovery";
  function createRecovery({ win, adapter, diagnostics, options = {}, timers }) {
    const doc = win.document;
    const opts = { ...RECOVERY_DEFAULTS, ...options };
    const t = timers ?? { setTimeout: (fn, ms) => win.setTimeout(fn, ms), clearTimeout: (id) => win.clearTimeout(id), now: () => win.performance.now() };
    const hub = createObserverHub({ max: 1, MutationObserverCtor: win.MutationObserver, schedule: (fn) => t.setTimeout(fn, opts.debounceMs), diagnostics });
    let route = win.location.pathname;
    let attempts = 0;
    let phase = "idle";
    let timer = null;
    let lastTyping = -Infinity;
    let statusEl = null;
    let disposed = false;
    const clearTimer = () => {
      if (timer !== null) t.clearTimeout(timer);
      timer = null;
    };
    const later = (fn, ms) => {
      clearTimer();
      timer = t.setTimeout(() => {
        timer = null;
        if (!disposed) fn();
      }, ms);
    };
    function showStatus(text) {
      if (!statusEl) {
        statusEl = doc.createElement("div");
        statusEl.setAttribute(STATUS_ATTR, "");
        statusEl.setAttribute("role", "status");
        statusEl.style.cssText = "position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:2147483000;max-width:90vw;padding:4px 12px;border:1px solid rgba(127,127,127,.4);border-radius:999px;background:var(--main-surface-secondary,rgba(127,127,127,.15));color:inherit;font:12px/1.4 system-ui,sans-serif;opacity:.85";
        doc.body.append(statusEl);
      }
      statusEl.textContent = text;
    }
    function hideStatus() {
      statusEl?.remove();
      statusEl = null;
    }
    function reset() {
      clearTimer();
      attempts = 0;
      phase = "idle";
      hideStatus();
    }
    function typing() {
      if (t.now() - lastTyping < opts.typingQuietMs) return true;
      const input = adapter.composerInput(doc);
      if (!input || doc.activeElement !== input) return false;
      return (input.value ?? input.textContent ?? "").trim() !== "";
    }
    const onTyping = () => {
      lastTyping = t.now();
    };
    win.addEventListener("keydown", onTyping, true);
    win.addEventListener("input", onTyping, true);
    function recovered() {
      diagnostics?.count("recovery.recovered");
      reset();
    }
    function schedule() {
      phase = "waiting";
      later(attempt, opts.delaysMs[Math.min(attempts, opts.delaysMs.length - 1)]);
    }
    function attempt() {
      if (win.location.pathname !== route) return check();
      const found = adapter.loadError(doc);
      if (!found) return recovered();
      if (typing()) {
        diagnostics?.count("recovery.deferred");
        return later(attempt, opts.busyRecheckMs);
      }
      attempts += 1;
      phase = "verifying";
      diagnostics?.count("recovery.retry");
      found.control.click();
      later(verify, opts.verifyMs);
    }
    function verify() {
      if (win.location.pathname !== route) return check();
      if (!adapter.loadError(doc)) return recovered();
      if (attempts >= opts.maxAttempts) {
        phase = "gave-up";
        diagnostics?.count("recovery.gave-up");
        showStatus(`ChatGPT still could not load this conversation after ${attempts} tries. Reload the page to try again.`);
        return;
      }
      schedule();
    }
    function check() {
      if (disposed) return;
      if (win.location.pathname !== route) {
        route = win.location.pathname;
        reset();
      }
      const found = adapter.loadError(doc);
      if (!found) {
        if (phase === "waiting" || phase === "verifying") recovered();
        return;
      }
      if (phase === "idle") {
        diagnostics?.count("recovery.detected");
        schedule();
      }
    }
    const unsubscribe = hub.subscribe(doc.body, check);
    check();
    return {
      get phase() {
        return phase;
      },
      get attempts() {
        return attempts;
      },
      check,
      dispose() {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        clearTimer();
        win.removeEventListener("keydown", onTyping, true);
        win.removeEventListener("input", onTyping, true);
        hideStatus();
      }
    };
  }

  // src/chatgpt/rail/minimap-model.js
  var HEADING = /^H[1-6]$/;
  var PRIORITY = ["code", "table", "image", "heading", "text"];
  function classify(el2) {
    if (HEADING.test(el2.tagName)) return "heading";
    switch (el2.tagName) {
      case "PRE":
        return "code";
      case "TABLE":
        return "table";
      case "IMG":
        return "image";
      default:
        return "text";
    }
  }
  var textLength = (el2) => (el2.textContent ?? "").trim().length;
  function blockKind(el2) {
    if (el2.parentElement?.closest("pre,table")) return null;
    if (el2.tagName === "LI" && el2.querySelector("p")) return null;
    const kind = classify(el2);
    return kind === "text" && textLength(el2) === 0 ? null : kind;
  }
  function buildTurnModel(blocks) {
    const model = [];
    for (const el2 of blocks) {
      const kind = blockKind(el2);
      if (!kind) continue;
      const len = textLength(el2);
      let lines;
      let width;
      if (kind === "code") {
        lines = Math.min(60, ((el2.textContent ?? "").match(/\n/g)?.length ?? 0) + 1) + 1;
        width = 0.95;
      } else if (kind === "table") {
        lines = Math.min(40, el2.querySelectorAll("tr").length) * 1.4 + 1;
        width = 0.95;
      } else if (kind === "image") {
        lines = 8;
        width = 0.8;
      } else if (kind === "heading") {
        lines = 2;
        width = Math.min(0.7, 0.2 + len / 120);
      } else {
        lines = Math.max(1, Math.ceil(len / 90));
        width = Math.min(1, 0.25 + len / 200);
      }
      model.push({ kind, lines, width });
    }
    return model.length ? model : [{ kind: "text", lines: 1, width: 0.3 }];
  }
  function layoutBars(model, maxBars = 120) {
    const chunk = Math.ceil(model.length / maxBars);
    const merged = [];
    for (let i = 0; i < model.length; i += chunk) {
      const group = model.slice(i, i + chunk);
      merged.push({
        kind: PRIORITY.find((k) => group.some((g) => g.kind === k)),
        lines: group.reduce((n, g) => n + g.lines, 0),
        width: Math.max(...group.map((g) => g.width))
      });
    }
    const total = merged.reduce((n, b) => n + b.lines + 0.5, 0);
    let cursor = 0;
    return merged.map((b) => {
      const top = cursor / total;
      cursor += b.lines + 0.5;
      const width = b.width * 0.76;
      return { kind: b.kind, top, height: b.lines / total, left: 0.12, width };
    });
  }
  function silhouette(boxes, extent, maxItems = 120) {
    const span = extent.bottom - extent.top;
    const live = boxes.filter((b) => b.bottom > b.top && b.right > b.left).sort((a, b) => a.top - b.top);
    if (span <= 0 || !live.length) return [];
    const chunk = Math.ceil(live.length / maxItems);
    const merged = [];
    for (let i = 0; i < live.length; i += chunk) {
      const group = live.slice(i, i + chunk);
      merged.push({
        kind: group.length === 1 ? group[0].kind : ["prompt", ...PRIORITY].find((k) => group.some((g) => g.kind === k)),
        top: Math.min(...group.map((g) => g.top)),
        bottom: Math.max(...group.map((g) => g.bottom)),
        left: Math.min(...group.map((g) => g.left)),
        right: Math.max(...group.map((g) => g.right))
      });
    }
    const x0 = Math.min(...merged.map((b) => b.left));
    const w = Math.max(...merged.map((b) => b.right)) - x0;
    const clamp01 = (n) => Math.max(0, Math.min(1, n));
    return merged.map((b) => ({
      kind: b.kind,
      top: clamp01((b.top - extent.top) / span),
      height: clamp01((b.bottom - b.top) / span),
      left: w > 0 ? clamp01((b.left - x0) / w) : 0,
      width: w > 0 ? clamp01((b.right - b.left) / w) : 1
    }));
  }
  function viewportIndicator({ turnTop, turnBottom, viewTop, viewBottom }) {
    const span = turnBottom - turnTop;
    if (span <= 0 || viewBottom <= turnTop || viewTop >= turnBottom) return null;
    const top = Math.max(0, (viewTop - turnTop) / span);
    const bottom = Math.min(1, (viewBottom - turnTop) / span);
    return { top, height: Math.max(bottom - top, 0.02), visible: bottom - top };
  }
  function scrollTopForFraction({ fraction, turnTop, turnHeight, viewHeight }) {
    const target = turnTop + fraction * turnHeight - viewHeight / 2;
    const max = turnTop + Math.max(0, turnHeight - viewHeight);
    return Math.max(turnTop, Math.min(max, target));
  }

  // src/chatgpt/rail/rail-layout.js
  var RAIL_WIDTH = 320;
  var RAIL_EDGE = 0;
  var RAIL_RESERVE = RAIL_WIDTH + 2 * RAIL_EDGE;
  var DOCK_MIN_VIEWPORT = 1024;
  var MIN_CONTENT = 560;
  var LAYOUT_CSS = `
[data-gs-column][data-gs-column]{box-sizing:border-box;padding-right:var(--gs-reserve,0px)}
`;
  function createRailLayout({ win, adapter, target }) {
    const doc = win.document;
    let written = [];
    let known = null;
    let applied = 0;
    const findColumns = () => {
      if (!known?.length || known.some((el2) => !el2.isConnected)) known = adapter.columns(doc);
      return known;
    };
    function release(el2) {
      el2.removeAttribute("data-gs-column");
      el2.style.removeProperty("--gs-reserve");
      if (!el2.getAttribute("style")) el2.removeAttribute("style");
    }
    function setReserve(cols, px) {
      if (written.some((el2) => !cols.includes(el2))) clear();
      written = cols;
      for (const col of cols) {
        if (px > 0) {
          if (col.getAttribute("data-gs-column") === null) col.setAttribute("data-gs-column", "");
          const v = `${Math.round(px)}px`;
          if (col.style.getPropertyValue("--gs-reserve") !== v) col.style.setProperty("--gs-reserve", v);
        } else if (applied > 0 || col.hasAttribute("data-gs-column")) release(col);
      }
      applied = px > 0 ? Math.round(px) : 0;
    }
    function clear() {
      for (const el2 of written) release(el2);
      written = [];
      applied = 0;
    }
    function signature(paneLeft) {
      const cols = findColumns();
      if (!cols.length) return "none";
      const r = cols[0].getBoundingClientRect();
      return `${win.innerWidth}|${Math.round(r.left)}|${Math.round(r.right + (written.includes(cols[0]) ? applied : 0))}|${cols.length}|${paneLeft == null ? "-" : Math.round(paneLeft)}`;
    }
    function evaluate(paneLeft) {
      const native = paneLeft != null;
      const cols = findColumns();
      const el2 = target() ?? adapter.composer(doc);
      const edge = () => Math.max(el2.getBoundingClientRect().right, adapter.composer(doc)?.getBoundingClientRect().right ?? 0);
      if (!cols.length || !el2 || !native && win.innerWidth < DOCK_MIN_VIEWPORT) {
        if (cols.length) setReserve(cols, 0);
        else clear();
        return { docked: native && !!cols.length, reserve: 0 };
      }
      setReserve(cols, 0);
      const limit = native ? paneLeft : win.innerWidth - RAIL_RESERVE;
      const need = Math.max(0, win.innerWidth - limit);
      const room = Math.max(0, win.innerWidth - cols[0].getBoundingClientRect().right);
      const cap = Math.max(0, need - room);
      let right = edge();
      let reserve = 0;
      if (right > limit && cap > 0) {
        reserve = Math.min(cap, 2 * (right - limit));
        for (let i = 0; i < 3; i++) {
          setReserve(cols, reserve);
          right = edge();
          const over = right - limit;
          if (over <= 0.5 || reserve >= cap) break;
          reserve = Math.min(cap, reserve + over);
        }
      }
      const fits = right <= limit + 0.5 && (reserve === 0 || el2.getBoundingClientRect().width >= MIN_CONTENT);
      if (!fits) {
        setReserve(cols, 0);
        return { docked: native, reserve: 0 };
      }
      return { docked: true, reserve };
    }
    return { evaluate, signature, reserve: () => applied, dispose: clear };
  }

  // src/chatgpt/rail/rail-state.js
  var NEW_CHAT = "new";
  function contentSignature(prompts) {
    const first = prompts[0];
    if (!first) return null;
    let h = 5381;
    for (let i = 0; i < Math.min(first.text.length, 200); i++) h = (h * 33 ^ first.text.charCodeAt(i)) >>> 0;
    return `${first.id}|${h.toString(36)}`;
  }
  function createRailStateStore({ max = 24 } = {}) {
    const slots = /* @__PURE__ */ new Map();
    return {
      /** The stored state for a conversation, or null. */
      get: (id) => id === NEW_CHAT ? null : slots.get(id) ?? null,
      /** The conversation whose stored content has this signature, or null. */
      owner(sig) {
        if (sig) {
          for (const [id, slot] of slots) if (slot.sig === sig) return id;
        }
        return null;
      },
      /**
       * Store `state` (with `sig`, the content signature) for `id`. Skipped when the content belongs to a
       * different stored conversation: that means the page still shows the previous conversation's DOM.
       */
      save(id, state) {
        if (id === NEW_CHAT) return false;
        const owner = this.owner(state.sig);
        if (owner && owner !== id) return false;
        slots.delete(id);
        slots.set(id, state);
        while (slots.size > max) slots.delete(slots.keys().next().value);
        return true;
      },
      forget: (id) => slots.delete(id),
      size: () => slots.size
    };
  }
  function createPanePrefs(storage, { max = 50, key = "gs.pane.prefs" } = {}) {
    const read = () => {
      try {
        const data = JSON.parse(storage?.getItem(key) ?? "{}");
        return data && typeof data === "object" && !Array.isArray(data) ? data : {};
      } catch {
        return {};
      }
    };
    return {
      get(id) {
        const p = id === NEW_CHAT ? null : read()[id];
        return p && typeof p === "object" ? { outputs: !!p.outputs, overview: !!p.overview, prompts: !!p.prompts } : null;
      },
      set(id, prefs) {
        if (id === NEW_CHAT) return;
        const data = read();
        delete data[id];
        data[id] = { outputs: !!prefs.outputs, overview: !!prefs.overview, prompts: !!prefs.prompts };
        for (const old of Object.keys(data).slice(0, Math.max(0, Object.keys(data).length - max))) delete data[old];
        try {
          storage?.setItem(key, JSON.stringify(data));
        } catch {
        }
      }
    };
  }

  // src/chatgpt/rail/rail.js
  var STYLE_ID2 = "gs-pane-style";
  var LINE = "var(--border-light,color-mix(in srgb,currentColor 14%,transparent))";
  var HOVER = "var(--surface-hover,color-mix(in srgb,currentColor 7%,transparent))";
  var SELECTED = "var(--interactive-bg-secondary-selected,color-mix(in srgb,currentColor 12%,transparent))";
  var CODE = "var(--bg-elevated-secondary,color-mix(in srgb,currentColor 12%,transparent))";
  var BUBBLE = "var(--message-surface,color-mix(in srgb,currentColor 10%,transparent))";
  var INK = "color-mix(in srgb,currentColor 38%,transparent)";
  var INK_FAINT = "color-mix(in srgb,currentColor 22%,transparent)";
  var ACCENT = "var(--interactive-bg-accent-default,AccentColor)";
  var MUTED = "var(--text-secondary,color-mix(in srgb,currentColor 65%,transparent))";
  var FOCUS = "outline:2px solid var(--border-heavy,currentColor);outline-offset:-2px";
  var CHEVRON = '<svg class="gs-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  var MENU = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  var CSS2 = `
.gs-pane{position:fixed;right:0;top:var(--gs-pane-top,0px);bottom:0;z-index:30;display:flex;flex-direction:column;width:${RAIL_WIDTH}px;max-width:100vw;box-sizing:border-box;border-left:1px solid ${LINE};background:var(--main-surface-primary,Canvas);color:var(--text-primary,CanvasText);font:inherit;font-size:14px;line-height:20px}
.gs-pane[hidden]{display:none}
.gs-pane *,.gs-pane-slot *{box-sizing:border-box}
.gs-pane[data-gs-mode="collapsed"]{top:auto;right:8px;bottom:var(--gs-pane-bottom,96px);width:min(${RAIL_WIDTH}px,calc(100vw - 16px));height:min(520px,calc(100vh - var(--gs-pane-bottom,96px) - 16px));border:1px solid ${LINE};border-radius:16px;overflow:hidden}
.gs-pane[data-gs-mode="collapsed"][data-gs-open="false"]{display:none}
.gs-pane-slot{display:flex;flex:1 1 auto;flex-direction:column;min-height:min(360px,60vh);max-height:100%;border-top:1px solid ${LINE};font-size:14px;line-height:20px}
.gs-pane-body{display:flex;flex:1 1 auto;flex-direction:column;min-height:0;overflow:hidden}
.gs-sec{display:flex;flex:0 0 auto;flex-direction:column;min-height:0}
.gs-sec-prompts{flex:1 1 auto}
.gs-sec-head{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:40px;padding:8px 16px;border:0;background:transparent;color:inherit;font:inherit;font-weight:600;text-align:left;cursor:pointer}
.gs-sec-head:hover,.gs-outputs-toggle:hover{background:${HOVER}}
.gs-chevron{flex:0 0 auto;transition:transform .15s}
.gs-sec[data-gs-collapsed="true"] .gs-chevron,[data-gs-outputs][data-gs-collapsed="true"] .gs-chevron{transform:rotate(-90deg)}
.gs-sec-body{display:flex;flex-direction:column;min-height:0;padding:0 16px 12px}
.gs-sec-prompts .gs-sec-body{flex:1 1 auto}
.gs-sec[data-gs-collapsed="true"] .gs-sec-body{display:none}
.gs-minimap{position:relative;flex:0 0 auto;height:min(220px,28vh);border:1px solid ${LINE};border-radius:8px;background:transparent;cursor:pointer;touch-action:none;overflow:hidden}
.gs-minimap:focus-visible,.gs-search input:focus-visible,.gs-prompt:focus-visible,.gs-pane-toggle:focus-visible,.gs-sec-head:focus-visible,.gs-filter:focus-visible,.gs-outputs-toggle:focus-visible{${FOCUS}}
.gs-bars{position:absolute;inset:0;--gs-lh:4px}
.gs-bar{position:absolute;min-height:2px;border-radius:2px;pointer-events:none}
.gs-bar[data-kind="text"]{background-image:linear-gradient(${INK_FAINT} 0 50%,transparent 50%);background-size:100% var(--gs-lh)}
.gs-bar[data-kind="heading"]{background-image:linear-gradient(${INK} 0 60%,transparent 60%);background-size:100% var(--gs-lh)}
.gs-bar[data-kind="code"]{border-radius:3px;background-color:${CODE};background-image:linear-gradient(${INK_FAINT} 0 40%,transparent 40%);background-size:100% var(--gs-lh)}
.gs-bar[data-kind="table"]{border:1px solid ${INK};background-image:linear-gradient(${INK_FAINT} 0 1px,transparent 1px);background-size:100% calc(var(--gs-lh) * 2)}
.gs-bar[data-kind="image"]{border:1px solid ${INK};background-color:${INK_FAINT}}
.gs-bar[data-kind="prompt"]{border-radius:6px;background-color:${BUBBLE}}
.gs-view{position:absolute;left:0;right:0;border:1px solid ${ACCENT};border-radius:4px;background:color-mix(in srgb,${ACCENT} 16%,transparent);pointer-events:none}
.gs-caption{margin-top:8px;font-size:12px;line-height:16px;color:${MUTED}}
.gs-search{display:flex;flex:0 0 auto;gap:6px;align-items:center;margin-bottom:8px}
.gs-search-field{position:relative;flex:1 1 auto;min-width:0}
.gs-search-field::before{content:"";position:absolute;left:10px;top:50%;width:9px;height:9px;margin-top:-6px;border:2px solid currentColor;border-radius:50%;opacity:.55;pointer-events:none}
.gs-search input{width:100%;min-height:36px;padding:4px 8px 4px 30px;border:1px solid ${LINE};border-radius:10px;background:transparent;color:inherit;font:inherit}
.gs-filter{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border:1px solid ${LINE};border-radius:10px;background:transparent;color:${MUTED};cursor:pointer}
.gs-filter:hover{background:${HOVER}}
.gs-filter[aria-pressed="true"]{background:${SELECTED};color:inherit}
.gs-prompts{flex:1 1 auto;min-height:60px;margin:0;padding:0;list-style:none;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
.gs-prompt{position:relative;display:flex;gap:10px;width:100%;min-height:48px;padding:6px 24px 6px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.gs-prompt:hover{background:${HOVER}}
.gs-prompt[aria-current="true"]{background:${SELECTED}}
.gs-prompt[data-in-view="true"]::after{content:"";position:absolute;right:10px;top:50%;width:6px;height:6px;margin-top:-3px;border-radius:50%;background:currentColor;opacity:.5}
.gs-n{flex:0 0 auto;min-width:3ch;color:${MUTED}}
.gs-copy{display:flex;flex:1 1 auto;flex-direction:column;min-width:0}
.gs-title{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-preview{font-size:12px;line-height:16px;color:${MUTED};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-empty{padding:8px;color:${MUTED}}
.gs-pane-toggle{display:none;position:fixed;right:8px;bottom:var(--gs-pane-bottom,96px);z-index:30;align-items:center;justify-content:center;min-width:44px;min-height:44px;border:1px solid ${LINE};border-radius:22px;background:var(--main-surface-primary,Canvas);color:inherit;cursor:pointer}
.gs-pane-toggle[data-gs-mode="collapsed"]{display:flex}
.gs-pane-toggle[hidden]{display:none}
.gs-outputs-toggle{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:28px;height:28px;margin-left:auto;padding:0;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}
[data-gs-outputs][data-gs-collapsed="true"]>:not([data-gs-outputs-head]){display:none}
${LAYOUT_CSS}`;
  function describePrompt(text, reply = "") {
    const clean = text.replace(/\s+/g, " ").trim();
    const m = clean.match(/^(.{1,60}?)(?:[.?!:]\s+|$)/);
    const title = (m ? m[1] : clean.slice(0, 60)).trim() || clean.slice(0, 60);
    const rest = clean.slice(title.length).replace(/^[.?!:\s]+/, "");
    const preview = (rest || reply.replace(/\s+/g, " ").trim()).slice(0, 100);
    return { title, preview };
  }
  var clamp2 = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  var PREVIEW_MAX = 100;
  var SCAN_MS = 400;
  var BLOCK_CAP = 800;
  function createRail({ win, adapter, runtime, store = createRailStateStore(), prefs = createPanePrefs(win.localStorage) }) {
    const doc = win.document;
    const scroll = runtime.scroll;
    const scroller = scroll.element ?? adapter.scroller(doc);
    const convId = adapter.conversationId(win);
    let els = [];
    let prompts = [];
    let signature = null;
    let query = "";
    let activeId = null;
    let open = false;
    let inViewOnly = false;
    let viewSet = /* @__PURE__ */ new Set();
    let listPinned = true;
    let listManual = false;
    let modelKey = "";
    let modelBuiltAt = -Infinity;
    let forceModel = false;
    let trailing = null;
    let scheduled = false;
    let layoutQueued = false;
    let forceScan = false;
    let layoutSig = null;
    let disposed = false;
    let drag = false;
    let userScrolled = false;
    let ownSig = null;
    let restore = store.get(convId);
    let didRestore = false;
    let viewBox = "";
    let bookmarkToRestore = null;
    let listTopToRestore = null;
    let outputsCollapsed = false;
    let openPending = convId !== "new";
    let lastHost = null;
    let scannedAt = -Infinity;
    let scanTimer = null;
    let outputsHost = null;
    let slot = null;
    const described = /* @__PURE__ */ new Map();
    const style = doc.createElement("style");
    style.id = STYLE_ID2;
    style.textContent = CSS2;
    doc.head.appendChild(style);
    const root = doc.createElement("aside");
    root.className = "gs-pane";
    root.dataset.gsUi = "";
    root.setAttribute("aria-label", "Conversation summary");
    root.dataset.gsHost = "fallback";
    root.dataset.gsMode = "docked";
    root.dataset.gsOpen = "true";
    const body = doc.createElement("div");
    body.className = "gs-pane-body";
    body.dataset.gsUi = "";
    body.innerHTML = `
      <section class="gs-sec gs-sec-overview" data-gs-collapsed="false">
        <button type="button" class="gs-sec-head" aria-expanded="true" aria-controls="gs-overview-body"><span class="gs-sec-title">Overview</span>${CHEVRON}</button>
        <div class="gs-sec-body" id="gs-overview-body">
          <div class="gs-minimap" tabindex="0" role="slider" aria-orientation="vertical" aria-label="Current turn overview" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="gs-bars"></div><div class="gs-view" hidden></div></div>
          <div class="gs-caption" aria-live="off">Drag to navigate \u2022 0% visible</div>
        </div>
      </section>
      <section class="gs-sec gs-sec-prompts" data-gs-collapsed="false">
        <button type="button" class="gs-sec-head" aria-expanded="true" aria-controls="gs-prompts-body"><span class="gs-sec-title">Prompts</span>${CHEVRON}</button>
        <div class="gs-sec-body" id="gs-prompts-body">
          <div class="gs-search"><div class="gs-search-field"><input type="search" placeholder="Search prompts..." aria-label="Search prompts"></div><button type="button" class="gs-filter" aria-pressed="false" aria-label="Only prompts in view" title="Only prompts in view">${MENU}</button></div>
          <ol class="gs-prompts" aria-label="Prompts, oldest first"></ol>
        </div>
      </section>`;
    root.append(body);
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = "gs-pane-toggle";
    toggle.dataset.gsUi = "";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Conversation summary");
    toggle.innerHTML = MENU;
    toggle.dataset.gsMode = "docked";
    doc.body.append(root, toggle);
    const outputsBtn = doc.createElement("button");
    outputsBtn.type = "button";
    outputsBtn.className = "gs-outputs-toggle";
    outputsBtn.dataset.gsUi = "";
    outputsBtn.setAttribute("aria-label", "Outputs");
    outputsBtn.innerHTML = CHEVRON;
    const $ = (sel) => body.querySelector(sel);
    const minimap = $(".gs-minimap");
    const bars = $(".gs-bars");
    const view = $(".gs-view");
    const overviewCard = $(".gs-sec-overview");
    const promptsCard = $(".gs-sec-prompts");
    const caption = $(".gs-caption");
    const filterBtn = $(".gs-filter");
    const input = $(".gs-search input");
    const list = $(".gs-prompts");
    const railLayout = createRailLayout({ win, adapter, target: () => els[0] });
    const cleanups = [];
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      cleanups.push(() => target.removeEventListener(type, fn, opts));
    };
    const setCollapsed = (card, collapsed) => {
      card.dataset.gsCollapsed = String(collapsed);
      card.querySelector(".gs-sec-head").setAttribute("aria-expanded", String(!collapsed));
    };
    const savePrefs = () => prefs.set(convId, { outputs: outputsCollapsed, overview: overviewCard.dataset.gsCollapsed === "true", prompts: promptsCard.dataset.gsCollapsed === "true" });
    function setOpen(next) {
      open = next;
      if (root.dataset.gsOpen !== String(next)) root.dataset.gsOpen = String(next);
      if (toggle.getAttribute("aria-expanded") !== String(next)) toggle.setAttribute("aria-expanded", String(next));
    }
    const stored = prefs.get(convId);
    if (stored) {
      outputsCollapsed = stored.outputs;
      setCollapsed(overviewCard, stored.overview);
      setCollapsed(promptsCard, stored.prompts);
    }
    if (restore) {
      outputsCollapsed = restore.ui.outputsCollapsed ?? outputsCollapsed;
      query = restore.ui.query;
      input.value = query;
      inViewOnly = restore.ui.inViewOnly;
      filterBtn.setAttribute("aria-pressed", String(inViewOnly));
      setCollapsed(overviewCard, restore.ui.overviewCollapsed);
      setCollapsed(promptsCard, restore.ui.promptsCollapsed);
    }
    function persist(bookmark) {
      if (disposed || restore || convId === "new") return;
      const sig = contentSignature(prompts);
      if (!sig) return;
      if (ownSig === null) {
        const owner = store.owner(sig);
        if (owner && owner !== convId) return;
        ownSig = sig;
      } else if (sig !== ownSig) return;
      const prev = store.get(convId);
      store.save(convId, {
        sig,
        ui: { query, inViewOnly, open, outputsCollapsed, overviewCollapsed: overviewCard.dataset.gsCollapsed === "true", promptsCollapsed: promptsCard.dataset.gsCollapsed === "true" },
        activeId,
        list: { top: list.scrollTop, pinned: listPinned },
        bookmark: bookmark ?? prev?.bookmark ?? null
      });
    }
    function applyRestore() {
      if (!restore || !prompts.length) return false;
      const sig = contentSignature(prompts);
      if (sig !== restore.sig) {
        const owner = store.owner(sig);
        if (!owner || owner === convId) restore = null;
        return false;
      }
      const saved = restore;
      restore = null;
      ownSig = sig;
      if (saved.activeId && prompts.some((p) => p.id === saved.activeId)) activeId = saved.activeId;
      listPinned = saved.list.pinned;
      listManual = !saved.list.pinned;
      if (saved.ui.open && root.dataset.gsMode === "collapsed") setOpen(true);
      bookmarkToRestore = saved.bookmark;
      listTopToRestore = saved.list.top;
      didRestore = true;
      return true;
    }
    function finishRestore() {
      if (listTopToRestore !== null) list.scrollTop = listPinned ? list.scrollHeight : listTopToRestore;
      listTopToRestore = null;
      const mark = bookmarkToRestore;
      bookmarkToRestore = null;
      if (!mark || mark.bottom || userScrolled) return;
      const el2 = els.find((e, i) => adapter.turnId(e, i) === mark.id);
      if (el2) runtime.navigateTo(el2, { offset: mark.offset });
    }
    function openAtLatest() {
      if (!openPending || disposed) return;
      if (didRestore || userScrolled) {
        openPending = false;
        return;
      }
      const last = prompts.at(-1);
      const el2 = last && els[last.turnIndex];
      if (restore || !el2 || !runtime.isTurnActive(el2) || !el2.getBoundingClientRect().height) return;
      openPending = false;
      runtime.open(el2, { offset: 0 });
    }
    function setVar(name, value) {
      for (const el2 of [root, toggle]) if (el2.style.getPropertyValue(name) !== value) el2.style.setProperty(name, value);
    }
    function setMode(mode) {
      if (root.dataset.gsMode !== mode) root.dataset.gsMode = mode;
      if (toggle.dataset.gsMode !== mode) toggle.dataset.gsMode = mode;
    }
    function releaseOutputs() {
      if (outputsHost) {
        outputsHost.section.removeAttribute("data-gs-outputs");
        outputsHost.section.removeAttribute("data-gs-collapsed");
        outputsHost.head.removeAttribute("data-gs-outputs-head");
      }
      outputsBtn.remove();
      outputsHost = null;
    }
    function syncOutputs(host) {
      const o = host?.outputs ?? null;
      if (outputsHost && (!o || o.section !== outputsHost.section || o.head !== outputsHost.head)) releaseOutputs();
      if (!o) return;
      outputsHost = o;
      if (!o.section.hasAttribute("data-gs-outputs")) o.section.setAttribute("data-gs-outputs", "");
      if (!o.head.hasAttribute("data-gs-outputs-head")) o.head.setAttribute("data-gs-outputs-head", "");
      if (outputsBtn.parentElement !== o.head) o.head.append(outputsBtn);
      const collapsed = String(outputsCollapsed);
      if (o.section.getAttribute("data-gs-collapsed") !== collapsed) o.section.setAttribute("data-gs-collapsed", collapsed);
      const expanded = String(!outputsCollapsed);
      if (outputsBtn.getAttribute("aria-expanded") !== expanded) outputsBtn.setAttribute("aria-expanded", expanded);
    }
    function place(host) {
      const hostKind = host ? "native" : "fallback";
      if (host) {
        slot ??= Object.assign(doc.createElement("div"), { className: "gs-pane-slot" });
        slot.dataset.gsUi = "";
        if (slot.parentElement !== host.container) host.container.append(slot);
        if (body.parentElement !== slot) slot.append(body);
      } else {
        if (body.parentElement !== root) root.append(body);
        slot?.remove();
      }
      if (root.dataset.gsHost !== hostKind) root.dataset.gsHost = hostKind;
      if (root.hidden !== !!host) root.hidden = !!host;
      if (toggle.hidden !== !!host) toggle.hidden = !!host;
      syncOutputs(host);
    }
    function layout(rescan = false) {
      let host = lastHost;
      if (!host || !host.pane.isConnected || !host.container.isConnected || host.outputs && !(host.outputs.section.isConnected && host.outputs.head.isConnected) || !host.pane.getBoundingClientRect().width) {
        const t = win.performance.now();
        if (rescan || t - scannedAt >= SCAN_MS) {
          host = adapter.nativeSummary(doc);
          scannedAt = t;
        } else {
          host = null;
          if (!scanTimer) {
            scanTimer = win.setTimeout(() => {
              scanTimer = null;
              if (!disposed) layout(true);
            }, SCAN_MS);
          }
        }
      }
      lastHost = host;
      place(host);
      const now = railLayout.signature(host?.left);
      if (now !== layoutSig) {
        const { docked } = railLayout.evaluate(host?.left);
        const was = root.dataset.gsMode;
        setMode(docked ? "docked" : "collapsed");
        if (docked) setOpen(true);
        else if (was === "docked") setOpen(false);
        layoutSig = railLayout.signature(host?.left);
        if (!host) setVar("--gs-pane-top", `${Math.max(0, Math.round(adapter.headerBottom(doc)))}px`);
      }
      if (!host && root.dataset.gsMode === "collapsed") {
        const rect = adapter.composer(doc)?.getBoundingClientRect();
        setVar("--gs-pane-bottom", rect?.height ? `${Math.max(16, Math.round(win.innerHeight - rect.top + 8))}px` : "96px");
      }
    }
    function promptEnd(i) {
      return (prompts[i + 1]?.turnIndex ?? els.length) - 1;
    }
    function describe2(p) {
      const cached = described.get(p.id);
      if (cached && cached.len === p.text.length) return cached;
      let d = { len: p.text.length, ...describePrompt(p.text, "") };
      d.final = d.preview !== "" || p !== prompts.at(-1);
      if (!d.preview) {
        const reply = adapter.reply(els, p.turnIndex);
        d = { ...d, ...describePrompt(p.text, reply?.textContent ?? "") };
        d.final = p !== prompts.at(-1) || d.preview.length >= PREVIEW_MAX;
      }
      if (d.final) described.set(p.id, d);
      return d;
    }
    function refreshLastPreview() {
      const p = prompts.at(-1);
      if (!p || described.has(p.id)) return;
      const d = describe2(p);
      const row = [...list.querySelectorAll(".gs-prompt")].find((b) => b.dataset.id === p.id);
      const pv = row?.querySelector(".gs-preview");
      if (pv && pv.textContent !== d.preview) pv.textContent = d.preview;
    }
    function renderList() {
      let shown = searchPrompts(prompts, query);
      if (inViewOnly) shown = shown.filter((p) => viewSet.has(p.id));
      list.textContent = "";
      if (!shown.length) {
        const li = doc.createElement("li");
        li.className = "gs-empty";
        li.textContent = prompts.length ? "No matching prompts" : "No prompts yet";
        list.append(li);
      }
      for (const p of shown) {
        const { title, preview } = describe2(p);
        const li = doc.createElement("li");
        const b = doc.createElement("button");
        b.type = "button";
        b.className = "gs-prompt";
        b.dataset.id = p.id;
        b.tabIndex = p.id === (activeId ?? shown.at(-1)?.id) ? 0 : -1;
        b.setAttribute("aria-current", String(p.id === activeId));
        b.dataset.inView = String(viewSet.has(p.id));
        b.title = p.preview;
        const n = doc.createElement("span");
        n.className = "gs-n";
        n.textContent = `#${prompts.indexOf(p) + 1}`;
        const copy = doc.createElement("span");
        copy.className = "gs-copy";
        const t = doc.createElement("span");
        t.className = "gs-title";
        t.textContent = title;
        const pv = doc.createElement("span");
        pv.className = "gs-preview";
        pv.textContent = preview;
        copy.append(t, pv);
        b.append(n, copy);
        li.append(b);
        list.append(li);
      }
      if (listPinned) list.scrollTop = list.scrollHeight;
    }
    function measureView() {
      const sTop = scroller.getBoundingClientRect().top;
      const viewTop = Math.max(sTop, 0);
      const viewBottom = Math.min(sTop + scrollerHeight(), win.innerHeight || Infinity);
      const first = els.length ? firstElementBelow(viewTop + 1) : 0;
      let last = first;
      while (last + 1 < els.length && els[last + 1].getBoundingClientRect().top < viewBottom) last++;
      const atBottom = scroller.scrollTop + scrollerHeight() >= scroller.scrollHeight - 2;
      return { sTop, viewTop, viewBottom, first, last, atBottom };
    }
    function updateInView(m) {
      const next = /* @__PURE__ */ new Set();
      if (els.length && prompts.length) {
        prompts.forEach((p, i) => {
          if (p.turnIndex <= m.last && promptEnd(i) >= m.first) next.add(p.id);
        });
      }
      const changed = next.size !== viewSet.size || [...next].some((id) => !viewSet.has(id));
      viewSet = next;
      if (!changed) return;
      if (inViewOnly) return renderList();
      for (const b of list.querySelectorAll(".gs-prompt")) b.dataset.inView = String(viewSet.has(b.dataset.id));
    }
    function firstElementBelow(y) {
      let lo = 0;
      let hi = els.length - 1;
      while (lo < hi) {
        const mid = lo + hi >> 1;
        if (els[mid].getBoundingClientRect().bottom > y) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    }
    function markActive() {
      for (const b2 of list.querySelectorAll(".gs-prompt")) {
        const cur = b2.dataset.id === activeId;
        b2.setAttribute("aria-current", String(cur));
        b2.tabIndex = cur ? 0 : -1;
      }
      const b = list.querySelector('[aria-current="true"]');
      if (b && !listManual && !listPinned) {
        if (b.offsetTop < list.scrollTop) list.scrollTop = b.offsetTop;
        else if (b.offsetTop + b.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = b.offsetTop + b.offsetHeight - list.clientHeight;
      }
    }
    function turnExtent() {
      const i = prompts.findIndex((p) => p.id === activeId);
      if (i < 0) return null;
      const a = els[prompts[i].turnIndex];
      const z = els[promptEnd(i)];
      if (!a || !z) return null;
      return { i, a, z };
    }
    function silhouetteItems(ext, slice, top, height) {
      if (slice.every((e) => runtime.isTurnActive(e))) {
        const users = slice.map((t) => adapter.userMessage(t)).filter(Boolean);
        const boxes = [];
        const add = (kind, el2) => {
          const r = el2.getBoundingClientRect();
          boxes.push({ kind, top: r.top, bottom: r.bottom, left: r.left, right: r.right });
        };
        for (const u of users) add("prompt", u);
        for (const el2 of adapter.blocks(slice).slice(0, BLOCK_CAP)) {
          const kind = !users.some((u) => u.contains(el2)) && blockKind(el2);
          if (kind) add(kind, el2);
        }
        const items = silhouette(boxes, { top, bottom: top + height });
        if (items.length) return items;
      }
      return layoutBars(buildTurnModel(adapter.blocks(slice)));
    }
    function renderMinimap(m) {
      const ext = turnExtent();
      if (!ext || overviewCard.dataset.gsCollapsed === "true") return;
      const slice = els.slice(prompts[ext.i].turnIndex, promptEnd(ext.i) + 1);
      const turnBox = ext.a.getBoundingClientRect();
      const turnPx = ext.z.getBoundingClientRect().bottom - turnBox.top;
      const key = `${activeId}:${slice.map((e) => e.textContent.length).join(",")}:${slice.every((e) => runtime.isTurnActive(e))}:${Math.round(turnPx / 20)}:${Math.round(turnBox.width / 8)}`;
      const now = win.performance.now();
      const throttled = key !== modelKey && modelKey !== "" && modelKey.startsWith(`${activeId}:`) && now - modelBuiltAt < 500 && !forceModel;
      if (throttled && !trailing) {
        trailing = win.setTimeout(() => {
          trailing = null;
          forceModel = true;
          schedule();
        }, 500);
      }
      if (key !== modelKey && !throttled) {
        forceModel = false;
        modelKey = key;
        modelBuiltAt = now;
        bars.textContent = "";
        const scale = (minimap.getBoundingClientRect().height || 220) / Math.max(turnPx, 1);
        bars.style.setProperty("--gs-lh", `${Math.max(3, Math.min(8, 24 * scale)).toFixed(1)}px`);
        for (const b of silhouetteItems(ext, slice, turnBox.top, turnPx)) {
          const d = doc.createElement("div");
          d.className = "gs-bar";
          d.dataset.kind = b.kind;
          d.style.cssText = `top:${(b.top * 100).toFixed(2)}%;height:${(b.height * 100).toFixed(2)}%;left:${(b.left * 100).toFixed(2)}%;width:${(b.width * 100).toFixed(2)}%`;
          bars.append(d);
        }
      }
      const ind = viewportIndicator({
        turnTop: ext.a.getBoundingClientRect().top,
        turnBottom: ext.z.getBoundingClientRect().bottom,
        viewTop: m.viewTop,
        viewBottom: m.viewBottom
      });
      if (view.hidden !== !ind) view.hidden = !ind;
      const text = `Drag to navigate \u2022 ${ind ? Math.round(ind.visible * 100) : 0}% visible`;
      if (caption.textContent !== text) caption.textContent = text;
      if (ind) {
        const top = `${(ind.top * 100).toFixed(2)}%`;
        const height = `${(ind.height * 100).toFixed(2)}%`;
        if (viewBox !== `${top} ${height}`) {
          viewBox = `${top} ${height}`;
          view.style.top = top;
          view.style.height = height;
        }
        const now2 = String(Math.round(ind.top * 100));
        if (minimap.getAttribute("aria-valuenow") !== now2) minimap.setAttribute("aria-valuenow", now2);
      }
    }
    function scrollerHeight() {
      return scroller.clientHeight || scroller.getBoundingClientRect().height;
    }
    function detectActive(m = measureView()) {
      if (!els.length || !prompts.length) return null;
      if (m.atBottom) return prompts.at(-1).id;
      let found = prompts[0];
      for (const p of prompts) if (p.turnIndex <= m.first) found = p;
      return found.id;
    }
    function bookmarkOf(m) {
      const el2 = els[m.first];
      if (!el2) return null;
      return { id: adapter.turnId(el2, m.first), offset: el2.getBoundingClientRect().top - m.sTop, bottom: m.atBottom };
    }
    function update() {
      scheduled = false;
      if (disposed) return;
      const m = measureView();
      const next = detectActive(m);
      if (next && next !== activeId) {
        activeId = next;
        markActive();
      }
      updateInView(m);
      renderMinimap(m);
      refreshLastPreview();
      persist(els.length ? bookmarkOf(m) : null);
    }
    function schedule() {
      if (scheduled || disposed) return;
      scheduled = true;
      win.requestAnimationFrame(update);
    }
    function scheduleLayout(rescan = false) {
      if (rescan === true) forceScan = true;
      if (layoutQueued || disposed) return;
      layoutQueued = true;
      win.requestAnimationFrame(() => {
        layoutQueued = false;
        const force = forceScan;
        forceScan = false;
        if (!disposed) layout(force);
      });
    }
    function refresh(index) {
      els = adapter.turns(doc);
      const sig = index.map((p) => `${p.id}:${p.text.length}`).join("|");
      prompts = index;
      layout();
      const restored = applyRestore();
      if (sig !== signature || restored) {
        signature = sig;
        if (!prompts.some((p) => p.id === activeId)) activeId = null;
        activeId = activeId ?? detectActive();
        renderList();
      }
      if (restored) {
        finishRestore();
        markActive();
      }
      openAtLatest();
      schedule();
    }
    function select(p) {
      activeId = p.id;
      listManual = false;
      markActive();
      const el2 = els[p.turnIndex];
      if (el2) runtime.navigateTo(el2, { offset: 0 });
      modelKey = "";
      renderMinimap(measureView());
      persist();
    }
    function ensureRendered(ext) {
      if (!runtime.isTurnActive(ext.a)) runtime.navigateTo(ext.a, { offset: 0 });
    }
    function turnGeometry(ext) {
      const sRect = scroller.getBoundingClientRect();
      const a = ext.a.getBoundingClientRect();
      return { turnTop: scroller.scrollTop + (a.top - sRect.top), turnHeight: ext.z.getBoundingClientRect().bottom - a.top };
    }
    function jumpFromPointer(clientY) {
      const ext = turnExtent();
      if (!ext) return;
      ensureRendered(ext);
      const r = minimap.getBoundingClientRect();
      const fraction = clamp2(r.height ? (clientY - r.top) / r.height : 0, 0, 1);
      scroll.scrollTo("minimap", scrollTopForFraction({ fraction, ...turnGeometry(ext), viewHeight: scrollerHeight() }));
    }
    on(minimap, "pointerdown", (e) => {
      drag = true;
      minimap.setPointerCapture?.(e.pointerId);
      jumpFromPointer(e.clientY);
      e.preventDefault();
    });
    on(minimap, "pointermove", (e) => drag && jumpFromPointer(e.clientY));
    const endDrag = (e) => {
      drag = false;
      minimap.releasePointerCapture?.(e.pointerId);
    };
    on(minimap, "pointerup", endDrag);
    on(minimap, "pointercancel", endDrag);
    on(minimap, "keydown", (e) => {
      const ext = turnExtent();
      const step = { ArrowUp: -0.1, ArrowDown: 0.1, PageUp: -0.3, PageDown: 0.3 }[e.key];
      if (!ext || step === void 0 && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      ensureRendered(ext);
      const { turnTop, turnHeight } = turnGeometry(ext);
      const viewH = scrollerHeight();
      const max = turnTop + Math.max(0, turnHeight - viewH);
      const next = e.key === "Home" ? turnTop : e.key === "End" ? max : scroller.scrollTop + step * Math.max(turnHeight, viewH);
      scroll.scrollTo("keyboard", clamp2(next, turnTop, max));
    });
    on(list, "click", (e) => {
      const b = e.target.closest?.(".gs-prompt");
      const p = b && prompts.find((x) => x.id === b.dataset.id);
      if (p) select(p);
    });
    on(list, "keydown", (e) => {
      const items = [...list.querySelectorAll(".gs-prompt")];
      const at = items.indexOf(doc.activeElement);
      const to = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: items.length - 1 }[e.key];
      if (to === void 0 || !items.length) return;
      e.preventDefault();
      const next = items[clamp2(to, 0, items.length - 1)];
      items.forEach((b) => b.tabIndex = b === next ? 0 : -1);
      next.focus();
      if (next.offsetTop < list.scrollTop) list.scrollTop = next.offsetTop;
      else if (next.offsetTop + next.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = next.offsetTop + next.offsetHeight - list.clientHeight;
    });
    on(list, "scroll", () => {
      listPinned = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
      persist();
    });
    for (const type of ["wheel", "touchmove", "pointerdown"]) on(list, type, () => listManual = true, { passive: true });
    on(input, "input", () => {
      query = input.value;
      listPinned = !query.trim();
      renderList();
      persist();
    });
    on(input, "keydown", (e) => {
      if (e.key === "Escape" && input.value) {
        input.value = "";
        input.dispatchEvent(new win.Event("input"));
        e.stopPropagation();
      }
    });
    on(toggle, "click", () => {
      setOpen(!open);
      persist();
    });
    on(outputsBtn, "click", (e) => {
      e.stopPropagation();
      outputsCollapsed = !outputsCollapsed;
      syncOutputs(lastHost);
      persist();
      savePrefs();
    });
    for (const head of body.querySelectorAll(".gs-sec-head")) {
      on(head, "click", () => {
        const card = head.closest(".gs-sec");
        const collapsed = card.dataset.gsCollapsed !== "true";
        setCollapsed(card, collapsed);
        if (!collapsed) {
          modelKey = "";
          schedule();
          if (card === promptsCard && listPinned) list.scrollTop = list.scrollHeight;
        }
        persist();
        savePrefs();
      });
    }
    on(filterBtn, "click", () => {
      inViewOnly = !inViewOnly;
      filterBtn.setAttribute("aria-pressed", String(inViewOnly));
      renderList();
      persist();
    });
    on(root, "keydown", (e) => {
      if (e.key === "Escape" && root.dataset.gsMode === "collapsed" && open && !input.value) {
        setOpen(false);
        toggle.focus();
      }
    });
    on(win, "resize", () => scheduleLayout(true));
    on(doc, "transitionend", (e) => !root.contains(e.target) && !body.contains(e.target) && /width|margin|padding|left|right|transform/.test(e.propertyName ?? "") && scheduleLayout(true), { capture: true, passive: true });
    cleanups.push(scroll.onScroll((kind) => {
      if (kind === "user") userScrolled = true;
      schedule();
    }));
    cleanups.push(runtime.onIndexChange(refresh));
    cleanups.push(runtime.onLayoutChange(scheduleLayout));
    cleanups.push(runtime.onFallback(() => api.dispose()));
    refresh(runtime.promptIndex);
    if (!didRestore) {
      listPinned = true;
      list.scrollTop = list.scrollHeight;
    }
    update();
    const api = {
      element: root,
      state: () => ({ activeId, open, mode: root.dataset.gsMode, host: root.dataset.gsHost, outputsCollapsed, listPinned, query, reserve: railLayout.reserve() }),
      /** Structure only, safe to expose: no ids, search text or prompts. */
      shape: () => ({ host: root.dataset.gsHost, mode: root.dataset.gsMode, open, outputsCollapsible: !!outputsHost, outputsCollapsed, reserve: railLayout.reserve() }),
      select: (id) => {
        const p = prompts.find((x) => x.id === id);
        if (p) select(p);
        return !!p;
      },
      update,
      dispose() {
        disposed = true;
        if (trailing) win.clearTimeout(trailing);
        if (scanTimer) win.clearTimeout(scanTimer);
        cleanups.forEach((fn) => fn());
        railLayout.dispose();
        releaseOutputs();
        slot?.remove();
        root.remove();
        toggle.remove();
        style.remove();
      }
    };
    return api;
  }

  // src/chatgpt/virtualization/backend.js
  var STATE = "data-gs-state";
  var HEIGHT_VAR = "--gs-h";
  var STYLE_ID3 = "gs-virtualization-style";
  var CSS3 = `
[data-gs-scroller]{overflow-anchor:none}
[${STATE}="inactive"]{content-visibility:hidden;contain-intrinsic-block-size:var(${HEIGHT_VAR})}
`;
  function discover(doc, adapter) {
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
      /** True when `el` is a turn element whose content is currently rendered (not skipped). */
      isTurnActive: (el2) => api?.turnIndexOf(el2) !== void 0 && el2.getAttribute(STATE) !== "inactive",
      /** Navigate to the turn that owns `el`; false when `el` is not a known turn element. */
      navigateToElement(el2, options) {
        const i = api?.turnIndexOf(el2);
        return i === void 0 ? false : api.navigateToTurn(i, options);
      },
      unmount() {
        api?.dispose();
        api = null;
      },
      api: () => api
    };
  }
  function mountTurns({ doc, adapter, scroll, observers, config: config2, fallback, onLayout }) {
    const win = doc.defaultView;
    const size = config2.windowTurns ?? 10;
    const prefetch = config2.prefetchTurns ?? 2;
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
    style.id = STYLE_ID3;
    style.textContent = CSS3;
    doc.head.appendChild(style);
    scroller.setAttribute("data-gs-scroller", "");
    const turnOf = /* @__PURE__ */ new Map();
    const index = () => {
      turnOf.clear();
      for (const t of turns) for (const el2 of t.elements) turnOf.set(el2, t.index);
    };
    index();
    const allElements = () => turns.flatMap((t) => t.elements);
    const viewportTop = () => scroller === doc.scrollingElement || scroller === doc.documentElement ? 0 : scroller.getBoundingClientRect().top;
    scroll.setAnchors(allElements, (key) => allElements().find((el2) => adapter.turnId(el2, -1) === key) ?? null);
    const offScroll = scroll.onScroll(() => schedule());
    const ro = new win.ResizeObserver(() => {
      scroll.restore();
      schedule();
      onLayout?.();
    });
    const stopObserving = observers.subscribe(parent, () => refresh(), { childList: true, subtree: true });
    function observe(el2, on) {
      if (on && !observed.has(el2)) {
        observed.add(el2);
        ro.observe(el2);
      } else if (!on && observed.has(el2)) {
        observed.delete(el2);
        ro.unobserve(el2);
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
      for (const el2 of allElements()) {
        if (el2.getBoundingClientRect().bottom > base + 0.01) return turnOf.get(el2);
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
        for (const el2 of t.elements) {
          const on = active.has(t.index);
          const isInactive = el2.getAttribute(STATE) === "inactive";
          if (on) {
            if (isInactive || !el2.hasAttribute(STATE)) writes.push([el2, true]);
          } else if (!isInactive) {
            const h = el2.getBoundingClientRect().height;
            if (h > 0) writes.push([el2, false, h]);
          }
        }
      }
      for (const [el2, on, h] of writes) {
        if (on) {
          el2.setAttribute(STATE, "active");
          el2.style.removeProperty(HEIGHT_VAR);
          observe(el2, true);
        } else {
          el2.style.setProperty(HEIGHT_VAR, `${h}px`);
          el2.setAttribute(STATE, "inactive");
          observe(el2, false);
        }
      }
      scroll.restore();
    }
    function refresh() {
      if (disposed) return;
      const current = adapter.turns(doc);
      const flat = allElements();
      if (current.length === flat.length && current.every((el2, i) => el2 === flat[i]) && adapter.turnRoot(doc) === parent) return;
      const next = discover(doc, adapter);
      if (!next.parent || next.parent !== parent) return fallback?.(next.reason ?? "container-changed");
      const wasAtLatest = windowStart + size >= turns.length;
      turns = next.turns;
      index();
      if (wasAtLatest) windowStart = Math.max(0, turns.length - size);
      for (const el2 of [...observed]) if (!el2.isConnected) observe(el2, false);
      for (const el2 of allElements()) {
        if (el2.hasAttribute(STATE)) continue;
        el2.setAttribute(STATE, "active");
        observe(el2, true);
      }
      scroll.restore();
      schedule();
    }
    for (const el2 of allElements()) {
      el2.setAttribute(STATE, "active");
      observe(el2, true);
    }
    const self = {
      active: true,
      stats,
      sync,
      turnCount: () => turns.length,
      turnIndexOf: (el2) => turnOf.get(el2),
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
        for (const el2 of allElements()) {
          el2.removeAttribute(STATE);
          el2.style.removeProperty(HEIGHT_VAR);
          if (!el2.getAttribute("style")) el2.removeAttribute("style");
        }
        scroller.removeAttribute("data-gs-scroller");
        style.remove();
      }
    };
    self.sync();
    return self;
  }

  // src/chatgpt/main.js
  var queueUi = persistentQueueUi(
    ({ win, adapter, diagnostics, config: config2 }) => createQueueUi({ win, adapter, diagnostics, dispatcher: selectDispatcher({ config: config2, win, adapter }) })
  );
  var railState = createRailStateStore();
  var pane = null;
  var config = loadConfig(window.localStorage);
  var recoveryDiagnostics = createDiagnostics(window.console);
  var recovery = config.enabled && config.recovery ? createRecovery({ win: window, adapter: chatgptAdapter, diagnostics: recoveryDiagnostics }) : null;
  var boot = createBoot({
    win: window,
    adapter: chatgptAdapter,
    version: "0.7.0",
    extraDiagnostics: () => recoveryDiagnostics.snapshot(),
    onDispose: () => {
      queueUi.shutdown();
      recovery?.dispose();
    },
    mount() {
      const runtime = createRuntime({ win: window, adapter: chatgptAdapter, backend: createTurnBackend(), queueUi });
      const rail = runtime.mode === "active" || runtime.mode === "composer-only" ? createRail({ win: window, adapter: chatgptAdapter, runtime, store: railState }) : null;
      pane = rail;
      return {
        runtime,
        dispose() {
          rail?.dispose();
          if (pane === rail) pane = null;
          runtime.dispose();
        }
      };
    }
  });
  Object.defineProperty(boot.health, "pane", { enumerable: true, get: () => pane?.shape() ?? null });
  window.__ghostshipUserscripts = boot.health;
})();
