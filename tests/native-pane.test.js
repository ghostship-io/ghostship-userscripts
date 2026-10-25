import test from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./virtualization-fixture.js";
import { createRuntime } from "../src/core/runtime.js";
import { DEFAULTS } from "../src/core/config.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createTurnBackend } from "../src/chatgpt/virtualization/backend.js";
import { createRail } from "../src/chatgpt/rail/rail.js";
import { createPanePrefs, createRailStateStore } from "../src/chatgpt/rail/rail-state.js";
import { DOCK_MIN_VIEWPORT, MIN_CONTENT, RAIL_WIDTH } from "../src/chatgpt/rail/rail-layout.js";

function mount(fx, { store = createRailStateStore(), prefs } = {}) {
  const runtime = createRuntime({ win: fx.win, adapter: chatgptAdapter, backend: createTurnBackend(), config: { ...DEFAULTS } });
  assert.equal(runtime.mode, "active");
  const rail = createRail({ win: fx.win, adapter: chatgptAdapter, runtime, store, prefs });
  return {
    runtime,
    rail,
    stop() {
      rail.dispose();
      runtime.dispose();
    },
    q: (sel) => fx.doc.querySelector(sel),
  };
}
const items = (fx) => [...fx.doc.querySelectorAll(".gs-prompt")];
const rects = (fx) => ({
  turn: chatgptAdapter.turns(fx.doc)[0].getBoundingClientRect(),
  composer: chatgptAdapter.composer(fx.doc).getBoundingClientRect(),
});
/** The panes the user can see: our fallback pane when shown, else our sections inside ChatGPT's. */
const visibleHosts = (fx) => [...fx.doc.querySelectorAll(".gs-pane-body")].filter((b) => !b.closest("[hidden]"));
const outputs = (fx) => fx.doc.getElementById("native-outputs");
const sources = (fx) => fx.doc.getElementById("native-sources");
const snapshot = (el) => [el, ...el.querySelectorAll("*")];

test("native host present: exactly one pinned pane, our sections inside ChatGPT's own, no second card", async () => {
  const fx = createFixture({ turns: 30, width: 1600, markup: "real", pane: {} });
  const nodes = snapshot(fx.pane);
  const records = [];
  const mo = new fx.win.MutationObserver((r) => records.push(...r));
  mo.observe(fx.pane, { childList: true, subtree: true, attributes: true, characterData: true });
  const { q } = mount(fx);
  await fx.settle();
  records.push(...mo.takeRecords());
  mo.disconnect();

  assert.equal(visibleHosts(fx).length, 1, "one visible pane");
  assert.equal(q(".gs-pane").hidden, true, "the fallback shell yields");
  assert.equal(q(".gs-pane").dataset.gsHost, "native");
  assert.equal(q(".gs-pane-toggle").hidden, true, "no second control for the same pane");
  assert.ok(fx.pane.contains(q(".gs-pane-body")), "the sections live inside the native pane");
  const sections = [...q(".gs-pane-body").children].map((c) => c.className.split(" ")[1]);
  assert.deepEqual(sections, ["gs-sec-overview", "gs-sec-prompts"], "overview above the prompts");
  assert.equal(fx.pane.querySelector(".pane-content").lastElementChild, q(".gs-pane-slot"), "appended after Sources");

  // Nothing native was moved, removed or re-created; the only native writes are our data attributes.
  assert.ok(nodes.every((n) => n.isConnected && fx.pane.contains(n)));
  const native = records.filter((r) => !r.target.closest("[data-gs-ui]"));
  assert.deepEqual(native.flatMap((r) => [...r.removedNodes]), [], "no native node removed");
  for (const r of native) {
    if (r.type === "attributes") assert.match(r.attributeName, /^data-gs-/, `native attribute ${r.attributeName} untouched`);
    if (r.type === "childList") assert.ok([...r.addedNodes].every((n) => n.matches?.("[data-gs-ui]")), "only our own nodes are added");
  }
  assert.equal(sources(fx).querySelector("a").getAttribute("href"), "#src-1", "Sources intact");
  assert.equal(sources(fx).hasAttribute("data-gs-collapsed"), false, "Sources is never collapsed by us");
});

