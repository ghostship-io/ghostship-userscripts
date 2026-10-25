import test from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./virtualization-fixture.js";
import { createRuntime } from "../src/core/runtime.js";
import { DEFAULTS } from "../src/core/config.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createTurnBackend } from "../src/chatgpt/virtualization/backend.js";
import { createRail } from "../src/chatgpt/rail/rail.js";
import { createPanePrefs, createRailStateStore } from "../src/chatgpt/rail/rail-state.js";
import { MIN_CONTENT, PANEL_GAP, PANEL_WIDTH } from "../src/chatgpt/rail/rail-layout.js";

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
const NEED = PANEL_WIDTH + 2 * PANEL_GAP;
const panel = (fx, name) => fx.doc.querySelector(`.gs-panel[data-gs-panel="${name}"]`);
const varOf = (fx, name, prop) => parseFloat(panel(fx, name).style.getPropertyValue(prop));
const outputs = (fx) => fx.doc.getElementById("native-outputs");
const sources = (fx) => fx.doc.getElementById("native-sources");
const norm = (html) => html.replace(/style="([^"]*)"/g, (_, v) => `style="${v.replace(/\s+/g, "").replace(/;$/, "")}"`);
const snapshot = (el) => [el, ...el.querySelectorAll("*")];
const resize = async (fx) => {
  fx.win.dispatchEvent(new fx.win.Event("resize"));
  await fx.settle();
};

test("beside ChatGPT's own side pane the panels sit in the space it leaves and the native pane is untouched except for the Outputs disclosure", async () => {
  const fx = createFixture({ turns: 30, width: 1700, markup: "real", pane: {}, header: true });
  const nodes = snapshot(fx.pane);
  const records = [];
  const mo = new fx.win.MutationObserver((r) => records.push(...r));
  mo.observe(fx.pane, { childList: true, subtree: true, attributes: true, characterData: true });
  const { q } = mount(fx);
  await fx.settle();
  records.push(...mo.takeRecords());
  mo.disconnect();

  assert.equal(chatgptAdapter.nativeSummary(fx.doc).pane, fx.pane);
  assert.equal(fx.pane.querySelector(".gs-panel"), null, "our panels are never inside the native pane");
  assert.equal(fx.doc.querySelectorAll('.gs-panel[data-gs-panel="minimap"]').length, 1, "one minimap panel, no duplicate");
  // The minimap is pinned top-right of the space left of the native pane; nothing overlaps it.
  assert.equal(varOf(fx, "minimap", "--gs-right"), fx.paneWidth() + PANEL_GAP);
  const { turn, composer } = rects(fx);
  const edge = fx.win.innerWidth - fx.paneWidth();
  assert.ok(turn.right <= edge - NEED && composer.right <= edge - NEED, `conversation ends at ${turn.right}, the minimap starts at ${edge - NEED}`);
  assert.ok(turn.left >= NEED, "and clears the prompts panel");
  // Nothing native was moved, removed or re-created; the only native writes are our data attributes and button.
  assert.ok(nodes.every((n) => n.isConnected && fx.pane.contains(n)));
  const native = records.filter((r) => !r.target.closest("[data-gs-ui]"));
  assert.deepEqual(native.flatMap((r) => [...r.removedNodes]), [], "no native node removed");
  for (const r of native) {
    if (r.type === "attributes") assert.match(r.attributeName, /^data-gs-/, `native attribute ${r.attributeName} untouched`);
    if (r.type === "childList") assert.ok([...r.addedNodes].every((n) => n.matches?.("[data-gs-ui]")), "only our own nodes are added");
  }
  assert.equal(sources(fx).querySelector("a").getAttribute("href"), "#src-1", "Sources intact");
  assert.equal(sources(fx).hasAttribute("data-gs-collapsed"), false, "Sources is never collapsed by us");
  assert.ok(q(".gs-outputs-toggle"), "Outputs got its disclosure");
});

test("Outputs collapses and expands repeatedly; Sources, the minimap and the prompt list stay usable", async () => {
  const fx = createFixture({ turns: 40, width: 1700, markup: "real", pane: {} });
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
    assert.equal(panel(fx, "minimap").hidden || panel(fx, "prompts").hidden, false, "both panels stay");
    assert.equal(list.scrollTop, bottom, "the newest prompt stays bottom-aligned");
    assert.equal(items(fx).at(-1).getAttribute("aria-current"), "true");
  }
  toggle.click();
  await fx.settle();
  assert.equal(outputs(fx).dataset.gsCollapsed, "true");
  items(fx)[0].click();
  await fx.settle();
  assert.equal(fx.rawTop(), 0);
  assert.equal(runtime.scroll.stats.unexpected, 0);
  const css = fx.doc.getElementById("gs-pane-style").textContent;
  assert.match(css, /\[data-gs-outputs\]\[data-gs-collapsed="true"\]>:not\(\[data-gs-outputs-head\]\)\{display:none\}/);
  assert.equal(outputs(fx).querySelector(".sec-head").hasAttribute("data-gs-outputs-head"), true);
});

