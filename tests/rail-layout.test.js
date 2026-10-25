import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createFixture } from "./virtualization-fixture.js";
import { createRuntime } from "../src/core/runtime.js";
import { DEFAULTS } from "../src/core/config.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createTurnBackend } from "../src/chatgpt/virtualization/backend.js";
import { createRail } from "../src/chatgpt/rail/rail.js";
import { createRailStateStore } from "../src/chatgpt/rail/rail-state.js";
import { DOCK_MIN_VIEWPORT, MIN_CONTENT, RAIL_EDGE, RAIL_RESERVE, RAIL_WIDTH } from "../src/chatgpt/rail/rail-layout.js";

function mount(fx, store) {
  const runtime = createRuntime({ win: fx.win, adapter: chatgptAdapter, backend: createTurnBackend(), config: { ...DEFAULTS } });
  assert.equal(runtime.mode, "active");
  const rail = createRail({ win: fx.win, adapter: chatgptAdapter, runtime, store });
  const stop = () => {
    rail.dispose();
    runtime.dispose();
  };
  return { runtime, rail, stop, q: (sel) => fx.doc.querySelector(sel) };
}
const items = (fx) => [...fx.doc.querySelectorAll(".gs-prompt")];
const rects = (fx) => ({
  turn: chatgptAdapter.turns(fx.doc)[0].getBoundingClientRect(),
  composer: chatgptAdapter.composer(fx.doc).getBoundingClientRect(),
});
const railLeft = (fx) => fx.win.innerWidth - RAIL_EDGE - RAIL_WIDTH;

test("the rail's column is reserved in the page: conversation and composer never intersect it", async () => {
  for (const [width, nav] of [[1920, 0], [1600, 0], [1448, 52], [1280, 0], [1280, 52], [1180, 52], [1100, 0], [DOCK_MIN_VIEWPORT, 0]]) {
    const fx = createFixture({ turns: 20, width, nav, markup: "real" });
    const { q } = mount(fx);
    await fx.settle();
    const label = `${width}px wide, ${nav}px navigation`;
    const { turn, composer } = rects(fx);
    assert.equal(q(".gs-rail").dataset.gsMode, "docked", label);
    assert.ok(turn.right <= railLeft(fx), `${label}: conversation ends at ${turn.right}, rail starts at ${railLeft(fx)}`);
    assert.ok(composer.right <= railLeft(fx), `${label}: composer ends at ${composer.right}`);
    assert.ok(turn.width >= MIN_CONTENT, `${label}: conversation keeps ${turn.width}px`);
    assert.equal(composer.left, turn.left, `${label}: composer and conversation shift together`);
  }
});

