// ==UserScript==
// @name         GhostShip ChatGPT
// @namespace    https://github.com/ghostship-io/ghostship-userscripts
// @version      0.4.0
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
          anchor = { el: el2, key: el2.getAttribute("data-testid") ?? "", offset: r.top - base };
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
  function createRuntime({ win, adapter, backend = createNoopBackend(), queueUi: queueUi2, config = loadConfig(win.localStorage) }) {
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
    let queue = { dispose() {
    } };
    try {
      queue = queueUi2?.({ win, adapter, config, diagnostics }) ?? queue;
    } catch (error) {
      diagnostics.count("queue.mount.failed");
      diagnostics.warnOnce("queue", `queue UI disabled (${error instanceof Error ? error.message : error})`);
    }
    let stop = () => {
    };
    const failOpen = (reason) => {
      stop();
      backend.unmount();
      observers.disposeAll();
      scroll.dispose();
      Object.assign(runtime2, { mode: "safe", scroll: void 0, observers: void 0, dispose: () => queue.dispose() });
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
      queue,
      dispose() {
        queue.dispose();
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
    /** The element the queue panel is inserted directly before: the composer form, else the input itself. */
    composer: (doc) => doc.querySelector(COMPOSER)?.closest("form") ?? doc.querySelector(COMPOSER),
    conversationId: (win) => win.location.pathname.match(/^\/c\/([\w-]+)/)?.[1] ?? "new",
    scroller: (doc) => doc.querySelector("[data-scroll-root]") ?? doc.scrollingElement ?? doc.documentElement,
    selfCheck(doc) {
      const missing = [];
      if (!doc.querySelector(TURN)) missing.push("turns");
      if (!doc.querySelector(COMPOSER)) missing.push("composer");
      return { ok: missing.length === 0, missing };
    }
  };

  // src/chatgpt/queue/dispatch.js
  var TIMED_OUT = Symbol("timed-out");
  var DispatchBoundary = class {
    #adapter;
    #opts;
    constructor(adapter, opts) {
      this.#adapter = adapter;
      this.#opts = { submitTimeoutMs: 1e4, stopTimeoutMs: 1e4, ...opts };
    }
    async readState(conversationId) {
      try {
        return await this.#adapter.readState(conversationId);
      } catch {
        return "unknown";
      }
    }
    async submit(request2) {
      this.#opts.onAction?.({ type: "submit", conversationId: request2.conversationId, itemId: request2.itemId });
      try {
        const result = await this.#race(this.#adapter.submit(request2), this.#opts.submitTimeoutMs);
        if (result === TIMED_OUT) {
          return { kind: "uncertain", code: "submit-timeout", message: "No submit acknowledgment before the timeout." };
        }
        return result;
      } catch (error) {
        return { kind: "uncertain", code: "submit-threw", message: describe(error) };
      }
    }
    async stop(conversationId) {
      this.#opts.onAction?.({ type: "stop", conversationId });
      let result;
      try {
        result = await this.#race(this.#adapter.stop({ conversationId }), this.#opts.stopTimeoutMs);
      } catch (error) {
        return { kind: "ambiguous", code: "stop-threw", message: describe(error) };
      }
      if (result === TIMED_OUT) {
        return { kind: "timeout", code: "stop-timeout", message: "No stop acknowledgment before the timeout." };
      }
      if (result.kind !== "confirmed") return result;
      const state = await this.readState(conversationId);
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
    submitScript = [];
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
    async submit(request2) {
      this.log.push({ type: "submit", request: request2 });
      const outcome = this.submitScript.shift() ?? { kind: "accepted" };
      const result = await play(outcome);
      if (result.kind === "accepted") this.state = "generating";
      return result;
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
      return this.log.map((entry) => entry.type === "submit" ? `submit:${entry.request.itemId}` : "stop");
    }
  };
  async function play(outcome) {
    if (outcome === "hang") return new Promise(() => void 0);
    if (outcome instanceof Error) throw outcome;
    return outcome;
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

  // src/chatgpt/queue/queue.js
  var DEFAULT_BACKOFF = [1e3, 5e3];
  var STOP_ACTIONS = {
    "stop-timeout": "ChatGPT did not confirm the stop. Check the response, then press Interrupt & Send Next again.",
    "stop-not-idle": "The response may still be running. Wait for it to finish or stop it manually, then try again.",
    "state-unknown": "Could not tell whether a response is running. Check ChatGPT, then try again."
  };
  var QueueEngine = class {
    #store;
    #dispatch;
    #clock;
    #tabId;
    #newId;
    #leaseTtlMs;
    #maxAttempts;
    #backoff;
    #tails = /* @__PURE__ */ new Map();
    constructor(opts) {
      this.#store = opts.store;
      this.#dispatch = opts.dispatch;
      this.#clock = opts.clock;
      this.#tabId = opts.tabId;
      this.#newId = opts.newId ?? (() => crypto.randomUUID());
      this.#leaseTtlMs = opts.leaseTtlMs ?? 15e3;
      this.#maxAttempts = opts.maxAttempts ?? 3;
      this.#backoff = opts.retryBackoffMs ?? DEFAULT_BACKOFF;
    }
    // ---- user-facing queue editing (any tab, no lease needed) ----------------
    enqueue(conversationId, input) {
      return this.#store.transact(async (tx) => {
        const items = await tx.itemsOf(conversationId);
        const now = this.#clock.now();
        const attachments = input.attachments ?? [];
        const item = {
          id: this.#newId(),
          conversationId,
          text: input.text,
          attachments,
          // The model the message will use, when the page could tell at queue time.
          model: input.model ?? null,
          status: "pending",
          position: items.length ? items[items.length - 1].position + 1 : 0,
          version: 1,
          attempts: 0,
          notBefore: 0,
          attemptId: null,
          leaseToken: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
          sentAt: null
        };
        applyAttachmentGate(item, now);
        await tx.putItem(item);
        return item;
      });
    }
    edit(id, patch) {
      return this.#mutate(id, (item, now) => {
        if (item.status === "sending" || item.status === "sent" || item.status === "manual-review") {
          throw new QueueError("item-locked", `Item ${id} is ${item.status} and cannot be edited.`);
        }
        if (patch.text !== void 0) item.text = patch.text;
        if (patch.attachments !== void 0) item.attachments = patch.attachments;
        item.version += 1;
        item.status = "pending";
        item.attempts = 0;
        item.notBefore = 0;
        item.lastError = null;
        applyAttachmentGate(item, now);
      });
    }
    /** Clears a `blocked` item once the user has reattached its files. */
    reattach(id, attachments) {
      return this.edit(id, { attachments });
    }
    remove(id) {
      return this.#store.transact(async (tx) => {
        const item = await tx.getItem(id);
        if (!item) throw new QueueError("not-found", `Item ${id} does not exist.`);
        if (item.status === "sending") throw new QueueError("item-locked", `Item ${id} is being sent.`);
        await tx.deleteItem(id);
      });
    }
    /** Moves an unsent item to `toIndex` among the unsent items of its conversation. */
    move(id, toIndex) {
      return this.#store.transact(async (tx) => {
        const target = await tx.getItem(id);
        if (!target) throw new QueueError("not-found", `Item ${id} does not exist.`);
        const unsent = (await tx.itemsOf(target.conversationId)).filter((i) => i.status !== "sent");
        if (unsent.some((i) => i.status === "sending")) {
          throw new QueueError("item-locked", "The queue cannot be reordered while a message is being sent.");
        }
        const from = unsent.findIndex((i) => i.id === id);
        if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= unsent.length) {
          throw new QueueError("invalid-order", `Index ${toIndex} is outside 0..${unsent.length - 1}.`);
        }
        const positions = unsent.map((i) => i.position);
        const [moved] = unsent.splice(from, 1);
        unsent.splice(toIndex, 0, moved);
        const now = this.#clock.now();
        for (const [i, item] of unsent.entries()) {
          item.position = positions[i];
          item.version += 1;
          item.updatedAt = now;
          await tx.putItem(item);
        }
        return unsent;
      });
    }
    pause(conversationId) {
      return this.#setPaused(conversationId, true);
    }
    resume(conversationId) {
      return this.#setPaused(conversationId, false);
    }
    /** The user chose to resend a failed or uncertain item. Resets the retry budget. */
    retry(id) {
      return this.#mutate(id, (item) => {
        if (item.status !== "failed" && item.status !== "manual-review") {
          throw new QueueError(
            "invalid-state",
            `Item ${id} is ${item.status}; only failed or manual-review items can be retried.`
          );
        }
        item.status = "pending";
        item.attempts = 0;
        item.notBefore = 0;
        item.attemptId = null;
        item.lastError = null;
      });
    }
    /** The user confirmed in ChatGPT that an uncertain or failed item did go out. */
    markDelivered(id) {
      return this.#mutate(id, (item, now) => {
        if (item.status !== "failed" && item.status !== "manual-review") {
          throw new QueueError("invalid-state", `Item ${id} is ${item.status}; nothing to confirm.`);
        }
        item.status = "sent";
        item.sentAt = now;
        item.lastError = null;
      });
    }
    /** Removes every message except one being sent (its outcome is still unrecorded). */
    clear(conversationId) {
      return this.#store.transact(async (tx) => {
        const removable = (await tx.itemsOf(conversationId)).filter((i) => i.status !== "sending");
        for (const item of removable) await tx.deleteItem(item.id);
        return removable.length;
      });
    }
    list(conversationId) {
      return this.#store.transact(async (tx) => ({
        paused: (await tx.getQueue(conversationId))?.paused ?? false,
        items: await tx.itemsOf(conversationId)
      }));
    }
    // ---- sending (lease holder only) -----------------------------------------
    /** Sequential drain, one step. Never stops a response; waits for it to finish. */
    step(conversationId) {
      return this.#serial(conversationId, async () => {
        const lease = await this.#acquire(conversationId);
        if (!lease.ok) return lease.outcome;
        const view = await this.#view(conversationId);
        if (view.paused) return { kind: "paused" };
        const gate = this.#headGate(view.head);
        if (gate) return gate;
        const head = view.head;
        if (head.notBefore > this.#clock.now()) {
          return { kind: "waiting", reason: "backoff", until: head.notBefore };
        }
        const state = await this.#dispatch.readState(conversationId);
        if (state !== "idle") return { kind: "waiting", reason: state === "generating" ? "generating" : "unknown-state" };
        return this.#send(head, lease.token);
      });
    }
    /**
     * Explicit user action. If a response is running, stops it and, only once the
     * stop is confirmed, submits exactly the next item. Any doubt leaves the item
     * pending with an actionable error and sends nothing.
     */
    interruptAndSendNext(conversationId) {
      return this.#serial(conversationId, async () => {
        const lease = await this.#acquire(conversationId);
        if (!lease.ok) return lease.outcome;
        let token = lease.token;
        const view = await this.#view(conversationId);
        const gate = this.#headGate(view.head);
        if (gate) return gate;
        const head = view.head;
        const state = await this.#dispatch.readState(conversationId);
        if (state === "unknown") {
          return this.#interruptFailed(head, "state-unknown", "Could not read the conversation state.");
        }
        if (state === "generating") {
          const stop = await this.#dispatch.stop(conversationId);
          if (stop.kind !== "confirmed") return this.#interruptFailed(head, stop.code, stop.message);
          const renewed = await this.#acquire(conversationId);
          if (!renewed.ok) return renewed.outcome;
          token = renewed.token;
          const after = await this.#view(conversationId);
          const next = after.head;
          if (!next || next.id !== head.id || next.version !== head.version || next.status !== "pending") {
            return { kind: "interrupt-aborted", reason: "head-changed" };
          }
          return this.#send(next, token);
        }
        return this.#send(head, token);
      });
    }
    /** Renews the lease; call periodically while this tab is the active sender. */
    async heartbeat(conversationId) {
      return (await this.#acquire(conversationId)).ok;
    }
    release(conversationId) {
      return this.#store.transact(async (tx) => {
        const lease = await tx.getLease(conversationId);
        if (lease?.holder === this.#tabId) await tx.deleteLease(conversationId);
      });
    }
    // ---- internals -----------------------------------------------------------
    #serial(conversationId, fn) {
      const run = (this.#tails.get(conversationId) ?? Promise.resolve()).then(fn, fn);
      this.#tails.set(
        conversationId,
        run.catch(() => void 0)
      );
      return run;
    }
    async #mutate(id, fn) {
      return this.#store.transact(async (tx) => {
        const item = await tx.getItem(id);
        if (!item) throw new QueueError("not-found", `Item ${id} does not exist.`);
        const now = this.#clock.now();
        fn(item, now);
        item.updatedAt = now;
        await tx.putItem(item);
        return item;
      });
    }
    #setPaused(conversationId, paused) {
      return this.#store.transact(async (tx) => {
        await tx.putQueue({ conversationId, paused });
      });
    }
    async #view(conversationId) {
      const { paused, items } = await this.list(conversationId);
      return { paused, head: items.find((i) => i.status !== "sent") };
    }
    #headGate(head) {
      if (!head) return { kind: "idle" };
      if (head.status === "sending") return { kind: "busy", itemId: head.id };
      if (head.status !== "pending") return { kind: "halted", itemId: head.id, status: head.status };
      return null;
    }
    /**
     * Acquires or renews this tab's lease. A fresh acquisition (first, or after
     * expiry) gets a new fencing token and, in the same transaction, turns any
     * item still `sending` under an older token into manual-review: its sender is
     * gone and we cannot know whether it was delivered.
     */
    async #acquire(conversationId) {
      return this.#store.transact(async (tx) => {
        const now = this.#clock.now();
        const current = await tx.getLease(conversationId);
        if (current && current.expiresAt > now && current.holder !== this.#tabId) {
          return { ok: false, outcome: { kind: "not-leader", holder: current.holder, expiresAt: current.expiresAt } };
        }
        const keep = current !== void 0 && current.holder === this.#tabId && current.expiresAt > now;
        const token = keep ? current.token : (current?.token ?? 0) + 1;
        await tx.putLease({ conversationId, holder: this.#tabId, token, expiresAt: now + this.#leaseTtlMs });
        if (!keep) {
          for (const item of await tx.itemsOf(conversationId)) {
            if (item.status === "sending" && item.leaseToken !== token) {
              item.status = "manual-review";
              item.lastError = orphanError(now);
              item.updatedAt = now;
              await tx.putItem(item);
            }
          }
        }
        return { ok: true, token };
      });
    }
    async #checkLease(tx, conversationId, token) {
      const lease = await tx.getLease(conversationId);
      const now = this.#clock.now();
      if (!lease || lease.holder !== this.#tabId || lease.token !== token || lease.expiresAt <= now) {
        throw new QueueError("lease-lost", "Another tab holds the sender lease.");
      }
      return lease;
    }
    /** Claim -> submit -> record. The claim is the only place an item becomes `sending`. */
    async #send(head, token) {
      const attemptId = this.#newId();
      const claimed = await this.#store.transact(async (tx) => {
        const lease = await this.#checkLease(tx, head.conversationId, token);
        const fresh = await tx.getItem(head.id);
        const first = (await tx.itemsOf(head.conversationId)).find((i) => i.status !== "sent");
        if (!fresh || first?.id !== fresh.id || fresh.status !== "pending" || fresh.version !== head.version) {
          return null;
        }
        const now = this.#clock.now();
        fresh.status = "sending";
        fresh.attempts += 1;
        fresh.attemptId = attemptId;
        fresh.leaseToken = token;
        fresh.lastError = null;
        fresh.updatedAt = now;
        await tx.putItem(fresh);
        await tx.putLease({ ...lease, expiresAt: now + this.#leaseTtlMs });
        return fresh;
      }).catch((error) => {
        if (error instanceof QueueError && error.code === "lease-lost") return "lease-lost";
        throw error;
      });
      if (claimed === "lease-lost") return this.#notLeader(head.conversationId);
      if (!claimed) return { kind: "busy", itemId: head.id };
      const result = await this.#dispatch.submit({
        itemId: claimed.id,
        attemptId,
        conversationId: claimed.conversationId,
        text: claimed.text,
        attachments: claimed.attachments
      });
      return this.#record(claimed.id, attemptId, result);
    }
    async #notLeader(conversationId) {
      const lease = await this.#store.transact((tx) => tx.getLease(conversationId));
      return { kind: "not-leader", holder: lease?.holder ?? "unknown", expiresAt: lease?.expiresAt ?? 0 };
    }
    /** Records a submit result; compare-and-set on `attemptId` so stale results are dropped. */
    #record(id, attemptId, result) {
      return this.#store.transact(async (tx) => {
        const item = await tx.getItem(id);
        if (!item || item.attemptId !== attemptId || item.status !== "sending" && item.status !== "manual-review") {
          return { kind: "busy", itemId: id };
        }
        const now = this.#clock.now();
        item.updatedAt = now;
        let outcome;
        if (result.kind === "accepted") {
          item.status = "sent";
          item.sentAt = now;
          item.lastError = null;
          outcome = { kind: "sent", itemId: id };
        } else if (result.kind === "uncertain") {
          item.status = "manual-review";
          item.lastError = {
            code: result.code,
            message: result.message,
            action: "Check the conversation in ChatGPT. Mark the message delivered if it is there, or retry it if it is not.",
            at: now
          };
          outcome = { kind: "manual-review", itemId: id };
        } else if (result.retryable && item.attempts < this.#maxAttempts) {
          item.status = "pending";
          item.notBefore = now + this.#backoff[Math.min(item.attempts, this.#backoff.length) - 1];
          item.lastError = {
            code: result.code,
            message: result.message,
            action: `Will retry automatically (attempt ${item.attempts} of ${this.#maxAttempts}).`,
            at: now
          };
          outcome = { kind: "retry-scheduled", itemId: id, notBefore: item.notBefore };
        } else {
          item.status = "failed";
          item.lastError = {
            code: result.code,
            message: result.message,
            action: "The message was not sent. Edit or retry it, or remove it from the queue.",
            at: now
          };
          outcome = { kind: "failed", itemId: id };
        }
        await tx.putItem(item);
        return outcome;
      });
    }
    async #interruptFailed(head, code, message) {
      const error = {
        code,
        message,
        action: STOP_ACTIONS[code] ?? "The response was not confirmed stopped. Nothing was sent; check ChatGPT and try again.",
        at: this.#clock.now()
      };
      await this.#store.transact(async (tx) => {
        const item = await tx.getItem(head.id);
        if (item && item.status === "pending") {
          item.lastError = error;
          await tx.putItem(item);
        }
      });
      return { kind: "interrupt-failed", itemId: head.id, error };
    }
  };
  function applyAttachmentGate(item, now) {
    const lost = item.attachments.filter((a) => !a.restorable);
    if (lost.length === 0) return;
    item.status = "blocked";
    item.lastError = {
      code: "attachments-not-restorable",
      message: `Cannot restore ${lost.map((a) => a.name).join(", ")}.`,
      action: "Reattach the files, then the message can be sent.",
      at: now
    };
  }
  function orphanError(now) {
    return {
      code: "orphaned-send",
      message: "The tab that was sending this message stopped before reporting the result.",
      action: "Check the conversation in ChatGPT. Mark the message delivered if it is there, or retry it if it is not.",
      at: now
    };
  }

  // src/chatgpt/queue/store.js
  var DB_NAME = "ghostship-chatgpt-queue";
  var DB_VERSION = 1;
  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  var Tx = class {
    #tx;
    constructor(tx) {
      this.#tx = tx;
    }
    getItem(id) {
      return request(this.#tx.objectStore("items").get(id));
    }
    putItem(item) {
      return request(this.#tx.objectStore("items").put(item));
    }
    deleteItem(id) {
      return request(this.#tx.objectStore("items").delete(id));
    }
    /** Items of one conversation ordered by position. */
    async itemsOf(conversationId) {
      const items = await request(this.#tx.objectStore("items").index("conversationId").getAll(conversationId));
      return items.sort((a, b) => a.position - b.position);
    }
    getQueue(conversationId) {
      return request(this.#tx.objectStore("queues").get(conversationId));
    }
    putQueue(state) {
      return request(this.#tx.objectStore("queues").put(state));
    }
    getLease(conversationId) {
      return request(this.#tx.objectStore("leases").get(conversationId));
    }
    putLease(lease) {
      return request(this.#tx.objectStore("leases").put(lease));
    }
    deleteLease(conversationId) {
      return request(this.#tx.objectStore("leases").delete(conversationId));
    }
  };
  var QueueStore = class _QueueStore {
    #db;
    constructor(db) {
      this.#db = db;
    }
    static async open(factory = globalThis.indexedDB, name = DB_NAME) {
      const open = factory.open(name, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        const items = db.createObjectStore("items", { keyPath: "id" });
        items.createIndex("conversationId", "conversationId");
        db.createObjectStore("queues", { keyPath: "conversationId" });
        db.createObjectStore("leases", { keyPath: "conversationId" });
      };
      return new _QueueStore(await request(open));
    }
    close() {
      this.#db.close();
    }
    transact(fn) {
      return new Promise((resolve, reject) => {
        const tx = this.#db.transaction(["items", "queues", "leases"], "readwrite");
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
  };

  // src/chatgpt/queue/view.js
  var STYLE_ID = "gs-queue-style";
  var CSS = `
.gs-q{box-sizing:border-box;width:100%;max-width:100%;min-width:0;margin:0 0 8px;padding:6px 8px;border:1px solid rgba(127,127,127,.3);border-radius:16px;background:var(--main-surface-secondary,rgba(127,127,127,.1));color:inherit;font:inherit;font-size:14px;line-height:1.35}
.gs-q *{box-sizing:border-box;min-width:0}
.gs-q svg{width:1.1em;height:1.1em;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.gs-q button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:4px 10px;border:1px solid rgba(127,127,127,.45);border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.gs-q button:hover:not(:disabled){background:rgba(127,127,127,.15)}
.gs-q button:disabled{opacity:.45;cursor:not-allowed}
.gs-q button:focus-visible,.gs-q textarea:focus-visible{outline:2px solid #2563eb;outline-offset:1px}
.gs-q-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.gs-q-toggle{border-color:transparent!important;padding:4px 6px!important}
.gs-q-toggle svg{transition:transform .15s}
.gs-q-toggle[aria-expanded="false"] svg{transform:rotate(-90deg)}
.gs-q-title{font-weight:600}
.gs-q-status{opacity:.7;font-size:12px}
.gs-q-badge{padding:1px 8px;border:1px solid currentColor;border-radius:999px;font-size:12px;opacity:.8}
.gs-q-spacer{flex:1 1 0}
.gs-q-head-actions{display:flex;flex-wrap:wrap;gap:6px}
.gs-q .gs-q-interrupt{border-color:currentColor;font-weight:600}
.gs-q .gs-q-armed{border-color:#b91c1c;color:#b91c1c}
.gs-q-error{margin:6px 0 0;padding:6px 8px;border-radius:8px;border:1px solid #b91c1c;color:#b91c1c;overflow-wrap:anywhere}
.gs-q-list{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:2px}
.gs-q-item{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:2px 10px;padding:4px 2px;border-top:1px solid rgba(127,127,127,.18)}
.gs-q-item.gs-q-dragging{opacity:.5}
.gs-q-item.gs-q-drop-before{box-shadow:0 -2px 0 #2563eb}
.gs-q-item.gs-q-drop-after{box-shadow:0 2px 0 #2563eb}
.gs-q-num{display:inline-flex;align-items:center;justify-content:center;min-width:2em;padding:2px 6px;border:1px solid rgba(127,127,127,.4);border-radius:8px;font-size:13px}
.gs-q-main{display:flex;gap:12px;align-items:baseline;overflow:hidden}
.gs-q-name{flex:0 1 45%;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-q-preview{flex:1 1 0;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-q-state{flex:none;font-size:12px;padding:0 6px;border-radius:6px;background:rgba(127,127,127,.25)}
.gs-q-model{grid-column:3;padding:1px 8px;border-radius:8px;background:rgba(127,127,127,.2);font-size:12px;white-space:nowrap}
.gs-q-actions{grid-column:4;display:flex;flex-wrap:wrap;align-items:center;gap:2px;justify-content:flex-end}
.gs-q .gs-q-icon{border-color:transparent;padding:4px 6px}
.gs-q .gs-q-handle{touch-action:none;cursor:grab}
.gs-q-note{grid-column:1/-1;margin:0;font-size:12px;opacity:.8;overflow-wrap:anywhere}
.gs-q-edit{grid-column:2/-1;display:grid;gap:4px}
.gs-q-edit .gs-q-actions{justify-content:flex-start}
.gs-q textarea{width:100%;max-width:100%;resize:vertical;font:inherit;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.5);border-radius:8px;padding:6px 8px}
.gs-q-add{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;align-items:flex-end}
.gs-q-add textarea{flex:1 1 12em}
@media (max-width:560px){
.gs-q-head-actions{flex:1 1 100%}
.gs-q-head-actions button{flex:1 1 auto}
.gs-q-item{grid-template-columns:auto minmax(0,1fr) auto}
.gs-q-main{display:block}
.gs-q-name,.gs-q-preview{display:block}
.gs-q-model{grid-column:2/-1;justify-self:start}
.gs-q-actions{grid-column:1/-1;justify-content:flex-end}
.gs-q button{min-height:36px}
}
`;
  var STATUS_LABEL = {
    pending: "Queued",
    sending: "Sending",
    sent: "Sent",
    failed: "Failed",
    "manual-review": "Needs review",
    blocked: "Blocked"
  };
  var EDITABLE = /* @__PURE__ */ new Set(["pending", "failed", "blocked"]);
  var ICONS = {
    chevron: ["M6 9l6 6 6-6"],
    interrupt: ["M5 5l7 7-7 7", "M13 5l7 7-7 7"],
    pause: ["M9 5v14", "M15 5v14"],
    play: ["M7 5l12 7-12 7z"],
    trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
    grip: ["M9 6h.01", "M15 6h.01", "M9 12h.01", "M15 12h.01", "M9 18h.01", "M15 18h.01"],
    pencil: ["M4 20l4-1 11-11-3-3L5 16z", "M14 7l3 3"],
    remove: ["M12 21a9 9 0 100-18 9 9 0 000 18z", "M9 9l6 6", "M15 9l-6 6"]
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
  function el(doc, tag, attrs = {}, children = []) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value == null) continue;
      node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of [].concat(children)) node.append(child);
    return node;
  }
  function button(doc, key, content, onClick, { label, disabled, className, title, pressed, expanded } = {}) {
    const node = el(
      doc,
      "button",
      { type: "button", "data-gs-key": key, "aria-label": label, disabled, class: className, title, "aria-expanded": expanded == null ? null : String(expanded) },
      content
    );
    node.addEventListener("click", onClick);
    return node;
  }
  function summarize(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return { title: lines[0] ?? "(empty message)", preview: lines.slice(1).join(" ") };
  }
  function interruptBlocker({ items, interrupting }) {
    if (interrupting) return "Stopping the current response.";
    const head = items.find((i) => i.status !== "sent");
    if (!head) return "The queue is empty.";
    if (head.status === "sending") return "The next message is already being sent.";
    if (head.status !== "pending") return `Resolve the first message (${STATUS_LABEL[head.status]}) first.`;
    return null;
  }
  function dropIndex(rects, y) {
    let index = 0;
    for (const rect of rects) {
      if (y > rect.top + (rect.bottom - rect.top) / 2) index += 1;
    }
    return index;
  }
  function renderPanel(doc, root, model, on) {
    const unsent = model.items.filter((i) => i.status !== "sent");
    const sentCount = model.items.length - unsent.length;
    const blocker = interruptBlocker(model);
    const clearable = model.items.some((i) => i.status !== "sending");
    const statusBits = [];
    if (model.paused) statusBits.push("paused");
    if (sentCount) statusBits.push(`${sentCount} sent`);
    const interruptBtn = button(doc, "head:interrupt", [icon(doc, "interrupt"), "Interrupt & Send Next"], () => on.interrupt(), {
      className: "gs-q-interrupt",
      disabled: blocker !== null,
      title: blocker
    });
    if (model.interrupting) interruptBtn.setAttribute("aria-busy", "true");
    const head = el(doc, "div", { class: "gs-q-head" }, [
      button(doc, "head:toggle", icon(doc, "chevron"), () => on.toggleCollapsed(), {
        className: "gs-q-toggle",
        label: model.collapsed ? "Expand queue" : "Collapse queue",
        expanded: !model.collapsed
      }),
      el(doc, "span", { class: "gs-q-title" }, `Queue (${unsent.length})`),
      el(doc, "span", { class: "gs-q-status", role: "status", "aria-live": "polite" }, statusBits.join(" \xB7 ")),
      model.dryRun ? el(doc, "span", { class: "gs-q-badge", title: "Dry run: nothing is sent to ChatGPT" }, "Dry run") : null,
      el(doc, "span", { class: "gs-q-spacer" }),
      el(doc, "div", { class: "gs-q-head-actions" }, [
        interruptBtn,
        button(doc, "head:pause", [icon(doc, model.paused ? "play" : "pause"), model.paused ? "Resume" : "Pause"], () => on.togglePause(), {
          label: model.paused ? "Resume queue" : "Pause queue"
        }),
        button(doc, "head:clear", [icon(doc, "trash"), model.confirmClear ? "Confirm clear" : "Clear"], () => on.clear(), {
          label: model.confirmClear ? "Confirm clearing the queue" : "Clear queue",
          disabled: !clearable,
          className: model.confirmClear ? "gs-q-armed" : null
        })
      ])
    ]);
    const children = [head];
    const message = model.error ?? (model.note ? { message: model.note, action: "" } : null);
    if (message) {
      children.push(el(doc, "p", { class: "gs-q-error", role: model.error ? "alert" : "status" }, `${message.message} ${message.action}`.trim()));
    }
    if (!model.collapsed) {
      const list = el(doc, "ol", { class: "gs-q-list", "aria-label": "Queued messages" });
      unsent.forEach((item, index) => list.append(renderItem(doc, item, index, unsent.length, model, on)));
      children.push(list);
      const input = el(doc, "textarea", {
        rows: 1,
        "data-gs-key": "add:input",
        "aria-label": "Message to queue",
        placeholder: "Queue a message"
      });
      input.value = model.draft ?? "";
      input.addEventListener("input", () => on.draft(input.value));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          on.add(input.value);
        }
      });
      children.push(el(doc, "div", { class: "gs-q-add" }, [input, button(doc, "add:submit", "Add to queue", () => on.add(input.value))]));
    }
    root.replaceChildren(...children);
    root.onkeydown = (event) => {
      if (event.key === "Escape" && model.confirmClear) on.disarmClear();
    };
  }
  function renderItem(doc, item, index, count, model, on) {
    const li = el(doc, "li", { class: "gs-q-item", "data-id": item.id, "data-status": item.status });
    const editing = model.edit?.id === item.id;
    const number = el(doc, "span", { class: "gs-q-num", "aria-label": `Message ${index + 1} of ${count}` }, String(index + 1));
    if (editing) {
      const area = el(doc, "textarea", { rows: 3, "data-gs-key": `${item.id}:edit`, "aria-label": "Edit queued message" });
      area.value = model.edit.text;
      area.addEventListener("input", () => on.editDraft(area.value));
      area.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          on.cancelEdit();
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          on.saveEdit(item.id, area.value);
        }
      });
      li.append(
        number,
        el(doc, "div", { class: "gs-q-edit" }, [
          area,
          el(doc, "div", { class: "gs-q-actions" }, [
            button(doc, `${item.id}:save`, "Save", () => on.saveEdit(item.id, area.value), { className: "gs-q-interrupt" }),
            button(doc, `${item.id}:cancel`, "Cancel", () => on.cancelEdit())
          ])
        ])
      );
      return li;
    }
    const { title, preview } = summarize(item.text);
    const locked = item.status === "sending";
    const main = el(doc, "div", { class: "gs-q-main", title: item.text }, [
      el(doc, "span", { class: "gs-q-name" }, title),
      preview ? el(doc, "span", { class: "gs-q-preview" }, preview) : null,
      item.status !== "pending" ? el(doc, "span", { class: "gs-q-state" }, STATUS_LABEL[item.status] ?? item.status) : null
    ]);
    li.append(number, main);
    if (item.model) li.append(el(doc, "span", { class: "gs-q-model", title: "Model for this message" }, item.model));
    const handle = button(doc, `${item.id}:handle`, icon(doc, "grip"), () => void 0, {
      className: "gs-q-icon gs-q-handle",
      label: `Reorder message ${index + 1}: drag, or use the arrow keys`,
      disabled: locked || count < 2
    });
    attachReorder(doc, handle, li, item, index, on);
    const actions = el(doc, "div", { class: "gs-q-actions", role: "group", "aria-label": `Actions for message ${index + 1}` });
    actions.append(handle);
    if (EDITABLE.has(item.status)) {
      actions.append(button(doc, `${item.id}:edit`, icon(doc, "pencil"), () => on.startEdit(item), { className: "gs-q-icon", label: `Edit message ${index + 1}` }));
    }
    if (item.status === "failed" || item.status === "manual-review") {
      actions.append(button(doc, `${item.id}:retry`, "Retry", () => on.retry(item.id)));
      actions.append(button(doc, `${item.id}:delivered`, "Mark delivered", () => on.markDelivered(item.id)));
    }
    actions.append(
      button(doc, `${item.id}:remove`, icon(doc, "remove"), () => on.remove(item.id), {
        className: "gs-q-icon",
        label: `Remove message ${index + 1}`,
        disabled: locked
      })
    );
    li.append(actions);
    li.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown" || locked) return;
      if (!event.altKey && event.target !== handle) return;
      event.preventDefault();
      on.move(item.id, index + (event.key === "ArrowUp" ? -1 : 1), `${item.id}:handle`);
    });
    if (item.lastError) {
      li.append(el(doc, "p", { class: "gs-q-note", "data-gs-note": item.lastError.code }, `${item.lastError.message} ${item.lastError.action}`));
    }
    return li;
  }
  function attachReorder(doc, handle, li, item, index, on) {
    let drag = null;
    const rows = () => [...li.parentElement.children];
    const target = (y) => {
      const others = rows().filter((row) => row !== li);
      const index2 = dropIndex(others.map((row) => row.getBoundingClientRect()), y);
      return { index: index2, row: others[index2] ?? others[others.length - 1], before: index2 < others.length };
    };
    const clearMarks = () => rows().forEach((row) => row.classList.remove("gs-q-drop-before", "gs-q-drop-after", "gs-q-dragging"));
    const finish = (commitY) => {
      if (!drag) return;
      const { index: to } = commitY == null ? { index } : target(commitY);
      drag = null;
      clearMarks();
      if (to !== index) on.move(item.id, to, `${item.id}:handle`);
    };
    handle.addEventListener("pointerdown", (event) => {
      if (handle.disabled || event.button != null && event.button !== 0) return;
      drag = { id: event.pointerId };
      handle.setPointerCapture?.(event.pointerId);
      li.classList.add("gs-q-dragging");
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag) return;
      rows().forEach((row2) => row2.classList.remove("gs-q-drop-before", "gs-q-drop-after"));
      const { row, before } = target(event.clientY);
      row?.classList.add(before ? "gs-q-drop-before" : "gs-q-drop-after");
    });
    handle.addEventListener("pointerup", (event) => finish(event.clientY));
    handle.addEventListener("pointercancel", () => finish(null));
  }

  // src/chatgpt/queue/controller.js
  var MESSAGES = {
    "not-leader": "Another tab is sending for this conversation.",
    "interrupt-aborted": "The first message changed while the response was stopping, so nothing was sent."
  };
  function createQueueUi({
    win,
    adapter,
    dispatcher,
    diagnostics,
    indexedDB = win.indexedDB,
    clock = systemClock,
    tabId = globalThis.crypto.randomUUID(),
    pollMs = 1e3,
    engineOptions = {}
  }) {
    const doc = win.document;
    const composer = adapter.composer(doc);
    if (!composer || !indexedDB) {
      diagnostics?.count("queue.unmounted");
      return { mounted: false, reason: composer ? "no-indexeddb" : "no-composer", dispose() {
      } };
    }
    let conversationId = adapter.conversationId(win);
    const model = {
      items: [],
      paused: false,
      interrupting: false,
      error: null,
      note: null,
      edit: null,
      draft: "",
      collapsed: false,
      confirmClear: false,
      dryRun: dispatcher.dryRun === true
    };
    let engine = null;
    let store = null;
    let disposed = false;
    let timer = null;
    let chain = Promise.resolve();
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      doc.head.append(style);
    }
    const root = doc.createElement("section");
    root.className = "gs-q";
    root.setAttribute("data-gs-queue", "");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Message queue");
    composer.before(root);
    const run = (fn) => {
      const next = chain.then(fn).catch((error) => {
        diagnostics?.count("queue.action.failed");
        model.error = { message: error instanceof Error ? error.message : String(error), action: "" };
        render();
      });
      chain = next;
      return next;
    };
    let painted = null;
    function render(focusKey) {
      const { items, paused, interrupting, error, note, edit, dryRun, collapsed, confirmClear } = model;
      const signature = JSON.stringify({ items, paused, interrupting, error, note, dryRun, collapsed, confirmClear, editing: edit?.id ?? null });
      if (signature === painted && !focusKey) return;
      painted = signature;
      const active = doc.activeElement;
      const key = focusKey ?? (root.contains(active) ? active.getAttribute("data-gs-key") : null);
      renderPanel(doc, root, model, handlers);
      if (!key) return;
      const wanted = root.querySelector(`[data-gs-key="${CSS_ESCAPE(key)}"]`);
      (wanted && !wanted.disabled ? wanted : root.querySelector("button:not(:disabled)"))?.focus({ preventScroll: true });
    }
    async function reload() {
      const view = await engine.list(conversationId);
      model.items = view.items;
      model.paused = view.paused;
      if (model.edit && !view.items.some((i) => i.id === model.edit.id && i.status !== "sent")) model.edit = null;
      render();
    }
    const act = (fn, focusKey) => run(async () => {
      model.error = null;
      model.confirmClear = false;
      await fn();
      await reload();
      if (focusKey) render(focusKey);
    });
    const handlers = {
      draft: (text) => {
        model.draft = text;
      },
      editDraft: (text) => {
        if (model.edit) model.edit.text = text;
      },
      add: (text) => {
        if (!text.trim()) return;
        model.draft = "";
        const modelName = adapter.currentModel?.(doc) ?? null;
        return act(() => engine.enqueue(conversationId, { text, model: modelName }), "add:input");
      },
      startEdit: (item) => {
        model.edit = { id: item.id, text: item.text };
        render(`${item.id}:edit`);
      },
      cancelEdit: () => {
        const id = model.edit?.id;
        model.edit = null;
        render(id ? `${id}:edit` : void 0);
      },
      saveEdit: (id, text) => act(async () => {
        model.edit = null;
        await engine.edit(id, { text });
      }, `${id}:edit`),
      move: (id, to, focusKey) => act(() => engine.move(id, to), focusKey),
      remove: (id) => act(() => engine.remove(id), "add:input"),
      retry: (id) => act(() => engine.retry(id)),
      markDelivered: (id) => act(() => engine.markDelivered(id)),
      toggleCollapsed: () => {
        model.collapsed = !model.collapsed;
        model.confirmClear = false;
        render("head:toggle");
      },
      // Clearing discards drafts, so it takes a second press.
      clear() {
        if (!model.confirmClear) {
          model.confirmClear = true;
          render("head:clear");
          return;
        }
        return act(() => engine.clear(conversationId), "head:clear");
      },
      disarmClear: () => {
        model.confirmClear = false;
        render("head:clear");
      },
      togglePause: () => act(() => model.paused ? engine.resume(conversationId) : engine.pause(conversationId)),
      interrupt() {
        model.interrupting = true;
        model.error = null;
        model.confirmClear = false;
        render("head:interrupt");
        return run(async () => {
          try {
            const outcome = await engine.interruptAndSendNext(conversationId);
            model.error = interruptError(outcome);
            diagnostics?.count(`queue.interrupt.${outcome.kind}`);
          } finally {
            model.interrupting = false;
          }
          await reload();
        });
      }
    };
    function tick() {
      return run(async () => {
        if (!engine || model.interrupting) return;
        const current = adapter.conversationId(win);
        if (current !== conversationId) {
          await engine.release(conversationId).catch(() => void 0);
          conversationId = current;
          model.edit = null;
        }
        const home = adapter.composer(doc);
        if (home && (!root.isConnected || root.nextElementSibling !== home)) home.before(root);
        const outcome = await engine.step(conversationId);
        model.note = MESSAGES[outcome.kind] ?? null;
        await reload();
      });
    }
    const ready = QueueStore.open(indexedDB).then(async (opened) => {
      if (disposed) return opened.close();
      store = opened;
      engine = new QueueEngine({
        store,
        dispatch: new DispatchBoundary(dispatcher, { clock }),
        clock,
        tabId,
        ...engineOptions
      });
      await run(reload);
      if (pollMs > 0) timer = win.setInterval(tick, pollMs);
    });
    ready.catch(() => {
      diagnostics?.count("queue.store.failed");
      model.error = { message: "The queue could not open its storage.", action: "Reload the page; queued messages are kept." };
      render();
    });
    render();
    const onPageHide = () => engine?.release(conversationId).catch(() => void 0);
    win.addEventListener("pagehide", onPageHide);
    return {
      mounted: true,
      root,
      ready,
      tick,
      /** Resolves when every queued UI action has finished. */
      settled: () => chain,
      dispose() {
        disposed = true;
        if (timer) win.clearInterval(timer);
        win.removeEventListener("pagehide", onPageHide);
        root.remove();
        doc.getElementById(STYLE_ID)?.remove();
        engine?.release(conversationId).catch(() => void 0).finally(() => store?.close());
      }
    };
  }
  function interruptError(outcome) {
    if (outcome.kind === "interrupt-failed") return { message: outcome.error.message, action: outcome.error.action };
    if (outcome.kind === "halted") return { message: `The first message is ${outcome.status}.`, action: "Resolve it before sending the next." };
    if (outcome.kind === "failed" || outcome.kind === "manual-review") {
      return { message: "The message was not confirmed sent.", action: "See the message below for what to do." };
    }
    const message = MESSAGES[outcome.kind];
    return message ? { message, action: "" } : null;
  }
  var CSS_ESCAPE = (value) => value.replace(/["\\]/g, "\\$&");

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
    });
    const stopObserving = observers.subscribe(parent, () => refresh(), { childList: true });
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
  var queueUi = ({ win, adapter, diagnostics, config }) => {
    if (!config.dryRun) diagnostics.warnOnce("queue-live", "live queue transport is not available; running the queue in dry-run mode");
    return createQueueUi({ win, adapter, diagnostics, dispatcher: new DryRunDispatcher() });
  };
  var runtime = createRuntime({ win: window, adapter: chatgptAdapter, backend: createTurnBackend(), queueUi });
  window.__ghostshipUserscripts = { mode: runtime.mode, diagnostics: () => runtime.diagnostics.snapshot() };
})();
