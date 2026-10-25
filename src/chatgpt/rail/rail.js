import { searchPrompts } from "../../core/prompt-index.js";
import { buildTurnModel, layoutBars, scrollTopForFraction, viewportIndicator } from "./minimap-model.js";

const RAIL_WIDTH = 296;
const DOCK_MIN_VIEWPORT = 1100;
const STYLE_ID = "gs-rail-style";
const ACCENT = "#19c37d";

// Layout contract (owner reference): a right column of two collapsible cards,
// "Conversation overview" (minimap) above "Prompts", anchored bottom-right and
// growing upward. Docked only when the free right gutter fits it, so the
// conversation column is never narrowed; otherwise it collapses to a toggle that
// opens the same cards above the composer. Nothing is wider than the viewport.
const CSS = `
.gs-rail{position:fixed;right:12px;bottom:16px;z-index:40;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:calc(100vw - 24px);box-sizing:border-box;font:13px/1.35 system-ui,sans-serif;color:var(--text-primary,#ececec)}
.gs-rail *{box-sizing:border-box}
.gs-rail[data-gs-mode="collapsed"]{bottom:var(--gs-rail-bottom,96px)}
.gs-rail-panel{display:flex;flex-direction:column;gap:12px;width:${RAIL_WIDTH}px;max-width:calc(100vw - 24px);max-height:min(calc(100vh - 72px),calc(100vh - var(--gs-rail-bottom,16px) - 72px));min-height:0}
.gs-rail[data-gs-mode="docked"] .gs-rail-panel{max-height:calc(100vh - 72px)}
.gs-rail[data-gs-open="false"] .gs-rail-panel{display:none}
.gs-card{display:flex;flex-direction:column;min-height:0;border:1px solid var(--border-light,rgba(128,128,128,.35));border-radius:12px;background:var(--main-surface-primary,#212121)}
.gs-card-prompts{flex:1 1 auto}
.gs-card-head{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:44px;padding:8px 14px;border:0;background:transparent;color:inherit;font:inherit;font-weight:600;font-size:14px;cursor:pointer}
.gs-card-prompts .gs-card-title{color:#6aa9ff;text-decoration:underline;text-underline-offset:3px}
.gs-chevron{display:inline-block;width:8px;height:8px;border:solid currentColor;border-width:2px 0 0 2px;transform:rotate(45deg) translate(2px,2px);transition:transform .15s}
.gs-card[data-gs-collapsed="true"] .gs-chevron{transform:rotate(225deg) translate(2px,2px)}
.gs-card-body{display:flex;flex-direction:column;min-height:0;padding:0 12px 12px}
.gs-card-prompts .gs-card-body{flex:1 1 auto}
.gs-card[data-gs-collapsed="true"] .gs-card-body{display:none}
.gs-minimap{position:relative;flex:0 0 auto;height:min(250px,32vh);border:1px solid var(--border-light,rgba(128,128,128,.35));border-radius:8px;background:rgba(128,128,128,.08);cursor:pointer;touch-action:none;overflow:hidden}
.gs-minimap:focus-visible,.gs-search input:focus-visible,.gs-prompt:focus-visible,.gs-rail-toggle:focus-visible,.gs-card-head:focus-visible,.gs-filter:focus-visible,.gs-jump:focus-visible{outline:2px solid ${ACCENT};outline-offset:1px}
.gs-bar{position:absolute;left:12%;min-height:2px;border-radius:2px;background:rgba(160,160,160,.5)}
.gs-bar[data-kind="heading"]{background:rgba(220,220,220,.8)}
.gs-bar[data-kind="code"]{background:rgba(106,169,255,.55)}
.gs-bar[data-kind="table"]{background:rgba(25,195,125,.45)}
.gs-bar[data-kind="image"]{background:rgba(255,160,90,.55)}
.gs-view{position:absolute;left:4px;right:4px;border:2px solid ${ACCENT};border-radius:3px;background:rgba(25,195,125,.2);pointer-events:none}
.gs-view::before,.gs-view::after{content:"";position:absolute;top:50%;width:6px;height:6px;margin-top:-3px;border-radius:50%;background:#fff;border:1px solid ${ACCENT}}
.gs-view::before{left:-5px}.gs-view::after{right:-5px}
.gs-caption{margin-top:8px;font-size:12px;opacity:.7}
.gs-search{display:flex;flex:0 0 auto;gap:6px;align-items:center;margin-bottom:8px}
.gs-search-field{position:relative;flex:1 1 auto;min-width:0}
.gs-search-field::before{content:"";position:absolute;left:10px;top:50%;width:9px;height:9px;margin-top:-6px;border:2px solid currentColor;border-radius:50%;opacity:.6;pointer-events:none}
.gs-search input{width:100%;min-height:36px;padding:4px 8px 4px 30px;border:1px solid var(--border-light,rgba(128,128,128,.35));border-radius:10px;background:rgba(128,128,128,.1);color:inherit;font:inherit}
.gs-filter{flex:0 0 auto;width:36px;height:36px;border:1px solid var(--border-light,rgba(128,128,128,.35));border-radius:10px;background:rgba(128,128,128,.1);color:inherit;cursor:pointer}
.gs-filter[aria-pressed="true"]{border-color:${ACCENT};color:${ACCENT}}
.gs-prompts{flex:1 1 auto;min-height:60px;margin:0;padding:0;list-style:none;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}
.gs-prompt{position:relative;display:flex;gap:10px;width:100%;min-height:48px;padding:6px 26px 6px 10px;border:0;border-left:3px solid transparent;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.gs-prompt:hover{background:rgba(128,128,128,.12)}
.gs-prompt[aria-current="true"]{background:rgba(25,195,125,.16);border-left-color:${ACCENT}}
.gs-prompt[data-in-view="true"]::after{content:"";position:absolute;right:10px;top:50%;width:6px;height:6px;margin-top:-3px;border-radius:50%;background:${ACCENT}}
.gs-n{flex:0 0 auto;min-width:3ch;opacity:.75}
.gs-copy{display:flex;flex:1 1 auto;flex-direction:column;min-width:0}
.gs-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-preview{font-size:12px;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-empty{padding:8px;opacity:.6}
.gs-jumps{display:flex;flex:0 0 auto;flex-direction:column;gap:2px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border-light,rgba(128,128,128,.25))}
.gs-jump{display:flex;gap:8px;align-items:center;min-height:28px;padding:2px 4px;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;opacity:.8;text-align:left;cursor:pointer}
.gs-jump:hover{opacity:1;text-decoration:underline}
.gs-rail-toggle{display:none;min-width:44px;min-height:44px;border:1px solid var(--border-light,rgba(128,128,128,.35));border-radius:22px;background:var(--main-surface-primary,#212121);color:inherit;cursor:pointer}
.gs-rail[data-gs-mode="collapsed"] .gs-rail-toggle{display:block}
`;

