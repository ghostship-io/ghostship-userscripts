// ==UserScript==
// @name         GhostShip ChatGPT
// @namespace    https://github.com/ghostship-io/ghostship-userscripts
// @version      0.7.6
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
          else current.handle.heal?.();
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
    expandThinking: true,
    // open ChatGPT's collapsed thinking traces as they scroll into view
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
  var clean = (el2) => (el2.textContent ?? "").replace(/\s+/g, " ").trim();
  function buildPromptIndex(root, adapter) {
    const prompts = [];
    const turns = adapter.turns(root);
    turns.forEach((turn, turnIndex) => {
      const el2 = adapter.userMessage(turn);
      if (!el2) return;
      const text = clean(el2);
      prompts.push({ id: adapter.turnId(turn, turnIndex), turnIndex, preview: text.slice(0, PREVIEW_LENGTH), text });
    });
    if (!prompts.length) {
      turns.forEach((turn, turnIndex) => {
        const lead = (adapter.blocks?.([turn]) ?? []).slice(0, 6).map(clean).filter(Boolean).join(" ");
        const text = (lead || clean(turn)).replace(/^ChatGPT said:\s*/i, "").slice(0, PREVIEW_LENGTH * 2);
        if (text) prompts.push({ id: adapter.turnId(turn, turnIndex), turnIndex, preview: text.slice(0, PREVIEW_LENGTH), text, automated: true });
      });
    }
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
  var SEND_FALLBACK = 'button[type="submit"][aria-label^="Send" i]';
  var STOP = 'button[data-testid="stop-button"]';
  var STOP_FALLBACK = 'button[aria-label^="Stop" i]';
  var STREAMING = ".result-streaming, [data-is-streaming='true']";
  var STEER = 'button[data-testid="steer-button"], button[aria-label^="Steer" i]';
  var PROFILE = '[data-testid="accounts-profile-button"], [data-testid="profile-button"]';
  var ATTACHMENT = '[data-testid*="attachment" i], [data-testid*="file-thumbnail" i]';
  var SCROLLER = "[data-scroll-root], [data-app-action-timeline-scroll]";
  var HEADER = "#page-header, header";
  var ASSISTANT = '[data-message-author-role="assistant"], [data-conversation-role="assistant"]';
  var SCROLLABLE = /* @__PURE__ */ new Set(["auto", "scroll", "overlay"]);
  var ABSOLUTE = /* @__PURE__ */ new Set(["absolute", "fixed"]);
  var ACTIVE_PAGE = '[data-app-shell-active-page="true"]';
  var scope = (root) => root.nodeType === 9 ? root.querySelector(ACTIVE_PAGE) ?? root : root;
  var pageHeader = (doc) => {
    for (const h of scope(doc).querySelectorAll(HEADER)) {
      if (h.closest(OWN_UI) || h.closest(TURN)) continue;
      const r = h.getBoundingClientRect();
      if (r.width && r.height) return h;
    }
    return scope(doc).querySelector("#page-header");
  };
  var SUMMARY_TITLE = /^(outputs?|sources?)$/i;
  var HEADINGS = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  var SUMMARY_HINT = "[data-summary-panel-variant],[data-summary-panel-density]";
  var SUMMARY_REGION = `aside,[role="complementary"],[role="region"],[aria-label*="summary" i],[data-testid*="summary" i],${SUMMARY_HINT}`;
  var BUTTONS = 'button,[role="button"]';
  var BUTTON_REGION = `aside,[role="complementary"],[role="region"],${SUMMARY_HINT}`;
  var OWN_UI = "[data-gs-ui]";
  var SUMMARY_TOGGLE = 'button[data-thread-summary-panel-toggle="true"]';
  var THINKING_TITLE = /^(thought|worked|thinking|stopped thinking|reasoned)\b/i;
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
  function hintedPane(page, win, composer) {
    for (const pane2 of page.querySelectorAll(SUMMARY_HINT)) {
      if (pane2.matches(TURN) || pane2.closest(TURN) || pane2.closest(OWN_UI) || pane2.contains(composer) || pane2.querySelector(TURN)) continue;
      const rect = pane2.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.right <= win.innerWidth / 2) continue;
      return { pane: pane2, container: pane2, left: rect.left, outputs: null };
    }
    return null;
  }
  var chatgptAdapter = {
    turns: (root) => [...scope(root).querySelectorAll(TURN)],
    role: (turn) => nonEmptyRole(turn, ROLE, "data-message-author-role") ?? (turn.querySelector("[data-user-message-bubble]") ? "user" : nonEmptyRole(turn, REPLY, "data-conversation-role")),
    blocks: (turnEls) => turnEls.flatMap((el2) => [...el2.querySelectorAll(BLOCKS)]),
    // Queue transport (live dispatcher): the editable composer input and its Send/Stop buttons.
    composerInput: (doc) => scope(doc).querySelector(COMPOSER),
    sendButton: (doc) => scope(doc).querySelector(SEND) ?? scope(doc).querySelector(COMPOSER)?.closest("form")?.querySelector(SEND_FALLBACK) ?? null,
    // Inside the composer form only: the queue card has its own Steer button, which must never be mistaken for it.
    steerButton: (doc) => scope(doc).querySelector(COMPOSER)?.closest("form")?.querySelector(STEER) ?? null,
    stopButton(doc) {
      const page = scope(doc);
      return page.querySelector(STOP) ?? page.querySelector(COMPOSER)?.closest("form")?.querySelector(STOP_FALLBACK) ?? null;
    },
    /**
     * A response is being produced: a Stop control is shown, the reply is still streaming, or the composer offers to steer it
     * (ChatGPT only offers Steer while a response runs, even where it hides Stop). A Send gesture then belongs to the queue.
     */
    generating(doc) {
      return this.stopButton(doc) !== null || this.steerButton(doc) !== null || scope(doc).querySelector(STREAMING) !== null;
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
    /** The active page element itself; it changes when ChatGPT switches to another mounted conversation page. */
    pageElement: (doc) => scope(doc),
    /**
     * The conversation the active page itself says it holds (ChatGPT stamps its composer wrapper with it), or null when it
     * declares none; `local-...` for a conversation started in this page. The URL changes before the page behind it does,
     * so a send is verified against both.
     */
    pageConversationId: (doc) => scope(doc).querySelector("[data-map-composer-conversation]")?.getAttribute("data-map-composer-conversation") || null,
    /**
     * The sidebar's conversation rows (the sidebar is outside the page element): `{ id, link, host }`, where `host` is the
     * element holding the row's title, which is where a marker goes.
     */
    sidebarLinks(doc) {
      const out = [];
      for (const link of doc.querySelectorAll('a[href*="/c/"]')) {
        const id = link.getAttribute("href")?.match(/^(?:\/g\/[^/]+)?\/c\/([\w-]+)/)?.[1];
        if (!id || link.closest(OWN_UI) || link.closest(TURN) || !link.closest("nav")) continue;
        const title = link.querySelector("[data-thread-title]");
        out.push({ id, link, host: title?.parentElement ?? link });
      }
      return out;
    },
    conversationId: (win) => win.location.pathname.match(/^(?:\/g\/[^/]+)?\/c\/([\w-]+)/)?.[1] ?? "new",
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
      if (!scope(doc).querySelector(TURN)) {
        const win = doc.defaultView;
        let node2 = composer;
        for (let up = node2.parentElement; up && up !== doc.body && up !== doc.documentElement; up = up.parentElement) {
          const width = up.getBoundingClientRect().width;
          if (width >= win.innerWidth - 40) break;
          if (width) node2 = up;
        }
        return node2;
      }
      const header = pageHeader(doc);
      let node = scroller;
      while (node && !(node.contains(composer) && (!header || node.contains(header)))) node = node.parentElement;
      return !node || node === doc.documentElement ? doc.body : node;
    },
    /**
     * Where the panels' room is measured and written: `frame` is the page column (its box is what the panels anchor
     * to) and gets the side padding, `header` is its page header (given opposite margins so it keeps the full width and
     * its buttons stay in the top-right corner) and, when the composer sits in an absolutely positioned overlay inside
     * the column (chatgpt.com does), that overlay is padded too, which padding on the column cannot move.
     */
    columns(doc) {
      const frame = this.column(doc);
      if (!frame) return null;
      const win = doc.defaultView;
      const pads = [frame];
      for (let el2 = this.composer(doc)?.parentElement; el2 && el2 !== frame; el2 = el2.parentElement) {
        if (frame.contains(el2) && ABSOLUTE.has(win.getComputedStyle(el2).position)) {
          pads.push(el2);
          break;
        }
      }
      const header = pageHeader(doc);
      const flows = header && frame.contains(header) && header !== frame && win.getComputedStyle(header).position !== "fixed";
      return { frame, pads, header: flows ? header : null };
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
      const candidates = [...page.querySelectorAll(HEADINGS)];
      for (const region2 of page.querySelectorAll(BUTTON_REGION)) if (!region2.matches(TURN) && !region2.closest(TURN)) candidates.push(...region2.querySelectorAll(BUTTONS));
      for (const region2 of page.querySelectorAll(SUMMARY_HINT)) if (!region2.matches(TURN) && !region2.closest(TURN)) candidates.push(...[...region2.querySelectorAll("*")].filter((el2) => !el2.firstElementChild));
      for (const title of new Set(candidates)) {
        const name = title.textContent.trim();
        if (name.length > 12 || !SUMMARY_TITLE.test(name) || title.closest(TURN) || title.closest(ROLE) || title.closest(OWN_UI)) continue;
        const rect2 = title.getBoundingClientRect();
        if (!rect2.width || !rect2.height || rect2.right <= win.innerWidth / 2) continue;
        if (found.some((t) => t.contains(title))) continue;
        for (let i = found.length - 1; i >= 0; i--) if (title.contains(found[i])) found.splice(i, 1);
        found.push(title);
      }
      const outputs = found.find((t) => /^outputs?$/i.test(t.textContent.trim())) ?? null;
      if (!found.length) return hintedPane(page, win, this.composer(doc));
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
    /**
     * Where the panel buttons go in the page header's button area: just before the right-most header button, as
     * `{ parent, before }`; null when there is no header or no button in it (the buttons then float top-right).
     */
    headerActions(doc) {
      const header = pageHeader(doc);
      if (!header) return null;
      const win = doc.defaultView;
      let best = null;
      for (const b of header.querySelectorAll("button,a[href]")) {
        if (b.closest(OWN_UI)) continue;
        const r = b.getBoundingClientRect();
        if (r.width && r.right > win.innerWidth / 2 && (!best || r.right > best.right)) best = { el: b, right: r.right };
      }
      if (!best) return null;
      let before = best.el;
      while (before.parentElement && before.parentElement !== header && nativeChildren(before.parentElement) === 1) before = before.parentElement;
      return { parent: before.parentElement, before, right: best.right };
    },
    /**
     * Whether ChatGPT's own summary pane (Activity / Outputs / Sources) is open, wherever it renders: the header toggle says
     * so, or a pane carrying its markup hint has a box (it is a popover outside the page when the page is narrow).
     */
    summaryOpen(doc) {
      if (scope(doc).querySelector(SUMMARY_TOGGLE)?.getAttribute("aria-pressed") === "true") return true;
      for (const el2 of doc.querySelectorAll(SUMMARY_HINT)) if (!el2.closest(OWN_UI) && !el2.closest(TURN) && el2.getBoundingClientRect().width) return true;
      return false;
    },
    /**
     * ChatGPT's own summary pane wherever it renders, with its box: `{ el, left, right, inPage }`, or null. In a wide page it
     * is part of the page (`inPage`); in a narrow one ChatGPT shows it as a popover outside the page.
     */
    summaryCard(doc) {
      const page = scope(doc);
      for (const el2 of doc.querySelectorAll(SUMMARY_HINT)) {
        if (el2.closest(OWN_UI) || el2.closest(TURN)) continue;
        const r = el2.getBoundingClientRect();
        if (r.width) return { el: el2, left: r.left, right: r.right, inPage: page.contains(el2) };
      }
      return null;
    },
    /**
     * Any other pane docked or floating over the right edge of the page (a Subagents or canvas view, say), found by
     * what is really painted there rather than by its title: the widest element on the right edge that is neither
     * the conversation nor the composer nor ours. `{ pane, container, left, outputs: null }` like `nativeSummary`, or null.
     */
    sidePane(doc) {
      const win = doc.defaultView;
      const W = win.innerWidth;
      const H = win.innerHeight;
      if (!doc.elementFromPoint) return null;
      const composer = this.composer(doc);
      let best = null;
      for (const y of [Math.max(24, this.headerBottom(doc) + 16), H * 0.3, H * 0.55, H * 0.8]) {
        let hit = doc.elementFromPoint(W - 16, y);
        if (!hit || hit.closest(OWN_UI)) continue;
        for (let el2 = hit; el2 && el2 !== doc.body && el2 !== doc.documentElement; el2 = el2.parentElement) {
          const r = el2.getBoundingClientRect();
          if (r.width > W * 0.6) break;
          if (r.right < W - 24) continue;
          if (el2.matches(TURN) || el2.closest(TURN) || composer && el2.contains(composer) || el2.querySelector(TURN) || el2.querySelector(OWN_UI)) break;
          if (r.width >= 200 && r.height >= H * 0.25 && (!best || r.left < best.left)) best = { pane: el2, left: r.left };
        }
      }
      return best && { pane: best.pane, container: best.pane, left: best.left, outputs: null };
    },
    /**
     * ChatGPT's collapsed thinking traces in the active page: the disclosure buttons of assistant turns ("Thought for 12s",
     * "Worked for 1m 5s", "Stopped thinking"), as `{ button, turn, key }` where `key` names the trace within its turn.
     * Buttons outside a turn (the model picker's "Thinking effort", say) never count.
     */
    thinkingToggles(doc) {
      const out = [];
      scope(doc).querySelectorAll(TURN).forEach((turn, turnIndex) => {
        let nth = 0;
        for (const button2 of turn.querySelectorAll("button[aria-expanded]")) {
          if (button2.closest(OWN_UI) || !THINKING_TITLE.test((button2.textContent ?? "").trim())) continue;
          out.push({ button: button2, turn, key: `${this.turnId(turn, turnIndex)}#${nth++}` });
        }
      });
      return out;
    },
    /** Bottom edge of the page header (0 without one): the fallback pane docks below it. */
    headerBottom(doc) {
      return pageHeader(doc)?.getBoundingClientRect().bottom ?? 0;
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

  // src/core/worker-timer.js
  var SOURCE = `
const live = new Map();
onmessage = (e) => {
  const m = e.data;
  if (m.op === "clear") {
    clearTimeout(live.get(m.id));
    live.delete(m.id);
  } else if (m.op === "once") {
    live.set(m.id, setTimeout(() => { live.delete(m.id); postMessage(m.id); }, m.ms));
  } else if (m.op === "every") {
    live.set(m.id, setInterval(() => postMessage(m.id), m.ms));
  }
};`;
  var IDLE_RELEASE_MS = 2e3;
  function createWorkerTimers({ win, createWorker = blobWorker(win) }) {
    const doc = win.document;
    const entries = /* @__PURE__ */ new Map();
    let worker = null;
    let broken = false;
    let releaseTimer = null;
    let nextId = 0;
    const open = () => {
      if (worker || broken || !doc.hidden) return worker;
      try {
        worker = createWorker(SOURCE);
        if (!worker) throw new Error("no worker");
        worker.onmessage = (event) => {
          const entry = entries.get(event.data);
          if (!entry) return;
          if (!entry.repeat) entries.delete(event.data);
          entry.fn();
        };
        worker.onerror = () => fail();
      } catch {
        broken = true;
        close();
      }
      return worker;
    };
    const close = () => {
      worker?.terminate?.();
      worker = null;
    };
    function fail() {
      broken = true;
      close();
      for (const [id, entry] of entries) if (entry.handle === null) arm(id, entry, false);
    }
    function arm(id, entry, allowWorker) {
      const w = allowWorker ? open() : null;
      if (w) {
        entry.handle = null;
        w.postMessage({ op: entry.repeat ? "every" : "once", id, ms: entry.ms });
      } else if (entry.repeat) {
        entry.handle = win.setInterval(entry.fn, entry.ms);
      } else {
        entry.handle = win.setTimeout(() => {
          entries.delete(id);
          entry.fn();
        }, entry.ms);
      }
    }
    function add(fn, ms, repeat) {
      win.clearTimeout(releaseTimer);
      releaseTimer = null;
      const id = ++nextId;
      const entry = { fn, ms, repeat, handle: null };
      entries.set(id, entry);
      arm(id, entry, true);
      return () => {
        if (!entries.delete(id)) return;
        if (entry.handle !== null) (repeat ? win.clearInterval : win.clearTimeout).call(win, entry.handle);
        else worker?.postMessage({ op: "clear", id });
        if (!entries.size && worker && !releaseTimer) {
          releaseTimer = win.setTimeout(() => {
            releaseTimer = null;
            if (!entries.size) close();
          }, IDLE_RELEASE_MS);
        }
      };
    }
    return {
      /** Runs `fn` once after `ms`; returns the cancel function. */
      once: (fn, ms) => add(fn, ms, false),
      /** Runs `fn` every `ms` until cancelled. */
      every: (fn, ms) => add(fn, ms, true),
      /** True while a worker is carrying timers. */
      get working() {
        return worker !== null;
      },
      dispose() {
        for (const [, entry] of entries) {
          if (entry.handle !== null) (entry.repeat ? win.clearInterval : win.clearTimeout).call(win, entry.handle);
        }
        entries.clear();
        win.clearTimeout(releaseTimer);
        close();
      }
    };
  }
  function blobWorker(win) {
    return (source) => {
      if (typeof win.Worker !== "function" || typeof win.Blob !== "function" || typeof win.URL?.createObjectURL !== "function") return null;
      const url = win.URL.createObjectURL(new win.Blob([source], { type: "text/javascript" }));
      let made;
      try {
        made = new win.Worker(url);
      } catch (error) {
        win.URL.revokeObjectURL(url);
        throw error;
      }
      const terminate = made.terminate.bind(made);
      made.terminate = () => {
        terminate();
        win.URL.revokeObjectURL(url);
      };
      return made;
    };
  }

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
    async readiness(target, text) {
      try {
        return await this.#adapter.readiness(target, text);
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

  // src/chatgpt/queue/own-click.js
  var ownClick = { active: false };
  function clickAsOwn(click) {
    ownClick.active = true;
    try {
      click();
    } finally {
      ownClick.active = false;
    }
  }

  // src/chatgpt/queue/live-dispatcher.js
  var norm = (text) => text.replace(/\s+/g, " ").trim();
  function createLiveDispatcher({
    win,
    adapter,
    pollMs = 50,
    arriveMs = 1200,
    timers = { once: (fn, ms) => {
      const handle = win.setTimeout(fn, ms);
      return () => win.clearTimeout(handle);
    } },
    settleMs = 600,
    controlSettleMs = 450,
    sendWaitMs = 8e3,
    placeWaitMs = 1500,
    steerWaitMs = 600,
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
    const placeFailures = /* @__PURE__ */ new Map();
    const PLACE_FAILURES_BEFORE_HOLD = 3;
    const waitFor = (probe, ms) => new Promise((resolve) => {
      const started = Date.now();
      const poll = () => {
        const hit = probe();
        if (hit) return resolve(hit);
        if (Date.now() - started >= ms) return resolve(null);
        timers.once(poll, pollMs);
      };
      poll();
    });
    const generating = () => adapter.generating(doc);
    const onTarget = (target) => {
      if (adapter.conversationId(win) !== target.conversationId || adapter.accountId(doc) !== target.accountId) return false;
      const held = adapter.pageConversationId?.(doc);
      return held === null || held === void 0 || held === target.conversationId || held.startsWith("local-");
    };
    let arrival = null;
    const loaded = (target) => {
      const key = `${target.accountId}:${target.conversationId}`;
      if (adapter.turns(doc).length === 0) {
        arrival = null;
        return false;
      }
      const page = adapter.pageElement(doc);
      if (arrival?.key !== key || arrival.page !== page) arrival = { key, page, since: now() };
      return now() - arrival.since >= arriveMs;
    };
    const enabled = (button2) => button2 && !button2.disabled && button2.getAttribute("aria-disabled") !== "true" ? button2 : null;
    function notReady(target, { allowGenerating = false, text = null } = {}) {
      if (!onTarget(target)) {
        arrival = null;
        return { state: "waiting", reason: "other-conversation" };
      }
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
      if (!loaded(target)) return { state: "waiting", reason: "loading" };
      if (!allowGenerating) {
        if (generating()) {
          lastBusy = now();
          return { state: "waiting", reason: "generating" };
        }
        if (now() - lastBusy < settleMs) return { state: "waiting", reason: "settling" };
      }
      if (io.hasText(input) && !(text !== null && norm(io.read(input)) === norm(text))) return { state: "waiting", reason: "composer-has-draft" };
      return null;
    }
    const unstage = (text) => {
      const input = adapter.composerInput(doc);
      if (input && norm(io.read(input)) === norm(text)) io.write(input, "");
    };
    async function place(text) {
      const holds = () => {
        const input = adapter.composerInput(doc);
        return input !== null && norm(io.read(input)) === norm(text);
      };
      if (!holds()) {
        const input = adapter.composerInput(doc);
        if (!input || io.write(input, text) === false) return false;
      }
      let streak = 0;
      return Boolean(await waitFor(() => holds() ? ++streak >= 2 : (streak = 0, false), placeWaitMs));
    }
    async function stage(target, text, control, ms, { allowGenerating }) {
      const key = `${target.accountId}:${target.conversationId}`;
      if (!await place(text)) {
        unstage(text);
        const failures = (placeFailures.get(key) ?? 0) + 1;
        if (failures < PLACE_FAILURES_BEFORE_HOLD) {
          placeFailures.set(key, failures);
          return { failed: { kind: "wait", reason: "placing-text" } };
        }
        placeFailures.delete(key);
        return { failed: { kind: "rejected", code: "composer-fill-failed", message: "The text did not appear in the composer after several tries; nothing was sent.", action: "Check the composer, then press Retry, Steer or Interrupt & Send Next." } };
      }
      placeFailures.delete(key);
      let enabledSince = null;
      const button2 = await waitFor(() => {
        if (!onTarget(target)) return "left";
        if (!allowGenerating && generating()) return "busy";
        const found = enabled(control());
        if (!found) {
          enabledSince = null;
          return null;
        }
        enabledSince ??= Date.now();
        return Date.now() - enabledSince >= controlSettleMs ? found : null;
      }, ms + controlSettleMs);
      if (button2 === "left") {
        unstage(text);
        return { failed: { kind: "wait", reason: "other-conversation" } };
      }
      if (button2 === "busy") {
        unstage(text);
        return { failed: { kind: "wait", reason: "generating" } };
      }
      if (!button2) {
        unstage(text);
        return { missing: true };
      }
      return { button: button2 };
    }
    async function click(itemId, button2, turnsBefore, target, { steering = false } = {}) {
      if (!onTarget(target)) {
        return { kind: "wait", reason: "other-conversation" };
      }
      clicked.add(itemId);
      clickAsOwn(() => button2.click());
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
      async readiness(target, text = null) {
        return notReady(target, { text }) ?? { state: "ready" };
      },
      async submit({ itemId, accountId, conversationId, text, attachments }) {
        const target = { accountId, conversationId };
        if (clicked.has(itemId)) {
          return { kind: "uncertain", code: "already-attempted", message: "This message was already submitted from this page." };
        }
        if (attachments.length) return attachmentsRefused;
        const not = notReady(target, { text });
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
        const not = notReady(target, { allowGenerating: true, text });
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
  function selectDispatcher({ config: config2, win, adapter, timers }) {
    return config2.dryRun ? new DryRunDispatcher() : createLiveDispatcher({ win, adapter, timers });
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
      if (paused.get(conversationId) && merge.length) needsDecision ??= "legacy-paused";
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
    }
    return out;
  }
  function legacyError(code, lost, now) {
    if (code === "attachments-not-restorable") {
      return { code, message: `Cannot restore ${lost.map((a) => a.name).join(", ")}.`, action: "Reattach the files, then retry.", at: now };
    }
    if (code === "legacy-paused") {
      return { code, message: "This queue was paused before the queue was upgraded, so it is held.", action: "Press Retry to let it send.", at: now };
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
      return await request(this.#tx.objectStore("state").get(key)) ?? { key, editBy: null, editUntil: 0 };
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
    allPending() {
      return request(this.#tx.objectStore("pending").getAll());
    }
    allInflight() {
      return request(this.#tx.objectStore("inflight").getAll());
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
    /** Ids of this account's conversations that hold a queued or unresolved prompt, whatever page is on screen. */
    queuedConversations(accountId) {
      return this.#store.read(async (tx) => {
        const ids = /* @__PURE__ */ new Set();
        for (const record of [...await tx.allPending(), ...await tx.allInflight()]) {
          if ((record.accountId === accountId || record.accountId === LEGACY_ACCOUNT) && record.conversationId !== "new") ids.add(record.conversationId);
        }
        return ids;
      });
    }
    #viewOf(pending, inflight, state) {
      const editing = state.editBy !== null && state.editUntil > this.#clock.now();
      return { pending: pending ?? null, inflight: inflight ?? null, editing, editBy: editing ? state.editBy : null };
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
        const ready = await this.#dispatch.readiness(target, view.pending.text);
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
    /** Why nothing may be sent now, or null. `explicit` is a user action (Steer): it lifts a transient hold. */
    #gate(view, explicit) {
      const { pending, inflight } = view;
      if (inflight?.status === "manual-review") return { kind: "halted", itemId: inflight.id, status: "manual-review" };
      if (inflight) return { kind: "busy", itemId: inflight.id };
      if (!pending) return { kind: "idle" };
      if (pending.status !== "pending" && !(explicit && pending.lastError?.code !== "attachments-not-restorable")) {
        return { kind: "halted", itemId: pending.id, status: pending.status };
      }
      if (view.editing) return explicit ? { kind: "editing" } : { kind: "waiting", reason: "editing" };
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

  // src/chatgpt/queue/markers.js
  var MARK = "data-gs-queued";
  var STYLE_ID = "gs-queued-style";
  var CSS = `[${MARK}]{display:inline-flex;flex:none;align-items:center;margin-left:6px;opacity:.8}
[${MARK}] svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}`;
  var ICON = ["M4 20l4-1 11-11-3-3L5 16z", "M14 7l3 3"];
  function createQueueMarkers({ doc, adapter }) {
    const ns = "http://www.w3.org/2000/svg";
    const build = () => {
      const mark = doc.createElement("span");
      mark.setAttribute(MARK, "");
      mark.setAttribute("data-gs-ui", "");
      mark.setAttribute("role", "img");
      mark.setAttribute("aria-label", "A message is queued in this conversation");
      mark.title = "A message is queued in this conversation";
      const svg = doc.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      for (const d of ICON) {
        const path = doc.createElementNS(ns, "path");
        path.setAttribute("d", d);
        svg.append(path);
      }
      mark.append(svg);
      return mark;
    };
    return {
      /** Puts a marker on each listed conversation's row and takes it off every other row. */
      sync(queued) {
        if (queued.size && !doc.getElementById(STYLE_ID)) {
          const style = doc.createElement("style");
          style.id = STYLE_ID;
          style.textContent = CSS;
          doc.head.append(style);
        }
        const wanted = /* @__PURE__ */ new Map();
        for (const row of adapter.sidebarLinks(doc)) if (queued.has(row.id)) wanted.set(row.host, row);
        for (const mark of doc.querySelectorAll(`[${MARK}]`)) {
          if (!wanted.has(mark.parentElement)) mark.remove();
        }
        for (const [host] of wanted) if (!host.querySelector(`:scope > [${MARK}]`)) host.append(build());
      },
      dispose() {
        for (const mark of doc.querySelectorAll(`[${MARK}]`)) mark.remove();
        doc.getElementById(STYLE_ID)?.remove();
      }
    };
  }

  // src/chatgpt/queue/view.js
  var STYLE_ID2 = "gs-queue-style";
  var CSS2 = `
.gs-q{box-sizing:border-box;width:100%;max-width:100%;min-width:0;margin:0 0 8px;padding:10px 12px 6px;border-radius:var(--radius-2xl,16px);background:var(--color-surface-elevated-secondary,var(--main-surface-secondary,rgba(127,127,127,.1)));box-shadow:var(--elevation-prominent,0 0 0 1px rgba(127,127,127,.3));color:inherit;font:inherit;font-size:14px;line-height:1.4}
.gs-q[hidden]{display:none}
.gs-q *{box-sizing:border-box;min-width:0}
.gs-q svg{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.gs-q button{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:2px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.gs-q button:hover:not(:disabled){background:rgba(127,127,127,.18)}
.gs-q button:disabled{opacity:.4;cursor:not-allowed}
.gs-q button:focus-visible{outline:2px solid currentColor;outline-offset:1px}
.gs-q .gs-q-icon{width:24px;height:24px;padding:0;border-radius:999px}
.gs-q-text{max-height:9em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.gs-q-foot{display:flex;align-items:center;gap:2px;margin-top:4px}
.gs-q-status{opacity:.65;font-size:12px}
.gs-q-badge{margin-left:6px;padding:0 6px;border:1px solid currentColor;border-radius:999px;font-size:11px;opacity:.7}
.gs-q-spacer{flex:1 1 0}
.gs-q-actions{display:flex;gap:2px}
.gs-q-note{margin:0 0 6px;padding:4px 8px;border-radius:8px;border:1px solid rgba(127,127,127,.4);font-size:13px;overflow-wrap:anywhere}
.gs-q-note[role="alert"]{border-color:#b91c1c;color:#b91c1c}
.gs-q-inflight{margin:6px 0 0;display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center}
.gs-q-inflight button{border:1px solid rgba(127,127,127,.45)}
`;
  var ICONS = {
    steer: ["M5 12h14", "M13 6l6 6-6 6"],
    trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
    pencil: ["M4 20l4-1 11-11-3-3L5 16z", "M14 7l3 3"],
    check: ["M5 12l5 5 9-10"],
    close: ["M6 6l12 12", "M18 6L6 18"]
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
    "other-conversation": "Waiting for the conversation to open",
    loading: "Waiting for the conversation to load",
    "unknown-state": "Waiting for ChatGPT",
    "unresolved-conversation": "Open the conversation to send",
    editing: "Editing"
  };
  function statusOf(model) {
    if (model.edit) return "Editing";
    if (model.busy === "steering") return "Steering";
    if (model.inflight?.status === "sending") return "Sending";
    if (model.inflight?.status === "manual-review") return "Needs review";
    if (!model.pending) return null;
    if (model.pending.status === "blocked") return "Blocked";
    if (model.editingElsewhere) return "Being edited in another tab";
    return WAITING[model.waiting] ?? "Queued";
  }
  function actionBlocker(model) {
    if (model.busy) return "Working on it.";
    if (model.edit) return "Save or cancel the edit first.";
    if (!model.pending) return "Nothing is queued.";
    if (model.inflight) return model.inflight.status === "sending" ? "The previous message is still being sent." : "Resolve the message that needs review first.";
    if (model.pending.status !== "pending" && model.pending.lastError?.code === "attachments-not-restorable") return "Send without the files or delete the prompt first.";
    return null;
  }
  var iconButton = (doc, key, name, onClick, label, { disabled, title } = {}) => button(doc, key, icon(doc, name), onClick, { label, disabled, className: "gs-q-icon", title: title ?? label });
  function renderPanel(doc, root, model, on) {
    const { pending, inflight } = model;
    const visible = pending || inflight || model.error || model.note || model.edit;
    root.hidden = !visible;
    if (!visible) {
      root.replaceChildren();
      return;
    }
    const blocker = actionBlocker(model);
    const children = [];
    const message = model.error ?? pending?.lastError ?? inflight?.lastError ?? (model.note ? { message: model.note, action: "" } : null);
    if (message) {
      const alert = Boolean(model.error ?? pending?.lastError ?? inflight?.lastError);
      children.push(el(doc, "p", { class: "gs-q-note", role: alert ? "alert" : "status", "data-gs-note": message.code }, `${message.message ?? ""} ${message.action ?? ""}`.trim()));
    }
    if (pending) children.push(el(doc, "div", { class: "gs-q-text", "data-gs-key": "queued-text", "data-id": pending.id, "data-version": pending.version }, pending.text));
    const actions = [];
    if (model.edit) {
      actions.push(
        iconButton(doc, "head:save", "check", () => on.saveEdit(), "Save the edited prompt"),
        iconButton(doc, "head:cancel", "close", () => on.cancelEdit(), "Cancel the edit"),
        iconButton(doc, "head:delete", "trash", () => on.remove(), "Delete the queued prompt", { disabled: model.busy })
      );
    } else if (pending) {
      actions.push(
        iconButton(doc, "head:edit", "pencil", () => on.startEdit(), "Edit the queued prompt", { disabled: model.busy || model.editingElsewhere }),
        iconButton(doc, "head:delete", "trash", () => on.remove(), "Delete the queued prompt", { disabled: model.busy }),
        iconButton(doc, "head:steer", "steer", () => on.steer(), "Steer: send the queued prompt now", { disabled: blocker !== null, title: blocker ?? "Steer: send the queued prompt now" })
      );
    }
    const status = statusOf(model);
    if (pending || status) {
      children.push(
        el(doc, "div", { class: "gs-q-foot" }, [
          el(doc, "span", { class: "gs-q-status", role: "status", "aria-live": "polite" }, status),
          model.dryRun ? el(doc, "span", { class: "gs-q-badge", title: "Dry run: nothing is sent to ChatGPT" }, "Dry run") : null,
          el(doc, "span", { class: "gs-q-spacer" }),
          el(doc, "div", { class: "gs-q-actions", role: "group", "aria-label": "Queue actions" }, actions)
        ])
      );
    }
    if (inflight?.status === "manual-review") {
      children.push(
        el(doc, "div", { class: "gs-q-inflight" }, [
          button(doc, "inflight:delivered", "Mark delivered", () => on.markDelivered(), { label: "The message did reach ChatGPT" }),
          button(doc, "inflight:restore", "Restore to queue", () => on.restoreInflight(), { label: "The message did not reach ChatGPT; put it back in the queue" })
        ])
      );
    }
    if (pending?.status === "blocked") {
      const files = pending.lastError?.code === "attachments-not-restorable";
      children.push(
        el(doc, "div", { class: "gs-q-inflight" }, [
          files ? button(doc, "head:drop-files", "Send without files", () => on.unblock(true), { label: "Drop the files that cannot be restored and queue the text" }) : button(doc, "head:retry", "Retry", () => on.unblock(false), { label: "Try sending the queued prompt again" })
        ])
      );
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
    hiddenPollMs = pollMs,
    timers = createWorkerTimers({ win }),
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
      editingElsewhere: false,
      edit: null,
      // {target, input, baseVersion, baseText, draft}
      busy: null,
      waiting: null,
      error: null,
      note: null,
      dryRun: dispatcher.dryRun === true
    };
    let engine = null;
    let store = null;
    let channel = null;
    let disposed = false;
    let dispatching = false;
    let submitting = false;
    let timer = null;
    let hiddenTicker = null;
    let queuedIds = /* @__PURE__ */ new Set();
    let queuedStale = true;
    let lastGenerating = false;
    let ticks = 0;
    let reloadSeq = 0;
    let opSeq = 0;
    let dispatchChain = Promise.resolve();
    let actionChain = Promise.resolve();
    if (!doc.getElementById(STYLE_ID2)) {
      const style = doc.createElement("style");
      style.id = STYLE_ID2;
      style.textContent = CSS2;
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
      const { pending, inflight, editingElsewhere, edit, busy, waiting, error, note, dryRun } = model;
      const signature = JSON.stringify({ pending, inflight, editingElsewhere, editing: edit?.baseVersion ?? null, busy, waiting, error, note, dryRun });
      if (signature === painted && !focusKey) return;
      painted = signature;
      const active = doc.activeElement;
      const key = focusKey ?? (root.contains(active) ? active.getAttribute("data-gs-key") : null);
      renderPanel(doc, root, model, handlers);
      if (!key) return;
      const wanted = root.querySelector(`[data-gs-key="${CSS_ESCAPE(key)}"]`);
      (wanted && !wanted.disabled ? wanted : root.querySelector("button:not(:disabled)"))?.focus({ preventScroll: true });
    }
    const markers = createQueueMarkers({ doc, adapter });
    async function refreshQueued() {
      queuedStale = false;
      try {
        queuedIds = await engine.queuedConversations(target.accountId);
      } catch {
        queuedStale = true;
      }
    }
    const paintMarkers = () => markers.sync(queuedIds);
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
      model.editingElsewhere = view.editing && view.editBy !== tabId;
      if (!view.pending) model.waiting = null;
      if (!view.pending && !view.inflight && !model.edit) model.error = null;
      if (model.edit && !view.pending) endEditLocally("gone");
      await refreshQueued();
      paintMarkers();
      syncHidden();
      render();
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
      if (ownClick.active) return;
      const input = adapter.composerInput(doc);
      if (!input || !event.target?.contains?.(input) || !hijacking()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void submitComposer("submit");
    }
    function onClick(event) {
      if (ownClick.active || dispatching || !hijacking()) return;
      const hit = event.target?.closest?.("button");
      const input = adapter.composerInput(doc);
      if (!hit || !input || !hit.closest("form")?.contains(input)) return;
      if (hit !== adapter.sendButton(doc) && hit !== adapter.steerButton(doc)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void submitComposer("button");
    }
    win.addEventListener("keydown", onKeydown, true);
    win.addEventListener("submit", onSubmit, true);
    win.addEventListener("click", onClick, true);
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
      render("head:steer");
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
      steer: explicit("steering", (t) => engine.steer(t, { native: true }))
    };
    async function followNavigation() {
      const now = targetNow();
      if (now.accountId === target.accountId && now.conversationId === target.conversationId) return false;
      const previous = target;
      if (model.edit) endEditLocally("cancel");
      await engine.release(previous).catch(() => void 0);
      target = now;
      Object.assign(model, { pending: null, inflight: null, editingElsewhere: false, waiting: null, error: null, note: null });
      await engine.adoptLegacy(now).catch(() => 0);
      ticks = RELOAD_EVERY;
      return true;
    }
    function tick() {
      return dispatch(async () => {
        if (!engine || model.busy) return;
        await followNavigation();
        paintMarkers();
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
    let waking = false;
    let again = false;
    function wake() {
      if (disposed || !engine) return;
      if (waking) {
        again = true;
        return;
      }
      waking = true;
      void tick().finally(() => {
        waking = false;
        if (again) {
          again = false;
          wake();
        }
      });
    }
    const hub = createObserverHub({ max: 1, MutationObserverCtor: win.MutationObserver, schedule: (fn) => Promise.resolve().then(fn) });
    let unobserve = null;
    function syncHidden() {
      const want = doc.hidden === true && Boolean(model.pending || model.inflight) && !disposed;
      if (want && !hiddenTicker && hiddenPollMs > 0) hiddenTicker = timers.every(wake, hiddenPollMs);
      else if (!want && hiddenTicker) hiddenTicker(), hiddenTicker = null;
      if (want && !unobserve && doc.body) {
        lastGenerating = adapter.generating(doc);
        unobserve = hub.subscribe(doc.body, () => {
          const now = adapter.generating(doc);
          if (lastGenerating && !now) wake();
          lastGenerating = now;
        }, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "disabled", "data-is-streaming"] });
      } else if (!want && unobserve) unobserve(), unobserve = null;
    }
    const onVisibility = () => {
      syncHidden();
      if (doc.hidden !== true) wake();
    };
    doc.addEventListener("visibilitychange", onVisibility);
    win.addEventListener("focus", wake);
    win.addEventListener("pageshow", wake);
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
            if (event.data?.from === tabId) return;
            if (event.data?.key === `${target.accountId}:${target.conversationId}`) void act(reload);
            else void act(async () => (await refreshQueued(), paintMarkers()));
          };
        }
      } catch {
        channel = null;
      }
      await engine.adoptLegacy(target).catch(() => 0);
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
      /** Runs the background pass now (coalesced); called on route changes, focus and visibility changes. */
      wake,
      /** Resolves when every queued UI action and dispatch pass has finished. */
      settled: () => Promise.all([actionChain, dispatchChain]).then(() => void 0),
      dispose() {
        disposed = true;
        if (timer) win.clearInterval(timer);
        hiddenTicker?.();
        unobserve?.();
        hub.disposeAll();
        doc.removeEventListener("visibilitychange", onVisibility);
        win.removeEventListener("focus", wake);
        win.removeEventListener("pageshow", wake);
        markers.dispose();
        timers.dispose();
        for (const [name, fn] of [["keydown", onKeydown], ["submit", onSubmit], ["click", onClick], ["pagehide", onPageHide]]) {
          win.removeEventListener(name, fn, name === "pagehide" ? void 0 : true);
        }
        if (model.edit) endEditLocally("cancel");
        channel?.close();
        root.remove();
        doc.getElementById(STYLE_ID2)?.remove();
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
      else shared.wake?.();
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

  // src/chatgpt/thinking.js
  var THINKING_DEFAULTS = Object.freeze({
    debounceMs: 120,
    // after the last scroll or page change
    maxPerPass: 8
  });
  function createThinkingExpander({ win, adapter, runtime, diagnostics, options = {} }) {
    const doc = win.document;
    const opts = { ...THINKING_DEFAULTS, ...options };
    const done = /* @__PURE__ */ new Set();
    let timer = null;
    let disposed = false;
    function viewport() {
      const r = adapter.scroller(doc).getBoundingClientRect();
      return { top: Math.max(r.top, 0), bottom: Math.min(r.bottom, win.innerHeight || Infinity) };
    }
    function pass() {
      timer = null;
      if (disposed) return;
      const view = viewport();
      const due = [];
      for (const { button: button2, turn, key } of adapter.thinkingToggles(doc)) {
        if (done.has(key) || button2.getAttribute("aria-expanded") !== "false" || !runtime.isTurnActive(turn)) continue;
        const r = button2.getBoundingClientRect();
        if (!r.height || r.bottom <= view.top || r.top >= view.bottom) continue;
        due.push({ button: button2, key, top: r.top });
      }
      due.sort((a, b) => b.top - a.top);
      for (const { button: button2, key } of due.slice(0, opts.maxPerPass)) {
        done.add(key);
        button2.click();
        diagnostics?.count("thinking.expanded");
      }
      if (due.length > opts.maxPerPass) schedule();
    }
    function schedule() {
      if (timer !== null || disposed) return;
      timer = win.setTimeout(pass, opts.debounceMs);
    }
    const stops = [runtime.onIndexChange?.(schedule), runtime.scroll?.onScroll?.(schedule)].filter((fn) => typeof fn === "function");
    schedule();
    return {
      dispose() {
        disposed = true;
        if (timer !== null) win.clearTimeout(timer);
        for (const stop of stops) stop();
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
  var PANEL_WIDTH = 300;
  var PANEL_GAP = 12;
  var DOCK_MIN_VIEWPORT = 1024;
  var MIN_CONTENT = 560;
  var LAYOUT_CSS = `
[data-gs-column][data-gs-right]{box-sizing:border-box;padding-right:var(--gs-reserve,0px)}
[data-gs-header]{margin-right:calc(-1 * var(--gs-reserve,0px))}
`;
  function createRailLayout({ win, adapter, target }) {
    const doc = win.document;
    let written = [];
    let known = null;
    let applied = 0;
    let anchor = win.innerWidth;
    let epoch = 0;
    const findColumns = () => {
      if (!known || !known.frame.isConnected || known.pads.some((el2) => !el2.isConnected) || known.header && !known.header.isConnected) {
        known = adapter.columns(doc);
        epoch++;
      }
      return known;
    };
    function release(el2) {
      for (const a of ["data-gs-column", "data-gs-right"]) el2.removeAttribute(a);
      el2.style.removeProperty("--gs-reserve");
      if (!el2.getAttribute("style")) el2.removeAttribute("style");
    }
    function setReserve(cols, right) {
      if (written.some((el2) => !cols.includes(el2))) clear();
      written = cols;
      const header = findColumns()?.header;
      if (header) {
        if (right > 0) {
          if (header.getAttribute("data-gs-header") === null) header.setAttribute("data-gs-header", "");
        } else if (header.hasAttribute("data-gs-header")) header.removeAttribute("data-gs-header");
      }
      const r = Math.max(0, Math.round(right));
      for (const col of cols) {
        if (r > 0) {
          if (col.getAttribute("data-gs-column") === null) col.setAttribute("data-gs-column", "");
          if (col.getAttribute("data-gs-right") === null) col.setAttribute("data-gs-right", "");
          if (col.style.getPropertyValue("--gs-reserve") !== `${r}px`) col.style.setProperty("--gs-reserve", `${r}px`);
        } else if (col.hasAttribute("data-gs-column") || col.hasAttribute("data-gs-right")) release(col);
      }
      applied = r;
    }
    function clear() {
      const header = known?.header;
      if (header?.hasAttribute("data-gs-header")) header.removeAttribute("data-gs-header");
      for (const el2 of written) release(el2);
      written = [];
      applied = 0;
    }
    function signature() {
      const cols = findColumns();
      if (!cols) return "none";
      const r = cols.frame.getBoundingClientRect();
      return `${win.innerWidth}|${Math.round(r.left)}|${Math.round(r.right)}|${cols.pads.length}|${epoch}`;
    }
    const natural = (col) => {
      const r = col.getBoundingClientRect();
      return { left: r.left, right: r.right };
    };
    function evaluate({ right = 0, force = false } = {}) {
      const cols = findColumns();
      const el2 = target() ?? adapter.composer(doc);
      if (!cols || !el2 || win.innerWidth < DOCK_MIN_VIEWPORT) {
        if (cols) setReserve(cols.pads, 0);
        else clear();
        anchor = win.innerWidth;
        return { docked: false, right: 0 };
      }
      setReserve(cols.pads, 0);
      const col = natural(cols.frame);
      anchor = col.right;
      const need = right > 0 ? right + 2 * PANEL_GAP : 0;
      const span = () => {
        const c = adapter.composer(doc)?.getBoundingClientRect();
        const t = el2.getBoundingClientRect();
        return { left: c ? Math.min(t.left, c.left) : t.left, right: c ? Math.max(t.right, c.right) : t.right };
      };
      const over = Math.max(0, span().right - (col.right - need));
      if (over > 0.5 || force && need > 0) {
        setReserve(cols.pads.slice(0, 1), need);
        const centered = () => {
          const c = adapter.composer(doc)?.getBoundingClientRect();
          const t = target()?.getBoundingClientRect();
          return c && t ? Math.abs((c.left + c.right) / 2 - (t.left + t.right) / 2) : 0;
        };
        if (cols.pads.length > 1 && centered() > 2) {
          const first = centered();
          setReserve(cols.pads, need);
          if (centered() > first) setReserve(cols.pads.slice(0, 1), need);
        }
      }
      const s = span();
      const fits = Math.max(0, s.right - (col.right - need)) <= 0.5 && s.right - s.left >= MIN_CONTENT;
      if (!fits) {
        setReserve(cols.pads, 0);
        anchor = win.innerWidth;
        return { docked: false, right: 0 };
      }
      return { docked: true, right: applied };
    }
    function edge() {
      return anchor;
    }
    return { evaluate, signature, edge, reserve: () => applied, dispose: clear };
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
  function jsonStore(storage, key) {
    return {
      read() {
        try {
          const data = JSON.parse(storage?.getItem(key) ?? "{}");
          return data && typeof data === "object" && !Array.isArray(data) ? data : {};
        } catch {
          return {};
        }
      },
      write(data) {
        try {
          storage?.setItem(key, JSON.stringify(data));
        } catch {
        }
      }
    };
  }
  function createPanePrefs(storage, { max = 50, key = "gs.pane.prefs" } = {}) {
    const json = jsonStore(storage, key);
    return {
      get(id) {
        const p = id === NEW_CHAT ? null : json.read()[id];
        return p && typeof p === "object" ? { outputs: !!p.outputs } : null;
      },
      set(id, prefs) {
        if (id === NEW_CHAT) return;
        const data = json.read();
        delete data[id];
        data[id] = { outputs: !!prefs.outputs };
        for (const old of Object.keys(data).slice(0, Math.max(0, Object.keys(data).length - max))) delete data[old];
        json.write(data);
      }
    };
  }
  function createPanelPrefs(storage, { key = "gs.pane.layout" } = {}) {
    const json = jsonStore(storage, key);
    return {
      get() {
        return json.read().shown !== false;
      },
      set(shown) {
        json.write({ shown: !!shown });
      }
    };
  }

  // src/chatgpt/rail/rail.js
  var STYLE_ID3 = "gs-pane-style";
  var SURFACE = "var(--color-surface-elevated-secondary,Canvas)";
  var PAGE = "var(--color-surface,Canvas)";
  var TEXT = "var(--color-text,CanvasText)";
  var LINE = "var(--color-border,color-mix(in srgb,currentColor 14%,transparent))";
  var HOVER = "var(--color-token-interactive-bg-secondary-hover,color-mix(in srgb,currentColor 8%,transparent))";
  var SELECTED = "var(--color-token-interactive-bg-secondary-selected,color-mix(in srgb,currentColor 12%,transparent))";
  var CODE = "var(--color-token-text-code-block-background,color-mix(in srgb,currentColor 12%,transparent))";
  var BUBBLE = "var(--color-token-interactive-bg-secondary-selected,color-mix(in srgb,currentColor 10%,transparent))";
  var INK = "color-mix(in srgb,currentColor 38%,transparent)";
  var INK_FAINT = "color-mix(in srgb,currentColor 22%,transparent)";
  var ACCENT = "var(--color-token-focus-border,AccentColor)";
  var MUTED = "var(--color-text-secondary,color-mix(in srgb,currentColor 65%,transparent))";
  var RING = "var(--elevation-prominent,0 0 0 .5px color-mix(in srgb,currentColor 20%,transparent))";
  var FOCUS = "outline:2px solid var(--color-border-strong,currentColor);outline-offset:-2px";
  var CHEVRON = '<svg class="gs-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  var PANELS_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4"/></svg>';
  var CSS3 = `
.gs-rail{position:fixed;z-index:30;top:var(--gs-top,60px);right:var(--gs-right,12px);bottom:var(--gs-bottom,16px);display:flex;flex-direction:column;gap:12px;width:min(${PANEL_WIDTH}px,calc(100vw - 16px));box-sizing:border-box;pointer-events:none}
.gs-rail[hidden]{display:none}
.gs-panel{display:flex;flex:0 1 auto;flex-direction:column;min-height:0;box-sizing:border-box;border-radius:var(--radius-2xl,16px);background:${SURFACE};box-shadow:${RING};color:${TEXT};font:inherit;font-size:14px;line-height:20px;overflow:hidden;pointer-events:auto}
.gs-panel[hidden]{display:none}
.gs-panel *,.gs-hbtns *{box-sizing:border-box}
.gs-panel-map{max-height:55%}
.gs-panel-prompts{margin-top:auto}
.gs-panel-head{display:flex;flex:0 0 auto;align-items:center;min-height:44px;padding:8px 16px;color:${MUTED}}
.gs-panel-body{display:flex;flex:1 1 auto;flex-direction:column;min-height:0;padding:0 16px 12px}
.gs-hbtns{display:inline-flex;align-items:center;margin:0 4px;pointer-events:auto}
.gs-hbtns[hidden]{display:none}
.gs-hbtns[data-gs-float]{position:fixed;top:8px;right:var(--gs-float-right,8px);z-index:41;margin:0}
.gs-hbtn{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:36px;height:36px;padding:0;border:0;border-radius:8px;background:transparent;color:${MUTED};cursor:pointer;pointer-events:auto}
.gs-hbtn[aria-pressed="true"]{color:${TEXT};background:${SELECTED}}
.gs-hbtn:hover,.gs-outputs-toggle:hover{background:${HOVER}}
.gs-chevron{flex:0 0 auto;transition:transform .15s}
[data-gs-outputs][data-gs-collapsed="true"] .gs-chevron{transform:rotate(-90deg)}
.gs-minimap{position:relative;display:flex;justify-content:center;align-items:flex-start;flex:0 0 auto;min-height:56px;padding:8px;border:1px solid ${LINE};border-radius:12px;background:${PAGE};cursor:pointer;touch-action:none;overflow:hidden}
.gs-frame{position:relative;flex:0 0 auto;width:72%;height:120px;overflow:hidden;border:1px solid ${INK};border-radius:4px;background:${PAGE}}
.gs-minimap:focus-visible,.gs-search input:focus-visible,.gs-prompt:focus-visible,.gs-hbtn:focus-visible,.gs-outputs-toggle:focus-visible{${FOCUS}}
.gs-scene{position:absolute;top:0;left:0;right:0;height:100%}
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
.gs-outputs-toggle{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:28px;height:28px;margin-left:auto;padding:0;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}
[data-gs-outputs][data-gs-collapsed="true"]>:not([data-gs-outputs-head]){display:none}
${LAYOUT_CSS}`;
  function describePrompt(text, reply = "") {
    const clean2 = text.replace(/\s+/g, " ").trim();
    const m = clean2.match(/^(.{1,60}?)(?:[.?!:]\s+|$)/);
    const title = (m ? m[1] : clean2.slice(0, 60)).trim() || clean2.slice(0, 60);
    const rest = clean2.slice(title.length).replace(/^[.?!:\s]+/, "");
    const preview = (rest || reply.replace(/\s+/g, " ").trim()).slice(0, 100);
    return { title, preview };
  }
  var clamp2 = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  var PREVIEW_MAX = 100;
  var OPEN_SETTLE_MS = 500;
  var OPEN_FOLLOW_MS = 1500;
  var SCAN_MS = 400;
  var BLOCK_CAP = 800;
  var CONTENT_W = 768;
  var FRAME_SHARE = 0.72;
  var PAPER = 11 / 8.5;
  var MAP_PAD = 18;
  var MAP_CHROME = 120;
  var PANE_SETTLE_MS = 450;
  var FLOAT_BOTTOM = 44;
  var MAP_W = 244;
  function createRail({ win, adapter, runtime, store = createRailStateStore(), prefs = createPanePrefs(win.localStorage), layoutPrefs = createPanelPrefs(win.localStorage), paneSettleMs = PANE_SETTLE_MS }) {
    const doc = win.document;
    const scroll = runtime.scroll;
    const scroller = scroll.element ?? adapter.scroller(doc);
    const convId = adapter.conversationId(win);
    let els = [];
    let prompts = [];
    let signature = null;
    let query = "";
    let activeId = null;
    let docked = true;
    let drawer = false;
    let shown = layoutPrefs.get();
    let hasMap = false;
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
    let geom = { sceneH: 1, frameH: 1 };
    let mapOffset = 0;
    let bookmarkToRestore = null;
    let listTopToRestore = null;
    let outputsCollapsed = false;
    let opening = convId === "new" ? "done" : "waiting";
    let openSig = null;
    let openStalled = false;
    let openGen = 0;
    let interacted = false;
    let lastHost = null;
    let lastPaneOpen = false;
    let paneYield = false;
    let settleTimer = null;
    let scannedAt = -Infinity;
    let scanTimer = null;
    let outputsHost = null;
    const described = /* @__PURE__ */ new Map();
    const style = doc.createElement("style");
    style.id = STYLE_ID3;
    style.textContent = CSS3;
    doc.head.appendChild(style);
    const panel = (name, label, inner) => {
      const el2 = doc.createElement("section");
      el2.className = `gs-panel gs-panel-${name === "minimap" ? "map" : "prompts"}`;
      el2.dataset.gsUi = "";
      el2.dataset.gsPanel = name;
      el2.setAttribute("aria-label", label);
      el2.innerHTML = `<div class="gs-panel-head"><span class="gs-panel-title">${label}</span></div><div class="gs-panel-body">${inner}</div>`;
      return el2;
    };
    const mapPanel = panel(
      "minimap",
      "Conversation view",
      `<div class="gs-minimap" tabindex="0" role="slider" aria-orientation="vertical" aria-label="Current turn overview" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="gs-frame"><div class="gs-scene"><div class="gs-bars"></div><div class="gs-view" hidden></div></div></div></div><div class="gs-caption" aria-live="off">Drag to navigate \u2022 0% visible</div>`
    );
    const promptsPanel = panel(
      "prompts",
      "Prompts",
      `<div class="gs-search"><div class="gs-search-field"><input type="search" placeholder="Filter prompts..." aria-label="Filter prompts"></div></div><ol class="gs-prompts" aria-label="Prompts, oldest first"></ol>`
    );
    mapPanel.hidden = true;
    const column = doc.createElement("div");
    column.className = "gs-rail";
    column.dataset.gsUi = "";
    column.append(mapPanel, promptsPanel);
    const root = { querySelector: (sel) => mapPanel.querySelector(sel) ?? promptsPanel.querySelector(sel), contains: (n) => column.contains(n) };
    const actions = doc.createElement("span");
    actions.className = "gs-hbtns";
    actions.dataset.gsUi = "";
    const button2 = doc.createElement("button");
    button2.type = "button";
    button2.className = "gs-hbtn";
    button2.dataset.gsUi = "";
    button2.setAttribute("aria-label", "Conversation view");
    button2.title = "Show or hide the conversation view and prompts";
    button2.setAttribute("aria-pressed", "false");
    button2.innerHTML = PANELS_ICON;
    actions.append(button2);
    doc.body.append(column);
    const outputsBtn = doc.createElement("button");
    outputsBtn.type = "button";
    outputsBtn.className = "gs-outputs-toggle";
    outputsBtn.dataset.gsUi = "";
    outputsBtn.setAttribute("aria-label", "Outputs");
    outputsBtn.innerHTML = CHEVRON;
    const $ = (sel) => root.querySelector(sel);
    const minimap = $(".gs-minimap");
    const frame = $(".gs-frame");
    const scene = $(".gs-scene");
    const bars = $(".gs-bars");
    const view = $(".gs-view");
    const caption = $(".gs-caption");
    const input = $(".gs-search input");
    const list = $(".gs-prompts");
    const railLayout = createRailLayout({ win, adapter, target: () => els[0] });
    const cleanups = [];
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      cleanups.push(() => target.removeEventListener(type, fn, opts));
    };
    const savePrefs = () => prefs.set(convId, { outputs: outputsCollapsed });
    const stored = prefs.get(convId);
    if (stored) outputsCollapsed = stored.outputs;
    if (restore) {
      outputsCollapsed = restore.ui.outputsCollapsed ?? outputsCollapsed;
      query = restore.ui.query;
      input.value = query;
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
        ui: { query, outputsCollapsed },
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
    function openTick() {
      if (opening === "done" || disposed) return;
      if (didRestore || userScrolled || interacted) return stopOpening();
      const last = prompts.at(-1);
      if (restore || !last) return;
      const sig = `${last.id}:${prompts.length}`;
      if (sig !== openSig || openStalled) {
        const el2 = els[last.turnIndex];
        if (sig === openSig && !(el2 && runtime.isTurnActive(el2) && el2.getBoundingClientRect().height)) return;
        openSig = sig;
        openStalled = false;
        armOpen("select", OPEN_SETTLE_MS);
      }
    }
    function stopOpening() {
      opening = "done";
      openGen++;
    }
    function armOpen(step, ms) {
      const gen = ++openGen;
      win.setTimeout(() => {
        if (gen !== openGen || disposed || opening === "done") return;
        if (didRestore || userScrolled || interacted) return stopOpening();
        if (step === "finish") return stopOpening();
        const last = prompts.at(-1);
        const el2 = last && els[last.turnIndex];
        if (!el2 || !runtime.isTurnActive(el2) || !el2.getBoundingClientRect().height) {
          openStalled = true;
          return;
        }
        if (!scroll.mayOpen()) return stopOpening();
        opening = "following";
        select(last, true);
        armOpen("finish", OPEN_FOLLOW_MS);
      }, ms);
    }
    function setVar(name, value) {
      if (column.style.getPropertyValue(name) !== value) column.style.setProperty(name, value);
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
    const open = () => els.length > 0 && (docked && shown || drawer);
    function applyVisibility() {
      const on2 = open();
      if (actions.hidden === els.length > 0) actions.hidden = els.length === 0;
      if (column.hidden === on2) column.hidden = !on2;
      const mapOn = on2 && hasMap;
      if (mapPanel.hidden === mapOn) mapPanel.hidden = !mapOn;
      const pressed = String(on2);
      if (button2.getAttribute("aria-pressed") !== pressed) button2.setAttribute("aria-pressed", pressed);
      const drawerMode = String(!docked);
      if (column.dataset.gsDrawer !== drawerMode) column.dataset.gsDrawer = drawerMode;
      if (mapOn) {
        modelKey = "";
        schedule();
      }
    }
    function placeButton(pane2) {
      const spot = adapter.headerActions(doc);
      const box = pane2?.isConnected ? pane2.getBoundingClientRect() : null;
      const covered = !!spot && !!box?.width && spot.right > box.left + 1 && box.top < adapter.headerBottom(doc) - 1;
      const floating = !spot || covered;
      if (!floating) {
        if (actions.parentElement !== spot.parent || actions.nextElementSibling !== spot.before) spot.parent.insertBefore(actions, spot.before);
        if (actions.hasAttribute("data-gs-float")) actions.removeAttribute("data-gs-float");
      } else {
        if (actions.parentElement !== doc.body) doc.body.append(actions);
        if (!actions.hasAttribute("data-gs-float")) actions.setAttribute("data-gs-float", "");
      }
      const right = `${box?.width && floating ? Math.max(8, Math.round(win.innerWidth - box.left) + 8) : 8}px`;
      if (actions.style.getPropertyValue("--gs-float-right") !== right) actions.style.setProperty("--gs-float-right", right);
      return floating;
    }
    function remount() {
      if (!style.isConnected) doc.head.appendChild(style);
      if (!column.isConnected) {
        doc.body.append(column);
        layoutSig = null;
      }
    }
    function toggle() {
      if (docked) {
        shown = !shown;
        layoutPrefs.set(shown);
      } else {
        drawer = !drawer;
      }
      layoutSig = null;
      layout(true);
    }
    function layout(rescan = false, settled = false) {
      remount();
      let host = lastHost;
      if (!host || !host.pane.isConnected || !host.container.isConnected || host.outputs && !(host.outputs.section.isConnected && host.outputs.head.isConnected) || !host.pane.getBoundingClientRect().width) {
        const t = win.performance.now();
        if (rescan || t - scannedAt >= SCAN_MS) {
          host = adapter.nativeSummary(doc) ?? adapter.sidePane(doc);
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
      syncOutputs(host);
      const floating = placeButton(host?.pane);
      const top = Math.max(Math.round(adapter.headerBottom(doc)), floating ? FLOAT_BOTTOM : 0) + 8;
      const card = adapter.summaryCard(doc);
      const paneOpen = !!host || !!card || adapter.summaryOpen(doc);
      if (!paneOpen) paneYield = false;
      else if (card && !card.inPage && !host) paneYield = true;
      const conversation = els.length > 0;
      if (paneOpen !== lastPaneOpen) {
        lastPaneOpen = paneOpen;
        if (settleTimer) win.clearTimeout(settleTimer);
        settleTimer = win.setTimeout(() => {
          settleTimer = null;
          layoutSig = null;
          if (!disposed) layout(true, true);
        }, paneSettleMs);
      }
      const key = `${railLayout.signature()}|${shown}|${top}|${paneOpen}|${paneYield}|${conversation}`;
      if (key !== layoutSig) {
        const room = shown && conversation && !paneYield;
        const r = railLayout.evaluate({ right: room ? PANEL_WIDTH : 0, force: room && !!host });
        docked = room ? r.docked : !(shown && conversation);
        if (docked) drawer = false;
        layoutSig = key;
        setVar("--gs-top", `${top}px`);
        setVar("--gs-right", `${docked ? Math.max(PANEL_GAP, Math.round(win.innerWidth - railLayout.edge()) + PANEL_GAP) : 8}px`);
        applyVisibility();
      }
      if (settled && paneOpen && docked && shown && conversation) {
        const box = host ? host.pane.getBoundingClientRect() : card;
        const paneLeft = box?.left;
        const paneRight = box?.right ?? Infinity;
        const columnLeft = railLayout.edge() - PANEL_GAP - PANEL_WIDTH;
        const t = els[0]?.getBoundingClientRect();
        const c = adapter.composer(doc)?.getBoundingClientRect();
        const contentRight = Math.max(t?.right ?? 0, c?.right ?? 0);
        if (paneLeft != null && (contentRight > paneLeft - 4 || paneRight > columnLeft)) {
          paneYield = true;
          layoutSig = null;
          scheduleLayout(true);
        }
      }
      const rect = adapter.composer(doc)?.getBoundingClientRect();
      const clear = rect?.height ? `${Math.max(16, Math.round(win.innerHeight - rect.top + 8))}px` : "96px";
      setVar("--gs-bottom", docked ? "16px" : clear);
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
      const shown2 = searchPrompts(prompts, query);
      list.textContent = "";
      if (!shown2.length) {
        const li = doc.createElement("li");
        li.className = "gs-empty";
        li.textContent = prompts.length ? "No matching prompts" : "No prompts yet";
        list.append(li);
      }
      for (const p of shown2) {
        const { title, preview } = describe2(p);
        const li = doc.createElement("li");
        const b = doc.createElement("button");
        b.type = "button";
        b.className = "gs-prompt";
        b.dataset.id = p.id;
        b.tabIndex = p.id === (activeId ?? shown2.at(-1)?.id) ? 0 : -1;
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
      if (!ext || mapPanel.hidden) return;
      const slice = els.slice(prompts[ext.i].turnIndex, promptEnd(ext.i) + 1);
      const turnBox = ext.a.getBoundingClientRect();
      const turnPx = ext.z.getBoundingClientRect().bottom - turnBox.top;
      const contentWidth = Math.min((turnBox.width || CONTENT_W) + railLayout.reserve(), CONTENT_W);
      const key = `${activeId}:${slice.map((e) => e.textContent.length).join(",")}:${slice.every((e) => runtime.isTurnActive(e))}:${Math.round(turnPx / 20)}:${Math.round(turnBox.width / 8)}:${Math.round(minimap.getBoundingClientRect().width / 8)}:${Math.round(win.innerHeight / 8)}:${Math.round(column.getBoundingClientRect().height / 8)}`;
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
        const items = silhouetteItems(ext, slice, turnBox.top, turnPx);
        const box = minimap.getBoundingClientRect();
        const room = (column.getBoundingClientRect().height || win.innerHeight - 76) * 0.55 - MAP_CHROME;
        const maxH = clamp2(Math.min(win.innerHeight * 0.45, room), 48, 360);
        const frameW = Math.round((box.width ? box.width - MAP_PAD : MAP_W) * FRAME_SHARE);
        const scale = frameW / contentWidth;
        geom = { sceneH: Math.max(8, Math.round(turnPx * scale)), frameH: 0 };
        geom.frameH = Math.min(geom.sceneH, Math.round(frameW * PAPER), Math.round(maxH));
        if (frame.style.height !== `${geom.frameH}px`) frame.style.height = `${geom.frameH}px`;
        scene.style.height = `${geom.sceneH}px`;
        bars.style.setProperty("--gs-lh", `${Math.max(3, Math.min(8, 24 * scale)).toFixed(1)}px`);
        for (const b of items) {
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
      if (ind) {
        const center = (ind.top + ind.height / 2) * geom.sceneH;
        const next = Math.round(clamp2(center - geom.frameH / 2, 0, Math.max(0, geom.sceneH - geom.frameH)));
        if (next !== mapOffset) {
          mapOffset = next;
          scene.style.transform = `translateY(${-next}px)`;
        }
      }
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
      const drawable = turnExtent() !== null;
      if (drawable !== hasMap) {
        hasMap = drawable;
        applyVisibility();
      }
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
      openTick();
      schedule();
    }
    function select(p, automatic = false) {
      activeId = p.id;
      listManual = false;
      markActive();
      const el2 = els[p.turnIndex];
      if (el2) automatic ? runtime.open(el2, { offset: 0 }) : runtime.navigateTo(el2, { offset: 0 });
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
      const sc = scene.getBoundingClientRect();
      const r = sc.height ? sc : minimap.getBoundingClientRect();
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
    on(button2, "click", () => toggle());
    on(column, "keydown", (e) => {
      if (e.key === "Escape" && !docked && drawer && !input.value) {
        drawer = false;
        applyVisibility();
        button2.focus?.();
      }
    });
    on(outputsBtn, "click", (e) => {
      e.stopPropagation();
      outputsCollapsed = !outputsCollapsed;
      syncOutputs(lastHost);
      persist();
      savePrefs();
    });
    on(win, "resize", () => {
      paneYield = false;
      scheduleLayout(true);
      schedule();
    });
    on(doc, "transitionend", (e) => !root.contains(e.target) && !actions.contains(e.target) && /width|margin|padding|left|right|transform/.test(e.propertyName ?? "") && scheduleLayout(true), { capture: true, passive: true });
    for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) on(doc, type, () => interacted = true, { capture: true, passive: true });
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
      element: mapPanel,
      state: () => ({ activeId, docked, outputsCollapsed, listPinned, query, reserve: railLayout.reserve() }),
      /** Structure only, safe to expose: no ids, search text or prompts. */
      shape: () => ({ docked, open: open(), minimap: open() && hasMap, prompts: open(), drawer, outputsCollapsible: !!outputsHost, outputsCollapsed, reserve: railLayout.reserve() }),
      select: (id) => {
        const p = prompts.find((x) => x.id === id);
        if (p) select(p);
        return !!p;
      },
      update,
      /** Cheap check on every page mutation batch: put back whatever ChatGPT's re-render removed (the column, the button, the style). */
      heal() {
        if (disposed) return;
        if (!column.isConnected || !style.isConnected || !actions.isConnected || !actions.parentElement?.isConnected) scheduleLayout(true);
      },
      dispose() {
        disposed = true;
        if (trailing) win.clearTimeout(trailing);
        if (scanTimer) win.clearTimeout(scanTimer);
        if (settleTimer) win.clearTimeout(settleTimer);
        cleanups.forEach((fn) => fn());
        railLayout.dispose();
        releaseOutputs();
        column.remove();
        actions.remove();
        style.remove();
      }
    };
    return api;
  }

  // src/chatgpt/virtualization/backend.js
  var STATE = "data-gs-state";
  var HEIGHT_VAR = "--gs-h";
  var STYLE_ID4 = "gs-virtualization-style";
  var CSS4 = `
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
    style.id = STYLE_ID4;
    style.textContent = CSS4;
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
  var queueUi = persistentQueueUi(({ win, adapter, diagnostics, config: config2 }) => {
    const timers = createWorkerTimers({ win });
    return createQueueUi({ win, adapter, diagnostics, timers, dispatcher: selectDispatcher({ config: config2, win, adapter, timers }) });
  });
  var railState = createRailStateStore();
  var pane = null;
  var config = loadConfig(window.localStorage);
  var recoveryDiagnostics = createDiagnostics(window.console);
  var recovery = config.enabled && config.recovery ? createRecovery({ win: window, adapter: chatgptAdapter, diagnostics: recoveryDiagnostics }) : null;
  var boot = createBoot({
    win: window,
    adapter: chatgptAdapter,
    version: "0.7.6",
    extraDiagnostics: () => recoveryDiagnostics.snapshot(),
    onDispose: () => {
      queueUi.shutdown();
      recovery?.dispose();
    },
    mount() {
      const runtime = createRuntime({ win: window, adapter: chatgptAdapter, backend: createTurnBackend(), queueUi });
      const rail = runtime.mode === "active" || runtime.mode === "composer-only" ? createRail({ win: window, adapter: chatgptAdapter, runtime, store: railState }) : null;
      pane = rail;
      const thinking = config.expandThinking && runtime.mode === "active" ? createThinkingExpander({ win: window, adapter: chatgptAdapter, runtime, diagnostics: runtime.diagnostics }) : null;
      return {
        runtime,
        heal: () => rail?.heal(),
        dispose() {
          thinking?.dispose();
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
