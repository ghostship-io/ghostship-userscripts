import { searchPrompts } from "../../core/prompt-index.js";
import { blockKind, buildTurnModel, layoutBars, scrollTopForFraction, silhouette, viewportIndicator } from "./minimap-model.js";
import { LAYOUT_CSS, PANEL_GAP, PANEL_WIDTH, createRailLayout } from "./rail-layout.js";
import { contentSignature, createPanePrefs, createPanelPrefs, createRailStateStore } from "./rail-state.js";

const STYLE_ID = "gs-pane-style";

// Layout contract: one pinned column on the right in ChatGPT's own chrome. The conversation view (minimap) is
// pinned top-right and grows downward with the conversation's real shape; the prompt list is pinned to the
// bottom of the same column and grows upward as prompts are added. The page column is padded (rail-layout.js,
// the one layout owner) so the conversation and composer re-center in the space the column leaves, around any
// native side pane or sidebar. ONE button in ChatGPT's header button area shows and hides both panels (the
// choice is remembered per browser); without a header it floats top-right, above the column, never over it.
// Without room (narrow windows) the column becomes a drawer opened by that button, never covering the composer
// or header. The column, its button and its style are re-attached whenever ChatGPT's re-render removes them.
// ChatGPT's own Outputs section only gets a disclosure control (no native node is moved, removed or
// re-created). Styling is ChatGPT's own tokens with theme-neutral fallbacks, no colors of its own, so both
// themes and later token changes carry over.
// ChatGPT's own tokens (as its summary pane uses them: elevated card, ring shadow, 16px radius, secondary text for
// titles), then neutral fallbacks, so the panels look like the page's own cards in both themes.
const SURFACE = "var(--color-surface-elevated-secondary,Canvas)";
const PAGE = "var(--color-surface,Canvas)";
const TEXT = "var(--color-text,CanvasText)";
const LINE = "var(--color-border,color-mix(in srgb,currentColor 14%,transparent))";
const HOVER = "var(--color-token-interactive-bg-secondary-hover,color-mix(in srgb,currentColor 8%,transparent))";
const SELECTED = "var(--color-token-interactive-bg-secondary-selected,color-mix(in srgb,currentColor 12%,transparent))";
const CODE = "var(--color-token-text-code-block-background,color-mix(in srgb,currentColor 12%,transparent))";
const BUBBLE = "var(--color-token-interactive-bg-secondary-selected,color-mix(in srgb,currentColor 10%,transparent))";
const INK = "color-mix(in srgb,currentColor 38%,transparent)";
const INK_FAINT = "color-mix(in srgb,currentColor 22%,transparent)";
const ACCENT = "var(--color-token-focus-border,AccentColor)";
const MUTED = "var(--color-text-secondary,color-mix(in srgb,currentColor 65%,transparent))";
const RING = "var(--elevation-prominent,0 0 0 .5px color-mix(in srgb,currentColor 20%,transparent))";
const FOCUS = "outline:2px solid var(--color-border-strong,currentColor);outline-offset:-2px";
const CHEVRON = '<svg class="gs-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const PANELS_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4"/></svg>';

