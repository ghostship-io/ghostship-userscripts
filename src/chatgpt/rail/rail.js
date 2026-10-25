import { searchPrompts } from "../../core/prompt-index.js";
import { buildTurnModel, layoutBars, scrollTopForFraction, viewportIndicator } from "./minimap-model.js";
import { LAYOUT_CSS, RAIL_EDGE, RAIL_WIDTH, createRailLayout } from "./rail-layout.js";
import { contentSignature, createRailStateStore } from "./rail-state.js";

const STYLE_ID = "gs-rail-style";
const ACCENT = "#19c37d";

// Layout contract (approved concept): a right column of two collapsible cards,
// "Conversation overview" (minimap) above "Prompts", anchored bottom-right and
// growing upward. Docked, its column is reserved in the page layout (rail-layout.js shifts the
// conversation and composer left by what it needs, never overlapping them); below the dock
// threshold it collapses to a toggle that opens the same cards above the composer.
// Nothing is wider than the viewport.
const CSS = `
.gs-rail{position:fixed;right:${RAIL_EDGE}px;bottom:16px;z-index:40;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:calc(100vw - 24px);box-sizing:border-box;font:13px/1.35 system-ui,sans-serif;color:var(--text-primary,#ececec)}
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
.gs-minimap:focus-visible,.gs-search input:focus-visible,.gs-prompt:focus-visible,.gs-rail-toggle:focus-visible,.gs-card-head:focus-visible,.gs-filter:focus-visible{outline:2px solid ${ACCENT};outline-offset:1px}
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
.gs-prompts{flex:1 1 auto;min-height:60px;margin:0;padding:0;list-style:none;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
.gs-prompt{position:relative;display:flex;gap:10px;width:100%;min-height:48px;padding:6px 26px 6px 10px;border:0;border-left:3px solid transparent;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.gs-prompt:hover{background:rgba(128,128,128,.12)}
.gs-prompt[aria-current="true"]{background:rgba(25,195,125,.16);border-left-color:${ACCENT}}
.gs-prompt[data-in-view="true"]::after{content:"";position:absolute;right:10px;top:50%;width:6px;height:6px;margin-top:-3px;border-radius:50%;background:${ACCENT}}
.gs-n{flex:0 0 auto;min-width:3ch;opacity:.75}
.gs-copy{display:flex;flex:1 1 auto;flex-direction:column;min-width:0}
.gs-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-preview{font-size:12px;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-empty{padding:8px;opacity:.6}
.gs-rail-toggle{display:none;min-width:44px;min-height:44px;border:1px solid var(--border-light,rgba(128,128,128,.35));border-radius:22px;background:var(--main-surface-primary,#212121);color:inherit;cursor:pointer}
.gs-rail[data-gs-mode="collapsed"] .gs-rail-toggle{display:block}
${LAYOUT_CSS}`;

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
const PREVIEW_MAX = 100;

/**
 * Right rail: current-turn minimap on top, searchable chronological prompt list
 * below (oldest first, newest last, list kept scrolled to the bottom while the
 * latest is in view). It never writes scroll position itself: every jump goes
 * through `runtime.navigateTo` (prompt selection, which also activates
 * virtualized-out turns) or `runtime.scroll.scrollTo` (minimap, keyboard).
 * Re-renders follow the runtime's prompt index; no observers of its own.
 *
 * Each conversation keeps its own state (selected prompt, search, filter, card and panel
 * expansion, prompt-list scroll, conversation scroll bookmark) in `store`, which outlives the
 * rail: the boot controller rebuilds the rail on every route change.
 */
