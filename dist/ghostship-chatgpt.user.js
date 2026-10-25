// ==UserScript==
// @name         GhostShip ChatGPT
// @namespace    https://github.com/ghostship-io/ghostship-userscripts
// @version      0.3.0
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
    const indexListeners = /* @__PURE__ */ new Set();
    const fallbackListeners = /* @__PURE__ */ new Set();
    const failOpen = (reason) => {
      stop();
      indexListeners.clear();
      fallbackListeners.forEach((fn) => fn(reason));
      fallbackListeners.clear();
      backend.unmount();
      observers.disposeAll();
      scroll.dispose();
      Object.assign(runtime2, { mode: "safe", scroll: void 0, observers: void 0, navigateTo: void 0, onIndexChange: void 0, dispose() {
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
      indexListeners.forEach((fn) => fn(runtime2.promptIndex));
    };
    reindex();
    stop = observers.subscribe(win.document.body, reindex);
    Object.assign(runtime2, {
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
      /** The one explicit navigation entry: activates a virtualized-out turn, then scrolls to it. */
      navigateTo(el, options) {
        return backend.navigateToElement?.(el, options) || scroll.navigateTo(el, options);
      },
      observers,
      dispose() {
        stop();
        indexListeners.clear();
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
  var BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,pre,table,img,blockquote";
  var USER = '[data-message-author-role="user"]';
  var COMPOSER = "#prompt-textarea";
  var chatgptAdapter = {
    turns: (root) => [...root.querySelectorAll(TURN)],
    role: (turn) => (turn.matches(ROLE) ? turn : turn.querySelector(ROLE))?.getAttribute("data-message-author-role") || null,
    blocks: (turnEls) => turnEls.flatMap((el) => [...el.querySelectorAll(BLOCKS)]),
    composer: (doc) => doc.querySelector(COMPOSER)?.closest("form") ?? doc.querySelector(COMPOSER),
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

  // src/chatgpt/rail/minimap-model.js
  var HEADING = /^H[1-6]$/;
  var PRIORITY = ["code", "table", "image", "heading", "text"];
  function classify(el) {
    if (HEADING.test(el.tagName)) return "heading";
    switch (el.tagName) {
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
  var textLength = (el) => (el.textContent ?? "").trim().length;
  function buildTurnModel(blocks) {
    const model = [];
    for (const el of blocks) {
      const nested = el.parentElement?.closest("pre,table");
      if (nested) continue;
      if (el.tagName === "LI" && el.querySelector("p")) continue;
      const kind = classify(el);
      const len = textLength(el);
      if (kind === "text" && len === 0) continue;
      let lines;
      let width;
      if (kind === "code") {
        lines = Math.min(60, ((el.textContent ?? "").match(/\n/g)?.length ?? 0) + 1) + 1;
        width = 0.95;
      } else if (kind === "table") {
        lines = Math.min(40, el.querySelectorAll("tr").length) * 1.4 + 1;
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
      return { kind: b.kind, top, height: b.lines / total, width: b.width };
    });
  }
  function viewportIndicator({ turnTop, turnBottom, viewTop, viewBottom }) {
    const span = turnBottom - turnTop;
    if (span <= 0 || viewBottom <= turnTop || viewTop >= turnBottom) return null;
    const top = Math.max(0, (viewTop - turnTop) / span);
    const bottom = Math.min(1, (viewBottom - turnTop) / span);
    return { top, height: Math.max(bottom - top, 0.02) };
  }
  function scrollTopForFraction({ fraction, turnTop, turnHeight, viewHeight }) {
    const target = turnTop + fraction * turnHeight - viewHeight / 2;
    const max = turnTop + Math.max(0, turnHeight - viewHeight);
    return Math.max(turnTop, Math.min(max, target));
  }

  // src/chatgpt/rail/rail.js
  var RAIL_WIDTH = 240;
  var DOCK_MIN_VIEWPORT = 1100;
  var STYLE_ID = "gs-rail-style";
  var CSS = `
.gs-rail{position:fixed;right:12px;bottom:16px;z-index:40;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:calc(100vw - 24px);box-sizing:border-box;font:13px/1.35 system-ui,sans-serif;color:var(--text-primary,#222)}
.gs-rail *{box-sizing:border-box}
.gs-rail[data-gs-mode="collapsed"]{bottom:var(--gs-rail-bottom,96px)}
.gs-rail-panel{display:flex;flex-direction:column;width:${RAIL_WIDTH}px;max-width:calc(100vw - 24px);max-height:min(70vh,calc(100vh - var(--gs-rail-bottom,16px) - 72px));overflow:hidden;border:1px solid var(--border-light,rgba(128,128,128,.35));border-radius:10px;background:var(--main-surface-primary,#fff)}
.gs-rail[data-gs-mode="collapsed"] .gs-rail-panel{width:min(320px,calc(100vw - 24px))}
.gs-rail[data-gs-open="false"] .gs-rail-panel{display:none}
.gs-rail-toggle{display:none;min-width:44px;min-height:44px;border:1px solid var(--border-light,rgba(128,128,128,.35));border-radius:22px;background:var(--main-surface-primary,#fff);color:inherit;cursor:pointer}
.gs-rail[data-gs-mode="collapsed"] .gs-rail-toggle{display:block}
.gs-minimap{position:relative;flex:0 0 auto;height:120px;margin:6px;border-radius:6px;background:rgba(128,128,128,.1);cursor:pointer;touch-action:none;overflow:hidden}
.gs-minimap:focus-visible,.gs-search input:focus-visible,.gs-prompt:focus-visible,.gs-rail-toggle:focus-visible{outline:2px solid #2f6feb;outline-offset:1px}
.gs-bar{position:absolute;left:4px;min-height:1px;border-radius:1px;background:rgba(128,128,128,.55)}
.gs-bar[data-kind="heading"]{background:currentColor;opacity:.85}
.gs-bar[data-kind="code"]{background:rgba(47,111,235,.55)}
.gs-bar[data-kind="table"]{background:rgba(46,160,67,.55)}
.gs-bar[data-kind="image"]{background:rgba(219,109,40,.55)}
.gs-view{position:absolute;left:0;right:0;border:1px solid #2f6feb;background:rgba(47,111,235,.18);pointer-events:none}
.gs-search{flex:0 0 auto;padding:0 6px 6px}
.gs-search input{width:100%;min-height:32px;padding:4px 8px;border:1px solid var(--border-light,rgba(128,128,128,.35));border-radius:6px;background:transparent;color:inherit;font:inherit}
.gs-prompts{flex:1 1 auto;min-height:0;margin:0;padding:0 4px 4px;list-style:none;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}
.gs-prompt{display:flex;gap:6px;width:100%;min-height:36px;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.gs-prompt:hover{background:rgba(128,128,128,.12)}
.gs-prompt[aria-current="true"]{background:rgba(47,111,235,.18);font-weight:600}
.gs-n{flex:0 0 auto;min-width:2ch;opacity:.6}
.gs-text{flex:1 1 auto;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.gs-empty{padding:8px;opacity:.6}
`;
  var clamp2 = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function createRail({ win, adapter, runtime: runtime2 }) {
    const doc = win.document;
    const scroller = adapter.scroller(doc);
    const scroll = runtime2.scroll;
    let els = [];
    let prompts = [];
    let signature = "";
    let query = "";
    let activeId = null;
    let open = false;
    let listPinned = true;
    let listManual = false;
    let modelKey = "";
    let scheduled = false;
    let disposed = false;
    let drag = false;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
    const root = doc.createElement("aside");
    root.className = "gs-rail";
    root.setAttribute("aria-label", "Conversation navigator");
    root.dataset.gsMode = "docked";
    root.dataset.gsOpen = "true";
    root.innerHTML = `
    <div class="gs-rail-panel" id="gs-rail-panel">
      <div class="gs-minimap" tabindex="0" role="slider" aria-orientation="vertical" aria-label="Current turn overview" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="gs-bars"></div><div class="gs-view" hidden></div></div>
      <div class="gs-search"><input type="search" placeholder="Search prompts" aria-label="Search prompts"></div>
      <ol class="gs-prompts" aria-label="Prompts, oldest first"></ol>
    </div>
    <button type="button" class="gs-rail-toggle" aria-controls="gs-rail-panel" aria-expanded="false" aria-label="Conversation navigator">\u2630</button>`;
    doc.body.appendChild(root);
    const $ = (sel) => root.querySelector(sel);
    const panel = $(".gs-rail-panel");
    const minimap = $(".gs-minimap");
    const bars = $(".gs-bars");
    const view = $(".gs-view");
    const input = $(".gs-search input");
    const list = $(".gs-prompts");
    const toggle = $(".gs-rail-toggle");
    const cleanups = [];
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      cleanups.push(() => target.removeEventListener(type, fn, opts));
    };
    function setOpen(next) {
      open = next;
      root.dataset.gsOpen = String(next);
      toggle.setAttribute("aria-expanded", String(next));
    }
    function layout() {
      const first = els[0];
      const gutter = first ? win.innerWidth - first.getBoundingClientRect().right : win.innerWidth;
      const docked = win.innerWidth >= DOCK_MIN_VIEWPORT && gutter >= RAIL_WIDTH + 24;
      const was = root.dataset.gsMode;
      root.dataset.gsMode = docked ? "docked" : "collapsed";
      if (docked) setOpen(true);
      else if (was === "docked") setOpen(false);
      const composer = adapter.composer(doc);
      const rect = composer?.getBoundingClientRect();
      root.style.setProperty("--gs-rail-bottom", rect?.height ? `${Math.max(16, Math.round(win.innerHeight - rect.top + 8))}px` : "96px");
    }
    function promptEnd(i) {
      return (prompts[i + 1]?.turnIndex ?? els.length) - 1;
    }
    function renderList() {
      const shown = searchPrompts(prompts, query);
      list.textContent = "";
      if (!shown.length) {
        const li = doc.createElement("li");
        li.className = "gs-empty";
        li.textContent = prompts.length ? "No matching prompts" : "No prompts yet";
        list.append(li);
      }
      for (const p of shown) {
        const li = doc.createElement("li");
        const b = doc.createElement("button");
        b.type = "button";
        b.className = "gs-prompt";
        b.dataset.id = p.id;
        b.tabIndex = p.id === (activeId ?? shown.at(-1)?.id) ? 0 : -1;
        b.setAttribute("aria-current", String(p.id === activeId));
        b.title = p.preview;
        const n = doc.createElement("span");
        n.className = "gs-n";
        n.textContent = String(prompts.indexOf(p) + 1);
        const t = doc.createElement("span");
        t.className = "gs-text";
        t.textContent = p.preview;
        b.append(n, t);
        li.append(b);
        list.append(li);
      }
      if (listPinned) list.scrollTop = list.scrollHeight;
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
    function renderMinimap() {
      const ext = turnExtent();
      if (!ext) return;
      const key = `${activeId}:${els.slice(prompts[ext.i].turnIndex, promptEnd(ext.i) + 1).map((e) => e.textContent.length).join(",")}`;
      if (key !== modelKey) {
        modelKey = key;
        const model = buildTurnModel(adapter.blocks(els.slice(prompts[ext.i].turnIndex, promptEnd(ext.i) + 1)));
        bars.textContent = "";
        for (const b of layoutBars(model)) {
          const d = doc.createElement("div");
          d.className = "gs-bar";
          d.dataset.kind = b.kind;
          d.style.cssText = `top:${(b.top * 100).toFixed(2)}%;height:${(b.height * 100).toFixed(2)}%;width:calc(${(b.width * 100).toFixed(1)}% - 8px)`;
          bars.append(d);
        }
      }
      const sTop = scroller.getBoundingClientRect().top;
      const ind = viewportIndicator({
        turnTop: ext.a.getBoundingClientRect().top,
        turnBottom: ext.z.getBoundingClientRect().bottom,
        viewTop: sTop,
        viewBottom: sTop + scrollerHeight()
      });
      view.hidden = !ind;
      if (ind) {
        view.style.top = `${(ind.top * 100).toFixed(2)}%`;
        view.style.height = `${(ind.height * 100).toFixed(2)}%`;
        minimap.setAttribute("aria-valuenow", String(Math.round(ind.top * 100)));
      }
    }
    function scrollerHeight() {
      return scroller.clientHeight || scroller.getBoundingClientRect().height;
    }
    function detectActive() {
      if (!els.length || !prompts.length) return null;
      if (scroller.scrollTop + scrollerHeight() >= scroller.scrollHeight - 2) return prompts.at(-1).id;
      const base = scroller.getBoundingClientRect().top + 1;
      let lo = 0;
      let hi = els.length - 1;
      while (lo < hi) {
        const mid = lo + hi >> 1;
        if (els[mid].getBoundingClientRect().bottom > base) hi = mid;
        else lo = mid + 1;
      }
      let found = prompts[0];
      for (const p of prompts) if (p.turnIndex <= lo) found = p;
      return found.id;
    }
    function update() {
      scheduled = false;
      if (disposed) return;
      const next = detectActive();
      if (next && next !== activeId) {
        activeId = next;
        markActive();
      }
      renderMinimap();
    }
    function schedule() {
      if (scheduled || disposed) return;
      scheduled = true;
      win.requestAnimationFrame(update);
    }
    function refresh(index) {
      els = adapter.turns(doc);
      const sig = index.map((p) => `${p.id}:${p.text.length}`).join("|");
      prompts = index;
      if (sig !== signature) {
        signature = sig;
        if (!prompts.some((p) => p.id === activeId)) activeId = null;
        activeId = activeId ?? detectActive();
        renderList();
      }
      layout();
      schedule();
    }
    function select(p) {
      activeId = p.id;
      listManual = false;
      markActive();
      const el = els[p.turnIndex];
      if (el) runtime2.navigateTo(el, { offset: 0 });
      modelKey = "";
      renderMinimap();
    }
    function jumpFromPointer(clientY) {
      const ext = turnExtent();
      if (!ext) return;
      const r = minimap.getBoundingClientRect();
      const fraction = clamp2(r.height ? (clientY - r.top) / r.height : 0, 0, 1);
      const sRect = scroller.getBoundingClientRect();
      const turnTop = scroller.scrollTop + (ext.a.getBoundingClientRect().top - sRect.top);
      const turnHeight = ext.z.getBoundingClientRect().bottom - ext.a.getBoundingClientRect().top;
      scroll.scrollTo("minimap", scrollTopForFraction({ fraction, turnTop, turnHeight, viewHeight: scrollerHeight() }));
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
      const sRect = scroller.getBoundingClientRect();
      const turnTop = scroller.scrollTop + (ext.a.getBoundingClientRect().top - sRect.top);
      const turnHeight = ext.z.getBoundingClientRect().bottom - ext.a.getBoundingClientRect().top;
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
    });
    for (const type of ["wheel", "touchmove", "pointerdown"]) on(list, type, () => listManual = true, { passive: true });
    on(input, "input", () => {
      query = input.value;
      listPinned = !query.trim();
      renderList();
    });
    on(input, "keydown", (e) => {
      if (e.key === "Escape" && input.value) {
        input.value = "";
        input.dispatchEvent(new win.Event("input"));
        e.stopPropagation();
      }
    });
    on(toggle, "click", () => setOpen(!open));
    on(root, "keydown", (e) => {
      if (e.key === "Escape" && root.dataset.gsMode === "collapsed" && open && !input.value) {
        setOpen(false);
        toggle.focus();
      }
    });
    on(win, "resize", () => layout());
    cleanups.push(scroll.onScroll(schedule));
    cleanups.push(runtime2.onIndexChange(refresh));
    cleanups.push(runtime2.onFallback(() => api.dispose()));
    refresh(runtime2.promptIndex);
    listPinned = true;
    list.scrollTop = list.scrollHeight;
    update();
    const api = {
      element: root,
      state: () => ({ activeId, open, mode: root.dataset.gsMode, listPinned, query }),
      select: (id) => {
        const p = prompts.find((x) => x.id === id);
        if (p) select(p);
        return !!p;
      },
      update,
      dispose() {
        disposed = true;
        cleanups.forEach((fn) => fn());
        root.remove();
        style.remove();
      }
    };
    return api;
  }

  // src/chatgpt/virtualization/backend.js
  var STATE = "data-gs-state";
  var HEIGHT_VAR = "--gs-h";
  var STYLE_ID2 = "gs-virtualization-style";
  var CSS2 = `
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
      /** Navigate to the turn that owns `el`; false when `el` is not a known turn element. */
      navigateToElement(el, options) {
        const i = api?.turnIndexOf(el);
        return i === void 0 ? false : api.navigateToTurn(i, options);
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
    style.id = STYLE_ID2;
    style.textContent = CSS2;
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
      }
    };
    self.sync();
    return self;
  }

  // src/chatgpt/main.js
  var runtime = createRuntime({ win: window, adapter: chatgptAdapter, backend: createTurnBackend() });
  if (runtime.mode === "active") createRail({ win: window, adapter: chatgptAdapter, runtime });
  window.__ghostshipUserscripts = { mode: runtime.mode, diagnostics: () => runtime.diagnostics.snapshot() };
})();
