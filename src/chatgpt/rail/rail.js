import { searchPrompts } from "../../core/prompt-index.js";
import { buildTurnModel, layoutBars, scrollTopForFraction, viewportIndicator } from "./minimap-model.js";

const RAIL_WIDTH = 240;
const DOCK_MIN_VIEWPORT = 1100;
const STYLE_ID = "gs-rail-style";

// Layout contract: one fixed column at the bottom-right that grows upward
// (anchored by `bottom`). Docked only when the free right gutter fits it, so the
// conversation column is never narrowed; otherwise it collapses to a toggle that
// opens the same column above the composer. Nothing is wider than the viewport.
const CSS = `
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

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Right rail: current-turn minimap on top, searchable chronological prompt list
 * below (oldest first, newest last, list kept scrolled to the bottom while the
 * latest is in view). It never writes scroll position itself: every jump goes
 * through `runtime.navigateTo` (prompt selection, which also activates
 * virtualized-out turns) or `runtime.scroll.scrollTo` (minimap, keyboard).
 * Re-renders follow the runtime's prompt index; no observers of its own.
 */
export function createRail({ win, adapter, runtime }) {
  const doc = win.document;
  const scroller = adapter.scroller(doc);
  const scroll = runtime.scroll;
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
    <button type="button" class="gs-rail-toggle" aria-controls="gs-rail-panel" aria-expanded="false" aria-label="Conversation navigator">☰</button>`;
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

  /** Dock only when the free right gutter fits the rail; otherwise collapse to the toggle. */
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
    for (const b of list.querySelectorAll(".gs-prompt")) {
      const cur = b.dataset.id === activeId;
      b.setAttribute("aria-current", String(cur));
      b.tabIndex = cur ? 0 : -1;
    }
    const b = list.querySelector('[aria-current="true"]');
    if (b && !listManual && !listPinned) {
      // Keep the active item visible without touching the conversation scroller.
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
      viewBottom: sTop + scrollerHeight(),
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

  /** Active prompt = the one whose turn holds the first element on screen; the newest at the bottom. */
  function detectActive() {
    if (!els.length || !prompts.length) return null;
    if (scroller.scrollTop + scrollerHeight() >= scroller.scrollHeight - 2) return prompts.at(-1).id;
    const base = scroller.getBoundingClientRect().top + 1;
    let lo = 0;
    let hi = els.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
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
    if (el) runtime.navigateTo(el, { offset: 0 });
    modelKey = "";
    renderMinimap();
  }

  function jumpFromPointer(clientY) {
    const ext = turnExtent();
    if (!ext) return;
    const r = minimap.getBoundingClientRect();
    const fraction = clamp(r.height ? (clientY - r.top) / r.height : 0, 0, 1);
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
    if (!ext || (step === undefined && e.key !== "Home" && e.key !== "End")) return;
    e.preventDefault();
    const sRect = scroller.getBoundingClientRect();
    const turnTop = scroller.scrollTop + (ext.a.getBoundingClientRect().top - sRect.top);
    const turnHeight = ext.z.getBoundingClientRect().bottom - ext.a.getBoundingClientRect().top;
    const viewH = scrollerHeight();
    const max = turnTop + Math.max(0, turnHeight - viewH);
    const next = e.key === "Home" ? turnTop : e.key === "End" ? max : scroller.scrollTop + step * Math.max(turnHeight, viewH);
    scroll.scrollTo("keyboard", clamp(next, turnTop, max));
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
    if (to === undefined || !items.length) return;
    e.preventDefault();
    const next = items[clamp(to, 0, items.length - 1)];
    items.forEach((b) => (b.tabIndex = b === next ? 0 : -1));
    next.focus();
    if (next.offsetTop < list.scrollTop) list.scrollTop = next.offsetTop;
    else if (next.offsetTop + next.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = next.offsetTop + next.offsetHeight - list.clientHeight;
  });
  // Manual list scrolling is respected: only "at the bottom" re-pins it to the newest prompt.
  on(list, "scroll", () => {
    listPinned = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
  });
  for (const type of ["wheel", "touchmove", "pointerdown"]) on(list, type, () => (listManual = true), { passive: true });
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
  cleanups.push(runtime.onIndexChange(refresh));
  cleanups.push(runtime.onFallback(() => api.dispose()));
  refresh(runtime.promptIndex);
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
    },
  };
  return api;
}
