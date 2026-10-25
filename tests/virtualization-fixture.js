import { JSDOM } from "jsdom";

/**
 * jsdom has no layout, so the fixture simulates one: every turn element has an
 * intrinsic height (`__h`) that the test can change, and elements skipped by
 * the virtualizer (data-gs-state="inactive") take their measured placeholder
 * height from the `--gs-h` custom property, as content-visibility:hidden with
 * contain-intrinsic-block-size would. Scroll events, ResizeObserver callbacks
 * and animation frames are queued and delivered by `settle()` so tests are
 * deterministic.
 */
// `overlay` (markup "real"): the page column is the scroller itself and the composer sits in an
// absolutely positioned overlay inside it, as on chatgpt.com, so padding on the scroller does not move it.
// `pane` (width, reserves, outputs, sources): ChatGPT's own right-side summary pane is mounted, with Outputs and
// Sources sections. `reserves: true` (default) makes it take its width out of the page column, as a flex sibling
// would; `reserves: false` makes it float over the right edge. `mountPane()` / `unmountPane()` / `hidePane()`
// emulate React rendering it, removing it and keeping it mounted but not displayed.
export function createFixture({ turns = 40, viewport = 800, markup = "chatgpt", width = 1024, nav = 0, overlay = false, pane = null, header = false } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>
      ${overlay
        ? `<div id="scroller" data-scroll-root style="overflow-y:auto"><main id="thread"></main><div id="overlay" style="position:absolute"><form id="composer"><textarea id="prompt-textarea"></textarea></form></div></div>`
        : `<div id="scroller" data-scroll-root style="overflow-y:auto"><main id="thread"></main></div>
      <form id="composer"><textarea id="prompt-textarea"></textarea></form>`}
    </body></html>`,
    { pretendToBeVisual: false, runScripts: "outside-only", url: "https://chatgpt.com/c/fixture" },
  );
  const win = dom.window;
  win.innerWidth = width;
  win.innerHeight = viewport;
  const doc = win.document;
  if (header) doc.body.insertAdjacentHTML("afterbegin", '<header id="page-header"><div class="t">ChatGPT</div><div class="acts"><button type="button">Share</button><button type="button">More</button></div></header>');
  const scroller = doc.getElementById("scroller");
  let thread = doc.getElementById("thread");
  const clock = { t: 0, now: () => clock.t };
  const sim = { top: 0 };
  const scrollEvents = [];
  const pendingScroll = { count: 0 };
  const rafQueue = [];
  const observed = new Set();
  const roInstances = [];
  const roSizes = new Map();

  const placeholder = (el) => {
    const v = el.style.getPropertyValue("--gs-h");
    return v ? parseFloat(v) : null;
  };
  // "real" markup: each turn is one [data-turn-key] element inside its own wrapper div.
  const heightOf = (el) =>
    el.__wrap ? heightOf(el.firstElementChild) : el.getAttribute("data-gs-state") === "inactive" && placeholder(el) !== null ? placeholder(el) : el.__h ?? 0;
  const scrollHeight = () => [...thread.children].reduce((s, el) => s + heightOf(el), 0);
  const maxTop = () => Math.max(0, scrollHeight() - viewport);
  const topOf = (el) => {
    let y = 0;
    for (const c of thread.children) {
      if (c === el) return y;
      y += heightOf(c);
    }
    return null;
  };
  const queueScroll = () => pendingScroll.count++;
  const setTop = (v) => {
    const next = Math.max(0, Math.min(maxTop(), v));
    if (next !== sim.top) {
      sim.top = next;
      queueScroll();
    }
  };

  const EP = win.Element.prototype;
  // The page column is <body>: its left edge is the app navigation (`nav`), its right edge shrinks by the
  // rail's reserved padding, and the centered conversation/composer (768 wide at most) follow it.
  let navWidth = nav;
  const reservedOf = (el) => parseFloat(el.style.getPropertyValue("--gs-reserve")) || 0;
  const reservedLeftOf = (el) => parseFloat(el.style.getPropertyValue("--gs-reserve-left")) || 0;
  const reserved = () => reservedOf(overlay ? scroller : doc.body);
  const paneState = { opts: { width: 360, reserves: true, outputs: true, sources: true, ...pane }, el: null, shown: true };
  const paneTaken = () => (paneState.el?.isConnected && paneState.shown && paneState.opts.reserves ? paneState.opts.width : 0);
  // The column's own box does not move with our padding (as in a browser); only the content inside it does.
  const columnRect = () => ({ left: navWidth, right: win.innerWidth - paneTaken() });
  const paddedRect = (el = overlay ? scroller : doc.body) => ({ left: navWidth + reservedLeftOf(el), right: win.innerWidth - paneTaken() - reservedOf(el) });
  const contentRect = (top, height, el) => {
    const col = paddedRect(el);
    const width = Math.min(768, col.right - col.left - 32);
    const left = col.left + (col.right - col.left - width) / 2;
    return { top, bottom: top + height, height, left, right: left + width, width, x: left, y: top };
  };
  const inPane = (el) => !!paneState.el && paneState.el.contains(el);
  const headerEl = () => doc.getElementById("page-header");
  EP.getBoundingClientRect = function () {
    const head = headerEl();
    if (head && (this === head || head.contains(this)) && !this.closest("[data-gs-ui]")) {
      const col = columnRect();
      if (this === head) return { top: 0, bottom: 56, height: 56, left: col.left, right: col.right, width: col.right - col.left, x: col.left, y: 0 };
      const btns = [...head.querySelectorAll("button")];
      const i = btns.indexOf(this);
      if (i >= 0) {
        const right = col.right - 16 - (btns.length - 1 - i) * 44;
        return { top: 8, bottom: 48, height: 40, left: right - 40, right, width: 40, x: right - 40, y: 8 };
      }
    }
    return baseRect.call(this);
  };
  const baseRect = function () {
    if (inPane(this) && !this.closest("[data-gs-ui]")) {
      if (!paneState.shown) return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0 };
      const left = win.innerWidth - paneState.opts.width;
      const rect = this === paneState.el
        ? { top: 0, bottom: viewport, height: viewport, left, right: win.innerWidth, width: paneState.opts.width }
        : { top: 40, bottom: 64, height: 24, left: left + 16, right: left + 216, width: 200 };
      return { ...rect, x: rect.left, y: rect.top };
    }
    if (this === doc.body || (overlay && this === scroller)) {
      const col = columnRect();
      return { top: 0, bottom: viewport, height: viewport, left: col.left, right: col.right, width: col.right - col.left, x: col.left, y: 0 };
    }
    if (this.id === "composer") return contentRect(viewport - 120, 100, overlay ? doc.getElementById("overlay") : doc.body);
    let top = 0;
    let height = 0;
    if (this === scroller) height = viewport;
    else if (this.parentElement === thread || this.parentElement?.__wrap) {
      const unit = this.parentElement === thread ? this : this.parentElement;
      top = topOf(unit) - sim.top;
      height = heightOf(unit);
      return contentRect(top, height);
    }
    return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top };
  };
  EP.scrollIntoView = function () {
    if (this.parentElement === thread) setTop(topOf(this));
  };
  EP.scrollTo = function (arg) {
    if (this === scroller) setTop(typeof arg === "object" ? arg.top : arg);
  };
  EP.scroll = EP.scrollTo;
  EP.scrollBy = function (arg) {
    if (this === scroller) setTop(sim.top + (typeof arg === "object" ? arg.top : arg));
  };
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => sim.top, set: setTop });
  Object.defineProperty(scroller, "scrollHeight", { get: scrollHeight });
  Object.defineProperty(scroller, "clientHeight", { get: () => viewport });

  // The rail's prompt list needs just enough layout to scroll: 40px rows, 200px viewport.
  const isList = (el) => el.classList?.contains("gs-prompts");
  const listMax = (el) => Math.max(0, el.children.length * 40 - 200);
  Object.defineProperty(EP, "scrollHeight", { configurable: true, get() { return isList(this) ? this.children.length * 40 : 0; } });
  Object.defineProperty(EP, "clientHeight", { configurable: true, get() { return isList(this) ? 200 : 0; } });
  Object.defineProperty(EP, "scrollTop", {
    configurable: true,
    get() { return this.__st ?? 0; },
    set(v) {
      const next = isList(this) ? Math.max(0, Math.min(listMax(this), v)) : v;
      if (next !== (this.__st ?? 0)) { this.__st = next; this.dispatchEvent(new win.Event("scroll")); }
    },
  });
  Object.defineProperty(EP, "offsetTop", { configurable: true, get() { return this.classList?.contains("gs-prompt") ? [...this.parentElement.parentElement.children].indexOf(this.parentElement) * 40 : 0; } });
  Object.defineProperty(EP, "offsetHeight", { configurable: true, get() { return this.classList?.contains("gs-prompt") ? 40 : 0; } });

  const buildPane = () => {
    const { outputs, sources } = paneState.opts;
    const el = doc.createElement("aside");
    el.id = "native-pane";
    el.setAttribute("aria-label", "Summary");
    if (paneState.opts.html) {
      el.innerHTML = paneState.opts.html;
      return el;
    }
    el.innerHTML =
      `<div class="pane-content">` +
      (outputs ? `<section id="native-outputs"><div class="sec-head"><h3>Outputs</h3></div><ul><li><a href="#out-1">Report</a></li><li><a href="#out-2">Notes</a></li></ul></section>` : "") +
      (sources ? `<section id="native-sources"><div class="sec-head"><h3>Sources</h3></div><ul><li><a href="#src-1">Example source</a></li></ul></section>` : "") +
      `</div>`;
    return el;
  };
  if (pane) {
    paneState.el = buildPane();
    doc.body.append(paneState.el);
  }

  win.requestAnimationFrame = (fn) => rafQueue.push(fn);
  // The observer hub flushes on a timer; queue it so settle() delivers it deterministically.
  win.setTimeout = (fn) => rafQueue.push(fn);
  Object.defineProperty(win.performance, "now", { configurable: true, value: () => clock.t });
  win.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb;
      this.targets = new Set();
      roInstances.push(this);
    }
    observe(el) {
      this.targets.add(el);
      observed.add(el);
      roSizes.set(el, heightOf(el));
    }
    unobserve(el) {
      this.targets.delete(el);
      observed.delete(el);
    }
    disconnect() {
      for (const el of this.targets) observed.delete(el);
      this.targets.clear();
      this.dead = true;
    }
  };

  const TOPICS = ["apples", "pears", "plums", "grapes"];
  const wordy = (n, tag = "p") => `<${tag}>${"lorem ipsum ".repeat(n)}</${tag}>`;
  const codeBlock = (lines) =>
    `<pre><code>${Array.from({ length: lines }, (_, i) => `<span class="tok">line ${i}</span>\n`).join("")}</code></pre>`;
  const table = (rows) =>
    `<table>${Array.from({ length: rows }, (_, i) => `<tr><td>r${i}</td><td>c</td></tr>`).join("")}</table>`;

  let seq = 0;
  const article = (role, inner, h) => {
    const el = doc.createElement("article");
    seq++;
    if (markup === "chatgpt") el.setAttribute("data-testid", `conversation-turn-${seq}`);
    el.innerHTML = markup === "no-role" ? inner : `<div data-message-author-role="${role}">${inner}</div>`;
    el.__h = h;
    return el;
  };
  const addTurn = (i, label = "Prompt") => {
    const heavy = i % 7 === 3;
    if (markup === "real") {
      seq++;
      const wrapper = doc.createElement("div");
      const turn = doc.createElement("div");
      turn.setAttribute("data-turn-key", `bbb2${String(seq).padStart(4, "0")}-0000-0000-0000-000000000000`);
      turn.innerHTML =
        `<div data-user-message-bubble="true">${label} ${i} about ${TOPICS[i % TOPICS.length]}</div>` +
        `<div data-conversation-role="assistant">${wordy(40)}${heavy ? "<h2>Details</h2>" + codeBlock(300) + table(40) : ""}${wordy(10)}</div>`;
      turn.__h = 90 + (i % 3) * 20 + (heavy ? 1400 : 300 + (i % 4) * 60);
      wrapper.__wrap = true;
      wrapper.append(turn);
      thread.append(wrapper);
      return;
    }
    thread.append(article("user", `${label} ${i} about ${TOPICS[i % TOPICS.length]}`, 90 + (i % 3) * 20));
    thread.append(
      article(
        "assistant",
        wordy(40) + (heavy ? "<h2>Details</h2>" + codeBlock(300) + table(40) + '<img alt="chart" src="x.png">' : "") + wordy(10),
        heavy ? 1400 : 300 + (i % 4) * 60,
      ),
    );
  };
  if (markup === "real") {
    scroller.removeAttribute("data-scroll-root");
    scroller.setAttribute("data-app-action-timeline-scroll", "");
    thread.setAttribute("data-thread-find-target", "conversation");
    const form = doc.getElementById("composer");
    form.setAttribute("data-chatgpt-composer", "");
    form.innerHTML = '<div contenteditable="true" role="textbox" aria-label="Ask"></div>';
  }
  for (let i = 0; i < turns; i++) addTurn(i);
  sim.top = maxTop();

  const api = {
    dom,
    win,
    doc,
    scroller,
    get thread() {
      return thread;
    },
    clock,
    scrollEvents,
    /** The conversation root swapped for a new element, as a route change can do. */
    replaceThread(count = 0) {
      const next = doc.createElement("main");
      next.id = "thread";
      if (markup === "real") next.setAttribute("data-thread-find-target", "conversation");
      thread.replaceWith(next);
      thread = next;
      for (let i = 0; i < count; i++) addTurn(i);
      sim.top = Math.min(sim.top, maxTop());
    },
    /** The app navigation changed width (ChatGPT's own sidebar opening or closing). */
    setNav(w) {
      navWidth = w;
    },
    reserve: reserved,
    reserveLeft: () => reservedLeftOf(overlay ? scroller : doc.body),
    get pane() {
      return paneState.el;
    },
    paneWidth: () => paneState.opts.width,
    mountPane(opts) {
      Object.assign(paneState.opts, opts);
      paneState.el?.remove();
      paneState.el = buildPane();
      paneState.shown = true;
      doc.body.append(paneState.el);
      return paneState.el;
    },
    unmountPane() {
      paneState.el?.remove();
    },
    /** Mounted but not displayed (a closed pane): no box, nothing visible. */
    hidePane(hidden = true) {
      paneState.shown = !hidden;
    },
    /** Swap the whole conversation root, as a route change does; returns the previous one. */
    swapThread(next) {
      const prev = thread;
      thread.replaceWith(next);
      thread = next;
      sim.top = Math.min(maxTop(), sim.top);
      return prev;
    },
    /** A detached conversation root with `count` turns of its own (`label` names its prompts). */
    buildThread(count, label = "Other") {
      const before = thread;
      const holder = doc.createElement("main");
      holder.id = "thread";
      if (markup === "real") holder.setAttribute("data-thread-find-target", "conversation");
      thread = holder;
      for (let i = 0; i < count; i++) addTurn(i, label);
      thread = before;
      return holder;
    },
    removeComposer() {
      const form = doc.getElementById("composer");
      form.remove();
      return form;
    },
    addComposer(form) {
      doc.body.append(form);
    },
    addTurn: () => addTurn(thread.children.length),
    elements: () => [...thread.children],
    setHeight(el, h) {
      el.__h = h;
    },
    setTop,
    rawTop: () => sim.top,
    maxTop,
    scrollHeight,
    viewport,
    topOf,
    /** First element intersecting the viewport and its pixel offset. */
    anchor() {
      for (const el of thread.children) {
        const r = el.getBoundingClientRect();
        if (r.bottom > 0) return { id: el.getAttribute("data-testid"), offset: r.top };
      }
      return null;
    },
    /** Elements intersecting the viewport that are not rendered (blank gap). */
    blankInViewport() {
      return [...thread.children].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < viewport && el.getAttribute("data-gs-state") === "inactive";
      });
    },
    /** A user wheel scroll: input event first, then the scroll. */
    wheel(dy) {
      scroller.dispatchEvent(new win.Event("wheel", { bubbles: true }));
      setTop(sim.top + dy);
    },
    /** What ChatGPT-style page code does on streaming: every autoscroll flavour. */
    pageAutoscroll() {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.scrollTo({ top: scroller.scrollHeight });
      scroller.scrollBy({ top: 500 });
      thread.lastElementChild.scrollIntoView({ block: "end" });
    },
    /** Scroll that bypasses every JS API, like native scroll anchoring would. */
    nativeJump(v) {
      setTop(v);
    },
    stream(el, extraHeight, text = "token ") {
      el.firstElementChild.append(doc.createTextNode(text));
      el.__h += extraHeight;
    },
    /** Simulate React remounting every turn node. */
    remount() {
      const old = [...thread.children];
      for (const el of old) {
        const fresh = el.cloneNode(true);
        fresh.removeAttribute("data-gs-state");
        fresh.style.removeProperty("--gs-h");
        if (!fresh.getAttribute("style")) fresh.removeAttribute("style");
        fresh.__h = el.__h;
        el.replaceWith(fresh);
      }
    },
    /** Deliver queued mutations, resizes, animation frames and scroll events until quiet. */
    async settle() {
      for (let round = 0; round < 25; round++) {
        let did = false;
        await Promise.resolve();
        for (const ro of roInstances) {
          if (ro.dead) continue;
          const changed = [...ro.targets].filter((el) => roSizes.get(el) !== heightOf(el));
          for (const el of ro.targets) roSizes.set(el, heightOf(el));
          if (changed.length) {
            did = true;
            ro.cb(changed.map((target) => ({ target, contentRect: { height: heightOf(target) } })));
          }
        }
        const frames = rafQueue.splice(0);
        if (frames.length) did = true;
        frames.forEach((f) => f());
        while (pendingScroll.count > 0) {
          pendingScroll.count--;
          did = true;
          scroller.dispatchEvent(new win.Event("scroll"));
        }
        await new Promise((r) => setImmediate(r));
        if (!did) break;
      }
    },
    advance(ms) {
      clock.t += ms;
    },
    observedTargets: () => observed.size,
    counts() {
      const total = scroller.querySelectorAll("*").length;
      let skipped = 0;
      for (const el of thread.children) {
        if (el.getAttribute("data-gs-state") === "inactive") skipped += el.querySelectorAll("*").length;
      }
      const activeElements = [...thread.children].filter((el) => el.getAttribute("data-gs-state") !== "inactive");
      return { total, rendered: total - skipped, activeElements: activeElements.length };
    },
  };
  scroller.addEventListener("scroll", () => scrollEvents.push(sim.top));
  return api;
}
