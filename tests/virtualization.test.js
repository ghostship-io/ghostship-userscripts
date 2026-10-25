import test from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./virtualization-fixture.js";
import { createRuntime } from "../src/core/runtime.js";
import { DEFAULTS } from "../src/core/config.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createTurnBackend } from "../src/chatgpt/virtualization/backend.js";
import { computeWindow } from "../src/core/virtualization.js";

const SIZE = 10;
const PREFETCH = 2;

/** Mount the real runtime with the content-visibility backend. */
function mount(fx) {
  const warnings = [];
  fx.win.console.warn = (m) => warnings.push(m);
  const backend = createTurnBackend();
  const runtime = createRuntime({ win: fx.win, adapter: chatgptAdapter, backend, config: { ...DEFAULTS, windowTurns: SIZE, prefetchTurns: PREFETCH } });
  const api = () => backend.api();
  return {
    runtime,
    warnings,
    get active() {
      return runtime.mode === "active";
    },
    get controller() {
      return runtime.scroll;
    },
    get stats() {
      return api().stats;
    },
    activeTurnCount: () => api().activeTurnCount(),
    turnCount: () => api().turnCount(),
    observerStats: () => ({ ...api().observerStats(), hubSubscriptions: runtime.observers.size() }),
    navigateToTurn: (...a) => backend.setWindow(...a),
    sync: () => api().sync(),
    dispose: () => runtime.dispose(),
  };
}
const activeTurns = (v) => v.activeTurnCount();

test("computeWindow: latest turns on entry, bounded, shifts with direction", () => {
  const entry = computeWindow({ count: 50, size: 10, prefetch: 2, start: 40, focus: 49, direction: 0 });
  assert.deepEqual([entry.start, entry.end], [40, 49]);
  const up = computeWindow({ count: 50, size: 10, prefetch: 2, start: 40, focus: 39, direction: -1 });
  assert.ok(up.start <= 39 && up.end >= 39);
  assert.ok(up.extraEnd - up.extraStart + 1 <= 10 + 2);
  const small = computeWindow({ count: 4, size: 10, prefetch: 2, start: 0, focus: 3, direction: 1 });
  assert.deepEqual([small.start, small.end], [0, 3]);
  const stay = computeWindow({ count: 50, size: 10, prefetch: 2, start: 40, focus: 45, direction: -1 });
  assert.equal(stay.start, 40);
});

test("entry: only the latest 10 turns render, nothing is detached, viewport unchanged", async () => {
  const fx = createFixture({ turns: 60 });
  const before = fx.counts();
  const top = fx.rawTop();
  const anchor = fx.anchor();
  const v = mount(fx);
  await fx.settle();
  assert.equal(v.active, true);
  assert.equal(activeTurns(v), SIZE);
  const after = fx.counts();
  assert.equal(after.total, before.total, "content-visibility keeps every node in the DOM");
  assert.ok(after.rendered < before.total / 4, `rendered ${after.rendered} of ${before.total}`);
  assert.equal(fx.rawTop(), top);
  assert.deepEqual(fx.anchor(), anchor);
  assert.equal(fx.scrollEvents.length, 0);
  console.log(`# entry 60 turns: total nodes ${before.total}, rendered ${after.rendered}, active elements ${after.activeElements}`);
});

test("streaming at the bottom: every page autoscroll is blocked, no scroll events, no bottom lock", async () => {
  const fx = createFixture({ turns: 30 });
  const v = mount(fx);
  await fx.settle();
  const top = fx.rawTop();
  const anchor = fx.anchor();
  const events = fx.scrollEvents.length;
  for (let i = 0; i < 40; i++) {
    fx.stream(fx.thread.lastElementChild, 18);
    fx.pageAutoscroll();
    if (i % 10 === 9) fx.addTurn();
    await fx.settle();
  }
  assert.equal(fx.rawTop(), top);
  assert.deepEqual(fx.anchor(), anchor);
  assert.equal(fx.scrollEvents.length, events, "no scroll events at all");
  assert.equal(v.controller.stats.unexpected, 0);
  const b = v.controller.stats.blocked;
  assert.ok(b.scrollTop >= 40 && b.scrollTo >= 40 && b.scrollBy >= 40 && b.scrollIntoView >= 40, JSON.stringify(b));
  assert.ok(activeTurns(v) <= SIZE + PREFETCH);
  assert.ok(fx.scrollHeight() - fx.rawTop() - fx.viewport > 500, "content grew past the viewport without following it");
});

