// Gate (c), right pane (#628): the built userscript against fixtures. ChatGPT's own summary pane hosts the
// sections when it is mounted, else one fallback pane stands in; the column is reserved once in the
// page (never overlapping the conversation or composer), the minimap and prompt list move the real
// scroller, each conversation keeps its own state, and none of it sends, clicks or touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { createFixture, installPageGuards, runBundle } from "./harness.js";

const NEED = 280 + 2 * 12; // a docked panel's width plus its gaps (rail-layout.js)
const panel = (fx, name) => fx.doc.querySelector(`.gs-panel[data-gs-panel="${name}"]`);
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

test("layout: minimap panel top-right, prompt panel bottom-left, oldest first and newest last, no first/last buttons", async () => {
  const { fx, guards } = await boot({ width: 1600 });
  assert.deepEqual([...fx.doc.querySelectorAll(".gs-panel")].map((p) => p.dataset.gsPanel), ["minimap", "prompts"]);
  assert.match(fx.doc.getElementById("gs-pane-style").textContent, /\.gs-panel-map\{top:[^}]*right:/);
  assert.match(fx.doc.getElementById("gs-pane-style").textContent, /\.gs-panel-prompts\{left:[^}]*bottom:/);
  const numbers = rows(fx).map((b) => +b.querySelector(".gs-n").textContent.slice(1));
  assert.deepEqual(numbers, Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal(rows(fx).at(-1).getAttribute("aria-current"), "true", "the newest prompt is active when viewing the latest");
  assert.equal(q(fx, ".gs-prompts").scrollTop, q(fx, ".gs-prompts").scrollHeight - 200, "the list rests at the newest prompt");
  assert.doesNotMatch(q(fx, ".gs-panel-prompts").textContent, /First prompt|Last prompt/);
  assert.equal(guards.isClean(), true, JSON.stringify(guards.report()));
});

test("desktop, split and mobile widths: the reserved columns never intersect the conversation or composer; narrow ones are drawers", async () => {
  for (const [width, nav, docked] of [[1920, 0, "both"], [1448, 52, "both"], [1280, 52, "both"], [1260, 52, "both"], [1100, 0, "prompts"], [1300, 260, "prompts"], [1023, 0, "none"], [768, 0, "none"], [390, 0, "none"]]) {
    const { fx, guards } = await boot({ width, nav });
    const turn = fx.doc.querySelector("[data-turn-key]").getBoundingClientRect();
    const composer = fx.doc.getElementById("composer").getBoundingClientRect();
    const label = `${width}px, navigation ${nav}px`;
    assert.deepEqual([!panel(fx, "minimap").hidden, !panel(fx, "prompts").hidden], docked === "both" ? [true, true] : docked === "prompts" ? [false, true] : [false, false], label);
    if (docked === "both") {
      assert.ok(turn.right <= width - NEED && composer.right <= width - NEED, `${label}: content ends at ${Math.max(turn.right, composer.right)}, the minimap starts at ${width - NEED}`);
      assert.ok(turn.left >= nav + NEED && composer.left >= nav + NEED, `${label}: content starts at ${Math.min(turn.left, composer.left)}, the prompts end at ${nav + NEED}`);
      assert.ok(turn.width >= 560, `${label}: conversation keeps ${turn.width}px`);
    } else if (docked === "prompts") {
      assert.ok(turn.left >= nav + NEED && composer.left >= nav + NEED && turn.width >= 560, `${label}: the prompts dock, the conversation keeps ${turn.width}px`);
      assert.equal(fx.reserve(), 0, `${label}: nothing is reserved for the minimap drawer`);
    } else {
      assert.equal(fx.reserve() + fx.reserveLeft(), 0, `${label}: drawers leave the page alone`);
    }
    assert.equal(fx.scrollEvents.length, 0, "starting the panels does not scroll");
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
  q(fx, ".gs-hbtn[data-gs-panel=\"minimap\"]").click(); // collapse the minimap: a per-browser choice
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
  assert.equal(panel(fx, "minimap").hidden, true, "the collapsed minimap stays collapsed: it is the browser's choice, not a conversation's");
  assert.doesNotMatch(q(fx, ".gs-panel-prompts").textContent, /Prompt \d/, "nothing of A leaks into B");

  visit("/c/fixture");
  await fx.settle();
  fx.swapThread(threadA);
  fx.setTop(fx.maxTop());
  await fx.settle();
  assert.equal(q(fx, ".gs-search input").value, "about");
  assert.equal(panel(fx, "minimap").hidden, true);
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

test("native side pane: panels sit beside it, Outputs collapses, Sources stays, the width is reserved once", async () => {
  for (const width of [1900, 1700]) {
    const { fx, guards, health } = await boot({ width, pane: {} });
    const label = `${width}px`;
    assert.equal(fx.doc.querySelectorAll(".gs-panel").length, 2, `${label}: two panels, no duplicate`);
    assert.equal(fx.pane.querySelector(".gs-panel"), null, `${label}: never inside ChatGPT's pane`);
    assert.equal(JSON.stringify(health.pane.docked), JSON.stringify({ minimap: true, prompts: true }));
    const edge = fx.win.innerWidth - fx.paneWidth();
    const turn = fx.doc.querySelector("[data-turn-key]").getBoundingClientRect();
    assert.ok(turn.right <= edge - NEED, `${label}: the conversation clears the minimap beside the native pane`);
    const outputs = fx.doc.getElementById("native-outputs");
    const toggle = q(fx, ".gs-outputs-toggle");
    for (let i = 0; i < 3; i++) {
      toggle.click();
      await fx.settle();
      assert.equal(outputs.dataset.gsCollapsed, String(i % 2 === 0), label);
      assert.equal(fx.doc.getElementById("native-sources").hasAttribute("data-gs-collapsed"), false, "Sources is never collapsed");
      assert.equal(rows(fx).at(-1).getAttribute("aria-current"), "true", "the newest prompt stays active and bottom-aligned");
    }
    fx.unmountPane();
    fx.win.dispatchEvent(new fx.win.Event("resize"));
    await fx.settle();
    assert.equal(fx.doc.querySelectorAll(".gs-panel").length, 2, `${label}: nothing doubles when the pane goes`);
    assert.equal(guards.isClean(), true, JSON.stringify(guards.report()));
  }
});

test("opening a conversation: one scroll to the start of the latest prompt, then streaming never moves it; a minimap silhouette is drawn", async () => {
  const { fx, guards, health } = await boot({ width: 1600, turns: 39 });
  const last = fx.elements().at(-1);
  assert.equal(fx.rawTop(), fx.topOf(last), "the start of the latest prompt is at the top of the viewport");
  const events = fx.scrollEvents.length;
  for (let i = 0; i < 10; i++) {
    fx.stream(last.firstElementChild, 25);
    fx.pageAutoscroll();
    await fx.settle();
  }
  assert.equal(fx.scrollEvents.length, events, "no repeat while streaming");
  assert.equal(health.diagnostics()["scroll.moved.open"], 1);
  assert.ok(fx.doc.querySelectorAll(".gs-bar").length > 0, "the overview is drawn");
  assert.equal(guards.isClean(), true, JSON.stringify(guards.report()));
});