test("Outputs collapses and expands repeatedly; Sources, the minimap and the prompt list stay usable", async () => {
  const fx = createFixture({ turns: 40, width: 1600, markup: "real", pane: {} });
  const { q, runtime } = mount(fx);
  const list = q(".gs-prompts");
  await fx.settle();
  const toggle = q(".gs-outputs-toggle");
  assert.ok(outputs(fx).querySelector(".sec-head").contains(toggle), "the disclosure sits in the Outputs title row");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const links = [...outputs(fx).querySelectorAll("a")];
  const bottom = list.scrollTop;

  for (let i = 0; i < 4; i++) {
    toggle.click();
    await fx.settle();
    const collapsed = i % 2 === 0;
    assert.equal(outputs(fx).dataset.gsCollapsed, String(collapsed), `round ${i}`);
    assert.equal(toggle.getAttribute("aria-expanded"), String(!collapsed));
    assert.deepEqual([...outputs(fx).querySelectorAll("a")], links, "the native items stay in place");
    assert.equal(sources(fx).hasAttribute("data-gs-collapsed"), false);
    assert.equal(visibleHosts(fx).length, 1);
    assert.equal(list.scrollTop, bottom, "the newest prompt stays bottom-aligned");
    assert.equal(items(fx).at(-1).getAttribute("aria-current"), "true");
  }
  // With Outputs collapsed the rest of the pane still works: a prompt jump moves the real conversation.
  toggle.click();
  await fx.settle();
  assert.equal(outputs(fx).dataset.gsCollapsed, "true");
  items(fx)[0].click();
  await fx.settle();
  assert.equal(fx.rawTop(), 0);
  assert.equal(runtime.scroll.stats.unexpected, 0);
  assert.equal(items(fx)[0].getAttribute("aria-current"), "true");
  // The collapse hides only the section's own list: the CSS keeps the title row.
  const css = fx.doc.getElementById("gs-pane-style").textContent;
  assert.match(css, /\[data-gs-outputs\]\[data-gs-collapsed="true"\]>:not\(\[data-gs-outputs-head\]\)\{display:none\}/);
  assert.equal(outputs(fx).querySelector(".sec-head").hasAttribute("data-gs-outputs-head"), true);
});

test("a pane without Outputs still hosts the sections and Sources is untouched", async () => {
  const fx = createFixture({ turns: 12, width: 1600, markup: "real", pane: { outputs: false } });
  const { q } = mount(fx);
  await fx.settle();
  assert.equal(visibleHosts(fx).length, 1);
  assert.equal(q(".gs-outputs-toggle"), null, "no fake Outputs, no disclosure for nothing");
  assert.equal(sources(fx).querySelector("a").getAttribute("href"), "#src-1");
  assert.equal(fx.doc.querySelectorAll("[data-gs-outputs]").length, 0);
});

test("the column is reserved once: a pane that already takes its width leaves the page alone", async () => {
  for (const theme of ["light", "dark"]) {
    for (const [width, nav] of [[1920, 0], [1600, 0], [1448, 52], [1280, 0], [1180, 52], [DOCK_MIN_VIEWPORT, 0], [900, 0]]) {
      const fx = createFixture({ turns: 20, width, nav, markup: "real", pane: {} });
      fx.doc.documentElement.className = theme;
      const { q } = mount(fx);
      await fx.settle();
      const label = `${theme}, ${width}px wide, ${nav}px navigation`;
      const left = fx.win.innerWidth - fx.paneWidth();
      const { turn, composer } = rects(fx);
      assert.equal(fx.reserve(), 0, `${label}: no second reservation`);
      assert.equal(fx.doc.body.hasAttribute("data-gs-column"), false, label);
      assert.equal(fx.doc.body.getAttribute("style"), null, label);
      assert.ok(turn.right <= left && composer.right <= left, `${label}: conversation ${turn.right}, composer ${composer.right}, pane ${left}`);
      assert.equal(visibleHosts(fx).length, 1, label);
      assert.equal(q(".gs-pane-toggle").hidden, true, label);
      assert.equal(q(".gs-pane").getAttribute("style"), null, "the shell carries no inline colors or offsets while hidden");
    }
  }
});

