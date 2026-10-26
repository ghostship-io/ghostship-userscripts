// The one owner of the pinned panels' room in the page layout. The panels sit together in a right-hand column
// (the conversation view on top, the prompt list below it) and need `right` px beside the page column's right
// edge. The page column (conversation, header, composer and queue panel together) gets right padding, so the
// centered conversation and the composer shift to the middle of the space the panels leave, at their own width.
// Nothing is written when the natural right gutter already fits them, or when the panels are hidden. When the
// shifted conversation would become too narrow (or the window is below the dock threshold) nothing is reserved
// and the panels become a drawer opened on request, so they never cover native UI on their own. A native pane
// that is open takes the room instead: the caller asks for no room at all and ChatGPT lays itself out.
export const PANEL_WIDTH = 300; // the width of ChatGPT's own summary card
export const PANEL_GAP = 12; // between a panel and the column edge, and between a panel and the conversation
export const DOCK_MIN_VIEWPORT = 1024;
export const MIN_CONTENT = 560;

export const LAYOUT_CSS = `
[data-gs-column][data-gs-right]{box-sizing:border-box;padding-right:var(--gs-reserve,0px)}
[data-gs-header]{margin-right:calc(-1 * var(--gs-reserve,0px))}
`;

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {object} o.adapter columns(doc), composer(doc)
 * @param {() => Element|undefined} o.target the conversation element (a turn); the composer when absent
 *
 * `evaluate({ right, force })`: `right` is the width of the panel column to dock (0 when hidden); `force` pads that width even when the
 * natural gutter would fit it, which an inline native pane needs to end up beside the column rather than under it.
 */
export function createRailLayout({ win, adapter, target }) {
  const doc = win.document;
  let written = []; // the elements we have written to
  let known = null; // { frame, pads } once found: the panels are rebuilt whenever the page layout is
  let applied = 0;
  let anchor = win.innerWidth; // the right edge the panels sit against, from the last evaluation
  let epoch = 0; // counts how often the page's elements were looked up again

  /** `{ frame, pads }`: the page column that is measured, and the elements that get the padding; null when not found. */
  const findColumns = () => {
    if (!known || !known.frame.isConnected || known.pads.some((el) => !el.isConnected) || (known.header && !known.header.isConnected)) {
      known = adapter.columns(doc);
      epoch++;
    }
    return known;
  };

  function release(el) {
    for (const a of ["data-gs-column", "data-gs-right"]) el.removeAttribute(a);
    el.style.removeProperty("--gs-reserve");
    if (!el.getAttribute("style")) el.removeAttribute("style");
  }

  function setReserve(cols, right) {
    if (written.some((el) => !cols.includes(el))) clear();
    written = cols;
    const header = findColumns()?.header;
    if (header) {
      // The header sits inside the padded column but spans the window: it cancels the padding.
      if (right > 0) {
        if (header.getAttribute("data-gs-header") === null) header.setAttribute("data-gs-header", "");
      } else if (header.hasAttribute("data-gs-header")) header.removeAttribute("data-gs-header");
    }
    const r = Math.max(0, Math.round(right));
    for (const col of cols) {
      if (r > 0) {
        if (col.getAttribute("data-gs-column") === null) col.setAttribute("data-gs-column", "");
        if (col.getAttribute("data-gs-right") === null) col.setAttribute("data-gs-right", "");
        if (col.style.getPropertyValue("--gs-reserve") !== `${r}px`) col.style.setProperty("--gs-reserve", `${r}px`);
      } else if (col.hasAttribute("data-gs-column") || col.hasAttribute("data-gs-right")) release(col);
    }
    applied = r;
  }

  function clear() {
    const header = known?.header;
    if (header?.hasAttribute("data-gs-header")) header.removeAttribute("data-gs-header");
    for (const el of written) release(el);
    written = [];
    applied = 0;
  }

  /** What decides the layout independent of what we applied; a change means re-evaluate. */
  function signature() {
    const cols = findColumns();
    if (!cols) return "none";
    const r = cols.frame.getBoundingClientRect();
    return `${win.innerWidth}|${Math.round(r.left)}|${Math.round(r.right)}|${cols.pads.length}|${epoch}`;
  }

  /** The column's box: our padding changes what is inside it, never its own edges. */
  const natural = (col) => {
    const r = col.getBoundingClientRect();
    return { left: r.left, right: r.right };
  };

  /**
   * Measure the natural layout, then reserve what the docked panels still need. Returns `{ docked, right }`;
   * `docked` is false when there is no room and the panels must be a drawer.
   *
   * The page column is padded first on its own. The composer's overlay (absolutely positioned inside the column on
   * chatgpt.com) usually follows the column and must not be padded again; when it does not (the composer would sit
   * off the conversation's center), it is padded too.
   */
  function evaluate({ right = 0, force = false } = {}) {
    const cols = findColumns();
    const el = target() ?? adapter.composer(doc);
    if (!cols || !el || win.innerWidth < DOCK_MIN_VIEWPORT) {
      if (cols) setReserve(cols.pads, 0);
      else clear();
      anchor = win.innerWidth;
      return { docked: false, right: 0 };
    }
    setReserve(cols.pads, 0);
    const col = natural(cols.frame);
    anchor = col.right;
    const need = right > 0 ? right + 2 * PANEL_GAP : 0; // gap to the column edge and to the conversation
    // Both the conversation and the composer must clear the panels; they can sit in different boxes.
    const span = () => {
      const c = adapter.composer(doc)?.getBoundingClientRect();
      const t = el.getBoundingClientRect();
      return { left: c ? Math.min(t.left, c.left) : t.left, right: c ? Math.max(t.right, c.right) : t.right };
    };
    const over = Math.max(0, span().right - (col.right - need));
    if (over > 0.5 || (force && need > 0)) {
      // The conversation is centered in the page column, so padding the right by exactly what the panels take
      // re-centers it in the space they leave, whatever the page's own margins.
      setReserve(cols.pads.slice(0, 1), need);
      const centered = () => {
        const c = adapter.composer(doc)?.getBoundingClientRect();
        const t = target()?.getBoundingClientRect();
        return c && t ? Math.abs((c.left + c.right) / 2 - (t.left + t.right) / 2) : 0;
      };
      if (cols.pads.length > 1 && centered() > 2) {
        const first = centered();
        setReserve(cols.pads, need);
        if (centered() > first) setReserve(cols.pads.slice(0, 1), need); // it followed the column after all: padded twice
      }
    }
    const s = span();
    const fits = Math.max(0, s.right - (col.right - need)) <= 0.5 && s.right - s.left >= MIN_CONTENT;
    if (!fits) {
      setReserve(cols.pads, 0);
      anchor = win.innerWidth;
      return { docked: false, right: 0 };
    }
    return { docked: true, right: applied };
  }

  /** Where the panels anchor: the right edge of the page column. */
  function edge() {
    return anchor;
  }

  return { evaluate, signature, edge, reserve: () => applied, dispose: clear };
}
