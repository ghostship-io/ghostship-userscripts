// Reserves the right rail's column in the page layout instead of floating over the conversation.
// The page column (conversation, header, composer and queue panel together) gets right padding, so
// the centered conversation and the composer shift left by exactly what the rail needs: nothing
// when the natural right gutter already fits it. Below a viewport threshold, or when the shifted
// conversation would become too narrow, the rail collapses to a toggle and the page is untouched.
export const RAIL_WIDTH = 296;
export const RAIL_EDGE = 12; // gap between the rail and the window edge
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
 * @param {() => Element|undefined} o.target element whose right edge must clear the rail (a turn); the composer when absent
 */
export function createRailLayout({ win, adapter, target }) {
  const doc = win.document;
  let column = null; // the column we have written to
  let known = null; // the column element once found: the rail is rebuilt whenever the page layout is
  let applied = 0;

  const findColumn = () => {
    if (!known?.isConnected) known = adapter.column(doc);
    return known;
  };

  function setReserve(col, px) {
    if (column && column !== col) clear();
    column = col;
    if (px > 0) {
      if (col.getAttribute("data-gs-column") === null) col.setAttribute("data-gs-column", "");
      const v = `${Math.round(px)}px`;
      if (col.style.getPropertyValue("--gs-reserve") !== v) col.style.setProperty("--gs-reserve", v);
    } else if (applied > 0 || col.hasAttribute("data-gs-column")) {
      col.removeAttribute("data-gs-column");
      col.style.removeProperty("--gs-reserve");
      if (!col.getAttribute("style")) col.removeAttribute("style");
    }
    applied = px > 0 ? Math.round(px) : 0;
  }

  function clear() {
    if (!column) return;
    column.removeAttribute("data-gs-column");
    column.style.removeProperty("--gs-reserve");
    if (!column.getAttribute("style")) column.removeAttribute("style");
    column = null;
    applied = 0;
  }

  /** What decides the layout independent of the reserve we applied; a change means re-evaluate. */
  function signature() {
    const col = findColumn();
    if (!col) return "none";
    const r = col.getBoundingClientRect();
    return `${win.innerWidth}|${Math.round(r.left)}|${Math.round(r.right + (col === column ? applied : 0))}`;
  }

  /** Measure the natural layout, then reserve what the rail needs. Returns `{ docked, reserve }`. */
  function evaluate() {
    const col = findColumn();
    const el = target() ?? adapter.composer(doc);
    if (!col || !el || win.innerWidth < DOCK_MIN_VIEWPORT) {
      if (col) setReserve(col, 0);
      else clear();
      return { docked: false, reserve: 0 };
    }
    setReserve(col, 0);
    const room = Math.max(0, win.innerWidth - col.getBoundingClientRect().right); // free space outside the column
    const cap = Math.max(0, RAIL_RESERVE - room);
    const limit = win.innerWidth - RAIL_RESERVE;
    let rect = el.getBoundingClientRect();
    let reserve = 0;
    if (rect.right > limit && cap > 0) {
      // A centered conversation moves by half the shrink, a full-width one by all of it: grow until it clears.
      reserve = Math.min(cap, 2 * (rect.right - limit));
      for (let i = 0; i < 3; i++) {
        setReserve(col, reserve);
        rect = el.getBoundingClientRect();
        const over = rect.right - limit;
        if (over <= 0.5 || reserve >= cap) break;
        reserve = Math.min(cap, reserve + over);
      }
    }
    const fits = rect.right <= limit + 0.5 && (reserve === 0 || rect.width >= MIN_CONTENT);
    if (!fits) {
      setReserve(col, 0);
      return { docked: false, reserve: 0 };
    }
    return { docked: true, reserve };
  }

  return { evaluate, signature, reserve: () => applied, dispose: clear };
}
