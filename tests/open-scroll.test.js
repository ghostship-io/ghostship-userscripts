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
