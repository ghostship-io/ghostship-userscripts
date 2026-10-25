import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createFixture } from "./virtualization-fixture.js";
import { installPageGuards, runBundle } from "./gate/harness.js";
import { compare } from "../profiling/compare.mjs";

const MEASURE = new URL("../profiling/measure.js", import.meta.url);
const source = readFileSync(MEASURE, "utf8");

/** Chrome-like PerformanceObserver so the long-frame and layout-shift paths run. */
function fakePerformanceObserver(win) {
  const live = new Set();
  win.PerformanceObserver = class {
    static supportedEntryTypes = ["long-animation-frame", "layout-shift"];
    constructor(cb) { this.cb = cb; }
    observe({ type }) { this.type = type; live.add(this); }
    disconnect() { live.delete(this); }
  };
  Object.defineProperty(win.performance, "memory", { configurable: true, value: { usedJSHeapSize: 50 * 1048576 } });
  return { emit: (type, ...entries) => live.forEach((po) => po.type === type && po.cb({ getEntries: () => entries })), live };
}

function profiled({ withScript }) {
  const fx = createFixture({ turns: 40 });
  const perf = fakePerformanceObserver(fx.win);
  const guards = installPageGuards(fx);
  if (withScript) runBundle(fx);
  return { fx, perf, guards };
}

const install = (fx) => new vm.Script(source, { filename: "measure.js" }).runInContext(fx.dom.getInternalVMContext());

async function scrollToTop(fx) {
  for (let i = 0; i < 80 && fx.rawTop() > 0; i++) {
    fx.wheel(-3000);
    await fx.settle();
  }
}

async function session(options) {
  const env = profiled(options);
  await env.fx.settle();
  const before = env.fx.doc.documentElement.outerHTML;
  assert.deepEqual(JSON.parse(JSON.stringify(install(env.fx))), { installed: true });
  assert.equal(env.fx.win.__gsProfile.start("thread-A").started, true);
  await env.fx.settle();
  env.perf.emit("long-animation-frame", { duration: 120, blockingDuration: 70 }, { duration: 60, blockingDuration: 10 });
  env.perf.emit("layout-shift", { value: 0.01, hadRecentInput: false }, { value: 0.5, hadRecentInput: true });
  await scrollToTop(env.fx);
  await env.fx.settle();
  const result = JSON.parse(JSON.stringify(env.fx.win.__gsProfile.stop()));
  env.fx.win.__gsProfile.dispose();
  return { ...env, result, domUnchanged: env.fx.doc.documentElement.outerHTML === before };
}

test("measure.js: records DOM, long frames, heap, layout shift, user scroll and time to reveal the oldest turn", async () => {
  const { result, perf } = await session({ withScript: false });
  assert.equal(result.schema, 1);
  assert.equal(result.label, "thread-A");
  assert.equal(result.dom.end.turnElements, 80);
  assert.equal(result.dom.end.renderedNodes, result.dom.end.totalNodes, "nothing skipped without the script");
  assert.deepEqual(result.loaf, { entries: 2, totalMs: 180, blockingMs: 80, maxMs: 120, over100: 1 });
  assert.equal(result.env.longFrameApi, "long-animation-frame");
  assert.equal(result.heapMB.max, 50);
  assert.equal(result.layoutShift, 0.01, "shifts caused by input are excluded");
  assert.ok(result.scroll.userEvents > 0);
  assert.equal(result.scroll.unsolicitedEvents, 0, "wheel-driven scrolling is user intent");
  assert.ok(result.scroll.netPx < 0);
  assert.equal(typeof result.revealOldestMs, "number");
  assert.equal(result.env.scriptMode, null);
  assert.equal(perf.live.size, 0, "observers disconnected after stop");
});

