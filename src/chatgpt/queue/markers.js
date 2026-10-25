// A small pencil on every sidebar conversation that holds a queued prompt (the one on screen included), so a queue left
// behind in another conversation stays visible. Change-only: a second pass with the same ids touches nothing, and what
// ChatGPT's re-render drops is put back on the next pass. Nothing native is moved, removed or re-created.
const MARK = "data-gs-queued";
const STYLE_ID = "gs-queued-style";
const CSS = `[${MARK}]{display:inline-flex;flex:none;align-items:center;margin-left:6px;opacity:.8}
[${MARK}] svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}`;
const ICON = ["M4 20l4-1 11-11-3-3L5 16z", "M14 7l3 3"];

export function createQueueMarkers({ doc, adapter }) {
  const ns = "http://www.w3.org/2000/svg";

  const build = () => {
    const mark = doc.createElement("span");
    mark.setAttribute(MARK, "");
    mark.setAttribute("data-gs-ui", "");
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", "A message is queued in this conversation");
    mark.title = "A message is queued in this conversation";
    const svg = doc.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const d of ICON) {
      const path = doc.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    mark.append(svg);
    return mark;
  };

  return {
    /** Puts a marker on each listed conversation's row and takes it off every other row. */
    sync(queued) {
      if (queued.size && !doc.getElementById(STYLE_ID)) {
        const style = doc.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        doc.head.append(style);
      }
      const wanted = new Map();
      for (const row of adapter.sidebarLinks(doc)) if (queued.has(row.id)) wanted.set(row.host, row);
      for (const mark of doc.querySelectorAll(`[${MARK}]`)) {
        if (!wanted.has(mark.parentElement)) mark.remove();
      }
      for (const [host] of wanted) if (!host.querySelector(`:scope > [${MARK}]`)) host.append(build());
    },
    dispose() {
      for (const mark of doc.querySelectorAll(`[${MARK}]`)) mark.remove();
      doc.getElementById(STYLE_ID)?.remove();
    },
  };
}