test("a pane without Outputs still works beside the panels and Sources is untouched", async () => {
  const fx = createFixture({ turns: 12, width: 1700, markup: "real", pane: { outputs: false } });
  const { q } = mount(fx);
  await fx.settle();
  assert.equal(q(".gs-outputs-toggle"), null, "no fake Outputs, no disclosure for nothing");
  assert.equal(sources(fx).querySelector("a").getAttribute("href"), "#src-1");
  assert.equal(fx.doc.querySelectorAll("[data-gs-outputs]").length, 0);
  assert.equal(varOf(fx, "minimap", "--gs-right"), fx.paneWidth() + PANEL_GAP);
});

test("with a side pane open at wide, medium and narrow widths: no collision with the pane, the conversation or the composer", async () => {
  for (const theme of ["light", "dark"]) {
    for (const [width, nav] of [[2200, 0], [1900, 52], [1700, 0], [1500, 52], [1300, 0], [1000, 0], [390, 0]]) {
      const fx = createFixture({ turns: 20, width, nav, markup: "real", pane: width > 600 ? {} : { width, reserves: false }, header: true });
      fx.doc.documentElement.className = theme;
      mount(fx);
      await fx.settle();
      const label = `${theme}, ${width}px wide, ${nav}px navigation, side pane open`;
      const left = fx.win.innerWidth - (width > 600 ? fx.paneWidth() : 0);
      const { turn, composer } = rects(fx);
      const shown = [!panel(fx, "minimap").hidden, !panel(fx, "prompts").hidden];
      assert.ok(turn.right <= left && composer.right <= left, `${label}: conversation ${turn.right}, composer ${composer.right}, pane ${left}`);
      if (shown[0]) assert.ok(turn.right <= left - NEED && composer.right <= left - NEED, `${label}: minimap clear of the conversation`);
      if (shown[1]) assert.ok(turn.left >= nav + NEED && composer.left >= nav + NEED, `${label}: prompts clear of the conversation`);
      if (shown[0] || shown[1]) assert.ok(turn.width >= MIN_CONTENT, `${label}: conversation keeps ${turn.width}px`);
      else assert.equal(fx.reserve() + fx.reserveLeft(), 0, `${label}: drawers reserve nothing`);
      if (shown[0]) assert.equal(varOf(fx, "minimap", "--gs-right"), width > 600 ? fx.paneWidth() + PANEL_GAP : PANEL_GAP, label);
      assert.equal(fx.doc.querySelectorAll(".gs-hbtns").length, 1, `${label}: one set of header buttons`);
    }
  }
});

test("a native pane that floats over the right edge is cleared once, by what it covers plus the minimap", async () => {
  for (const [width, nav] of [[1900, 0], [1700, 52], [1600, 0]]) {
    const fx = createFixture({ turns: 20, width, nav, markup: "real", pane: { reserves: false } });
    mount(fx);
    await fx.settle();
    const label = `${width}px wide, ${nav}px navigation`;
    const left = fx.win.innerWidth - fx.paneWidth();
    const { turn, composer } = rects(fx);
    assert.ok(turn.right <= left - NEED && composer.right <= left - NEED, `${label}: conversation ${turn.right}, composer ${composer.right}, minimap starts ${left - NEED}`);
    assert.equal(composer.left, turn.left, `${label}: composer and conversation shift together`);
    assert.equal(varOf(fx, "minimap", "--gs-right"), fx.paneWidth() + PANEL_GAP, `${label}: the minimap sits left of the floating pane`);
  }
});

