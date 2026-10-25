import test from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./virtualization-fixture.js";
import { createRuntime } from "../src/core/runtime.js";
import { DEFAULTS } from "../src/core/config.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createTurnBackend } from "../src/chatgpt/virtualization/backend.js";
import { createRail } from "../src/chatgpt/rail/rail.js";
import { createRailStateStore } from "../src/chatgpt/rail/rail-state.js";

const mountRuntime = (fx) => {
  const runtime = createRuntime({ win: fx.win, adapter: chatgptAdapter, backend: createTurnBackend(), config: { ...DEFAULTS } });
  assert.equal(runtime.mode, "active");
  return runtime;
};
const mount = (fx, store) => {
  const runtime = mountRuntime(fx);
  const rail = createRail({ win: fx.win, adapter: chatgptAdapter, runtime, store });
  return { runtime, rail, moved: () => runtime.diagnostics.snapshot()["scroll.moved.open"] ?? 0 };
};
const last = (fx) => fx.elements().at(-1);
// 39 turns: the newest (index 38) is a tall one, so its start can reach the top of the viewport.
const LONG = { turns: 39, width: 1600, markup: "real" };

test("opening a long conversation scrolls once, to the start of the latest prompt", async () => {
  const fx = createFixture(LONG);
  assert.equal(fx.rawTop(), fx.maxTop(), "the page opens at the bottom");
  const events = fx.scrollEvents.length;
  const { runtime, moved } = mount(fx);
  await fx.settle();
  assert.ok(fx.topOf(last(fx)) < fx.maxTop(), "the latest turn is taller than the viewport");
  assert.equal(fx.rawTop(), fx.topOf(last(fx)), "the top of the latest prompt is at the top of the viewport");
  assert.equal(last(fx).getBoundingClientRect().top, 0);
  assert.equal(fx.scrollEvents.length, events + 1, "one scroll");
  assert.equal(moved(), 1);
  assert.equal(runtime.scroll.stats.unexpected, 0);
});

test("it never repeats: streaming, page autoscroll, new turns and later renders leave the viewport alone", async () => {
  const fx = createFixture(LONG);
  const { runtime, moved } = mount(fx);
  await fx.settle();
  const top = fx.rawTop();
  const events = fx.scrollEvents.length;
  for (let i = 0; i < 10; i++) {
    fx.stream(last(fx).firstElementChild, 30);
    fx.pageAutoscroll();
    await fx.settle();
  }
  fx.addTurn();
  await fx.settle();
  fx.remount();
  await fx.settle();
  assert.equal(fx.rawTop(), top);
  assert.equal(fx.scrollEvents.length, events);
  assert.equal(moved(), 1);
  assert.equal(runtime.scroll.stats.unexpected, 0);
});

test("a short conversation, where the latest prompt cannot reach the top, is left where the page put it", async () => {
  const fx = createFixture({ turns: 3, width: 1600, markup: "real" });
  const events = fx.scrollEvents.length;
  const top = fx.rawTop();
  mount(fx);
  await fx.settle();
  assert.equal(fx.rawTop(), top);
  assert.equal(fx.scrollEvents.length, events);
  // A medium thread whose last turn is shorter than the viewport ends at the bottom, the page's own limit.
  const mid = createFixture({ turns: 20, width: 1600, markup: "real" });
  mount(mid);
  await mid.settle();
  assert.equal(mid.rawTop(), mid.maxTop());
});

test("it yields to a user scroll that started first and does not come back", async () => {
  const fx = createFixture(LONG);
  const runtime = mountRuntime(fx);
  fx.wheel(-400); // the user is already scrolling when the pane starts
  const rail = createRail({ win: fx.win, adapter: chatgptAdapter, runtime });
  await fx.settle();
  const where = fx.rawTop();
  assert.equal(where, fx.maxTop() - 400);
  assert.equal(runtime.diagnostics.snapshot()["scroll.moved.open"], undefined);
  assert.ok(runtime.diagnostics.snapshot()["scroll.open.yielded"] >= 1);
  fx.addTurn();
  await fx.settle();
  assert.equal(fx.rawTop(), where, "it does not retry later");
  rail.dispose();

  // Same when the user scrolled after the pane started but before the latest turn had rendered.
  const late = createFixture(LONG);
  late.setHeight(last(late).firstElementChild, 0);
  const ui = mount(late);
  await late.settle();
  assert.equal(ui.moved(), 0, "waiting for the turn to render");
  late.wheel(-300);
  await late.settle();
  late.setHeight(last(late).firstElementChild, 1500);
  late.thread.append(late.doc.createComment("render"));
  await late.settle();
  assert.equal(ui.moved(), 0);
  assert.ok(late.rawTop() < late.maxTop(), "the user's position is kept");
});

test("it waits for the latest turn to render, then scrolls once", async () => {
  const fx = createFixture(LONG);
  const tall = last(fx).firstElementChild.__h;
  fx.setHeight(last(fx).firstElementChild, 0);
  const { moved } = mount(fx);
  await fx.settle();
  assert.equal(moved(), 0);
  fx.setHeight(last(fx).firstElementChild, tall);
  fx.thread.append(fx.doc.createComment("render"));
  await fx.settle();
  assert.equal(moved(), 1);
  assert.equal(fx.rawTop(), fx.topOf(last(fx)));
});