test("a native pane that floats over the right edge is cleared by shifting once, by what overlaps it", async () => {
  for (const [width, nav] of [[1600, 0], [1448, 52], [1280, 0], [1100, 0]]) {
    const fx = createFixture({ turns: 20, width, nav, markup: "real", pane: { reserves: false } });
    const { q } = mount(fx);
    await fx.settle();
    const label = `${width}px wide, ${nav}px navigation`;
    const left = fx.win.innerWidth - fx.paneWidth();
    const { turn, composer } = rects(fx);
    assert.ok(turn.right <= left && composer.right <= left, `${label}: conversation ${turn.right}, composer ${composer.right}, pane ${left}`);
    assert.ok(fx.reserve() <= fx.paneWidth(), `${label}: shifted by ${fx.reserve()}, never more than the pane`);
    assert.ok(turn.width >= MIN_CONTENT, label);
    assert.equal(composer.left, turn.left, `${label}: composer and conversation shift together`);
    assert.equal(visibleHosts(fx).length, 1, label);
    assert.equal(q(".gs-pane").hidden, true);
  }
  const wide = createFixture({ turns: 12, width: 1920, markup: "real", pane: { reserves: false } });
  mount(wide);
  await wide.settle();
  assert.equal(wide.reserve(), 0, "a wide window already clears a floating pane");
});

test("no native host: one docked fallback of the same shape, reserved once; it yields to a native pane that appears and returns when it goes", async () => {
  const fx = createFixture({ turns: 20, width: 1280, markup: "real" });
  const { q } = mount(fx);
  await fx.settle();
  assert.equal(visibleHosts(fx).length, 1);
  assert.equal(q(".gs-pane").dataset.gsHost, "fallback");
  assert.equal(q(".gs-pane").hidden, false);
  assert.equal(q(".gs-pane").dataset.gsMode, "docked");
  assert.deepEqual([...q(".gs-pane-body").children].map((c) => c.className.split(" ")[1]), ["gs-sec-overview", "gs-sec-prompts"], "same sections, same order");
  assert.equal(q(".gs-outputs-toggle"), null, "no invented Outputs or Sources");
  const fallbackReserve = fx.reserve();
  assert.ok(fallbackReserve > 0);

  // ChatGPT mounts its own pane (which takes its width): we move in, release our reservation, never both.
  const native = fx.mountPane();
  fx.win.dispatchEvent(new fx.win.Event("resize"));
  await fx.settle();
  assert.equal(visibleHosts(fx).length, 1, "no duplicate pane");
  assert.equal(q(".gs-pane").hidden, true);
  assert.ok(native.contains(q(".gs-pane-body")));
  assert.equal(fx.reserve(), 0, "the width is reserved by the native pane alone");
  assert.equal(rects(fx).turn.right <= fx.win.innerWidth - fx.paneWidth(), true);
  assert.equal(fx.doc.querySelectorAll(".gs-pane-slot").length, 1);

  // It goes away again: the fallback comes back and reserves for itself.
  fx.unmountPane();
  fx.win.dispatchEvent(new fx.win.Event("resize"));
  await fx.settle();
  assert.equal(visibleHosts(fx).length, 1);
  assert.equal(q(".gs-pane").dataset.gsHost, "fallback");
  assert.equal(q(".gs-pane").hidden, false);
  assert.equal(fx.reserve(), fallbackReserve);
  assert.equal(fx.doc.querySelectorAll(".gs-pane-slot").length, 0);

  // A pane that stays mounted but is closed (no box) is not a host.
  fx.mountPane();
  fx.hidePane();
  fx.win.dispatchEvent(new fx.win.Event("resize"));
  await fx.settle();
  assert.equal(q(".gs-pane").dataset.gsHost, "fallback");
  assert.equal(visibleHosts(fx).length, 1);
});

