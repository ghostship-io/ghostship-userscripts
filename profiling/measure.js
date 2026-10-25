// READ-ONLY page profiler. Evaluate this whole file in a chatgpt.com thread tab
// (browser tool `eval`, or the DevTools console). It installs passive recorders
// and exposes window.__gsProfile; it never clicks, types, scrolls, sends,
// requests, or writes to the DOM, storage or the network. Results are numbers
// only: no message text, titles, URLs or ids.
//
//   window.__gsProfile.start("thread-A")   // begin recording (label is yours, not the title)
//   ... drive real wheel/keyboard scrolling with the browser tool ...
//   JSON.stringify(window.__gsProfile.stop())
(() => {
  const w = window;
  const d = document;
  if (w.__gsProfile && w.__gsProfile.dispose) w.__gsProfile.dispose();

  const TURN = '[data-testid^="conversation-turn-"]';
  const INTENT_MS = 500;
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
  const now = () => w.performance.now();
  const round = (n, p = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : null);
  const supported = (type) => !!(w.PerformanceObserver && (w.PerformanceObserver.supportedEntryTypes || []).includes(type));

  function findScroller() {
    const marked = d.querySelector("[data-scroll-root]");
    if (marked) return marked;
    for (let el = d.querySelector(TURN)?.parentElement; el && el !== d.body; el = el.parentElement) {
      const overflow = w.getComputedStyle(el).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight + 1) return el;
    }
    return d.scrollingElement || d.documentElement;
  }

  function domCounts(scroller) {
    const total = d.getElementsByTagName("*").length;
    let skipped = 0;
    // Turns skipped by the virtualizer keep their nodes but are not rendered.
    for (const el of d.querySelectorAll('[data-gs-state="inactive"]')) skipped += el.getElementsByTagName("*").length;
    return {
      totalNodes: total,
      renderedNodes: total - skipped,
      scrollerNodes: scroller.getElementsByTagName("*").length,
      turnElements: d.querySelectorAll(TURN).length,
    };
  }

  const heapMB = () => (w.performance.memory ? round(w.performance.memory.usedJSHeapSize / 1048576) : null);

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  }

  function isRevealed(scroller) {
    const oldest = d.querySelector(TURN);
    if (!oldest || oldest.getAttribute("data-gs-state") === "inactive") return false;
    const rect = oldest.getBoundingClientRect();
    const view = scroller === d.scrollingElement || scroller === d.documentElement ? { top: 0, bottom: w.innerHeight } : scroller.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom && !!oldest.querySelector("[data-message-author-role]");
  }

  let rec = null;

  function start(label) {
    if (rec) stopRecording();
    const scroller = findScroller();
    const pageScroll = scroller === d.scrollingElement || scroller === d.documentElement || scroller === d.body;
    const topOf = () => (pageScroll ? w.scrollY : scroller.scrollTop);
    const r = {
      label: String(label || "unlabelled"),
      t0: now(),
      scroller,
      dom0: domCounts(scroller),
      heap: { start: heapMB(), max: heapMB() },
      loaf: { entries: 0, totalMs: 0, blockingMs: 0, maxMs: 0, over100: 0 },
      cls: 0,
      frames: { gaps: [], last: null },
      scroll: { events: 0, userEvents: 0, unsolicitedEvents: 0, unsolicitedPx: 0, maxUnsolicitedPx: 0, netPx: 0, last: topOf() },
      firstIntent: null,
      lastIntent: -Infinity,
      pointerHeld: false,
      revealMs: null,
      observers: [],
      cleanup: [],
      raf: 0,
      stopped: false,
    };
    rec = r;

    const intent = () => {
      r.lastIntent = now();
      if (r.firstIntent === null) r.firstIntent = r.lastIntent;
    };
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      r.cleanup.push(() => target.removeEventListener(type, fn, opts));
    };
    const passive = { capture: true, passive: true };
    for (const type of ["wheel", "touchstart", "touchmove"]) on(w, type, intent, passive);
    on(w, "keydown", (e) => SCROLL_KEYS.has(e.key) && intent(), passive);
    on(w, "pointerdown", () => { r.pointerHeld = true; intent(); }, passive);
    on(w, "pointerup", () => { r.pointerHeld = false; r.lastIntent = now(); }, passive);
    on(w, "pointercancel", () => { r.pointerHeld = false; }, passive);

    on(pageScroll ? d : scroller, "scroll", () => {
      const top = topOf();
      const delta = top - r.scroll.last;
      r.scroll.last = top;
      r.scroll.events++;
      r.scroll.netPx += delta;
      if (r.pointerHeld || now() - r.lastIntent <= INTENT_MS) r.scroll.userEvents++;
      else if (Math.abs(delta) > 1) {
        r.scroll.unsolicitedEvents++;
        r.scroll.unsolicitedPx += Math.abs(delta);
        r.scroll.maxUnsolicitedPx = Math.max(r.scroll.maxUnsolicitedPx, Math.abs(delta));
      }
      checkReveal();
    }, { passive: true });

    function checkReveal() {
      if (r.revealMs === null && r.firstIntent !== null && isRevealed(scroller)) r.revealMs = round(now() - r.firstIntent);
    }

    const observe = (type, onEntries) => {
      if (!supported(type)) return false;
      const po = new w.PerformanceObserver((list) => onEntries(list.getEntries()));
      po.observe({ type, buffered: false });
      r.observers.push(po);
      return true;
    };
    r.loafType = observe("long-animation-frame", (entries) => {
      for (const e of entries) {
        r.loaf.entries++;
        r.loaf.totalMs += e.duration;
        r.loaf.blockingMs += e.blockingDuration || 0;
        r.loaf.maxMs = Math.max(r.loaf.maxMs, e.duration);
        if (e.duration > 100) r.loaf.over100++;
      }
    })
      ? "long-animation-frame"
      : observe("longtask", (entries) => {
          for (const e of entries) {
            r.loaf.entries++;
            r.loaf.totalMs += e.duration;
            r.loaf.maxMs = Math.max(r.loaf.maxMs, e.duration);
            if (e.duration > 100) r.loaf.over100++;
          }
        })
        ? "longtask"
        : null;
    observe("layout-shift", (entries) => {
      for (const e of entries) if (!e.hadRecentInput) r.cls += e.value;
    });

    const tick = (t) => {
      if (r.stopped) return;
      if (r.frames.last !== null && r.frames.gaps.length < 50000) r.frames.gaps.push(t - r.frames.last);
      r.frames.last = t;
      const h = heapMB();
      if (h !== null && h > r.heap.max) r.heap.max = h;
      checkReveal();
      r.raf = w.requestAnimationFrame(tick);
    };
    r.raf = w.requestAnimationFrame(tick);
    return { started: true, label: r.label, loaf: r.loafType, heap: heapMB() !== null };
  }

  function stopRecording() {
    if (!rec) return null;
    const r = rec;
    r.stopped = true;
    w.cancelAnimationFrame?.(r.raf);
    r.observers.forEach((po) => po.disconnect());
    r.cleanup.forEach((fn) => fn());
    rec = null;
    return r;
  }

  function stop() {
    const r = rec;
    if (!r) return { error: "not-started" };
    const dom1 = domCounts(r.scroller);
    const heapEnd = heapMB();
    if (heapEnd !== null && heapEnd > r.heap.max) r.heap.max = heapEnd;
    stopRecording();
    const gaps = [...r.frames.gaps].sort((a, b) => a - b);
    const major = /Chrome\/(\d+)/.exec(w.navigator.userAgent || "");
    return {
      schema: 1,
      label: r.label,
      durationMs: round(now() - r.t0),
      env: {
        chromeMajor: major ? Number(major[1]) : null,
        viewport: { w: w.innerWidth, h: w.innerHeight },
        longFrameApi: r.loafType,
        heapApi: heapEnd !== null,
        scriptMode: (w.__ghostshipUserscripts && w.__ghostshipUserscripts.mode) || null,
      },
      dom: { start: r.dom0, end: dom1 },
      loaf: { entries: r.loaf.entries, totalMs: round(r.loaf.totalMs), blockingMs: round(r.loaf.blockingMs), maxMs: round(r.loaf.maxMs), over100: r.loaf.over100 },
      frames: { count: gaps.length, over50: gaps.filter((g) => g > 50).length, maxGapMs: round(gaps[gaps.length - 1] ?? NaN), p95GapMs: round(percentile(gaps, 95) ?? NaN) },
      heapMB: { start: r.heap.start, end: heapEnd, max: heapEnd === null ? null : r.heap.max },
      scroll: {
        events: r.scroll.events,
        userEvents: r.scroll.userEvents,
        unsolicitedEvents: r.scroll.unsolicitedEvents,
        unsolicitedPx: round(r.scroll.unsolicitedPx),
        maxUnsolicitedPx: round(r.scroll.maxUnsolicitedPx),
        netPx: round(r.scroll.netPx),
      },
      revealOldestMs: r.revealMs,
      layoutShift: round(r.cls, 4),
    };
  }

  w.__gsProfile = {
    start,
    stop,
    dispose() {
      stopRecording();
      delete w.__gsProfile;
    },
  };
  return { installed: true };
})()