/** Title = first sentence of the prompt; preview = what follows, else the start of the reply. */
export function describePrompt(text, reply = "") {
  const clean = text.replace(/\s+/g, " ").trim();
  const m = clean.match(/^(.{1,60}?)(?:[.?!:]\s+|$)/);
  const title = (m ? m[1] : clean.slice(0, 60)).trim() || clean.slice(0, 60);
  const rest = clean.slice(title.length).replace(/^[.?!:\s]+/, "");
  const preview = (rest || reply.replace(/\s+/g, " ").trim()).slice(0, 100);
  return { title, preview };
}

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
  let signature = null;
  let query = "";
  let activeId = null;
  let open = false;
  let inViewOnly = false;
  let viewSet = new Set();
  let listPinned = true;
  let listManual = false;
  let modelKey = "";
  let modelBuiltAt = -Infinity;
  let forceModel = false;
  let trailing = null;
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
      <section class="gs-card gs-card-overview" data-gs-collapsed="false">
        <button type="button" class="gs-card-head" aria-expanded="true" aria-controls="gs-overview-body"><span class="gs-card-title">Conversation overview</span><span class="gs-chevron" aria-hidden="true"></span></button>
        <div class="gs-card-body" id="gs-overview-body">
          <div class="gs-minimap" tabindex="0" role="slider" aria-orientation="vertical" aria-label="Current turn overview" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="gs-bars"></div><div class="gs-view" hidden></div></div>
          <div class="gs-caption" aria-live="off">Drag to navigate • 0% visible</div>
        </div>
      </section>
      <section class="gs-card gs-card-prompts" data-gs-collapsed="false">
        <button type="button" class="gs-card-head" aria-expanded="true" aria-controls="gs-prompts-body"><span class="gs-card-title">Prompts</span><span class="gs-chevron" aria-hidden="true"></span></button>
        <div class="gs-card-body" id="gs-prompts-body">
          <div class="gs-search"><div class="gs-search-field"><input type="search" placeholder="Search prompts..." aria-label="Search prompts"></div><button type="button" class="gs-filter" aria-pressed="false" aria-label="Only prompts in view" title="Only prompts in view">&#9776;</button></div>
          <ol class="gs-prompts" aria-label="Prompts, oldest first"></ol>
          <div class="gs-jumps"><button type="button" class="gs-jump gs-first">&uarr; First prompt (oldest)</button><button type="button" class="gs-jump gs-last">&darr; Last prompt (newest)</button></div>
        </div>
      </section>
    </div>
    <button type="button" class="gs-rail-toggle" aria-controls="gs-rail-panel" aria-expanded="false" aria-label="Conversation navigator">&#9776;</button>`;
  doc.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const panel = $(".gs-rail-panel");
  const minimap = $(".gs-minimap");
  const bars = $(".gs-bars");
  const view = $(".gs-view");
  const overviewCard = $(".gs-card-overview");
  const caption = $(".gs-caption");
  const filterBtn = $(".gs-filter");
  const input = $(".gs-search input");
  const list = $(".gs-prompts");
  const toggle = $(".gs-rail-toggle");

  const cleanups = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  // Change-only DOM writes everywhere: an idle or streaming page must see no writes from the rail.
  function setOpen(next) {
    open = next;
    if (root.dataset.gsOpen !== String(next)) root.dataset.gsOpen = String(next);
    if (toggle.getAttribute("aria-expanded") !== String(next)) toggle.setAttribute("aria-expanded", String(next));
  }

  /** Dock only when the free right gutter fits the rail; otherwise collapse to the toggle. */
  function layout() {
    const first = els[0];
    const gutter = first ? win.innerWidth - first.getBoundingClientRect().right : win.innerWidth;
    const docked = win.innerWidth >= DOCK_MIN_VIEWPORT && gutter >= RAIL_WIDTH + 24;
    const was = root.dataset.gsMode;
    if (was !== (docked ? "docked" : "collapsed")) root.dataset.gsMode = docked ? "docked" : "collapsed";
    if (docked) setOpen(true);
    else if (was === "docked") setOpen(false);
    const composer = adapter.composer(doc);
    const rect = composer?.getBoundingClientRect();
    const bottom = rect?.height ? `${Math.max(16, Math.round(win.innerHeight - rect.top + 8))}px` : "96px";
    if (root.style.getPropertyValue("--gs-rail-bottom") !== bottom) root.style.setProperty("--gs-rail-bottom", bottom);
  }

  function promptEnd(i) {
    return (prompts[i + 1]?.turnIndex ?? els.length) - 1;
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
      const { title, preview } = describePrompt(p.text, els[p.turnIndex + 1]?.textContent ?? "");
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

  /** Prompts whose turn is on screen get a dot; only the changed rows are touched. */
  function updateInView() {
    const next = new Set();
    if (els.length && prompts.length) {
      const base = scroller.getBoundingClientRect().top;
      const bottom = base + scrollerHeight();
      const firstVisible = firstElementBelow(base + 1);
      let lastVisible = firstVisible;
      while (lastVisible + 1 < els.length && els[lastVisible + 1].getBoundingClientRect().top < bottom) lastVisible++;
      prompts.forEach((p, i) => {
        if (p.turnIndex <= lastVisible && promptEnd(i) >= firstVisible) next.add(p.id);
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
      const mid = (lo + hi) >> 1;
      if (els[mid].getBoundingClientRect().bottom > y) hi = mid;
      else lo = mid + 1;
    }
    return lo;
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
    if (!ext || overviewCard.dataset.gsCollapsed === "true") return;
    const key = `${activeId}:${els.slice(prompts[ext.i].turnIndex, promptEnd(ext.i) + 1).map((e) => e.textContent.length).join(",")}`;
    // A growing (streaming) turn rebuilds its overview at most twice a second.
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
      const model = buildTurnModel(adapter.blocks(els.slice(prompts[ext.i].turnIndex, promptEnd(ext.i) + 1)));
      bars.textContent = "";
      for (const b of layoutBars(model)) {
        const d = doc.createElement("div");
        d.className = "gs-bar";
        d.dataset.kind = b.kind;
        d.style.cssText = `top:${(b.top * 100).toFixed(2)}%;height:${(b.height * 100).toFixed(2)}%;width:${(b.width * 76).toFixed(1)}%`;
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
    // Only write on change: any DOM write under body re-triggers the prompt-index observer.
    const text = `Drag to navigate • ${ind ? Math.round(ind.visible * 100) : 0}% visible`;
    if (caption.textContent !== text) caption.textContent = text;
    if (ind) {
      view.style.top = `${(ind.top * 100).toFixed(2)}%`;
      view.style.height = `${(ind.height * 100).toFixed(2)}%`;
      const now = String(Math.round(ind.top * 100));
      if (minimap.getAttribute("aria-valuenow") !== now) minimap.setAttribute("aria-valuenow", now);
    }
  }

  function scrollerHeight() {
    return scroller.clientHeight || scroller.getBoundingClientRect().height;
  }

  /** Active prompt = the one whose turn holds the first element on screen; the newest at the bottom. */
  function detectActive() {
    if (!els.length || !prompts.length) return null;
    if (scroller.scrollTop + scrollerHeight() >= scroller.scrollHeight - 2) return prompts.at(-1).id;
    const lo = firstElementBelow(scroller.getBoundingClientRect().top + 1);
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
    updateInView();
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
  for (const head of root.querySelectorAll(".gs-card-head")) {
    on(head, "click", () => {
      const card = head.closest(".gs-card");
      const collapsed = card.dataset.gsCollapsed !== "true";
      card.dataset.gsCollapsed = String(collapsed);
      head.setAttribute("aria-expanded", String(!collapsed));
      if (!collapsed) {
        modelKey = "";
        schedule();
        if (card.classList.contains("gs-card-prompts") && listPinned) list.scrollTop = list.scrollHeight;
      }
    });
  }
  on(filterBtn, "click", () => {
    inViewOnly = !inViewOnly;
    filterBtn.setAttribute("aria-pressed", String(inViewOnly));
    renderList();
  });
  on($(".gs-first"), "click", () => {
    if (!prompts[0]) return;
    select(prompts[0]);
    list.scrollTop = 0;
  });
  on($(".gs-last"), "click", () => {
    if (!prompts.length) return;
    select(prompts.at(-1));
    listPinned = true;
    list.scrollTop = list.scrollHeight;
  });
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
      if (trailing) win.clearTimeout(trailing);
      cleanups.forEach((fn) => fn());
      root.remove();
      style.remove();
    },
  };
  return api;
}