test("headings inside the conversation never count as the native pane", async () => {
  const fx = createFixture({ turns: 12, width: 1600, markup: "real" });
  const reply = fx.thread.lastElementChild.querySelector("[data-conversation-role]");
  reply.insertAdjacentHTML("beforeend", "<h3>Sources</h3><h3>Outputs</h3>");
  const { q } = mount(fx);
  await fx.settle();
  assert.equal(chatgptAdapter.nativeSummary(fx.doc), null);
  assert.equal(q(".gs-pane").dataset.gsHost, "fallback");
});

test("Outputs state is per conversation, survives A -> B -> A and a reload, and never leaks", async () => {
  const fx = createFixture({ turns: 20, width: 1600, markup: "real", pane: {} });
  const store = createRailStateStore();
  const prefs = createPanePrefs(fx.win.localStorage);
  const visit = (path) => fx.win.history.pushState({}, "", path);

  let ui = mount(fx, { store, prefs });
  await fx.settle();
  ui.q(".gs-outputs-toggle").click();
  ui.q(".gs-sec-overview .gs-sec-head").click();
  assert.equal(outputs(fx).dataset.gsCollapsed, "true");
  ui.stop();
  assert.equal(outputs(fx).hasAttribute("data-gs-outputs"), false, "dispose releases the native section");
  assert.equal(fx.pane.querySelector("[data-gs-ui]"), null);

  visit("/c/conversation-b");
  ui = mount(fx, { store, prefs });
  await fx.settle();
  assert.equal(outputs(fx).dataset.gsCollapsed, "false", "B starts expanded");
  assert.equal(ui.q(".gs-sec-overview").dataset.gsCollapsed, "false");
  ui.stop();

  visit("/c/fixture");
  ui = mount(fx, { store, prefs });
  await fx.settle();
  assert.equal(outputs(fx).dataset.gsCollapsed, "true", "A is back as it was");
  assert.equal(ui.q(".gs-sec-overview").dataset.gsCollapsed, "true");
  ui.stop();

  // A reload keeps the in-memory store out of it: only the stored collapse choices come back.
  ui = mount(fx, { store: createRailStateStore(), prefs: createPanePrefs(fx.win.localStorage) });
  await fx.settle();
  assert.equal(outputs(fx).dataset.gsCollapsed, "true");
  const stored = fx.win.localStorage.getItem("gs.pane.prefs");
  assert.doesNotMatch(stored, /Prompt|about/, "no prompt text in storage");
  ui.stop();
});

test("prefs are bounded, per conversation, and tolerate bad storage", () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  const prefs = createPanePrefs(storage, { max: 3 });
  for (const id of ["a", "b", "c", "d"]) prefs.set(id, { outputs: id === "a" });
  assert.equal(prefs.get("a"), null, "oldest dropped");
  assert.deepEqual(prefs.get("d"), { outputs: false, overview: false, prompts: false });
  prefs.set("new", { outputs: true });
  assert.equal(prefs.get("new"), null);
  data.set("gs.pane.prefs", "{not json");
  assert.equal(prefs.get("b"), null);
  assert.equal(createPanePrefs(null).get("a"), null);
});