test("the page shifts only by what the rail needs; a wide window is left alone", async () => {
  const wide = createFixture({ turns: 12, width: 1920, markup: "real" });
  mount(wide);
  await wide.settle();
  assert.equal(wide.reserve(), 0, "the natural right gutter already fits the rail");
  assert.equal(wide.doc.body.hasAttribute("data-gs-column"), false);
  assert.equal(wide.doc.body.getAttribute("style"), null, "no writes to the page at all");

  const tight = createFixture({ turns: 12, width: 1280, markup: "real" });
  mount(tight);
  await tight.settle();
  const reserve = tight.reserve();
  assert.ok(reserve > 0 && reserve < RAIL_RESERVE, `shifted by ${reserve}px, less than the full ${RAIL_RESERVE}px`);
  assert.equal(tight.doc.body.hasAttribute("data-gs-column"), true);
  assert.match(tight.doc.getElementById("gs-rail-style").textContent, /\[data-gs-column\]\[data-gs-column\]\{[^}]*padding-right:var\(--gs-reserve/);
});

test("narrow windows and split windows collapse the rail and leave the page untouched", async () => {
  for (const width of [1023, 900, 768, 390]) {
    const fx = createFixture({ turns: 12, width, markup: "real" });
    const { q } = mount(fx);
    await fx.settle();
    assert.equal(q(".gs-rail").dataset.gsMode, "collapsed", `${width}px`);
    assert.equal(q(".gs-rail").dataset.gsOpen, "false", `${width}px: opens only on request`);
    assert.equal(fx.reserve(), 0);
    assert.equal(fx.doc.body.hasAttribute("data-gs-column"), false, "the page column is untouched");
    assert.equal(fx.doc.body.getAttribute("style"), null);
  }
  // A wide window whose open sidebar leaves too little for the shifted conversation also collapses.
  const split = createFixture({ turns: 12, width: 1100, nav: 260, markup: "real" });
  const { q } = mount(split);
  await split.settle();
  assert.equal(q(".gs-rail").dataset.gsMode, "collapsed");
  assert.equal(split.reserve(), 0);
  assert.ok(rects(split).turn.width >= MIN_CONTENT || split.reserve() === 0);
});

test("opening and closing ChatGPT's sidebar, or resizing the window, re-measures without oscillating", async () => {
  const fx = createFixture({ turns: 20, width: 1100, markup: "real" });
  const { q } = mount(fx);
  await fx.settle();
  assert.equal(q(".gs-rail").dataset.gsMode, "docked");
  assert.ok(fx.reserve() > 0);

  const transition = () => Object.assign(new fx.win.Event("transitionend", { bubbles: true }), { propertyName: "width" });
  fx.setNav(260); // the sidebar opens: not enough room left for both
  fx.doc.body.dispatchEvent(transition());
  await fx.settle();
  assert.equal(q(".gs-rail").dataset.gsMode, "collapsed");
  assert.equal(fx.reserve(), 0);
  assert.equal(q(".gs-rail").dataset.gsOpen, "false");

  fx.setNav(0); // and closes again
  fx.doc.body.dispatchEvent(transition());
  await fx.settle();
  assert.equal(q(".gs-rail").dataset.gsMode, "docked");
  const settled = fx.reserve();
  assert.ok(settled > 0);

  // Stable afterwards: no layout writes while nothing changes, whatever notifies the rail.
  const writes = [];
  const mo = new fx.win.MutationObserver((records) => writes.push(...records.map((r) => `${r.type}:${r.attributeName ?? ""}`)));
  mo.observe(fx.doc.body, { attributes: true });
  for (let i = 0; i < 5; i++) {
    fx.doc.body.dispatchEvent(transition());
    fx.win.dispatchEvent(new fx.win.Event("resize"));
    await fx.settle();
  }
  assert.deepEqual(writes, []);
  assert.equal(fx.reserve(), settled);
  mo.disconnect();

  fx.win.innerWidth = 1500; // the window grows: the gutter now fits, so the page is released
  fx.win.dispatchEvent(new fx.win.Event("resize"));
  await fx.settle();
  assert.equal(fx.reserve(), 0);
  assert.equal(fx.doc.body.hasAttribute("data-gs-column"), false);
});

test("dispose removes the reservation and leaves the page exactly as it was", async () => {
  const fx = createFixture({ turns: 20, width: 1280, markup: "real" });
  const before = fx.doc.documentElement.outerHTML;
  const { stop } = mount(fx);
  await fx.settle();
  assert.ok(fx.reserve() > 0);
  stop();
  assert.equal(fx.doc.documentElement.outerHTML, before);
});

test("an idle docked page with a reserved column makes no DOM writes", async () => {
  const fx = createFixture({ turns: 20, width: 1280, markup: "real" });
  const { runtime } = mount(fx);
  await fx.settle();
  const flushes = runtime.diagnostics.snapshot()["observer.flush"];
  const writes = [];
  const mo = new fx.win.MutationObserver((records) => writes.push(...records.map((r) => `${r.type}:${r.target.className || r.target.tagName}`)));
  mo.observe(fx.doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  await fx.settle();
  await fx.settle();
  assert.deepEqual(writes, []);
  assert.equal(runtime.diagnostics.snapshot()["observer.flush"], flushes);
  mo.disconnect();
});

test("the scroll owner is the element that really scrolls, and the minimap moves it", () => {
  const dom = new JSDOM(
    `<!doctype html><body><div data-scroll-root><div id="inner" style="overflow-y:auto"><div data-thread-find-target="conversation"><div data-turn-key="t1"><div data-user-message-bubble>hi</div></div></div></div></div><form><div contenteditable="true" role="textbox"></div></form></body>`,
    { url: "https://chatgpt.com/c/x" },
  );
  const doc = dom.window.document;
  const inner = doc.getElementById("inner");
  assert.equal(chatgptAdapter.scroller(doc), doc.querySelector("[data-scroll-root]"), "a non-overflowing inner element does not take over");
  Object.defineProperty(inner, "scrollHeight", { get: () => 5000 });
  Object.defineProperty(inner, "clientHeight", { get: () => 800 });
  assert.equal(chatgptAdapter.scroller(doc), inner, "the nearest overflowing scrollable ancestor of the turns is the scroll owner");
});

test("the minimap wakes a turn the virtualizer skipped before navigating inside it", async () => {
  const fx = createFixture({ turns: 40, width: 1600, markup: "real" });
  const { runtime, q } = mount(fx);
  await fx.settle();
  q(".gs-minimap").getBoundingClientRect = () => ({ top: 0, bottom: 120, height: 120, left: 0, right: 200, width: 200 });
  items(fx)[3].click();
  await fx.settle();
  const turn = chatgptAdapter.turns(fx.doc)[3];
  turn.setAttribute("data-gs-state", "inactive");
  turn.style.setProperty("--gs-h", `${turn.__h}px`);
  assert.equal(runtime.isTurnActive(turn), false);
  const nav = runtime.scroll.stats.navigations;
  const down = Object.assign(new fx.win.Event("pointerdown", { bubbles: true }), { clientY: 60, pointerId: 1 });
  q(".gs-minimap").dispatchEvent(down);
  await fx.settle();
  assert.equal(turn.getAttribute("data-gs-state"), "active");
  assert.ok(runtime.scroll.stats.navigations >= nav + 2, "wake-up navigation, then the minimap move");
  const top = turn.getBoundingClientRect().top;
  assert.ok(top < 0 && top > -turn.__h, "the viewport is inside the turn");
  assert.notEqual(q(".gs-caption").textContent, "Drag to navigate • 0% visible");
});

test("prompt rows on the current markup preview the reply inside the turn, not the next prompt", async () => {
  const fx = createFixture({ turns: 12, width: 1600, markup: "real" });
  mount(fx);
  await fx.settle();
  const row = items(fx)[2];
  assert.match(row.querySelector(".gs-title").textContent, /^Prompt 2 about/);
  assert.match(row.querySelector(".gs-preview").textContent, /^lorem ipsum/);
  assert.doesNotMatch(row.querySelector(".gs-preview").textContent, /Prompt 3/);
});

test("the newest row's preview fills in as its reply streams", async () => {
  const fx = createFixture({ turns: 5, width: 1600, markup: "real" });
  mount(fx);
  await fx.settle();
  fx.addTurn();
  fx.thread.lastElementChild.firstElementChild.lastElementChild.textContent = "";
  await fx.settle();
  const row = () => items(fx).at(-1).querySelector(".gs-preview");
  assert.equal(row().textContent, "");
  const reply = fx.thread.lastElementChild.firstElementChild.lastElementChild;
  reply.textContent = "The first part of the answer";
  fx.stream(fx.thread.lastElementChild.firstElementChild, 20);
  await fx.settle();
  assert.equal(row().textContent, "The first part of the answer");
});

test("each conversation keeps its own rail state: A -> B -> A restores A, B stays B", async () => {
  const store = createRailStateStore();
  const fx = createFixture({ turns: 30, width: 1600, markup: "real" });
  const threadA = fx.thread;
  const visit = (path) => fx.win.history.pushState({}, "", path);

  // Conversation A: search, collapse the overview, scroll the list by hand, read a prompt mid-turn.
  let ui = mount(fx, store);
  await fx.settle();
  const input = ui.q(".gs-search input");
  input.value = "about";
  input.dispatchEvent(new fx.win.Event("input"));
  ui.q(".gs-card-overview .gs-card-head").click();
  items(fx)[10].click();
  await fx.settle();
  fx.wheel(300);
  await fx.settle();
  const list = ui.q(".gs-prompts");
  list.dispatchEvent(new fx.win.Event("wheel"));
  list.scrollTop = 160;
  await fx.settle();
  const a = { top: fx.rawTop(), active: items(fx).find((b) => b.getAttribute("aria-current") === "true").dataset.id, list: list.scrollTop };
  assert.ok(a.top < fx.maxTop());
  ui.stop();

  // Route change to B while the page still shows A's turns (the page renders a moment later): nothing leaks either way.
  visit("/c/conversation-b");
  const stale = mount(fx, store);
  await fx.settle();
  stale.stop();
  const savedA = store.get("fixture");
  assert.ok(savedA && savedA.ui.query === "about", "A's entry was not overwritten by its own stale DOM");
  assert.equal(store.get("conversation-b"), null, "B has nothing stored from A's DOM");

  // B renders: its own prompts, default state, nothing of A.
  const threadB = fx.buildThread(12, "Other");
  fx.swapThread(threadB);
  fx.setTop(fx.maxTop());
  ui = mount(fx, store);
  await fx.settle();
  assert.equal(items(fx).length, 12);
  assert.doesNotMatch(ui.q(".gs-rail").textContent, /Prompt \d/, "no prompt preview of A in B");
  assert.equal(ui.q(".gs-search input").value, "");
  assert.equal(ui.q(".gs-card-overview").dataset.gsCollapsed, "false");
  assert.equal(items(fx).at(-1).getAttribute("aria-current"), "true");
  ui.q(".gs-search input").value = "pears";
  ui.q(".gs-search input").dispatchEvent(new fx.win.Event("input"));
  ui.q(".gs-card-prompts .gs-card-head").click();
  ui.stop();

  // Back to A: everything is where the user left it.
  visit("/c/fixture");
  fx.swapThread(threadA);
  fx.setTop(fx.maxTop()); // ChatGPT opens a conversation at its newest message
  ui = mount(fx, store);
  await fx.settle();
  assert.equal(ui.q(".gs-search input").value, "about");
  assert.equal(ui.q(".gs-card-overview").dataset.gsCollapsed, "true");
  assert.equal(ui.q(".gs-card-prompts").dataset.gsCollapsed, "false");
  assert.equal(items(fx).find((b) => b.getAttribute("aria-current") === "true").dataset.id, a.active);
  assert.equal(ui.q(".gs-prompts").scrollTop, a.list);
  assert.equal(fx.rawTop(), a.top, "the conversation is back at the exact scroll position");
  assert.equal(ui.runtime.scroll.stats.unexpected, 0);
  ui.stop();

  // And B is still B.
  visit("/c/conversation-b");
  fx.swapThread(threadB);
  fx.setTop(fx.maxTop());
  ui = mount(fx, store);
  await fx.settle();
  assert.equal(ui.q(".gs-search input").value, "pears");
  assert.equal(ui.q(".gs-card-prompts").dataset.gsCollapsed, "true");
  assert.equal(ui.q(".gs-card-overview").dataset.gsCollapsed, "false");
  assert.equal(items(fx).length, 3, "B filters by its own search (pears), not A's");
  assert.doesNotMatch(ui.q(".gs-rail").textContent, /Prompt \d/);
  ui.stop();
});

test("a conversation read at the newest message is not scrolled on return; a new chat stores nothing", async () => {
  const store = createRailStateStore();
  const fx = createFixture({ turns: 20, width: 1600, markup: "real" });
  let ui = mount(fx, store);
  await fx.settle();
  ui.stop();
  const bottom = fx.rawTop();
  const events = fx.scrollEvents.length;
  ui = mount(fx, store);
  await fx.settle();
  assert.equal(fx.rawTop(), bottom);
  assert.equal(fx.scrollEvents.length, events, "restoring a bottom bookmark does not scroll");
  ui.stop();

  const chat = createFixture({ turns: 6, width: 1600, markup: "real" });
  chat.win.history.pushState({}, "", "/");
  const other = createRailStateStore();
  const m = mount(chat, other);
  await chat.settle();
  m.stop();
  assert.equal(other.size(), 0);
});

test("the store is bounded and keeps one entry per conversation", () => {
  const store = createRailStateStore({ max: 3 });
  for (const id of ["a", "b", "c", "d"]) store.save(id, { sig: `sig-${id}` });
  assert.equal(store.size(), 3);
  assert.equal(store.get("a"), null, "least recently used goes first");
  assert.equal(store.save("e", { sig: "sig-d" }), false, "content already owned by another conversation is not stored");
  assert.equal(store.owner("sig-d"), "d");
  assert.equal(store.save("new", { sig: "x" }), false);
});
