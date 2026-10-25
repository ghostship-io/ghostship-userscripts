import test from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./virtualization-fixture.js";
import { createRuntime } from "../src/core/runtime.js";
import { DEFAULTS } from "../src/core/config.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createTurnBackend } from "../src/chatgpt/virtualization/backend.js";
import { createRail, describePrompt } from "../src/chatgpt/rail/rail.js";
import { buildTurnModel, layoutBars, scrollTopForFraction, viewportIndicator } from "../src/chatgpt/rail/minimap-model.js";

function mount(fx) {
  const runtime = createRuntime({ win: fx.win, adapter: chatgptAdapter, backend: createTurnBackend(), config: { ...DEFAULTS } });
  assert.equal(runtime.mode, "active");
  const rail = createRail({ win: fx.win, adapter: chatgptAdapter, runtime });
  const q = (sel) => fx.doc.querySelector(sel);
  return { runtime, rail, q, list: q(".gs-prompts"), minimap: q(".gs-minimap") };
}
const items = (fx) => [...fx.doc.querySelectorAll(".gs-prompt")];
const pointer = (fx, type, clientY) => Object.assign(new fx.win.Event(type, { bubbles: true }), { clientY, pointerId: 1 });
const fixMinimapRect = (m) => (m.getBoundingClientRect = () => ({ top: 0, bottom: 120, height: 120, left: 0, right: 200, width: 200 }));

test("minimap model: bounded, skips nested blocks, classifies code/table/heading", async () => {
  const fx = createFixture({ turns: 8 });
  const heavy = fx.elements()[2 * 3 + 1];
  const model = buildTurnModel(chatgptAdapter.blocks([heavy]));
  const kinds = new Set(model.map((b) => b.kind));
  for (const k of ["heading", "text", "code", "table", "image"]) assert.ok(kinds.has(k), k);
  assert.equal(model.filter((b) => b.kind === "code").length, 1, "code spans are not separate blocks");
  const many = Array.from({ length: 1000 }, () => ({ kind: "text", lines: 1, width: 0.5 }));
  const bars = layoutBars(many, 120);
  assert.ok(bars.length <= 120);
  assert.ok(bars.every((b, i) => i === 0 || b.top >= bars[i - 1].top + bars[i - 1].height - 1e-9), "bars never overlap");
  assert.ok(bars.at(-1).top + bars.at(-1).height <= 1);
  assert.equal(viewportIndicator({ turnTop: 0, turnBottom: 1000, viewTop: -500, viewBottom: -100 }), null);
  assert.deepEqual(viewportIndicator({ turnTop: 0, turnBottom: 1000, viewTop: 250, viewBottom: 750 }), { top: 0.25, height: 0.5, visible: 0.5 });
  assert.equal(scrollTopForFraction({ fraction: 0.5, turnTop: 1000, turnHeight: 2000, viewHeight: 800 }), 1600);
  assert.equal(scrollTopForFraction({ fraction: 1, turnTop: 1000, turnHeight: 2000, viewHeight: 800 }), 2200, "clamped inside the turn");
  assert.equal(scrollTopForFraction({ fraction: 0.5, turnTop: 1000, turnHeight: 300, viewHeight: 800 }), 1000, "short turn pins to its top");
});

test("layout: minimap on top, prompts chronological oldest-first, newest last, list at the bottom", async () => {
  const fx = createFixture({ turns: 30, width: 1600 });
  const { q, list } = mount(fx);
  await fx.settle();
  const cards = [...q(".gs-rail-panel").children].map((c) => c.className.split(" ")[1]);
  assert.deepEqual(cards, ["gs-card-overview", "gs-card-prompts"], "overview card above the prompts card");
  assert.deepEqual([...q(".gs-card-overview .gs-card-body").children].map((c) => c.className), ["gs-minimap", "gs-caption"]);
  assert.deepEqual([...q(".gs-card-prompts .gs-card-body").children].map((c) => c.className), ["gs-search", "gs-prompts"]);
  assert.equal(q(".gs-card-overview .gs-card-title").textContent, "Conversation overview");
  assert.equal(q(".gs-card-prompts .gs-card-title").textContent, "Prompts");
  assert.equal(q(".gs-search input").placeholder, "Search prompts...");
  const buttons = items(fx);
  assert.equal(buttons.length, 30);
  assert.deepEqual(buttons.map((b) => b.querySelector(".gs-n").textContent), Array.from({ length: 30 }, (_, i) => `#${i + 1}`));
  assert.match(buttons[0].textContent, /Prompt 0 about/);
  assert.match(buttons.at(-1).textContent, /Prompt 29 about/);
  assert.equal(list.scrollTop, list.scrollHeight - 200, "scrolled to the newest prompt");
  assert.equal(buttons.at(-1).getAttribute("aria-current"), "true", "latest is active when viewing latest");
  assert.equal(q(".gs-rail").dataset.gsMode, "docked");
  assert.ok(q(".gs-bar"), "minimap shows the active turn");
  assert.ok(fx.doc.querySelectorAll(".gs-bar").length <= 120);
});

