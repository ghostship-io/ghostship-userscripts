// Pure turn overview model: block elements -> weighted bars. No layout reads, so it
// works for turns that are virtualized out, and never copies message content.
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

/** `blocks`: block-level elements in document order. Nested duplicates are skipped. */
export function buildTurnModel(blocks) {
  const model = [];
  for (const el of blocks) {
    const nested = el.parentElement?.closest("pre,table");
    if (nested) continue;
    if (el.tagName === "LI" && el.querySelector("p")) continue;
    const kind = classify(el);
    const len = textLength(el);
    if (kind === "text" && len === 0) continue;
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

/** Positions in 0..1 of the turn; at most `maxBars` bars so the overview DOM stays bounded. */
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
    return { kind: b.kind, top, height: b.lines / total, width: b.width };
  });
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
