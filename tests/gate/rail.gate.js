// Gate (c), right rail (#628): the built userscript against fixtures. The rail's column is reserved in the
// page (never overlapping the conversation or composer), the minimap and prompt list move the real
// scroller, each conversation keeps its own state, and none of it sends, clicks or touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { createFixture, installPageGuards, runBundle } from "./harness.js";

const RAIL_LEFT = (fx) => fx.win.innerWidth - 12 - 296;
const boot = async (options = {}) => {
  const fx = createFixture({ turns: 40, markup: "real", ...options });
  const guards = installPageGuards(fx);
  const health = runBundle(fx);
  await fx.settle();
  return { fx, guards, health };
};
const q = (fx, sel) => fx.doc.querySelector(sel);
const rows = (fx) => [...fx.doc.querySelectorAll(".gs-prompt")];
const dispatch = (fx, el, type, extra = {}) => el.dispatchEvent(Object.assign(new fx.win.Event(type, { bubbles: true }), extra));

test("layout: minimap above the prompt list, oldest first and newest last, no first/last buttons", async () => {
  const { fx, guards } = await boot({ width: 1600 });
  const cards = [...q(fx, ".gs-rail-panel").children].map((c) => c.className.split(" ")[1]);
  assert.deepEqual(cards, ["gs-card-overview", "gs-card-prompts"]);
  const numbers = rows(fx).map((b) => +b.querySelector(".gs-n").textContent.slice(1));
  assert.deepEqual(numbers, Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal(rows(fx).at(-1).getAttribute("aria-current"), "true", "the newest prompt is active when viewing the latest");
  assert.equal(q(fx, ".gs-prompts").scrollTop, q(fx, ".gs-prompts").scrollHeight - 200, "the list rests at the newest prompt");
  assert.doesNotMatch(q(fx, ".gs-rail").textContent, /First prompt|Last prompt/);
  assert.equal(guards.isClean(), true, JSON.stringify(guards.report()));
});

test("desktop, split and mobile widths: the reserved rail column never intersects the conversation or composer", async () => {
  for (const [width, nav, mode] of [[1920, 0, "docked"], [1448, 52, "docked"], [1280, 52, "docked"], [1100, 0, "docked"], [1100, 260, "collapsed"], [768, 0, "collapsed"], [390, 0, "collapsed"]]) {
    const { fx, guards } = await boot({ width, nav });
    const turn = fx.doc.querySelector("[data-turn-key]").getBoundingClientRect();
    const composer = fx.doc.getElementById("composer").getBoundingClientRect();
    const label = `${width}px, navigation ${nav}px`;
    assert.equal(q(fx, ".gs-rail").dataset.gsMode, mode, label);
    if (mode === "docked") {
      assert.ok(turn.right <= RAIL_LEFT(fx) && composer.right <= RAIL_LEFT(fx), `${label}: content ends at ${Math.max(turn.right, composer.right)}, rail starts at ${RAIL_LEFT(fx)}`);
      assert.ok(turn.width >= 560, `${label}: conversation keeps ${turn.width}px`);
    } else {
      assert.equal(fx.reserve(), 0, `${label}: a collapsed rail leaves the page alone`);
      assert.equal(q(fx, ".gs-rail").dataset.gsOpen, "false");
    }
    assert.equal(fx.scrollEvents.length, 0, "starting the rail does not scroll");
    assert.equal(guards.isClean(), true, JSON.stringify(guards.report()));
  }
});

test("jump to a prompt and minimap click/drag move the real scroller, through virtualized-out turns", async () => {
  const { fx, guards } = await boot({ width: 1600 });
  const first = fx.elements()[0].firstElementChild;
  assert.equal(first.getAttribute("data-gs-state"), "inactive");
  rows(fx)[0].click();
  await fx.settle();
  assert.equal(fx.rawTop(), 0);
  assert.equal(first.getAttribute("data-gs-state"), "active");
  assert.equal(fx.blankInViewport().length, 0);

  rows(fx)[3].click(); // the long code/table turn
  await fx.settle();
  const minimap = q(fx, ".gs-minimap");
  minimap.getBoundingClientRect = () => ({ top: 0, bottom: 120, height: 120, left: 0, right: 200, width: 200 });
  const start = fx.rawTop();
  const events = fx.scrollEvents.length;
  dispatch(fx, minimap, "pointerdown", { clientY: 60, pointerId: 1 });
  await fx.settle();
  const mid = fx.rawTop();
  assert.ok(mid > start, "a click inside the minimap moves the conversation");
  for (const y of [75, 95, 119]) {
    dispatch(fx, minimap, "pointermove", { clientY: y, pointerId: 1 });
    await fx.settle();
  }
  dispatch(fx, minimap, "pointerup", { clientY: 119, pointerId: 1 });
  assert.ok(fx.rawTop() > mid, "dragging down keeps moving it");
  assert.ok(fx.scrollEvents.length > events);
  assert.doesNotMatch(q(fx, ".gs-caption").textContent, /^Drag to navigate • 0% visible$/, "a turn on screen is never reported as 0% visible");
  assert.equal(guards.isClean(), true, JSON.stringify(guards.report()));
});

test("A -> B -> A: each conversation restores its own search, panel state and scroll position", async () => {
  const { fx, guards } = await boot({ width: 1600 });
  const threadA = fx.thread;
  const visit = (path) => fx.win.history.pushState({}, "", path);

  const input = q(fx, ".gs-search input");
  input.value = "about";
  dispatch(fx, input, "input");
  q(fx, ".gs-card-overview .gs-card-head").click();
  rows(fx)[12].click();
  await fx.settle();
  fx.wheel(250);
  await fx.settle();
  const a = { top: fx.rawTop(), active: rows(fx).find((b) => b.getAttribute("aria-current") === "true").dataset.id };

  visit("/c/gate-b"); // the route changes before the page re-renders
  await fx.settle();
  fx.swapThread(fx.buildThread(9, "Other"));
  fx.setTop(fx.maxTop());
  await fx.settle();
  assert.equal(rows(fx).length, 9, "B shows its own prompts");
  assert.equal(q(fx, ".gs-search input").value, "");
  assert.equal(q(fx, ".gs-card-overview").dataset.gsCollapsed, "false");
  assert.doesNotMatch(q(fx, ".gs-rail").textContent, /Prompt \d/, "nothing of A leaks into B");

  visit("/c/fixture");
  await fx.settle();
  fx.swapThread(threadA);
  fx.setTop(fx.maxTop());
  await fx.settle();
  assert.equal(q(fx, ".gs-search input").value, "about");
  assert.equal(q(fx, ".gs-card-overview").dataset.gsCollapsed, "true");
  assert.equal(rows(fx).find((b) => b.getAttribute("aria-current") === "true").dataset.id, a.active);
  assert.equal(fx.rawTop(), a.top, "A is back at the exact scroll position");
  assert.equal(guards.isClean(), true, JSON.stringify(guards.report()));
});

test("streaming and idle: the rail adds no scroll movement and no layout writes", async () => {
  const { fx, guards } = await boot({ width: 1280 });
  const reserve = fx.reserve();
  assert.ok(reserve > 0);
  const top = fx.rawTop();
  const events = fx.scrollEvents.length;
  for (let i = 0; i < 20; i++) {
    fx.stream(fx.thread.lastElementChild.firstElementChild, 20);
    fx.pageAutoscroll();
    await fx.settle();
  }
  assert.equal(fx.rawTop(), top);
  assert.equal(fx.scrollEvents.length, events);
  assert.equal(fx.reserve(), reserve, "the reserved column does not oscillate");
  assert.equal(guards.isClean(), true, JSON.stringify(guards.report()));
});
