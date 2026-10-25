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
export function createFixture({ turns = 40, viewport = 800, markup = "chatgpt" } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>
      <div id="scroller" data-scroll-root style="overflow-y:auto"><main id="thread"></main></div>
      <form id="composer"><textarea id="prompt-textarea"></textarea></form>
    </body></html>`,
    { pretendToBeVisual: false, runScripts: "outside-only", url: "https://chatgpt.com/c/fixture" },
  );
  const win = dom.window;
  const doc = win.document;
  const scroller = doc.getElementById("scroller");
  const thread = doc.getElementById("thread");
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
  const heightOf = (el) =>
    el.getAttribute("data-gs-state") === "inactive" && placeholder(el) !== null ? placeholder(el) : el.__h ?? 0;
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
  EP.getBoundingClientRect = function () {
    let top = 0;
    let height = 0;
    if (this === scroller) height = viewport;
    else if (this.parentElement === thread) {
      top = topOf(this) - sim.top;
      height = heightOf(this);
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
  const addTurn = (i) => {
    const heavy = i % 7 === 3;
    thread.append(article("user", wordy(5), 90 + (i % 3) * 20));
    thread.append(
      article(
        "assistant",
        wordy(40) + (heavy ? codeBlock(300) + table(40) + '<img alt="chart" src="x.png">' : "") + wordy(10),
        heavy ? 1400 : 300 + (i % 4) * 60,
      ),
    );
  };
  for (let i = 0; i < turns; i++) addTurn(i);
  sim.top = maxTop();

  const api = {
    dom,
    win,
    doc,
    scroller,
    thread,
    clock,
    scrollEvents,
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