test("ChatGPT re-rendering its pane: the disclosure and our sections follow, nothing doubles", async () => {
  const fx = createFixture({ turns: 20, width: 1600, markup: "real", pane: {} });
  const { q } = mount(fx);
  await fx.settle();
  q(".gs-outputs-toggle").click();
  fx.mountPane(); // React renders a fresh pane (all new nodes), collapsed state still ours
  fx.win.dispatchEvent(new fx.win.Event("resize"));
  await fx.settle();
  assert.equal(visibleHosts(fx).length, 1);
  assert.equal(fx.doc.querySelectorAll(".gs-outputs-toggle").length, 1);
  assert.equal(fx.doc.querySelectorAll(".gs-pane-slot").length, 1);
  assert.equal(outputs(fx).dataset.gsCollapsed, "true");

  // Our slot is dropped from under us: it is put back.
  q(".gs-pane-slot").remove();
  fx.win.dispatchEvent(new fx.win.Event("resize"));
  await fx.settle();
  assert.equal(fx.doc.querySelectorAll(".gs-pane-slot").length, 1);
  assert.equal(visibleHosts(fx).length, 1);
});

test("the pane's own controls work inside the native host: keyboard, pointer and the disclosure", async () => {
  const fx = createFixture({ turns: 40, width: 1600, markup: "real", pane: {} });
  const { q, runtime } = mount(fx);
  await fx.settle();
  const minimap = q(".gs-minimap");
  minimap.getBoundingClientRect = () => ({ top: 0, bottom: 120, height: 120, left: 0, right: 200, width: 200 });
  assert.equal(minimap.getAttribute("role"), "slider");
  assert.equal(minimap.tabIndex, 0);
  items(fx)[3].click(); // a heavy turn, taller than the viewport
  await fx.settle();
  const before = fx.rawTop();
  minimap.dispatchEvent(Object.assign(new fx.win.Event("pointerdown", { bubbles: true }), { clientY: 100, pointerId: 1 }));
  await fx.settle();
  assert.notEqual(fx.rawTop(), before, "dragging the minimap moves the conversation");
  assert.equal(runtime.scroll.stats.unexpected, 0);
  const toggle = q(".gs-outputs-toggle");
  assert.equal(toggle.tagName, "BUTTON", "a real button: Enter and Space work natively");
  assert.ok(toggle.getAttribute("aria-label"));
  // The click is ours alone: the native title row's handlers never see it.
  let reached = false;
  outputs(fx).querySelector(".sec-head").addEventListener("click", () => (reached = true));
  toggle.click();
  assert.equal(reached, false);
});