test("selecting the oldest prompt jumps through the shared navigation, activating the virtualized-out turn", async () => {
  const fx = createFixture({ turns: 40, width: 1600 });
  const { runtime, list } = mount(fx);
  await fx.settle();
  const first = fx.elements()[0];
  assert.equal(first.getAttribute("data-gs-state"), "inactive");
  const nav = runtime.scroll.stats.navigations;
  items(fx)[0].click();
  await fx.settle();
  assert.equal(fx.rawTop(), 0);
  assert.equal(first.getAttribute("data-gs-state"), "active");
  assert.equal(fx.blankInViewport().length, 0);
  assert.ok(runtime.scroll.stats.navigations > nav);
  assert.equal(runtime.scroll.stats.unexpected, 0);
  assert.equal(items(fx)[0].getAttribute("aria-current"), "true");
  assert.equal(items(fx).filter((b) => b.getAttribute("aria-current") === "true").length, 1);
  // Rapid jumps stay bounded and land on the right turn.
  for (const i of [39, 5, 21, 0, 30]) {
    items(fx)[i].click();
    await fx.settle();
    assert.equal(fx.elements()[2 * i].getBoundingClientRect().top === 0 || fx.rawTop() === fx.maxTop(), true, `prompt ${i}`);
    assert.equal(fx.blankInViewport().length, 0);
  }
  assert.equal(runtime.scroll.stats.unexpected, 0);
  void list;
});

test("conversation scrolling updates the active prompt; order and manual list scroll are preserved", async () => {
  const fx = createFixture({ turns: 40, width: 1600 });
  const { list } = mount(fx);
  await fx.settle();
  fx.wheel(-9000);
  await fx.settle();
  const active = items(fx).find((b) => b.getAttribute("aria-current") === "true");
  assert.ok(active && active !== items(fx).at(-1));
  const idx = items(fx).indexOf(active);
  const shown = [fx.elements()[2 * idx], fx.elements()[2 * idx + 1]];
  assert.ok(shown.some((e) => e.getBoundingClientRect().bottom > 0), "active prompt's turn is the one at the top");
  assert.ok(items(fx).map((b) => +b.querySelector(".gs-n").textContent.slice(1)).every((n, i) => n === i + 1), "never reversed");
  // The user scrolls the list away from the bottom; new prompts must not yank it.
  list.dispatchEvent(new fx.win.Event("wheel"));
  list.scrollTop = 200;
  await fx.settle();
  const kept = list.scrollTop;
  fx.addTurn();
  fx.addTurn();
  await fx.settle();
  assert.equal(items(fx).length, 42);
  assert.equal(list.scrollTop, kept);
  // Back at the bottom it follows the newest prompt again.
  list.scrollTop = list.scrollHeight;
  fx.addTurn();
  await fx.settle();
  assert.equal(list.scrollTop, list.scrollHeight - 200);
});

test("streaming and re-renders do not rebuild the list or move the conversation", async () => {
  const fx = createFixture({ turns: 20, width: 1600 });
  const { runtime, list } = mount(fx);
  await fx.settle();
  const node = items(fx)[3];
  const top = fx.rawTop();
  const events = fx.scrollEvents.length;
  for (let i = 0; i < 20; i++) {
    fx.stream(fx.thread.lastElementChild, 20);
    await fx.settle();
  }
  assert.equal(items(fx)[3], node, "same button nodes while only the last reply streams");
  assert.equal(fx.rawTop(), top);
  assert.equal(fx.scrollEvents.length, events);
  assert.equal(runtime.scroll.stats.unexpected, 0);
  void list;
});