test("the native pane appearing, closing or being hidden re-anchors the minimap; nothing doubles", async () => {
  const fx = createFixture({ turns: 20, width: 1700, markup: "real", header: true });
  mount(fx);
  await fx.settle();
  assert.equal(varOf(fx, "minimap", "--gs-right"), PANEL_GAP, "no native pane: the corner");
  const bare = [fx.reserve(), fx.reserveLeft()];

  fx.mountPane();
  await resize(fx);
  assert.equal(varOf(fx, "minimap", "--gs-right"), fx.paneWidth() + PANEL_GAP, "beside the native pane");
  assert.equal(fx.doc.querySelectorAll(".gs-panel").length, 2);
  assert.ok(rects(fx).turn.right <= fx.win.innerWidth - fx.paneWidth() - NEED);

  fx.hidePane(); // mounted but closed: no box
  await resize(fx);
  assert.equal(varOf(fx, "minimap", "--gs-right"), PANEL_GAP);
  fx.hidePane(false);
  await resize(fx);
  assert.equal(varOf(fx, "minimap", "--gs-right"), fx.paneWidth() + PANEL_GAP);

  fx.unmountPane();
  await resize(fx);
  assert.equal(varOf(fx, "minimap", "--gs-right"), PANEL_GAP);
  assert.deepEqual([fx.reserve(), fx.reserveLeft()], bare, "the same reservation as before the pane");
  assert.equal(fx.doc.querySelectorAll(".gs-panel").length, 2);
  assert.equal(fx.doc.querySelectorAll(".gs-hbtns").length, 1);
});

test("a pane that mounts without any resize or mutation hint is found by the trailing scan", async () => {
  const fx = createFixture({ turns: 20, width: 1700, markup: "real" });
  mount(fx);
  await fx.settle();
  assert.equal(varOf(fx, "minimap", "--gs-right"), PANEL_GAP);
  fx.mountPane();
  fx.thread.append(fx.doc.createComment("render")); // an ordinary refresh, inside the scan throttle
  await fx.settle();
  assert.equal(varOf(fx, "minimap", "--gs-right"), fx.paneWidth() + PANEL_GAP, "the trailing scan caught it");
});

test("headings inside the conversation never count as the native pane", async () => {
  const fx = createFixture({ turns: 12, width: 1700, markup: "real" });
  const reply = fx.thread.lastElementChild.querySelector("[data-conversation-role]");
  reply.insertAdjacentHTML("beforeend", "<h3>Sources</h3><h3>Outputs</h3>");
  mount(fx);
  await fx.settle();
  assert.equal(chatgptAdapter.nativeSummary(fx.doc), null);
  assert.equal(varOf(fx, "minimap", "--gs-right"), PANEL_GAP);
});

test("Outputs state is per conversation, survives A -> B -> A and a reload, and never leaks", async () => {
  const fx = createFixture({ turns: 20, width: 1700, markup: "real", pane: {} });
  const store = createRailStateStore();
  const prefs = createPanePrefs(fx.win.localStorage);
  const visit = (path) => fx.win.history.pushState({}, "", path);

  let ui = mount(fx, { store, prefs });
  await fx.settle();
  ui.q(".gs-outputs-toggle").click();
  assert.equal(outputs(fx).dataset.gsCollapsed, "true");
  ui.stop();
  assert.equal(outputs(fx).hasAttribute("data-gs-outputs"), false, "dispose releases the native section");
  assert.equal(fx.pane.querySelector("[data-gs-ui]"), null);

  visit("/c/conversation-b");
  ui = mount(fx, { store, prefs });
  await fx.settle();
  assert.equal(outputs(fx).dataset.gsCollapsed, "false", "B starts expanded");
  ui.stop();

  visit("/c/fixture");
  ui = mount(fx, { store, prefs });
  await fx.settle();
  assert.equal(outputs(fx).dataset.gsCollapsed, "true", "A is back as it was");
  ui.stop();

  // A reload keeps the in-memory store out of it: only the stored choice comes back.
  ui = mount(fx, { store: createRailStateStore(), prefs: createPanePrefs(fx.win.localStorage) });
  await fx.settle();
  assert.equal(outputs(fx).dataset.gsCollapsed, "true");
  assert.doesNotMatch(fx.win.localStorage.getItem("gs.pane.prefs"), /Prompt|about/, "no prompt text in storage");
  ui.stop();
});

test("prefs are bounded, per conversation, and tolerate bad storage", () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  const prefs = createPanePrefs(storage, { max: 3 });
  for (const id of ["a", "b", "c", "d"]) prefs.set(id, { outputs: id === "a" });
  assert.equal(prefs.get("a"), null, "oldest dropped");
  assert.deepEqual(prefs.get("d"), { outputs: false });
  prefs.set("new", { outputs: true });
  assert.equal(prefs.get("new"), null);
  data.set("gs.pane.prefs", "{not json");
  assert.equal(prefs.get("b"), null);
  assert.equal(createPanePrefs(null).get("a"), null);
});

