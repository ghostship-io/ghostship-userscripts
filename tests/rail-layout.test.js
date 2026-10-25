import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createFixture } from "./virtualization-fixture.js";
import { createRuntime } from "../src/core/runtime.js";
import { DEFAULTS } from "../src/core/config.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createTurnBackend } from "../src/chatgpt/virtualization/backend.js";
import { createRail } from "../src/chatgpt/rail/rail.js";
import { createPanelPrefs, createRailStateStore } from "../src/chatgpt/rail/rail-state.js";
import { DOCK_MIN_VIEWPORT, MIN_CONTENT, PANEL_GAP, PANEL_WIDTH } from "../src/chatgpt/rail/rail-layout.js";

function mount(fx, store, layoutPrefs) {
  const runtime = createRuntime({ win: fx.win, adapter: chatgptAdapter, backend: createTurnBackend(), config: { ...DEFAULTS } });
  assert.equal(runtime.mode, "active");
  const rail = createRail({ win: fx.win, adapter: chatgptAdapter, runtime, store, layoutPrefs });
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
/** Markup with style attributes normalized (a browser re-serializes them once a property was set and removed). */
const norm = (html) => html.replace(/style="([^"]*)"/g, (_, v) => `style="${v.replace(/\s+/g, "").replace(/;$/, "")}"`);
const NEED = PANEL_WIDTH + 2 * PANEL_GAP; // what a docked panel takes beside the conversation
const hiddenPanel = (fx, name) => fx.doc.querySelector(`.gs-panel[data-gs-panel="${name}"]`).hidden;
const hbtn = (fx, name) => fx.doc.querySelector(`.gs-hbtn[data-gs-panel="${name}"]`);
const varOf = (fx, name, prop) => parseFloat(fx.doc.querySelector(`.gs-panel[data-gs-panel="${name}"]`).style.getPropertyValue(prop));

test("the minimap is pinned top-right and the prompts bottom-left; the conversation re-centers in the space between them", async () => {
  for (const [width, nav] of [[1920, 0], [1600, 0], [1448, 52], [1280, 0], [1260, 52], [1200, 0]]) {
    const fx = createFixture({ turns: 20, width, nav, markup: "real", header: true });
    mount(fx);
    await fx.settle();
    const label = `${width}px wide, ${nav}px navigation`;
    const { turn, composer } = rects(fx);
    assert.equal(hiddenPanel(fx, "minimap") || hiddenPanel(fx, "prompts"), false, `${label}: both panels docked`);
    assert.ok(turn.left >= nav + NEED && composer.left >= nav + NEED, `${label}: conversation starts at ${turn.left}, the prompts panel ends at ${nav + NEED}`);
    assert.ok(turn.right <= width - NEED && composer.right <= width - NEED, `${label}: conversation ends at ${turn.right}, the minimap starts at ${width - NEED}`);
    assert.ok(turn.width >= MIN_CONTENT, `${label}: conversation keeps ${turn.width}px`);
    assert.equal(composer.left, turn.left, `${label}: composer and conversation shift together`);
    // Re-centered in what remains: equal room on both sides.
    assert.ok(Math.abs(turn.left - nav - NEED - (width - NEED - turn.right)) <= 2, `${label}: centered between the panels`);
    // The panels are anchored to the column's corners.
    assert.equal(varOf(fx, "prompts", "--gs-left"), nav + PANEL_GAP, label);
    assert.equal(varOf(fx, "minimap", "--gs-right"), PANEL_GAP, label);
    assert.equal(varOf(fx, "minimap", "--gs-top"), 56 + 8, `${label}: below the header, in the top-right corner`);
    assert.equal(varOf(fx, "prompts", "--gs-bottom"), 16, `${label}: bottom-left corner`);
  }
});