export function createRail({ win, adapter, runtime, store = createRailStateStore() }) {
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
  let viewSet = new Set();
  let listPinned = true;
  let listManual = false;
  let modelKey = "";
  let modelBuiltAt = -Infinity;
  let forceModel = false;
  let trailing = null;
  let scheduled = false;
  let layoutQueued = false;
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
  const described = new Map();

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
        </div>
      </section>
    </div>
    <button type="button" class="gs-rail-toggle" aria-controls="gs-rail-panel" aria-expanded="false" aria-label="Conversation navigator">&#9776;</button>`;
  doc.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const minimap = $(".gs-minimap");
  const bars = $(".gs-bars");
  const view = $(".gs-view");
  const overviewCard = $(".gs-card-overview");
  const promptsCard = $(".gs-card-prompts");
  const caption = $(".gs-caption");
  const filterBtn = $(".gs-filter");
  const input = $(".gs-search input");
  const list = $(".gs-prompts");
  const toggle = $(".gs-rail-toggle");
  const railLayout = createRailLayout({ win, adapter, target: () => els[0] });

  const cleanups = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  const setCollapsed = (card, collapsed) => {
    card.dataset.gsCollapsed = String(collapsed);
    card.querySelector(".gs-card-head").setAttribute("aria-expanded", String(!collapsed));
  };

  // Change-only DOM writes everywhere: an idle or streaming page must see no writes from the rail.
  function setOpen(next) {
    open = next;
    if (root.dataset.gsOpen !== String(next)) root.dataset.gsOpen = String(next);
    if (toggle.getAttribute("aria-expanded") !== String(next)) toggle.setAttribute("aria-expanded", String(next));
  }

  // ---- per-conversation state -------------------------------------------------------------

  // The conversation's own panel state needs no DOM: apply it right away.
  if (restore) {
    query = restore.ui.query;
    input.value = query;
    inViewOnly = restore.ui.inViewOnly;
    filterBtn.setAttribute("aria-pressed", String(inViewOnly));
    setCollapsed(overviewCard, restore.ui.overviewCollapsed);
    setCollapsed(promptsCard, restore.ui.promptsCollapsed);
  }

  /** Remember this conversation's state; never from another conversation's (stale) DOM. */
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
      ui: { query, inViewOnly, open, overviewCollapsed: overviewCard.dataset.gsCollapsed === "true", promptsCollapsed: promptsCard.dataset.gsCollapsed === "true" },
      activeId,
      list: { top: list.scrollTop, pinned: listPinned },
      bookmark: bookmark ?? prev?.bookmark ?? null,
    });
  }

  /** The saved content applies once the page shows this conversation's own prompts. Returns true when applied. */
  function applyRestore() {
    if (!restore || !prompts.length) return false;
    const sig = contentSignature(prompts);
    if (sig !== restore.sig) {
      const owner = store.owner(sig);
      if (!owner || owner === convId) restore = null; // different content than saved: start fresh
      return false; // else the page still shows another conversation: wait for its own prompts
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
    // Explicit restore of where the user was reading; reading at the latest needs none (the page opens there).
    if (!mark || mark.bottom || userScrolled) return;
    const el = els.find((e, i) => adapter.turnId(e, i) === mark.id);
    if (el) runtime.navigateTo(el, { offset: mark.offset });
  }

  // ---- layout -----------------------------------------------------------------------------

  /** Reserve the rail's column in the page (or collapse to the toggle) when the page layout changed. */
  function layout() {
    const now = railLayout.signature();
    if (now !== layoutSig) {
      const { docked } = railLayout.evaluate();
      const was = root.dataset.gsMode;
      if (was !== (docked ? "docked" : "collapsed")) root.dataset.gsMode = docked ? "docked" : "collapsed";
      if (docked) setOpen(true);
      else if (was === "docked") setOpen(false);
      layoutSig = railLayout.signature();
    }
    if (root.dataset.gsMode === "collapsed") {
      const rect = adapter.composer(doc)?.getBoundingClientRect();
      const bottom = rect?.height ? `${Math.max(16, Math.round(win.innerHeight - rect.top + 8))}px` : "96px";
      if (root.style.getPropertyValue("--gs-rail-bottom") !== bottom) root.style.setProperty("--gs-rail-bottom", bottom);
    }
  }

  // ---- prompt list ------------------------------------------------------------------------

  function promptEnd(i) {
    return (prompts[i + 1]?.turnIndex ?? els.length) - 1;
  }

  /** Title and one-line preview, cached per prompt so a long thread's replies are not re-read on every render. */
  function describe(p) {
    const cached = described.get(p.id);
    if (cached && cached.len === p.text.length) return cached;
    let d = { len: p.text.length, ...describePrompt(p.text, "") };
    // Only the newest prompt's reply can still be growing; its preview is final once long enough.
    d.final = d.preview !== "" || p !== prompts.at(-1);
    if (!d.preview) {
      const reply = adapter.reply(els, p.turnIndex);
      d = { ...d, ...describePrompt(p.text, reply?.textContent ?? "") };
      d.final = p !== prompts.at(-1) || d.preview.length >= PREVIEW_MAX;
    }
    if (d.final) described.set(p.id, d);
    return d;
  }

  /** The newest prompt's reply is still arriving: fill its row's preview in place until it is long enough. */
  function refreshLastPreview() {
    const p = prompts.at(-1);
    if (!p || described.has(p.id)) return;
    const d = describe(p);
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
      const { title, preview } = describe(p);
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

  /** Where the conversation viewport is, in page coordinates: the scroller clipped to the window. */
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

  /** Prompts whose turn is on screen get a dot; only the changed rows are touched. */
  function updateInView(m) {
    const next = new Set();
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

  // ---- minimap ----------------------------------------------------------------------------

  function turnExtent() {
    const i = prompts.findIndex((p) => p.id === activeId);
    if (i < 0) return null;
    const a = els[prompts[i].turnIndex];
    const z = els[promptEnd(i)];
    if (!a || !z) return null;
    return { i, a, z };
  }

  function renderMinimap(m) {
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
    const ind = viewportIndicator({
      turnTop: ext.a.getBoundingClientRect().top,
      turnBottom: ext.z.getBoundingClientRect().bottom,
      viewTop: m.viewTop,
      viewBottom: m.viewBottom,
    });
    if (view.hidden !== !ind) view.hidden = !ind;
    // Only write on change: any DOM write under body re-triggers the prompt-index observer.
    const text = `Drag to navigate • ${ind ? Math.round(ind.visible * 100) : 0}% visible`;
    if (caption.textContent !== text) caption.textContent = text;
    if (ind) {
      const top = `${(ind.top * 100).toFixed(2)}%`;
      const height = `${(ind.height * 100).toFixed(2)}%`;
      if (viewBox !== `${top} ${height}`) {
        viewBox = `${top} ${height}`;
        view.style.top = top;
        view.style.height = height;
      }
      const now = String(Math.round(ind.top * 100));
      if (minimap.getAttribute("aria-valuenow") !== now) minimap.setAttribute("aria-valuenow", now);
    }
  }

  function scrollerHeight() {
    return scroller.clientHeight || scroller.getBoundingClientRect().height;
  }

  /** Active prompt = the one whose turn holds the first element on screen; the newest at the bottom. */
  function detectActive(m = measureView()) {
    if (!els.length || !prompts.length) return null;
    if (m.atBottom) return prompts.at(-1).id;
    let found = prompts[0];
    for (const p of prompts) if (p.turnIndex <= m.first) found = p;
    return found.id;
  }

  /** The reading position as an anchor: the first turn on screen and its offset from the scroller's top. */
  function bookmarkOf(m) {
    const el = els[m.first];
    if (!el) return null;
    return { id: adapter.turnId(el, m.first), offset: el.getBoundingClientRect().top - m.sTop, bottom: m.atBottom };
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

  /** A cheap, batched check of the page column; the full rail update is not needed for it. */
  function scheduleLayout() {
    if (layoutQueued || disposed) return;
    layoutQueued = true;
    win.requestAnimationFrame(() => {
      layoutQueued = false;
      if (!disposed) layout();
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
    schedule();
  }

  function select(p) {
    activeId = p.id;
    listManual = false;
    markActive();
    const el = els[p.turnIndex];
    if (el) runtime.navigateTo(el, { offset: 0 });
    modelKey = "";
    renderMinimap(measureView());
    persist();
  }

  /** Wake a turn the virtualizer skipped before measuring it: its height is only a placeholder until then. */
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
    const fraction = clamp(r.height ? (clientY - r.top) / r.height : 0, 0, 1);
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
    if (!ext || (step === undefined && e.key !== "Home" && e.key !== "End")) return;
    e.preventDefault();
    ensureRendered(ext);
    const { turnTop, turnHeight } = turnGeometry(ext);
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
    persist();
  });
  for (const type of ["wheel", "touchmove", "pointerdown"]) on(list, type, () => (listManual = true), { passive: true });
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
  for (const head of root.querySelectorAll(".gs-card-head")) {
    on(head, "click", () => {
      const card = head.closest(".gs-card");
      const collapsed = card.dataset.gsCollapsed !== "true";
      setCollapsed(card, collapsed);
      if (!collapsed) {
        modelKey = "";
        schedule();
        if (card === promptsCard && listPinned) list.scrollTop = list.scrollHeight;
      }
      persist();
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
  // The page column moves with the window and with ChatGPT's own sidebar (an animated width change).
  on(win, "resize", scheduleLayout);
  on(doc, "transitionend", (e) => !root.contains(e.target) && /width|margin|padding|left|right|transform/.test(e.propertyName ?? "") && scheduleLayout(), { capture: true, passive: true });

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
    state: () => ({ activeId, open, mode: root.dataset.gsMode, listPinned, query, reserve: railLayout.reserve() }),
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
      railLayout.dispose();
      root.remove();
      style.remove();
    },
  };
  return api;
}
