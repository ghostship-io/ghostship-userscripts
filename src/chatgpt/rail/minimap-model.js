// Turn overview model. `silhouette` turns the real rendered boxes of a turn into at most `maxItems` items
// (fractions of the turn's box); `buildTurnModel` + `layoutBars` estimate the same from content for a turn that
// is not rendered (virtualized out), where no real geometry exists. Neither copies message content.
const HEADING = /^H[1-6]$/;
const PRIORITY = ["code", "table", "image", "heading", "text"];

function classify(el) {
  if (HEADING.test(el.tagName)) return "heading";
  switch (el.tagName) {
    case "PRE":
      return "code";
    case "TABLE":
      return "table";
    case "IMG":
      return "image";
    default:
      return "text";
  }
}

const textLength = (el) => (el.textContent ?? "").trim().length;

/** What a block element draws as, or null when it is skipped (nested in code/table, a wrapper, or empty text). */
export function blockKind(el) {
  if (el.parentElement?.closest("pre,table")) return null;
  if (el.tagName === "LI" && el.querySelector("p")) return null;
  const kind = classify(el);
  return kind === "text" && textLength(el) === 0 ? null : kind;
}

/** `blocks`: block-level elements in document order. Nested duplicates are skipped. */
export function buildTurnModel(blocks) {
  const model = [];
  for (const el of blocks) {
    const kind = blockKind(el);
    if (!kind) continue;
    const len = textLength(el);
    let lines;
    let width;
    if (kind === "code") {
      lines = Math.min(60, ((el.textContent ?? "").match(/\n/g)?.length ?? 0) + 1) + 1;
      width = 0.95;
    } else if (kind === "table") {
      lines = Math.min(40, el.querySelectorAll("tr").length) * 1.4 + 1;
      width = 0.95;
    } else if (kind === "image") {
      lines = 8;
      width = 0.8;
    } else if (kind === "heading") {
      lines = 2;
      width = Math.min(0.7, 0.2 + len / 120);
    } else {
      lines = Math.max(1, Math.ceil(len / 90));
      width = Math.min(1, 0.25 + len / 200);
    }
    model.push({ kind, lines, width });
  }
  return model.length ? model : [{ kind: "text", lines: 1, width: 0.3 }];
}

/** Estimated items for a turn without geometry: `{ kind, top, height, left, width }`, all 0..1. */
export function layoutBars(model, maxBars = 120) {
  const chunk = Math.ceil(model.length / maxBars);
  const merged = [];
  for (let i = 0; i < model.length; i += chunk) {
    const group = model.slice(i, i + chunk);
    merged.push({
      kind: PRIORITY.find((k) => group.some((g) => g.kind === k)),
      lines: group.reduce((n, g) => n + g.lines, 0),
      width: Math.max(...group.map((g) => g.width)),
    });
  }
  const total = merged.reduce((n, b) => n + b.lines + 0.5, 0);
  let cursor = 0;
  return merged.map((b) => {
    const top = cursor / total;
    cursor += b.lines + 0.5;
    const width = b.width * 0.76;
    return { kind: b.kind, top, height: b.lines / total, left: 0.12, width };
  });
}

/**
 * The turn as it is really laid out. `boxes`: `{ kind, top, bottom, left, right }` in page pixels, kind one of
 * prompt | text | heading | code | table | image; `extent`: `{ top, bottom }` of the whole turn. Items are
 * fractions of the turn's box (horizontally of the span the boxes cover), at most `maxItems`: neighbours are
 * merged (the most structural kind wins) when there are more.
 */
export function silhouette(boxes, extent, maxItems = 120) {
  const span = extent.bottom - extent.top;
  const live = boxes.filter((b) => b.bottom > b.top && b.right > b.left).sort((a, b) => a.top - b.top);
  if (span <= 0 || !live.length) return [];
  const chunk = Math.ceil(live.length / maxItems);
  const merged = [];
  for (let i = 0; i < live.length; i += chunk) {
    const group = live.slice(i, i + chunk);
    merged.push({
      kind: group.length === 1 ? group[0].kind : ["prompt", ...PRIORITY].find((k) => group.some((g) => g.kind === k)),
      top: Math.min(...group.map((g) => g.top)),
      bottom: Math.max(...group.map((g) => g.bottom)),
      left: Math.min(...group.map((g) => g.left)),
      right: Math.max(...group.map((g) => g.right)),
    });
  }
  const x0 = Math.min(...merged.map((b) => b.left));
  const w = Math.max(...merged.map((b) => b.right)) - x0;
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  return merged.map((b) => ({
    kind: b.kind,
    top: clamp01((b.top - extent.top) / span),
    height: clamp01((b.bottom - b.top) / span),
    left: w > 0 ? clamp01((b.left - x0) / w) : 0,
    width: w > 0 ? clamp01((b.right - b.left) / w) : 1,
  }));
}

/** Where the viewport sits in the turn (0..1) and the fraction of the turn visible; null when they do not intersect. */
export function viewportIndicator({ turnTop, turnBottom, viewTop, viewBottom }) {
  const span = turnBottom - turnTop;
  if (span <= 0 || viewBottom <= turnTop || viewTop >= turnBottom) return null;
  const top = Math.max(0, (viewTop - turnTop) / span);
  const bottom = Math.min(1, (viewBottom - turnTop) / span);
  return { top, height: Math.max(bottom - top, 0.02), visible: bottom - top };
}

/** Scroll position (px within the scroller's content) for a click/drag at `fraction` of the turn. */
export function scrollTopForFraction({ fraction, turnTop, turnHeight, viewHeight }) {
  const target = turnTop + fraction * turnHeight - viewHeight / 2;
  const max = turnTop + Math.max(0, turnHeight - viewHeight);
  return Math.max(turnTop, Math.min(max, target));
}