test("idle with a native pane: no DOM writes, no extra observers, no polling", async () => {
  const bare = createFixture({ turns: 20, width: 1280, markup: "real" });
  const base = mount(bare);
  await bare.settle();
  const baseline = base.runtime.observers.size();

  const fx = createFixture({ turns: 20, width: 1280, markup: "real", pane: {} });
  const { runtime } = mount(fx);
  await fx.settle();
  assert.equal(runtime.observers.size(), baseline, "the native pane adds no observer");
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

test("dispose leaves ChatGPT's pane and the page exactly as they were", async () => {
  const fx = createFixture({ turns: 20, width: 1280, markup: "real", pane: { reserves: false } });
  const before = fx.doc.documentElement.outerHTML;
  const ui = mount(fx);
  await fx.settle();
  ui.q(".gs-outputs-toggle").click();
  assert.notEqual(fx.doc.documentElement.outerHTML, before);
  ui.stop();
  assert.equal(fx.doc.documentElement.outerHTML, before);
});

test("mobile and narrow windows: the fallback is a toggle above the composer, and never reserves", async () => {
  for (const width of [390, 768, 1023]) {
    const fx = createFixture({ turns: 12, width, markup: "real" });
    const { q } = mount(fx);
    await fx.settle();
    assert.equal(q(".gs-pane").dataset.gsMode, "collapsed", `${width}px`);
    assert.equal(q(".gs-pane").dataset.gsOpen, "false");
    assert.equal(q(".gs-pane-toggle").dataset.gsMode, "collapsed");
    assert.equal(fx.reserve(), 0);
    const composer = chatgptAdapter.composer(fx.doc).getBoundingClientRect();
    const bottom = parseInt(q(".gs-pane-toggle").style.getPropertyValue("--gs-pane-bottom"), 10);
    assert.ok(fx.win.innerHeight - bottom >= 0 && fx.win.innerHeight - bottom <= composer.top, `${width}px: the toggle and drawer end above the composer`);
    q(".gs-pane-toggle").click();
    assert.equal(q(".gs-pane").dataset.gsOpen, "true");
    assert.equal(q(".gs-pane").style.getPropertyValue("--gs-pane-bottom"), `${bottom}px`);
  }
  assert.ok(RAIL_WIDTH > 0);
});

test("mobile: a native pane that is a full-width sheet is the one host; nothing is reserved or covered twice", async () => {
  for (const width of [390]) {
    const fx = createFixture({ turns: 12, width, markup: "real", pane: { width, reserves: false } });
    const { q } = mount(fx);
    await fx.settle();
    assert.equal(visibleHosts(fx).length, 1, `${width}px`);
    assert.equal(q(".gs-pane").hidden, true);
    assert.equal(q(".gs-pane-toggle").hidden, true);
    assert.equal(fx.reserve(), 0);
    assert.equal(fx.doc.body.hasAttribute("data-gs-column"), false);
    // Closing the sheet brings back the toggle, never a second pane.
    fx.hidePane();
    fx.win.dispatchEvent(new fx.win.Event("resize"));
    await fx.settle();
    assert.equal(q(".gs-pane-toggle").hidden, false);
    assert.equal(q(".gs-pane").dataset.gsMode, "collapsed");
  }
});

test("detection is structural: disclosure-button titles, localized wrappers and an unlabeled region all work; unrelated panels do not", async () => {
  const buttons = `<div class="x"><section id="native-outputs"><button type="button" aria-expanded="true">Outputs<svg></svg></button><ul><li><a href="#o">Item</a></li></ul></section><section id="native-sources"><button type="button">Sources</button><ul><li><a href="#s">Source</a></li></ul></section></div>`;
  const fx = createFixture({ turns: 12, width: 1600, markup: "real", pane: { html: buttons } });
  const { q } = mount(fx);
  await fx.settle();
  const host = chatgptAdapter.nativeSummary(fx.doc);
  assert.ok(host && host.pane === fx.pane);
  assert.equal(host.outputs.head, outputs(fx).firstElementChild, "the disclosure sits in the Outputs title row");
  assert.equal(q(".gs-pane-slot").parentElement, fx.pane.firstElementChild);
  q(".gs-outputs-toggle").click();
  assert.equal(outputs(fx).dataset.gsCollapsed, "true");

  // A right-hand panel with other titles is not the summary pane.
  const other = createFixture({ turns: 12, width: 1600, markup: "real", pane: { html: `<div><section><h3>Details</h3><p>x</p></section></div>` } });
  mount(other);
  await other.settle();
  assert.equal(chatgptAdapter.nativeSummary(other.doc), null);
  assert.equal(visibleHosts(other).length, 1);
  assert.equal(other.doc.querySelector(".gs-pane").dataset.gsHost, "fallback");

  // Outputs whose list cannot be told apart from the title row is left alone rather than half-hidden.
  const flat = createFixture({ turns: 12, width: 1600, markup: "real", pane: { html: `<aside><h3>Outputs</h3><h3>Sources</h3></aside>` } });
  const m = mount(flat);
  await flat.settle();
  assert.equal(flat.doc.querySelector(".gs-outputs-toggle"), null);
  assert.equal(flat.doc.querySelectorAll("[data-gs-outputs]").length, 0);
  assert.equal(visibleHosts(flat).length, 1);
  m.stop();
});