test("the page shifts only by what the panels need; a wide window is left alone", async () => {
  const wide = createFixture({ turns: 12, width: 1920, markup: "real" });
  mount(wide);
  await wide.settle();
  assert.equal(wide.reserve() + wide.reserveLeft(), 0, "the natural gutters already fit both panels");
  assert.equal(wide.doc.body.hasAttribute("data-gs-column"), false);
  assert.equal(wide.doc.body.getAttribute("style"), null, "no writes to the page at all");

  const tight = createFixture({ turns: 12, width: 1280, markup: "real" });
  mount(tight);
  await tight.settle();
  assert.equal(tight.reserve(), NEED, "the minimap takes its width from the right");
  assert.equal(tight.reserveLeft(), NEED, "the prompts take theirs from the left");
  assert.equal(tight.doc.body.hasAttribute("data-gs-column"), true);
  const css = tight.doc.getElementById("gs-pane-style").textContent;
  assert.match(css, /\[data-gs-column\]\[data-gs-left\]\{[^}]*padding-left:var\(--gs-reserve-left/);
  assert.match(css, /\[data-gs-column\]\[data-gs-right\]\{[^}]*padding-right:var\(--gs-reserve/);
});

test("collapsing a panel to its header button gives its room back; the same button restores it; the choice survives a reload", async () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  const fx = createFixture({ turns: 20, width: 1280, markup: "real", header: true });
  const make = () => mount(fx, undefined, createPanelPrefs(storage));
  let ui = make();
  await fx.settle();
  const full = rects(fx).turn;
  assert.ok(fx.reserve() > 0 && fx.reserveLeft() > 0);

  hbtn(fx, "prompts").click();
  await fx.settle();
  assert.equal(hiddenPanel(fx, "prompts"), true);
  assert.equal(fx.reserveLeft(), 0, "no room kept for the hidden prompts");
  assert.ok(fx.reserve() > 0, "the minimap still has its room");
  const oneSided = rects(fx).turn;
  assert.ok(oneSided.width >= full.width, "the conversation widens");

  hbtn(fx, "minimap").click();
  await fx.settle();
  assert.equal(fx.reserve() + fx.reserveLeft(), 0, "both collapsed: the conversation is centered at its full width");
  assert.equal(fx.doc.body.hasAttribute("data-gs-column"), false);
  assert.equal(rects(fx).turn.width, 768);
  assert.deepEqual(JSON.parse(data.get("gs.pane.layout")), { minimap: false, prompts: false });

  // A reload (a fresh rail on the same storage) keeps both collapsed.
  ui.stop();
  ui = make();
  await fx.settle();
  assert.equal(hiddenPanel(fx, "minimap") && hiddenPanel(fx, "prompts"), true);
  assert.equal(fx.reserve() + fx.reserveLeft(), 0);
  assert.equal(hbtn(fx, "minimap").getAttribute("aria-pressed"), "false");

  // The same buttons restore them.
  hbtn(fx, "minimap").click();
  hbtn(fx, "prompts").click();
  await fx.settle();
  assert.equal(hiddenPanel(fx, "minimap") || hiddenPanel(fx, "prompts"), false);
  assert.ok(fx.reserve() > 0 && fx.reserveLeft() > 0);
  assert.equal(hbtn(fx, "minimap").getAttribute("aria-pressed"), "true");
  ui.stop();
});

test("the page column is padded, but the header cancels it: ChatGPT's header, and its buttons, stay where they are", async () => {
  const fx = createFixture({ turns: 20, width: 1280, markup: "real", header: true });
  mount(fx);
  await fx.settle();
  const header = fx.doc.getElementById("page-header");
  assert.equal(fx.doc.body.hasAttribute("data-gs-column"), true);
  assert.equal(header.hasAttribute("data-gs-header"), true, "the header cancels the column's padding with opposite margins");
  assert.match(fx.doc.getElementById("gs-pane-style").textContent, /\[data-gs-header\]\{margin-left:calc\(-1 \* var\(--gs-reserve-left,0px\)\);margin-right:calc\(-1 \* var\(--gs-reserve,0px\)\)\}/);
  assert.equal(header.getBoundingClientRect().right, 1280, "the header still spans the window");
  // Nothing reserved: the header is untouched too.
  const wide = createFixture({ turns: 20, width: 1920, markup: "real", header: true });
  mount(wide);
  await wide.settle();
  assert.equal(wide.doc.getElementById("page-header").hasAttribute("data-gs-header"), false);
  // Disposing releases it.
  const ui = createFixture({ turns: 20, width: 1280, markup: "real", header: true });
  const m = mount(ui);
  await ui.settle();
  m.stop();
  assert.equal(ui.doc.getElementById("page-header").hasAttribute("data-gs-header"), false);
});

test("the panel buttons sit in ChatGPT's header button area; without a header they float top-right", async () => {
  const fx = createFixture({ turns: 12, width: 1600, markup: "real", header: true });
  mount(fx);
  await fx.settle();
  const acts = fx.doc.querySelector(".gs-hbtns");
  const native = [...fx.doc.querySelectorAll("#page-header .acts > button")];
  assert.equal(acts.parentElement, native[0].parentElement, "inside the native button group");
  assert.equal(acts.nextElementSibling, native.at(-1), "just before the right-most native button");
  assert.equal(acts.hasAttribute("data-gs-float"), false);
  // ChatGPT re-renders its header: the buttons are put back, once.
  const group = native[0].parentElement;
  acts.remove();
  fx.win.dispatchEvent(new fx.win.Event("resize"));
  await fx.settle();
  assert.equal(fx.doc.querySelectorAll(".gs-hbtns").length, 1);
  assert.equal(fx.doc.querySelector(".gs-hbtns").parentElement, group);
  const bare = createFixture({ turns: 12, width: 1600, markup: "real" });
  mount(bare);
  assert.equal(bare.doc.querySelector(".gs-hbtns").hasAttribute("data-gs-float"), true);
});

test("narrow windows turn the panels into drawers; a medium window docks the prompts and leaves the minimap a drawer", async () => {
  for (const width of [1023, 900, 768, 390]) {
    const fx = createFixture({ turns: 12, width, markup: "real" });
    mount(fx);
    await fx.settle();
    assert.equal(hiddenPanel(fx, "minimap") && hiddenPanel(fx, "prompts"), true, `${width}px: nothing covers the conversation on its own`);
    assert.equal(fx.reserve() + fx.reserveLeft(), 0, `${width}px`);
    assert.equal(fx.doc.body.hasAttribute("data-gs-column"), false, `${width}px`);
    assert.equal(fx.doc.body.getAttribute("style"), null, `${width}px`);
    hbtn(fx, "minimap").click();
    assert.equal(hiddenPanel(fx, "minimap"), false, `${width}px: opens on request`);
    hbtn(fx, "prompts").click();
    assert.deepEqual([hiddenPanel(fx, "minimap"), hiddenPanel(fx, "prompts")], [true, false], `${width}px: one drawer at a time`);
  }
  // Not room for both beside a 560px conversation: the prompts dock, the minimap is a drawer behind its button.
  for (const [width, nav] of [[1100, 0], [1160, 0], [1300, 260]]) {
    const fx = createFixture({ turns: 12, width, nav, markup: "real" });
    mount(fx);
    await fx.settle();
    const label = `${width}px, navigation ${nav}px`;
    assert.deepEqual([hiddenPanel(fx, "minimap"), hiddenPanel(fx, "prompts")], [true, false], label);
    assert.equal(fx.reserve(), 0, `${label}: nothing reserved for the closed minimap`);
    assert.ok(rects(fx).turn.left >= nav + NEED && rects(fx).turn.width >= MIN_CONTENT, label);
    hbtn(fx, "minimap").click();
    assert.equal(hiddenPanel(fx, "minimap"), false, `${label}: the minimap opens as a drawer`);
    assert.equal(hiddenPanel(fx, "prompts"), false, `${label}: the docked prompts stay`);
    assert.equal(fx.doc.querySelector('.gs-panel[data-gs-panel="minimap"]').dataset.gsDrawer, "true");
    hbtn(fx, "minimap").click();
    assert.equal(hiddenPanel(fx, "minimap"), true);
  }
});

test("opening and closing ChatGPT's sidebar, or resizing the window, re-measures without oscillating", async () => {
  const fx = createFixture({ turns: 20, width: 1300, markup: "real" });
  mount(fx);
  await fx.settle();
  assert.equal(hiddenPanel(fx, "minimap"), false);
  assert.ok(fx.reserve() + fx.reserveLeft() > 0);

  const transition = () => Object.assign(new fx.win.Event("transitionend", { bubbles: true }), { propertyName: "width" });
  fx.setNav(260); // the sidebar opens: not enough room left for both panels
  fx.doc.body.dispatchEvent(transition());
  await fx.settle();
  assert.deepEqual([hiddenPanel(fx, "minimap"), hiddenPanel(fx, "prompts")], [true, false], "the minimap becomes a drawer instead of covering the page");
  assert.equal(fx.reserve(), 0);
  fx.setNav(700); // an even wider sidebar: neither fits
  fx.doc.body.dispatchEvent(transition());
  await fx.settle();
  assert.equal(hiddenPanel(fx, "minimap") && hiddenPanel(fx, "prompts"), true);
  assert.equal(fx.reserve() + fx.reserveLeft(), 0);

  fx.setNav(0); // and closes again
  fx.doc.body.dispatchEvent(transition());
  await fx.settle();
  assert.equal(hiddenPanel(fx, "minimap") || hiddenPanel(fx, "prompts"), false);
  const settled = [fx.reserve(), fx.reserveLeft()];
  assert.ok(settled[0] > 0 && settled[1] > 0);

  // Stable afterwards: no layout writes while nothing changes, whatever notifies the panels.
  const writes = [];
  const mo = new fx.win.MutationObserver((records) => writes.push(...records.map((r) => `${r.type}:${r.attributeName ?? ""}`)));
  mo.observe(fx.doc.body, { attributes: true });
  for (let i = 0; i < 5; i++) {
    fx.doc.body.dispatchEvent(transition());
    fx.win.dispatchEvent(new fx.win.Event("resize"));
    await fx.settle();
  }
  assert.deepEqual(writes, []);
  assert.deepEqual([fx.reserve(), fx.reserveLeft()], settled);
  mo.disconnect();

  fx.win.innerWidth = 1900; // the window grows: the gutters now fit, so the page is released
  fx.win.dispatchEvent(new fx.win.Event("resize"));
  await fx.settle();
  assert.equal(fx.reserve() + fx.reserveLeft(), 0);
  assert.equal(fx.doc.body.hasAttribute("data-gs-column"), false);
});

test("dispose removes the reservation and the panels and leaves the page exactly as it was", async () => {
  const fx = createFixture({ turns: 20, width: 1280, markup: "real", header: true });
  const before = fx.doc.documentElement.outerHTML;
  const { stop } = mount(fx);
  await fx.settle();
  assert.ok(fx.reserve() > 0 && fx.reserveLeft() > 0);
  stop();
  assert.equal(norm(fx.doc.documentElement.outerHTML), norm(before));
});

test("an idle docked page with reserved columns makes no DOM writes", async () => {
  const fx = createFixture({ turns: 20, width: 1280, markup: "real", header: true });
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
  assert.doesNotMatch(ui.q(".gs-panel-prompts").textContent, /Prompt \d/, "no prompt preview of A in B");
  assert.equal(ui.q(".gs-search input").value, "");
  assert.equal(items(fx).at(-1).getAttribute("aria-current"), "true");
  ui.q(".gs-search input").value = "pears";
  ui.q(".gs-search input").dispatchEvent(new fx.win.Event("input"));
  ui.stop();

  // Back to A: everything is where the user left it.
  visit("/c/fixture");
  fx.swapThread(threadA);
  fx.setTop(fx.maxTop()); // ChatGPT opens a conversation at its newest message
  ui = mount(fx, store);
  await fx.settle();
  assert.equal(ui.q(".gs-search input").value, "about");
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
  assert.equal(items(fx).length, 3, "B filters by its own search (pears), not A's");
  assert.doesNotMatch(ui.q(".gs-panel-prompts").textContent, /Prompt \d/);
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

test("the composer clears both panels when it sits in an overlay inside the scrolling column (live chatgpt.com layout)", async () => {
  for (const [width, nav] of [[1600, 52], [1448, 52], [1280, 0], [1260, 52]]) {
    const fx = createFixture({ turns: 20, width, nav, markup: "real", overlay: true });
    mount(fx);
    await fx.settle();
    const label = `${width}px wide, ${nav}px navigation`;
    const { turn, composer } = rects(fx);
    assert.ok(turn.left >= nav + NEED && composer.left >= nav + NEED, `${label}: left edges ${turn.left} / ${composer.left}`);
    assert.ok(turn.right <= width - NEED && composer.right <= width - NEED, `${label}: right edges ${turn.right} / ${composer.right}`);
    assert.equal(composer.left, turn.left, `${label}: composer and conversation shift together`);
  }
});

test("the overlay's reservation is removed with the panels and written only once", async () => {
  const fx = createFixture({ turns: 20, width: 1280, markup: "real", overlay: true });
  const overlay = fx.doc.getElementById("overlay");
  const { stop } = mount(fx);
  await fx.settle();
  assert.equal(overlay.hasAttribute("data-gs-column"), true);
  const writes = [];
  new fx.win.MutationObserver((list) => writes.push(...list)).observe(fx.doc.documentElement, { attributes: true, subtree: true });
  await fx.settle();
  assert.equal(writes.length, 0, "idle: no layout writes");
  stop();
  assert.equal(overlay.hasAttribute("data-gs-column"), false);
  assert.equal(overlay.style.getPropertyValue("--gs-reserve"), "");
  assert.equal(overlay.style.getPropertyValue("--gs-reserve-left"), "");
  assert.equal(overlay.style.position, "absolute", "the page's own style survives");
});

test("a header that ChatGPT replaces (column and composer untouched) takes over the cancelling margins", async () => {
  const fx = createFixture({ turns: 20, width: 1280, markup: "real", header: true });
  mount(fx);
  await fx.settle();
  const old = fx.doc.getElementById("page-header");
  assert.equal(old.hasAttribute("data-gs-header"), true);
  const fresh = old.cloneNode(true);
  fresh.removeAttribute("data-gs-header");
  old.replaceWith(fresh);
  fx.win.dispatchEvent(new fx.win.Event("resize"));
  await fx.settle();
  assert.equal(fresh.hasAttribute("data-gs-header"), true, "the new header cancels the padding too");
});