test("search filters chronologically, keeps numbering, clears with Escape", async () => {
  const fx = createFixture({ turns: 30, width: 1600 });
  const { q } = mount(fx);
  await fx.settle();
  const input = q(".gs-search input");
  input.value = "plums";
  input.dispatchEvent(new fx.win.Event("input"));
  const hits = items(fx).map((b) => b.querySelector(".gs-n").textContent);
  assert.deepEqual(hits, ["#3", "#7", "#11", "#15", "#19", "#23", "#27"]);
  input.value = "nothing-like-this";
  input.dispatchEvent(new fx.win.Event("input"));
  assert.equal(items(fx).length, 0);
  assert.match(q(".gs-empty").textContent, /No matching/);
  input.value = "Prompt 12 ";
  input.dispatchEvent(new fx.win.Event("input"));
  assert.equal(items(fx).length, 1);
  items(fx)[0].click();
  await fx.settle();
  assert.equal(items(fx)[0].getAttribute("aria-current"), "true");
  input.dispatchEvent(new fx.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(input.value, "");
  assert.equal(items(fx).length, 30);
});

test("minimap: viewport indicator, click and drag navigate the active turn through the scroll manager", async () => {
  const fx = createFixture({ turns: 40, width: 1600 });
  const { runtime, q, minimap } = mount(fx);
  fixMinimapRect(minimap);
  await fx.settle();
  items(fx)[3].click(); // turn 3 is the long code/table/image turn
  await fx.settle();
  const kinds = new Set([...fx.doc.querySelectorAll(".gs-bar")].map((b) => b.dataset.kind));
  for (const k of ["heading", "code", "table", "image"]) assert.ok(kinds.has(k), k);
  const view = q(".gs-view");
  assert.equal(view.hidden, false);
  const a = fx.elements()[6];
  const turnTop = a.getBoundingClientRect().top + fx.rawTop();
  const turnHeight = fx.elements()[6].__h + fx.elements()[7].__h;
  const events = fx.scrollEvents.length;
  minimap.dispatchEvent(pointer(fx, "pointerdown", 60));
  await fx.settle();
  const mid = fx.rawTop();
  assert.ok(mid > turnTop && mid < turnTop + turnHeight, "click lands inside the turn");
  assert.ok(fx.scrollEvents.length > events);
  let last = mid;
  for (const y of [70, 85, 100, 119]) {
    minimap.dispatchEvent(pointer(fx, "pointermove", y));
    await fx.settle();
    assert.ok(fx.rawTop() >= last, "dragging down moves forward");
    last = fx.rawTop();
  }
  minimap.dispatchEvent(pointer(fx, "pointerup", 119));
  const after = fx.rawTop();
  minimap.dispatchEvent(pointer(fx, "pointermove", 10));
  await fx.settle();
  assert.equal(fx.rawTop(), after, "no dragging after pointerup");
  assert.ok(last <= turnTop + turnHeight - fx.viewport + 1, "never leaves the turn");
  assert.ok(runtime.diagnostics.snapshot()["scroll.moved.minimap"] >= 5);
  assert.equal(runtime.scroll.stats.unexpected, 0);
  minimap.dispatchEvent(new fx.win.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  await fx.settle();
  assert.equal(fx.rawTop(), turnTop);
  assert.ok(runtime.diagnostics.snapshot()["scroll.moved.keyboard"] >= 1);
});

test("responsive: docked from the dock threshold, collapsed toggle on narrow viewports", async () => {
  const wide = createFixture({ turns: 12, width: 1600 });
  mount(wide);
  const dock = wide.doc.querySelector(".gs-rail");
  assert.equal(dock.dataset.gsMode, "docked");
  assert.equal(dock.dataset.gsOpen, "true");

  // 1280 leaves a 256px natural gutter: docked by shifting the page column, not by overlapping it.
  const tight = createFixture({ turns: 12, width: 1280 });
  mount(tight);
  assert.equal(tight.doc.querySelector(".gs-rail").dataset.gsMode, "docked");
  assert.ok(tight.reserve() > 0);

  const narrow = createFixture({ turns: 12, width: 390 });
  const { q } = mount(narrow);
  const rail = q(".gs-rail");
  const toggle = q(".gs-rail-toggle");
  assert.equal(rail.dataset.gsMode, "collapsed");
  assert.equal(rail.dataset.gsOpen, "false");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(narrow.reserve(), 0, "a collapsed rail reserves nothing");
  toggle.click();
  assert.equal(rail.dataset.gsOpen, "true");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  q(".gs-search input").dispatchEvent(new narrow.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(rail.dataset.gsOpen, "false", "Escape closes the collapsed panel");
  // Growing the window re-docks it.
  narrow.win.innerWidth = 1700;
  narrow.win.dispatchEvent(new narrow.win.Event("resize"));
  await narrow.settle();
  assert.equal(rail.dataset.gsMode, "docked");
  assert.equal(rail.dataset.gsOpen, "true");
});

test("styles keep the rail inside the viewport and anchored bottom-right, growing upward", async () => {
  const fx = createFixture({ turns: 5, width: 1600 });
  mount(fx);
  const css = fx.doc.getElementById("gs-rail-style").textContent;
  assert.match(css, /\.gs-rail\{position:fixed;right:\d+px;bottom:\d+px/);
  assert.match(css, /\.gs-rail\{[^}]*max-width:calc\(100vw - 24px\)/);
  assert.match(css, /\.gs-rail-panel\{[^}]*max-width:calc\(100vw - 24px\)[^}]*max-height:min\(calc\(100vh/);
  assert.match(css, /\.gs-prompts\{[^}]*overflow-x:hidden;overflow-y:auto/);
  assert.match(css, /\.gs-title\{[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/);
  assert.match(css, /\.gs-preview\{[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/);
  assert.doesNotMatch(css, /overflow-x:(auto|scroll)/);
  assert.doesNotMatch(css, /position:(sticky|absolute)[^}]*\.gs-rail\b/);
  assert.match(css, /focus-visible/);
});

test("keyboard: arrows rove through prompts and Enter-click activates", async () => {
  const fx = createFixture({ turns: 12, width: 1600 });
  mount(fx);
  await fx.settle();
  const b = items(fx);
  b.at(-1).focus();
  b.at(-1).dispatchEvent(new fx.win.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  assert.equal(fx.doc.activeElement, b.at(-2));
  assert.deepEqual(b.map((x) => x.tabIndex).filter((t) => t === 0).length, 1, "single tab stop");
  b.at(-2).dispatchEvent(new fx.win.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  assert.equal(fx.doc.activeElement, b[0]);
  assert.equal(fx.doc.querySelector(".gs-minimap").getAttribute("role"), "slider");
  assert.equal(fx.doc.querySelector(".gs-minimap").tabIndex, 0);
});

test("fail-open removes the rail; dispose leaves the DOM as it was", async () => {
  const fx = createFixture({ turns: 20, width: 1600 });
  const before = fx.doc.documentElement.outerHTML;
  const { runtime, rail } = mount(fx);
  await fx.settle();
  assert.ok(fx.doc.querySelector(".gs-rail"));
  rail.dispose();
  runtime.dispose();
  assert.equal(fx.doc.documentElement.outerHTML, before);

  const fx2 = createFixture({ turns: 20, width: 1600 });
  mount(fx2);
  await fx2.settle();
  fx2.elements().forEach((e) => e.removeAttribute("data-testid"));
  fx2.thread.append(fx2.doc.createElement("div"));
  await fx2.settle();
  assert.equal(fx2.doc.querySelector(".gs-rail"), null);
  assert.equal(fx2.doc.getElementById("gs-rail-style"), null);
});

test("reference layout: collapsible cards, caption percentage, green in-view dots, filter", async () => {
  const fx = createFixture({ turns: 40, width: 1600 });
  const { q, list, minimap } = mount(fx);
  fixMinimapRect(minimap);
  await fx.settle();
  const head = (cls) => q(`.${cls} .gs-card-head`);
  assert.match(q(".gs-caption").textContent, /^Drag to navigate • \d+% visible$/);

  // Rows: #N, bold title, one-line preview; the newest row is last.
  const row = items(fx).at(-1);
  assert.equal(row.querySelector(".gs-n").textContent, "#40");
  assert.equal(row.querySelector(".gs-title").textContent, "Prompt 39 about grapes");
  assert.ok(row.querySelector(".gs-preview").textContent.length > 0);

  // Green dot on prompts whose turn is in view; follows scrolling.
  const dotted = () => items(fx).filter((b) => b.dataset.inView === "true").map((b) => b.querySelector(".gs-n").textContent);
  assert.ok(dotted().includes("#40"));
  fx.wheel(-9000);
  await fx.settle();
  assert.ok(!dotted().includes("#40"));
  assert.ok(dotted().length >= 1);
  assert.ok(items(fx).find((b) => b.getAttribute("aria-current") === "true").dataset.inView === "true", "active row is in view");

  // Filter button limits the list to prompts in view.
  q(".gs-filter").click();
  assert.equal(q(".gs-filter").getAttribute("aria-pressed"), "true");
  assert.ok(items(fx).length >= 1 && items(fx).length < 40);
  assert.ok(items(fx).every((b) => b.dataset.inView === "true"));
  q(".gs-filter").click();
  assert.equal(items(fx).length, 40);

  // No "First prompt" / "Last prompt" buttons: the list itself (scroll, search, select) is the navigation.
  assert.equal(q(".gs-first"), null);
  assert.equal(q(".gs-last"), null);
  assert.equal(q(".gs-jumps"), null);
  assert.doesNotMatch(q(".gs-rail").textContent, /First prompt|Last prompt/);
  items(fx)[0].click();
  await fx.settle();
  assert.equal(fx.rawTop(), 0);
  assert.equal(items(fx)[0].getAttribute("aria-current"), "true");
  list.scrollTop = list.scrollHeight;
  items(fx).at(-1).click();
  await fx.settle();
  assert.equal(items(fx).at(-1).getAttribute("aria-current"), "true");
  assert.equal(fx.blankInViewport().length, 0);

  // Chevron headers collapse and expand each card.
  for (const cls of ["gs-card-overview", "gs-card-prompts"]) {
    const card = q(`.${cls}`);
    assert.equal(head(cls).getAttribute("aria-expanded"), "true");
    head(cls).click();
    assert.equal(card.dataset.gsCollapsed, "true");
    assert.equal(head(cls).getAttribute("aria-expanded"), "false");
    head(cls).click();
    assert.equal(card.dataset.gsCollapsed, "false");
  }
  assert.match(fx.doc.getElementById("gs-rail-style").textContent, /\.gs-card\[data-gs-collapsed="true"\] \.gs-card-body\{display:none\}/);
});

test("minimap caption reports the visible share of the turn", async () => {
  const fx = createFixture({ turns: 40, width: 1600 });
  const { q, minimap } = mount(fx);
  fixMinimapRect(minimap);
  await fx.settle();
  fx.elements()[6].__h = 4000; // long reply turn => viewport covers a fraction of it
  fx.elements()[7].__h = 4000;
  q(".gs-prompt[data-id='conversation-turn-7']").click();
  await fx.settle();
  const pct = +q(".gs-caption").textContent.match(/(\d+)% visible/)[1];
  assert.ok(pct > 5 && pct < 20, `visible ${pct}%`);
});

test("prompt rows: first sentence is the title, the rest (or the reply) the one-line preview", () => {
  assert.deepEqual(describePrompt("Summarize the notes. Cover topics one to three with examples", "reply text"), {
    title: "Summarize the notes",
    preview: "Cover topics one to three with examples",
  });
  assert.deepEqual(describePrompt("Short question", "The answer begins here"), { title: "Short question", preview: "The answer begins here" });
  assert.equal(describePrompt("x".repeat(200)).title.length, 60);
  assert.equal(describePrompt("a".repeat(200), "").preview.length, 100);
});

test("an idle page stays idle: the rail does not feed the prompt-index observer in a loop", async () => {
  const fx = createFixture({ turns: 20, width: 1600 });
  const { runtime } = mount(fx);
  await fx.settle();
  const flushes = runtime.diagnostics.snapshot()["observer.flush"];
  const writes = [];
  const mo = new fx.win.MutationObserver((records) => writes.push(...records.map((r) => `${r.type}:${r.target.className || r.target.tagName}`)));
  mo.observe(fx.doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  await fx.settle();
  await fx.settle();
  await Promise.resolve();
  assert.deepEqual(writes, [], "no DOM writes while nothing happens");
  assert.equal(runtime.diagnostics.snapshot()["observer.flush"], flushes);
  mo.disconnect();
});
