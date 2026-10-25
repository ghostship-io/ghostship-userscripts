// The one owner of the right pane's column in the page layout. The page column (conversation, header,
// composer and queue panel together) gets right padding, so the centered conversation and the composer
// shift left by exactly what the pane needs: nothing when the natural right gutter already fits it, and
// nothing at all when ChatGPT's own summary pane is mounted and already reserves its width (`paneLeft`
// is then that pane's measured left edge: the page is only shifted by what still overlaps it). For our
// own fallback pane, below a viewport threshold or when the shifted conversation would become too
// narrow, the pane collapses to a toggle and the page is untouched.
export const RAIL_WIDTH = 320;
export const RAIL_EDGE = 0; // the docked pane sits against the window edge, like the native one
export const RAIL_RESERVE = RAIL_WIDTH + 2 * RAIL_EDGE;
export const DOCK_MIN_VIEWPORT = 1024;
export const MIN_CONTENT = 560;

export const LAYOUT_CSS = `
[data-gs-column][data-gs-column]{box-sizing:border-box;padding-right:var(--gs-reserve,0px)}
`;

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {object} o.adapter column(doc), composer(doc)
 * @param {() => Element|undefined} o.target element whose right edge must clear the pane (a turn); the composer when absent
 *
 * `evaluate(paneLeft)` / `signature(paneLeft)`: `paneLeft` is the left edge of ChatGPT's mounted summary pane,
 * or null/undefined when our own fallback pane is the one docked on the right.
 */
export function createRailLayout({ win, adapter, target }) {
  const doc = win.document;
  let written = []; // the elements we have written to
  let known = null; // the page column (and composer overlay) once found: the rail is rebuilt whenever the page layout is
  let applied = 0;

  const findColumns = () => {
    if (!known?.length || known.some((el) => !el.isConnected)) known = adapter.columns(doc);
    return known;
  };

  function release(el) {
    el.removeAttribute("data-gs-column");
    el.style.removeProperty("--gs-reserve");
    if (!el.getAttribute("style")) el.removeAttribute("style");
  }

  function setReserve(cols, px) {
    if (written.some((el) => !cols.includes(el))) clear();
    written = cols;
    for (const col of cols) {
      if (px > 0) {
        if (col.getAttribute("data-gs-column") === null) col.setAttribute("data-gs-column", "");
        const v = `${Math.round(px)}px`;
        if (col.style.getPropertyValue("--gs-reserve") !== v) col.style.setProperty("--gs-reserve", v);
      } else if (applied > 0 || col.hasAttribute("data-gs-column")) release(col);
    }
    applied = px > 0 ? Math.round(px) : 0;
  }

  function clear() {
    for (const el of written) release(el);
    written = [];
    applied = 0;
  }

  /** What decides the layout independent of the reserve we applied; a change means re-evaluate. */
  function signature(paneLeft) {
    const cols = findColumns();
    if (!cols.length) return "none";
    const r = cols[0].getBoundingClientRect();
    return `${win.innerWidth}|${Math.round(r.left)}|${Math.round(r.right + (written.includes(cols[0]) ? applied : 0))}|${cols.length}|${paneLeft == null ? "-" : Math.round(paneLeft)}`;
  }

  /** Measure the natural layout, then reserve what the pane still needs. Returns `{ docked, reserve }`. */
  function evaluate(paneLeft) {
    const native = paneLeft != null;
    const cols = findColumns();
    const el = target() ?? adapter.composer(doc);
    // Both the conversation and the composer must clear the rail; they can sit in different boxes.
    const edge = () => Math.max(el.getBoundingClientRect().right, adapter.composer(doc)?.getBoundingClientRect().right ?? 0);
    if (!cols.length || !el || (!native && win.innerWidth < DOCK_MIN_VIEWPORT)) {
      if (cols.length) setReserve(cols, 0);
      else clear();
      return { docked: native && !!cols.length, reserve: 0 };
    }
    setReserve(cols, 0);
    const limit = native ? paneLeft : win.innerWidth - RAIL_RESERVE; // the conversation and composer must end here
    const need = Math.max(0, win.innerWidth - limit);
    const room = Math.max(0, win.innerWidth - cols[0].getBoundingClientRect().right); // free space outside the column
    const cap = Math.max(0, need - room);
    let right = edge();
    let reserve = 0;
    if (right > limit && cap > 0) {
      // A centered conversation moves by half the shrink, a full-width one by all of it: grow until it clears.
      reserve = Math.min(cap, 2 * (right - limit));
      for (let i = 0; i < 3; i++) {
        setReserve(cols, reserve);
        right = edge();
        const over = right - limit;
        if (over <= 0.5 || reserve >= cap) break;
        reserve = Math.min(cap, reserve + over);
      }
    }
    const fits = right <= limit + 0.5 && (reserve === 0 || el.getBoundingClientRect().width >= MIN_CONTENT);
    if (!fits) {
      setReserve(cols, 0);
      return { docked: native, reserve: 0 };
    }
    return { docked: true, reserve };
  }

  return { evaluate, signature, reserve: () => applied, dispose: clear };
}