test("measure.js: scrolling nobody asked for is counted as unsolicited (canary)", async () => {
  const { fx } = profiled({ withScript: false });
  fx.setTop(fx.rawTop() - 3000); // reading an older turn
  await fx.settle();
  install(fx);
  fx.win.__gsProfile.start("canary");
  fx.pageAutoscroll(); // what ChatGPT does while streaming
  await fx.settle();
  fx.nativeJump(100);
  await fx.settle();
  const result = fx.win.__gsProfile.stop();
  assert.ok(result.scroll.unsolicitedEvents >= 2);
  assert.ok(result.scroll.maxUnsolicitedPx > 0);
});

test("measure.js: with the script enabled the same drive renders far fewer nodes and moves nothing unasked", async () => {
  const off = await session({ withScript: false });
  const on = await session({ withScript: true });
  assert.equal(on.result.env.scriptMode, "active");
  assert.equal(on.result.dom.end.totalNodes, off.result.dom.end.totalNodes + 1, "content-visibility keeps every node (+1 style element)");
  assert.equal(on.result.scroll.unsolicitedEvents, 0);
  assert.equal(typeof on.result.revealOldestMs, "number");
  const { failures } = compare(off.result, on.result);
  // The synthetic long-frame numbers are identical, so only the rendered-nodes drop is under test here.
  assert.deepEqual(failures, []);
  assert.ok(on.result.dom.end.renderedNodes < off.result.dom.end.renderedNodes);
});

test("measure.js is read-only: no DOM change, no click, no submit, no network, no storage", async () => {
  for (const withScript of [false, true]) {
    const { domUnchanged, guards, fx } = await session({ withScript });
    if (!withScript) assert.equal(domUnchanged, true);
    assert.deepEqual(guards.report(), { nativeClicks: [], formSubmits: 0, network: [] });
    assert.equal(fx.win.__gsProfile, undefined, "dispose removes the global");
  }
  const code = source.replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(
    code,
    /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|document\.cookie)\b|\.click\(|\.submit\(|requestSubmit|dispatchEvent|\.(innerHTML|outerHTML|textContent|value)\s*=[^=]|\.(setAttribute|removeAttribute|append|appendChild|prepend|insertBefore|remove|replaceWith|scrollTo|scrollBy|scrollIntoView|focus|blur)\(|\.scrollTop\s*=|\.style\b/,
  );
});

test("compare: passes a clean improvement and fails each release-gate regression", () => {
  const base = {
    env: { scriptMode: null },
    dom: { end: { renderedNodes: 100000, totalNodes: 100000, turnElements: 400 } },
    loaf: { entries: 40, totalMs: 4000, maxMs: 300 },
    frames: { over50: 90 },
    heapMB: { max: 800 },
    revealOldestMs: 2000,
    layoutShift: 0.1,
    scroll: { unsolicitedEvents: 3, unsolicitedPx: 400 },
  };
  const good = structuredClone(base);
  Object.assign(good, { env: { scriptMode: "active" }, loaf: { entries: 10, totalMs: 900, maxMs: 120 }, revealOldestMs: 900 });
  good.dom.end.renderedNodes = 9000;
  good.scroll = { unsolicitedEvents: 0, unsolicitedPx: 0 };
  assert.deepEqual(compare(base, good).failures, []);

  const mutate = (fn) => { const r = structuredClone(good); fn(r); return compare(base, r).failures.join("\n"); };
  assert.match(mutate((r) => (r.scroll.unsolicitedEvents = 1)), /unsolicited/);
  assert.match(mutate((r) => (r.loaf.totalMs = 4600)), /long-frame total/);
  assert.match(mutate((r) => (r.revealOldestMs = 2800)), /reveal/);
  assert.match(mutate((r) => (r.heapMB.max = 1000)), /heap/);
  assert.match(mutate((r) => (r.dom.end.renderedNodes = 100000)), /rendered nodes did not drop/);
  assert.match(mutate((r) => (r.env.scriptMode = null)), /scriptMode/);
  assert.match(mutate((r) => delete r.revealOldestMs), /missing after/);
});