const CSS = `
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
const OPEN_SETTLE_MS = 500; // the prompt list unchanged this long: the page has settled
const OPEN_FOLLOW_MS = 1500; // after selecting, further prompts loading within this window re-target
const SCAN_MS = 400; // at most one page scan for ChatGPT's pane per this long
const BLOCK_CAP = 800; // rendered blocks measured per rebuild
const CONTENT_W = 768; // the conversation column's usual width, when it cannot be measured
const FRAME_SHARE = 0.72; // the sheet's width as a share of the track: the rest is the bezel at its sides
const PAPER = 11 / 8.5; // US Letter, portrait: height over width
const MAP_PAD = 18; // the track's padding and borders
const MAP_CHROME = 120; // the minimap panel's header, caption and padding around the frame
const PANE_SETTLE_MS = 450; // ChatGPT's pane and page transitions are done by then
const FLOAT_BOTTOM = 44; // the floating header button ends here (8px from the top, 36px high)
const MAP_W = 244; // the track's width when it cannot be measured

/**
 * The right pane: current-turn minimap on top, searchable chronological prompt list
 * below (oldest first, newest last, list kept scrolled to the bottom while the
 * latest is in view). It never writes scroll position itself: every jump goes
 * through `runtime.navigateTo` (prompt selection, which also activates
 * virtualized-out turns) or `runtime.scroll.scrollTo` (minimap, keyboard).
 * Re-renders follow the runtime's prompt index; no observers of its own.
 *
 * Each conversation keeps its own state (selected prompt, search, filter, section and Outputs
 * collapse, prompt-list scroll, conversation scroll bookmark) in `store`, which outlives the
 * pane: the boot controller rebuilds it on every route change. The collapse states also
 * survive a reload (`prefs`).
 */
export function createRail({ win, adapter, runtime, store = createRailStateStore(), prefs = createPanePrefs(win.localStorage), layoutPrefs = createPanelPrefs(win.localStorage), paneSettleMs = PANE_SETTLE_MS }) {
  const doc = win.document;
  const scroll = runtime.scroll;
  const scroller = scroll.element ?? adapter.scroller(doc);
  const convId = adapter.conversationId(win);
  let els = [];
  let prompts = [];
  let signature = null;
  let query = "";
  let activeId = null;
  let docked = true; // whether the panel column has room beside the conversation; without it the column is a drawer opened on request
  let drawer = false; // the column is open as a drawer
  let shown = layoutPrefs.get(); // whether the user wants the panels: remembered per browser
  let hasMap = false; // there is a conversation turn to draw
  let viewSet = new Set();
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
  let geom = { sceneH: 1, frameH: 1 }; // the minimap's scene (the whole turn at the minimap's scale) and the frame it slides in, px
  let mapOffset = 0; // how far the scene is slid up under the frame, px
  let bookmarkToRestore = null;
  let listTopToRestore = null;
  let outputsCollapsed = false;
  let opening = convId === "new" ? "done" : "waiting"; // opening a conversation: waiting -> following -> done
  let openSig = null;
  let openStalled = false;
  let openGen = 0;
  let interacted = false;
  let lastHost = null;
  let lastPaneOpen = false;
  let paneYield = false; // an open ChatGPT pane and our column do not both fit: ours is a drawer until it closes or the window resizes
  let settleTimer = null;
  let scannedAt = -Infinity;
  let scanTimer = null;
  let outputsHost = null; // { section, head } of the native Outputs section we added the disclosure to
  const described = new Map();

  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);

  const panel = (name, label, inner) => {
    const el = doc.createElement("section");
    el.className = `gs-panel gs-panel-${name === "minimap" ? "map" : "prompts"}`;
    el.dataset.gsUi = "";
    el.dataset.gsPanel = name;
    el.setAttribute("aria-label", label);
    el.innerHTML = `<div class="gs-panel-head"><span class="gs-panel-title">${label}</span></div><div class="gs-panel-body">${inner}</div>`;
    return el;
  };
  const mapPanel = panel(
    "minimap",
    "Conversation view",
    `<div class="gs-minimap" tabindex="0" role="slider" aria-orientation="vertical" aria-label="Current turn overview" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="gs-frame"><div class="gs-scene"><div class="gs-bars"></div><div class="gs-view" hidden></div></div></div></div><div class="gs-caption" aria-live="off">Drag to navigate • 0% visible</div>`,
  );
  const promptsPanel = panel(
    "prompts",
    "Prompts",
    `<div class="gs-search"><div class="gs-search-field"><input type="search" placeholder="Filter prompts..." aria-label="Filter prompts"></div></div><ol class="gs-prompts" aria-label="Prompts, oldest first"></ol>`,
  );
  mapPanel.hidden = true; // until there is a conversation to draw
  // One column holds both panels: the conversation view on top, the prompt list pinned to the bottom.
  const column = doc.createElement("div");
  column.className = "gs-rail";
  column.dataset.gsUi = "";
  column.append(mapPanel, promptsPanel);
  const root = { querySelector: (sel) => mapPanel.querySelector(sel) ?? promptsPanel.querySelector(sel), contains: (n) => column.contains(n) };
  // The one button that shows and hides both panels lives in ChatGPT's header button area.
  const actions = doc.createElement("span");
  actions.className = "gs-hbtns";
  actions.dataset.gsUi = "";
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "gs-hbtn";
  button.dataset.gsUi = "";
  button.setAttribute("aria-label", "Conversation view");
  button.title = "Show or hide the conversation view and prompts";
  button.setAttribute("aria-pressed", "false");
  button.innerHTML = PANELS_ICON;
  actions.append(button);
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

  // ---- per-conversation state -------------------------------------------------------------

  // The conversation's own panel state needs no DOM: apply it right away.
  const stored = prefs.get(convId);
  if (stored) outputsCollapsed = stored.outputs;
  if (restore) {
    outputsCollapsed = restore.ui.outputsCollapsed ?? outputsCollapsed;
    query = restore.ui.query;
    input.value = query;
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
      ui: { query, outputsCollapsed },
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

  /**
   * Opening a conversation: once the page has settled (the prompt list unchanged for OPEN_SETTLE_MS and the last
   * turn rendered), select the last prompt in the list exactly as a click on it would (highlight, minimap, and
   * the shared scroll controller puts its start at the top of the viewport). While more prompts keep loading it
   * re-targets the new last prompt each time, and stops once the list has stayed unchanged for OPEN_FOLLOW_MS.
   * It stops for good as soon as the user scrolls or clicks, types or touches anything, never runs when a saved
   * reading position is restored instead, and later renders or streaming leave the viewport alone.
   */
  function openTick() {
    if (opening === "done" || disposed) return;
    if (didRestore || userScrolled || interacted) return stopOpening();
    const last = prompts.at(-1);
    if (restore || !last) return;
    const sig = `${last.id}:${prompts.length}`;
    if (sig !== openSig || openStalled) {
      const el = els[last.turnIndex];
      if (sig === openSig && !(el && runtime.isTurnActive(el) && el.getBoundingClientRect().height)) return; // still rendering
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
      const el = last && els[last.turnIndex];
      if (!el || !runtime.isTurnActive(el) || !el.getBoundingClientRect().height) {
        openStalled = true; // the next refresh re-arms once the turn has rendered
        return;
      }
      if (!scroll.mayOpen()) return stopOpening();
      opening = "following";
      select(last, true);
      armOpen("finish", OPEN_FOLLOW_MS);
    }, ms);
  }

  // ---- layout -----------------------------------------------------------------------------

  /** Change-only write of a position variable of the panel column. */
  function setVar(name, value) {
    if (column.style.getPropertyValue(name) !== value) column.style.setProperty(name, value);
  }

  /** Remove the disclosure from the native Outputs section and the attributes that drive its collapse. */
  function releaseOutputs() {
    if (outputsHost) {
      outputsHost.section.removeAttribute("data-gs-outputs");
      outputsHost.section.removeAttribute("data-gs-collapsed");
      outputsHost.head.removeAttribute("data-gs-outputs-head");
    }
    outputsBtn.remove();
    outputsHost = null;
  }

  /** Native Outputs: a disclosure in its title row hides the rest of the section; nothing is moved or removed. */
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

  const open = () => els.length > 0 && ((docked && shown) || drawer);

  /** The column, the minimap inside it and the header button follow the room (docked or drawer) and the remembered choice. */
  function applyVisibility() {
    const on = open();
    if (actions.hidden === (els.length > 0)) actions.hidden = els.length === 0;
    if (column.hidden === on) column.hidden = !on;
    const mapOn = on && hasMap;
    if (mapPanel.hidden === mapOn) mapPanel.hidden = !mapOn;
    const pressed = String(on);
    if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    const drawerMode = String(!docked);
    if (column.dataset.gsDrawer !== drawerMode) column.dataset.gsDrawer = drawerMode;
    if (mapOn) {
      modelKey = "";
      schedule();
    }
  }

  /**
   * Put the button in ChatGPT's header button area (before its right-most button). With no header, or when a pane
   * covers that corner of the header, it floats top-right instead, left of the pane. Returns whether it floats.
   */
  function placeButton(pane) {
    const spot = adapter.headerActions(doc);
    const box = pane?.isConnected ? pane.getBoundingClientRect() : null;
    const covered = !!spot && !!box?.width && spot.right > box.left + 1 && box.top < adapter.headerBottom(doc) - 1; // under a pane that reaches into the header band
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

  /** ChatGPT's re-render can drop what we put in the page (the column, its style or the header button): put it back. */
  function remount() {
    if (!style.isConnected) doc.head.appendChild(style);
    if (!column.isConnected) {
      doc.body.append(column);
      layoutSig = null; // a fresh column has none of its position variables
    }
  }

  /** The one button shows and hides both panels: docked, it is the remembered choice; with no room beside the conversation it opens and closes a drawer. */
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

  /** Re-center the conversation around the docked column (or turn it into a drawer) when the page layout changed. */
  function layout(rescan = false, settled = false) {
    remount();
    // A mounted native pane is revalidated cheaply; looking for one is a page scan, so it runs at most every SCAN_MS
    // (at once on resize, route and animation hints) and a trailing pass catches a pane that mounted in between.
    let host = lastHost;
    if (!host || !host.pane.isConnected || !host.container.isConnected || (host.outputs && !(host.outputs.section.isConnected && host.outputs.head.isConnected)) || !host.pane.getBoundingClientRect().width) {
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
    // Under a page header the column starts below it; with the button floating, below the button.
    const top = Math.max(Math.round(adapter.headerBottom(doc)), floating ? FLOAT_BOTTOM : 0) + 8;
    // A new chat has nothing to show. An open ChatGPT pane keeps our column beside it while the page has room for the
    // conversation, the pane and the column. Where it has not, ChatGPT shows its pane as a popover over the page, or
    // the settled pane would overlap the conversation or the column: then ours steps aside (a drawer on request, the
    // page left to ChatGPT) until the pane closes or the window changes size.
    const card = adapter.summaryCard(doc);
    const paneOpen = !!host || !!card || adapter.summaryOpen(doc);
    if (!paneOpen) paneYield = false;
    else if (card && !card.inPage && !host) paneYield = true;
    const conversation = els.length > 0;
    if (paneOpen !== lastPaneOpen) {
      // ChatGPT slides its page into the new place over a transition, so what is measured right now is not where it ends up:
      // measure again once it has settled.
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
      const r = railLayout.evaluate({ right: room ? PANEL_WIDTH : 0, force: room && !!host }); // nothing is reserved while hidden; an inline pane needs the padding to end up beside our column
      docked = room ? r.docked : !(shown && conversation); // hidden by choice counts as "has room": the button then only toggles the choice
      if (docked) drawer = false;
      layoutSig = key;
      setVar("--gs-top", `${top}px`);
      // Docked, the column sits in the right gutter the page column leaves; as a drawer, in the window's corner.
      setVar("--gs-right", `${docked ? Math.max(PANEL_GAP, Math.round(win.innerWidth - railLayout.edge()) + PANEL_GAP) : 8}px`);
      applyVisibility();
    }
    if (settled && paneOpen && docked && shown && conversation) {
      // Settled, the pane must clear both the conversation and our column; if it does not there is no room for all three.
      const box = host ? host.pane.getBoundingClientRect() : card; // where the pane is now, not where it was found
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
    // A drawer ends above the composer, never over it.
    const rect = adapter.composer(doc)?.getBoundingClientRect();
    const clear = rect?.height ? `${Math.max(16, Math.round(win.innerHeight - rect.top + 8))}px` : "96px";
    setVar("--gs-bottom", docked ? "16px" : clear);
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
    const shown = searchPrompts(prompts, query);
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

  /**
   * The turn's silhouette from its real rendered boxes: the prompt bubble, then each block of the reply at its
   * measured position and size. A turn the virtualizer skipped has no boxes, so its content is estimated instead.
   */
  function silhouetteItems(ext, slice, top, height) {
    if (slice.every((e) => runtime.isTurnActive(e))) {
      const users = slice.map((t) => adapter.userMessage(t)).filter(Boolean);
      const boxes = [];
      const add = (kind, el) => {
        const r = el.getBoundingClientRect();
        boxes.push({ kind, top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      };
      for (const u of users) add("prompt", u);
      for (const el of adapter.blocks(slice).slice(0, BLOCK_CAP)) {
        const kind = !users.some((u) => u.contains(el)) && blockKind(el);
        if (kind) add(kind, el);
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
    // The conversation column as it is with no panes open, drawn on a sheet of paper (portrait, with a bezel at the sides).
    const contentWidth = Math.min((turnBox.width || CONTENT_W) + railLayout.reserve(), CONTENT_W);
    // Content, rendered-ness and the turn's size (to 20px / 8px): anything that changes the drawn boxes.
    const key = `${activeId}:${slice.map((e) => e.textContent.length).join(",")}:${slice.every((e) => runtime.isTurnActive(e))}:${Math.round(turnPx / 20)}:${Math.round(turnBox.width / 8)}:${Math.round(minimap.getBoundingClientRect().width / 8)}:${Math.round(win.innerHeight / 8)}:${Math.round(column.getBoundingClientRect().height / 8)}`;
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
      bars.textContent = "";
      const items = silhouetteItems(ext, slice, turnBox.top, turnPx);
      // The frame always fills the track, so it reads as the conversation column at one fixed scale; the scene inside
      // it is the whole turn at that scale and slides under the frame as the conversation scrolls (a short turn fits).
      const box = minimap.getBoundingClientRect();
      const room = (column.getBoundingClientRect().height || win.innerHeight - 76) * 0.55 - MAP_CHROME; // the panel takes at most 55% of the column
      const maxH = clamp(Math.min(win.innerHeight * 0.45, room), 48, 360); // the panel grows with the conversation, up to this
      const frameW = Math.round((box.width ? box.width - MAP_PAD : MAP_W) * FRAME_SHARE);
      const scale = frameW / contentWidth;
      geom = { sceneH: Math.max(8, Math.round(turnPx * scale)), frameH: 0 };
      geom.frameH = Math.min(geom.sceneH, Math.round(frameW * PAPER), Math.round(maxH)); // a sheet of paper, or the whole turn when it is shorter
      if (frame.style.height !== `${geom.frameH}px`) frame.style.height = `${geom.frameH}px`;
      scene.style.height = `${geom.sceneH}px`;
      // One text line of the real conversation (about 24px), at the same scale (never finer than 3px).
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
      viewBottom: m.viewBottom,
    });
    if (view.hidden !== !ind) view.hidden = !ind;
    // The scene slides so the viewport box stays inside the frame (centered where the turn is longer than the frame).
    if (ind) {
      const center = (ind.top + ind.height / 2) * geom.sceneH;
      const next = Math.round(clamp(center - geom.frameH / 2, 0, Math.max(0, geom.sceneH - geom.frameH)));
      if (next !== mapOffset) {
        mapOffset = next;
        scene.style.transform = `translateY(${-next}px)`;
      }
    }
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
    // The conversation view only exists for a conversation with a turn to draw; an empty frame would say nothing.
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

  /** A cheap, batched check of the page column; the full rail update is not needed for it. */
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
    const el = els[p.turnIndex];
    if (el) automatic ? runtime.open(el, { offset: 0 }) : runtime.navigateTo(el, { offset: 0 });
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
    const sc = scene.getBoundingClientRect(); // the whole turn, slid under the frame: a point on it is a point in the turn
    const r = sc.height ? sc : minimap.getBoundingClientRect(); // the track around it clamps
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
  on(button, "click", () => toggle());
  on(column, "keydown", (e) => {
    if (e.key === "Escape" && !docked && drawer && !input.value) {
      drawer = false;
      applyVisibility();
      button.focus?.();
    }
  });
  on(outputsBtn, "click", (e) => {
    e.stopPropagation(); // the native title row has handlers of its own
    outputsCollapsed = !outputsCollapsed;
    syncOutputs(lastHost);
    persist();
    savePrefs();
  });
  // The page column moves with the window and with ChatGPT's own sidebar (an animated width change).
  on(win, "resize", () => {
    paneYield = false; // a different size may have room for the pane and our column after all
    scheduleLayout(true);
    schedule();
  });
  on(doc, "transitionend", (e) => !root.contains(e.target) && !actions.contains(e.target) && /width|margin|padding|left|right|transform/.test(e.propertyName ?? "") && scheduleLayout(true), { capture: true, passive: true });

  // Anything the user does ends the automatic selection of the last prompt.
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) on(doc, type, () => (interacted = true), { capture: true, passive: true });
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
    },
  };
  return api;
}