test("returning to a conversation restores its saved reading position instead of opening at the latest prompt", async () => {
  const store = createRailStateStore();
  const fx = createFixture(LONG);
  let ui = mount(fx, store);
  await fx.settle();
  fx.wheel(-2500); // the user reads further up
  await fx.settle();
  const reading = fx.rawTop();
  ui.rail.dispose();
  ui.runtime.dispose();

  ui = mount(fx, store);
  await fx.settle();
  assert.equal(ui.moved(), 0, "no second opening scroll");
  assert.ok(Math.abs(fx.rawTop() - reading) <= 1, "back where the user was reading");
  ui.rail.dispose();
  ui.runtime.dispose();
});

/** Hold the open-selection timers (500 ms settle, 1500 ms follow) so a test decides when time passes. */
function holdOpenTimers(fx) {
  const held = [];
  const real = fx.win.setTimeout;
  fx.win.setTimeout = (fn, ms) => (ms === 500 || ms === 1500 ? held.push({ fn, ms }) : real(fn, ms));
  return {
    held,
    /** Let the oldest pending timer fire (stale ones are ignored by the rail). */
    async fire(fx2 = fx) {
      held.splice(0).forEach((t) => t.fn());
      await fx2.settle();
    },
  };
}
const lastRow = (fx) => [...fx.doc.querySelectorAll(".gs-prompt")].at(-1);
const current = (fx) => fx.doc.querySelector('.gs-prompt[aria-current="true"]');

test("on open it waits for the page to settle, then selects the last prompt like a click on it", async () => {
  const fx = createFixture({ ...LONG, turns: 30 });
  const t = holdOpenTimers(fx);
  fx.setTop(fx.maxTop() - 3000); // the page opens somewhere that is not the newest prompt's start
  const { moved } = mount(fx);
  await fx.settle();
  assert.equal(moved(), 0, "nothing happens before the page has settled");
  assert.ok(t.held.some((x) => x.ms === 500), "waiting for the list to stay unchanged");
  await t.fire();
  assert.equal(moved(), 1);
  assert.equal(current(fx), lastRow(fx), "the last entry of the Prompts list is selected");
  assert.equal(fx.rawTop(), Math.min(fx.maxTop(), fx.topOf(last(fx))), "and its start is at the top");
  assert.equal(fx.doc.querySelector(".gs-view").hidden, false, "the minimap follows the selection");
});

test("while more prompts keep loading it re-targets the new last prompt, then stops once the list settles", async () => {
  const fx = createFixture({ ...LONG, turns: 30 });
  const t = holdOpenTimers(fx);
  const { moved } = mount(fx);
  await fx.settle();
  // More prompts load before the page has settled: only the final last prompt is targeted.
  fx.addTurn();
  fx.thread.append(fx.doc.createComment("loaded"));
  await fx.settle();
  fx.addTurn();
  fx.thread.append(fx.doc.createComment("loaded"));
  await fx.settle();
  assert.equal(moved(), 0);
  await t.fire();
  assert.equal(moved(), 1);
  assert.equal(current(fx), lastRow(fx));
  assert.equal(fx.doc.querySelectorAll(".gs-prompt").length, 32);
  // Still following: another prompt loads after the first selection, so the new last one is selected.
  fx.addTurn();
  fx.thread.append(fx.doc.createComment("loaded"));
  await fx.settle();
  await t.fire();
  assert.equal(moved(), 2, "re-targeted");
  assert.equal(current(fx), lastRow(fx));
  assert.equal(fx.doc.querySelectorAll(".gs-prompt").length, 33);
  // The follow window ends with no further change: it stops, and later prompts are left alone.
  await t.fire();
  const top = fx.rawTop();
  fx.addTurn();
  fx.thread.append(fx.doc.createComment("loaded"));
  await fx.settle();
  await t.fire();
  assert.equal(moved(), 2, "no retargeting after it settled");
  assert.equal(fx.rawTop(), top);
});

test("any user action ends it: scrolling, a click, a key press or a touch", async () => {
  for (const act of [(fx) => fx.wheel(-300), (fx) => fx.doc.body.dispatchEvent(new fx.win.Event("pointerdown", { bubbles: true })), (fx) => fx.doc.body.dispatchEvent(new fx.win.Event("keydown", { bubbles: true })), (fx) => fx.doc.body.dispatchEvent(new fx.win.Event("touchstart", { bubbles: true }))]) {
    const fx = createFixture({ ...LONG, turns: 30 });
    const t = holdOpenTimers(fx);
    const { moved } = mount(fx);
    await fx.settle();
    act(fx);
    await fx.settle();
    const where = fx.rawTop();
    await t.fire();
    fx.addTurn();
    fx.thread.append(fx.doc.createComment("loaded"));
    await fx.settle();
    await t.fire();
    assert.equal(moved(), 0);
    assert.equal(fx.rawTop(), where, "the user's position is kept");
  }
});

test("a short conversation still selects its last prompt without moving the page", async () => {
  const fx = createFixture({ turns: 3, width: 1600, markup: "real" });
  const t = holdOpenTimers(fx);
  mount(fx);
  await fx.settle();
  const events = fx.scrollEvents.length;
  await t.fire();
  assert.equal(current(fx), lastRow(fx));
  assert.equal(fx.scrollEvents.length, events);
});