test("streaming while reading an older turn keeps the exact offset", async () => {
  const fx = createFixture({ turns: 40 });
  const v = mount(fx);
  await fx.settle();
  fx.setTop(fx.rawTop() - 5000);
  fx.wheel(-137.5);
  await fx.settle();
  const anchor = fx.anchor();
  const events = fx.scrollEvents.length;
  for (let i = 0; i < 20; i++) {
    fx.stream(fx.thread.lastElementChild, 25);
    fx.pageAutoscroll();
    await fx.settle();
  }
  assert.deepEqual(fx.anchor(), anchor);
  assert.equal(fx.scrollEvents.length, events);
  assert.equal(v.controller.stats.unexpected, 0);
});

test("anchor offset survives resizes above it (image load, code expansion) and window shifts", async () => {
  const fx = createFixture({ turns: 40 });
  const v = mount(fx);
  await fx.settle();
  fx.wheel(-2500.25);
  await fx.settle();
  const anchor = fx.anchor();
  const els = fx.elements();
  const idx = els.findIndex((e) => e.getAttribute("data-testid") === anchor.id);
  const above = els[idx - 1];
  assert.equal(above.getAttribute("data-gs-state"), "active", "neighbouring turn is live");
  for (const delta of [220, -90, 1500, -400.5]) {
    fx.setHeight(above, above.__h + delta);
    await fx.settle();
    assert.deepEqual(fx.anchor(), anchor, `after resize ${delta}`);
  }
  assert.equal(v.controller.stats.unexpected, 0);
  assert.ok(v.controller.stats.corrections >= 4);
});

test("a scroll that bypasses the JS APIs (native anchoring) is reverted and counted", async () => {
  const fx = createFixture({ turns: 40 });
  const v = mount(fx);
  await fx.settle();
  fx.wheel(-1000);
  await fx.settle();
  const anchor = fx.anchor();
  fx.advance(10_000);
  fx.nativeJump(fx.rawTop() + 700);
  await fx.settle();
  assert.deepEqual(fx.anchor(), anchor);
  assert.equal(v.controller.stats.unexpected, 1);
});

test("slow upward scroll: window follows, bounded, no blank gap, anchor continuous", async () => {
  const fx = createFixture({ turns: 40 });
  const v = mount(fx);
  await fx.settle();
  let maxActive = 0;
  for (let i = 0; i < 400 && fx.rawTop() > 0; i++) {
    fx.wheel(-300);
    fx.advance(16);
    await fx.settle();
    maxActive = Math.max(maxActive, activeTurns(v));
    assert.equal(fx.blankInViewport().length, 0, `blank gap at step ${i}`);
  }
  assert.equal(fx.rawTop(), 0);
  assert.ok(maxActive <= SIZE + PREFETCH, `max active ${maxActive}`);
  assert.equal(v.controller.stats.unexpected, 0);
  console.log(`# slow upward scroll: max active turns ${maxActive}, syncs ${v.stats.syncs}`);
});

test("direct and rapid navigation through the explicit API", async () => {
  const fx = createFixture({ turns: 40 });
  const v = mount(fx);
  await fx.settle();
  assert.equal(v.navigateToTurn(0), true);
  await fx.settle();
  assert.equal(fx.rawTop(), 0);
  assert.equal(fx.blankInViewport().length, 0);
  for (const i of [39, 3, 25, 0, 31, 12]) {
    assert.equal(v.navigateToTurn(i, { offset: 24 }), true);
    await fx.settle();
    const top = fx.elements()[2 * i].getBoundingClientRect().top;
    if (fx.rawTop() > 0 && fx.rawTop() < fx.maxTop()) assert.equal(top, 24, `turn ${i} at the requested offset`);
    assert.equal(fx.blankInViewport().length, 0);
    assert.ok(activeTurns(v) <= SIZE + PREFETCH, `active ${activeTurns(v)}`);
  }
  assert.equal(v.controller.stats.unexpected, 0);
});

test("long code/table/image turns keep stable heights when skipped and restored", async () => {
  const fx = createFixture({ turns: 40 });
  const heights = fx.elements().map((e) => e.__h);
  const total = fx.scrollHeight();
  const v = mount(fx);
  await fx.settle();
  assert.equal(fx.scrollHeight(), total, "placeholders reproduce measured heights");
  v.navigateToTurn(0);
  await fx.settle();
  v.navigateToTurn(39);
  await fx.settle();
  assert.equal(fx.scrollHeight(), total);
  assert.deepEqual(fx.elements().map((e) => e.__h), heights);
});