test("ChatGPT re-rendering its pane: the disclosure follows, nothing doubles", async () => {
  const fx = createFixture({ turns: 20, width: 1700, markup: "real", pane: {} });
  const { q } = mount(fx);
  await fx.settle();
  q(".gs-outputs-toggle").click();
  fx.mountPane(); // React renders a fresh pane (all new nodes), the collapsed state is still ours
  await resize(fx);
  assert.equal(fx.doc.querySelectorAll(".gs-outputs-toggle").length, 1);
  assert.equal(outputs(fx).dataset.gsCollapsed, "true");
  assert.equal(fx.doc.querySelectorAll(".gs-panel").length, 2);

  // Only the Outputs section re-rendered.
  const old = outputs(fx);
  const fresh = old.cloneNode(true);
  fresh.querySelectorAll("[data-gs-ui],[data-gs-outputs-head]").forEach((n) => (n.matches("[data-gs-ui]") ? n.remove() : n.removeAttribute("data-gs-outputs-head")));
  fresh.removeAttribute("data-gs-outputs");
  fresh.removeAttribute("data-gs-collapsed");
  old.replaceWith(fresh);
  await resize(fx);
  assert.equal(fx.doc.querySelectorAll(".gs-outputs-toggle").length, 1);
  assert.equal(outputs(fx), fresh);
  assert.equal(fresh.dataset.gsCollapsed, "true");
  assert.equal(old.hasAttribute("data-gs-outputs"), false, "the detached section is released");
});

test("the panels' own controls work beside a native pane: keyboard, pointer and the disclosure", async () => {
  const fx = createFixture({ turns: 40, width: 1700, markup: "real", pane: {} });
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
  let reached = false; // the click is ours alone: the native title row's handlers never see it
  outputs(fx).querySelector(".sec-head").addEventListener("click", () => (reached = true));
  toggle.click();
  assert.equal(reached, false);
});

test("idle with a native pane: no DOM writes, no extra observers, no polling", async () => {
  const bare = createFixture({ turns: 20, width: 1700, markup: "real" });
  const base = mount(bare);
  await bare.settle();
  const baseline = base.runtime.observers.size();

  const fx = createFixture({ turns: 20, width: 1700, markup: "real", pane: {}, header: true });
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

test("dispose leaves ChatGPT's pane, its header and the page exactly as they were", async () => {
  const fx = createFixture({ turns: 20, width: 1700, markup: "real", pane: { reserves: false }, header: true });
  const before = fx.doc.documentElement.outerHTML;
  const ui = mount(fx);
  await fx.settle();
  ui.q(".gs-outputs-toggle").click();
  assert.notEqual(fx.doc.documentElement.outerHTML, before);
  ui.stop();
  assert.equal(norm(fx.doc.documentElement.outerHTML), norm(before));
});

test("mobile: a native full-width sheet is the only thing shown; our panels stay drawers behind their header buttons", async () => {
  const fx = createFixture({ turns: 12, width: 390, markup: "real", pane: { width: 390, reserves: false }, header: true });
  mount(fx);
  await fx.settle();
  assert.equal(panel(fx, "minimap").hidden && panel(fx, "prompts").hidden, true);
  assert.equal(fx.reserve() + fx.reserveLeft(), 0);
  assert.equal(fx.doc.body.hasAttribute("data-gs-column"), false);
});

test("detection is structural: disclosure-button titles and unlabeled regions work; unrelated panels do not", async () => {
  const buttons = `<div class="x"><section id="native-outputs"><button type="button" aria-expanded="true">Outputs<svg></svg></button><ul><li><a href="#o">Item</a></li></ul></section><section id="native-sources"><button type="button">Sources</button><ul><li><a href="#s">Source</a></li></ul></section></div>`;
  const fx = createFixture({ turns: 12, width: 1700, markup: "real", pane: { html: buttons } });
  const { q } = mount(fx);
  await fx.settle();
  const host = chatgptAdapter.nativeSummary(fx.doc);
  assert.ok(host && host.pane === fx.pane);
  assert.equal(host.outputs.head, outputs(fx).firstElementChild, "the disclosure sits in the Outputs title row");
  q(".gs-outputs-toggle").click();
  assert.equal(outputs(fx).dataset.gsCollapsed, "true");

  const other = createFixture({ turns: 12, width: 1700, markup: "real", pane: { html: `<div><section><h3>Details</h3><p>x</p></section></div>` } });
  mount(other);
  await other.settle();
  assert.equal(chatgptAdapter.nativeSummary(other.doc), null);

  const flat = createFixture({ turns: 12, width: 1700, markup: "real", pane: { html: `<aside><h3>Outputs</h3><h3>Sources</h3></aside>` } });
  const m = mount(flat);
  await flat.settle();
  assert.equal(flat.doc.querySelector(".gs-outputs-toggle"), null, "Outputs whose list cannot be told apart from its title row is left alone");
  assert.equal(flat.doc.querySelectorAll("[data-gs-outputs]").length, 0);
  m.stop();
});
