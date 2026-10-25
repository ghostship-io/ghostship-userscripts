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
  const panels = [...fx.doc.querySelectorAll(".gs-panel")].map((p) => p.dataset.gsPanel);
  assert.deepEqual(panels, ["minimap", "prompts"], "two panels: the conversation view and the prompt list");
  assert.deepEqual([...q('[data-gs-panel="minimap"] .gs-panel-body').children].map((c) => c.className), ["gs-minimap", "gs-caption"]);
  assert.deepEqual([...q('[data-gs-panel="prompts"] .gs-panel-body').children].map((c) => c.className), ["gs-search", "gs-prompts"]);
  assert.equal(q('[data-gs-panel="minimap"] .gs-panel-title').textContent, "Conversation view");
  assert.equal(q('[data-gs-panel="prompts"] .gs-panel-title').textContent, "Prompts");
  assert.equal(q(".gs-search input").placeholder, "Filter prompts...");
  const buttons = items(fx);
  assert.equal(buttons.length, 30);
  assert.deepEqual(buttons.map((b) => b.querySelector(".gs-n").textContent), Array.from({ length: 30 }, (_, i) => `#${i + 1}`));
  assert.match(buttons[0].textContent, /Prompt 0 about/);
  assert.match(buttons.at(-1).textContent, /Prompt 29 about/);
  assert.equal(list.scrollTop, list.scrollHeight - 200, "scrolled to the newest prompt");
  assert.equal(buttons.at(-1).getAttribute("aria-current"), "true", "latest is active when viewing latest");
  assert.equal(q('[data-gs-panel="minimap"]').hidden, false);
  assert.equal(q('[data-gs-panel="prompts"]').hidden, false);
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

test("responsive: docked from the dock threshold, a drawer opened by the one header button on narrow viewports", async () => {
  const hidden = (fx) => fx.doc.querySelector(".gs-rail").hidden;
  const wide = createFixture({ turns: 12, width: 1600 });
  mount(wide);
  assert.equal(hidden(wide), false);
  assert.equal(wide.doc.querySelector(".gs-rail").dataset.gsDrawer, "false");

  // 1280 leaves 256px of natural gutter: docked by shifting the page column, not by overlapping it.
  const tight = createFixture({ turns: 12, width: 1280 });
  mount(tight);
  assert.equal(hidden(tight), false);
  assert.ok(tight.reserve() > 0);

  const narrow = createFixture({ turns: 12, width: 390 });
  const { q } = mount(narrow);
  assert.equal(hidden(narrow), true, "nothing covers the conversation on its own");
  assert.equal(narrow.reserve(), 0, "a drawer reserves nothing");
  const btn = () => q(".gs-hbtn");
  assert.equal(btn().getAttribute("aria-pressed"), "false");
  btn().click();
  assert.equal(hidden(narrow), false);
  assert.equal(q(".gs-rail").dataset.gsDrawer, "true");
  assert.equal(btn().getAttribute("aria-pressed"), "true");
  q(".gs-rail").dispatchEvent(new narrow.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(hidden(narrow), true, "Escape closes the drawer");
  btn().click();
  btn().click();
  assert.equal(hidden(narrow), true, "the same button closes it again");
  // Growing the window docks the remembered choice (shown by default).
  narrow.win.innerWidth = 1700;
  narrow.win.dispatchEvent(new narrow.win.Event("resize"));
  await narrow.settle();
  assert.equal(hidden(narrow), false);
});

test("styles: one right-hand column of two elevated cards, native tokens only, no bespoke chrome", async () => {
  const fx = createFixture({ turns: 5, width: 1600 });
  mount(fx);
  const css = fx.doc.getElementById("gs-pane-style").textContent;
  assert.match(css, /\.gs-rail\{position:fixed;[^}]*top:var\(--gs-top,60px\);right:var\(--gs-right,12px\);bottom:var\(--gs-bottom,16px\)[^}]*flex-direction:column/, "one column pinned top-right to bottom-right");
  assert.match(css, /\.gs-panel-prompts\{margin-top:auto\}/, "the prompts sit at the bottom of the column and grow up");
  assert.match(css, /\.gs-panel\{[^}]*border-radius:var\(--radius-2xl,16px\)[^}]*box-shadow:var\(--elevation-prominent/, "ChatGPT's own card: elevated surface, ring, radius");
  assert.match(css, /\.gs-prompts\{[^}]*overflow-x:hidden;overflow-y:auto/);
  assert.match(css, /\.gs-title\{[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/);
  assert.match(css, /\.gs-preview\{[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/);
  assert.doesNotMatch(css, /overflow-x:(auto|scroll)/);
  assert.match(css, /focus-visible/);
  // Native visual system: colors come from ChatGPT's tokens (or the current color / system colors), so both
  // themes and later token changes carry over; no fixed colors, underlined titles or card shells.
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, "no literal colors");
  assert.doesNotMatch(css, /text-decoration|drop-shadow/);
  assert.doesNotMatch(css, /\.gs-(card|pane)\b/);
  for (const token of ["--color-surface-elevated-secondary", "--color-text", "--color-border", "--color-text-secondary", "--elevation-prominent"]) assert.ok(css.includes(token), token);
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
  assert.ok(fx.doc.querySelector(".gs-panel"));
  rail.dispose();
  runtime.dispose();
  assert.equal(fx.doc.documentElement.outerHTML, before);

  const fx2 = createFixture({ turns: 20, width: 1600 });
  mount(fx2);
  await fx2.settle();
  fx2.elements().forEach((e) => e.removeAttribute("data-testid"));
  fx2.thread.append(fx2.doc.createElement("div"));
  await fx2.settle();
  assert.equal(fx2.doc.querySelector(".gs-panel"), null);
  assert.equal(fx2.doc.querySelector(".gs-hbtns"), null);
  assert.equal(fx2.doc.getElementById("gs-pane-style"), null);
});

test("reference layout: collapsible cards, caption percentage, green in-view dots, filter", async () => {
  const fx = createFixture({ turns: 40, width: 1600 });
  const { q, list, minimap } = mount(fx);
  fixMinimapRect(minimap);
  await fx.settle();
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

  // The one box filters the list by text; there is no second control beside it.
  assert.equal(q(".gs-filter"), null);
  assert.equal(q(".gs-search").querySelectorAll("button").length, 0, "no button beside the filter box");
  assert.equal(q(".gs-search input").getAttribute("aria-label"), "Filter prompts");

  // No "First prompt" / "Last prompt" buttons: the list itself (scroll, search, select) is the navigation.
  assert.equal(q(".gs-first"), null);
  assert.equal(q(".gs-last"), null);
  assert.equal(q(".gs-jumps"), null);
  assert.doesNotMatch(q(".gs-panel-prompts").textContent, /First prompt|Last prompt/);
  items(fx)[0].click();
  await fx.settle();
  assert.equal(fx.rawTop(), 0);
  assert.equal(items(fx)[0].getAttribute("aria-current"), "true");
  list.scrollTop = list.scrollHeight;
  items(fx).at(-1).click();
  await fx.settle();
  assert.equal(items(fx).at(-1).getAttribute("aria-current"), "true");
  assert.equal(fx.blankInViewport().length, 0);

  // One header button hides both panels and the same button restores them; the choice is remembered per browser.
  const rail = q(".gs-rail");
  const button = q(".gs-hbtn");
  assert.equal(fx.doc.querySelectorAll(".gs-hbtn").length, 1, "one button for both panels");
  assert.equal(q(".gs-collapse"), null, "no per-panel controls");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  button.click();
  assert.equal(rail.hidden, true);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  button.click();
  assert.equal(rail.hidden, false);
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
