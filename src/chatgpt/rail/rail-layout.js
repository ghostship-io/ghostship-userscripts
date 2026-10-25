// The one owner of the pinned panels' room in the page layout. The page column (conversation, header,
// composer and queue panel together) gets left and right padding, so the centered conversation and the
// composer shift to the middle of the space the panels leave: the prompts panel is pinned bottom-left and
// needs `left` px beside the column's left edge, the minimap panel is pinned top-right and needs `right`
// px beside its right edge. Nothing is written when the natural side gutters already fit them, or when a
// panel is hidden. The column's edges already exclude ChatGPT's own side panes and sidebar when they take
// their width out of the page; a pane that floats over the right edge is passed as `paneLeft`, its
// measured left edge, and only the overlap is cleared. When the shifted conversation would become too
// narrow (or the window is below the dock threshold) nothing is reserved and the panels become drawers
// opened on request, so they never cover native UI on their own.
export const PANEL_WIDTH = 280;
export const PANEL_GAP = 12; // between a panel and the column edge, and between a panel and the conversation
export const DOCK_MIN_VIEWPORT = 1024;
export const MIN_CONTENT = 560;

export const LAYOUT_CSS = `
[data-gs-column][data-gs-left]{box-sizing:border-box;padding-left:var(--gs-reserve-left,0px)}
[data-gs-column][data-gs-right]{box-sizing:border-box;padding-right:var(--gs-reserve,0px)}
`;

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {object} o.adapter columns(doc), composer(doc)
 * @param {() => Element|undefined} o.target the conversation element (a turn); the composer when absent
 *
 * `evaluate({ left, right, paneLeft })` / `signature(paneLeft)`: `left` and `right` are the widths of the
 * panels to dock (0 when hidden); `paneLeft` is the left edge of a native pane floating over the right edge.
 */
export function createRailLayout({ win, adapter, target }) {
  const doc = win.document;
  let written = []; // the elements we have written to
  let known = null; // the page column (and composer overlay) once found: the panels are rebuilt whenever the page layout is
  let applied = { left: 0, right: 0 };

  const findColumns = () => {
    if (!known?.length || known.some((el) => !el.isConnected)) known = adapter.columns(doc);
    return known;
  };

  function release(el) {
    for (const a of ["data-gs-column", "data-gs-left", "data-gs-right"]) el.removeAttribute(a);
    el.style.removeProperty("--gs-reserve");
    el.style.removeProperty("--gs-reserve-left");
    if (!el.getAttribute("style")) el.removeAttribute("style");
  }

  function setReserve(cols, left, right) {
    if (written.some((el) => !cols.includes(el))) clear();
    written = cols;
    const l = Math.max(0, Math.round(left));
    const r = Math.max(0, Math.round(right));
    for (const col of cols) {
      if (l > 0 || r > 0) {
        if (col.getAttribute("data-gs-column") === null) col.setAttribute("data-gs-column", "");
      } else if (col.hasAttribute("data-gs-column") || col.hasAttribute("data-gs-left") || col.hasAttribute("data-gs-right")) {
        release(col);
        continue;
      }
      for (const [attr, prop, v] of [["data-gs-left", "--gs-reserve-left", l], ["data-gs-right", "--gs-reserve", r]]) {
        if (v > 0) {
          if (col.getAttribute(attr) === null) col.setAttribute(attr, "");
          if (col.style.getPropertyValue(prop) !== `${v}px`) col.style.setProperty(prop, `${v}px`);
        } else if (col.hasAttribute(attr)) {
          col.removeAttribute(attr);
          col.style.removeProperty(prop);
        }
      }
    }
    applied = { left: l, right: r };
  }

  function clear() {
    for (const el of written) release(el);
    written = [];
    applied = { left: 0, right: 0 };
  }

  /** What decides the layout independent of what we applied; a change means re-evaluate. */
  function signature(paneLeft) {
    const cols = findColumns();
    if (!cols.length) return "none";
    const r = cols[0].getBoundingClientRect();
    return `${win.innerWidth}|${Math.round(r.left)}|${Math.round(r.right)}|${cols.length}|${paneLeft == null ? "-" : Math.round(paneLeft)}`;
  }

  /** The column's box: our padding changes what is inside it, never its own edges. */
  const natural = (col) => {
    const r = col.getBoundingClientRect();
    return { left: r.left, right: r.right };
  };

  /**
   * Measure the natural layout, then reserve what the docked panels still need on each side. Returns
   * `{ docked, left, right }`; `docked` is false when there is no room and the panels must be drawers.
   */
  function evaluate({ left = 0, right = 0, paneLeft = null } = {}) {
    const cols = findColumns();
    const el = target() ?? adapter.composer(doc);
    if (!cols.length || !el || win.innerWidth < DOCK_MIN_VIEWPORT) {
      if (cols.length) setReserve(cols, 0, 0);
      else clear();
      return { docked: false, left: 0, right: 0 };
    }
    setReserve(cols, 0, 0);
    const col = natural(cols[0]);
    const edge = paneLeft == null ? col.right : Math.min(col.right, paneLeft);
    const needL = left > 0 ? left + 2 * PANEL_GAP : 0; // gap to the column edge and to the conversation
    const needR = right > 0 ? right + 2 * PANEL_GAP : 0;
    // Both the conversation and the composer must clear the panels; they can sit in different boxes.
    const span = () => {
      const c = adapter.composer(doc)?.getBoundingClientRect();
      const t = el.getBoundingClientRect();
      return { left: c ? Math.min(t.left, c.left) : t.left, right: c ? Math.max(t.right, c.right) : t.right };
    };
    const over = () => {
      const s = span();
      return { l: Math.max(0, col.left + needL - s.left), r: Math.max(0, s.right - (edge - needR)) };
    };
    let o = over();
    if (o.l > 0.5 || o.r > 0.5) {
      // The conversation is centered in the page column, so padding each side by exactly what its panel takes (plus
      // what a floating native pane covers) re-centers it in the space the panels leave, whatever the page's own margins.
      setReserve(cols, needL, needR + Math.max(0, col.right - edge));
      o = over();
    }
    const s = span();
    const fits = o.l <= 0.5 && o.r <= 0.5 && s.right - s.left >= MIN_CONTENT;
    if (!fits) {
      setReserve(cols, 0, 0);
      return { docked: false, left: 0, right: 0 };
    }
    return { docked: true, left: applied.left, right: applied.right };
  }

  /** Where the panels anchor: the column's edges without our padding, the right one stopping at a floating native pane. */
  function edges(paneLeft) {
    const cols = findColumns();
    if (!cols.length) return { left: 0, right: win.innerWidth };
    const col = natural(cols[0]);
    return { left: col.left, right: paneLeft == null ? col.right : Math.min(col.right, paneLeft) };
  }

  return { evaluate, signature, edges, reserve: () => ({ ...applied }), dispose: clear };
}