test("React remount of every turn: window and anchor recover", async () => {
  const fx = createFixture({ turns: 40 });
  const v = mount(fx);
  await fx.settle();
  fx.wheel(-1800);
  await fx.settle();
  const anchor = fx.anchor();
  fx.remount();
  await fx.settle();
  assert.equal(v.active, true);
  assert.ok(activeTurns(v) <= SIZE + PREFETCH);
  assert.equal(fx.blankInViewport().length, 0);
  assert.deepEqual(fx.anchor(), anchor);
  assert.equal(fx.scrollEvents.filter(Boolean).length, fx.scrollEvents.length);
  assert.ok(fx.counts().activeElements <= (SIZE + PREFETCH) * 2);
});

test("selection and focus pin a skipped turn", async () => {
  const fx = createFixture({ turns: 40 });
  const v = mount(fx);
  await fx.settle();
  fx.wheel(-4000);
  await fx.settle();
  const oldEl = fx.elements()[2];
  const range = fx.doc.createRange();
  range.selectNodeContents(oldEl.firstElementChild);
  fx.doc.getSelection().removeAllRanges();
  fx.doc.getSelection().addRange(range);
  v.sync();
  await fx.settle();
  assert.equal(oldEl.getAttribute("data-gs-state"), "active");
  assert.ok(v.stats.pinned >= 1);
});

test("observers stay bounded across long streaming sessions", async () => {
  const fx = createFixture({ turns: 30 });
  const v = mount(fx);
  await fx.settle();
  for (let i = 0; i < 60; i++) {
    fx.addTurn();
    await fx.settle();
  }
  const s = v.observerStats();
  assert.ok(s.resizeTargets <= (SIZE + PREFETCH) * 2 + 2, JSON.stringify(s));
  assert.equal(fx.observedTargets(), s.resizeTargets);
  assert.equal(s.hubSubscriptions, 2, "one for the prompt index, one for the turn container");
  assert.equal(activeTurns(v), SIZE);
  console.log(`# 60 appended turns: turns ${v.turnCount()}, resize targets ${s.resizeTargets}, active turns ${activeTurns(v)}`);
});

test("fail open: unknown markup leaves the page untouched and native scrolling intact", async () => {
  const cases = [
    ["chatgpt", (fx) => fx.elements().forEach((e) => (e.innerHTML = "<div>x</div>")), /unknown-role/],
    ["chatgpt", (fx) => { const w = fx.doc.createElement("div"); fx.elements()[3].replaceWith(w); w.append(fx.doc.createElement("article")); w.firstChild.setAttribute("data-testid", "conversation-turn-99"); w.firstChild.innerHTML = '<div data-message-author-role="user">x</div>'; }, /turns-not-siblings/],
  ];
  for (const [markup, mutate, reason] of cases) {
    const fx = createFixture({ turns: 10, markup });
    mutate(fx);
    const snapshot = fx.doc.documentElement.outerHTML;
    const v = mount(fx);
    assert.equal(v.active, false);
    assert.equal(v.runtime.mode, "safe");
    assert.match(v.warnings.join("\n"), reason);
    assert.equal(fx.doc.documentElement.outerHTML, snapshot);
    fx.scroller.scrollTop = 100;
    assert.equal(fx.rawTop(), 100, "native scrolling is not intercepted");
    assert.equal(v.runtime.observers, undefined);
  }
});

test("fail open at runtime when the markup stops matching, restoring everything", async () => {
  const fx = createFixture({ turns: 30 });
  const v = mount(fx);
  await fx.settle();
  assert.equal(v.active, true);
  fx.elements().forEach((e) => e.removeAttribute("data-testid"));
  fx.thread.append(fx.doc.createElement("div"));
  await fx.settle();
  assert.equal(v.runtime.mode, "safe");
  assert.match(v.warnings.join("\n"), /no-turns/);
  assert.equal(fx.doc.querySelector("[data-gs-state]"), null);
  assert.equal(fx.doc.getElementById("gs-virtualization-style"), null);
  fx.scroller.scrollTop = 123;
  assert.equal(fx.rawTop(), 123, "scroll patches removed");
});

test("dispose restores the DOM exactly", async () => {
  const fx = createFixture({ turns: 30 });
  const snapshot = fx.doc.documentElement.outerHTML;
  const v = mount(fx);
  await fx.settle();
  assert.notEqual(fx.doc.documentElement.outerHTML, snapshot);
  v.dispose();
  assert.equal(fx.doc.documentElement.outerHTML, snapshot);
  fx.scroller.scrollTop = 321;
  assert.equal(fx.rawTop(), 321);
});
