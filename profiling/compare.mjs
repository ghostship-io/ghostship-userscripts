// node profiling/compare.mjs before.json after.json
// Prints a before/after table from two measure.js results (same thread, same
// scroll drive) and exits non-zero on a release-gate regression (#631).
import { readFileSync } from "node:fs";

// Gate thresholds: relative slack, plus an absolute floor so tiny numbers do not flap.
export const LIMITS = {
  loafTotalMs: { rel: 0.1, abs: 50 },
  loafMaxMs: { rel: 0.25, abs: 50 },
  revealOldestMs: { rel: 0.2, abs: 100 },
  heapMaxMB: { rel: 0.15, abs: 20 },
  layoutShift: { rel: 0.25, abs: 0.02 },
};

const get = (r, path) => path.split(".").reduce((o, k) => o?.[k], r);

const ROWS = [
  ["rendered nodes (end)", "dom.end.renderedNodes"],
  ["total nodes (end)", "dom.end.totalNodes"],
  ["turn elements (end)", "dom.end.turnElements"],
  ["long-frame count", "loaf.entries"],
  ["long-frame total ms", "loaf.totalMs", "loafTotalMs"],
  ["long-frame max ms", "loaf.maxMs", "loafMaxMs"],
  ["frame gaps > 50 ms", "frames.over50"],
  ["heap max MB", "heapMB.max", "heapMaxMB"],
  ["time to reveal oldest turn ms", "revealOldestMs", "revealOldestMs"],
  ["layout shift", "layoutShift", "layoutShift"],
  ["unsolicited scroll events", "scroll.unsolicitedEvents"],
  ["unsolicited scroll px", "scroll.unsolicitedPx"],
];

export function compare(before, after) {
  const rows = [];
  const failures = [];
  for (const [name, path, limit] of ROWS) {
    const b = get(before, path);
    const a = get(after, path);
    rows.push({ name, before: b ?? "n/a", after: a ?? "n/a" });
    if (limit && typeof b === "number" && typeof a === "number") {
      const { rel, abs } = LIMITS[limit];
      if (a > b + Math.max(abs, b * rel)) failures.push(`${name}: ${b} -> ${a} exceeds the allowed regression`);
    }
    if (limit && typeof b === "number" && a == null) failures.push(`${name}: measured before but missing after`);
  }
  if ((get(after, "scroll.unsolicitedEvents") ?? 0) > 0) failures.push(`unsolicited scroll events after: ${after.scroll.unsolicitedEvents} (must be 0)`);
  if (get(after, "dom.end.renderedNodes") >= get(before, "dom.end.renderedNodes")) failures.push("rendered nodes did not drop");
  if (before.env?.scriptMode === after.env?.scriptMode) failures.push(`both runs report scriptMode ${before.env?.scriptMode}; they must differ (before: off, after: active)`);
  return { rows, failures };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [beforeFile, afterFile] = process.argv.slice(2);
  if (!beforeFile || !afterFile) {
    console.error("usage: node profiling/compare.mjs before.json after.json");
    process.exit(2);
  }
  const { rows, failures } = compare(JSON.parse(readFileSync(beforeFile, "utf8")), JSON.parse(readFileSync(afterFile, "utf8")));
  const width = Math.max(...rows.map((r) => r.name.length));
  console.log(`${"measure".padEnd(width)}  before  after`);
  for (const r of rows) console.log(`${r.name.padEnd(width)}  ${String(r.before).padEnd(6)}  ${r.after}`);
  console.log(failures.length ? `\nFAIL\n- ${failures.join("\n- ")}` : "\nPASS");
  process.exit(failures.length ? 1 : 0);
}
