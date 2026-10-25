import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig, DEFAULTS } from "../src/core/config.js";
import { createScrollManager } from "../src/core/scroll-manager.js";
import { createObserverHub } from "../src/core/observers.js";
import { createDiagnostics } from "../src/core/diagnostics.js";
import { assertBackend, createNoopBackend } from "../src/core/virtualization.js";
import { buildPromptIndex, searchPrompts } from "../src/core/prompt-index.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { loadFixture, tick } from "./helpers.js";
import { JSDOM } from "jsdom";

test("config: defaults, invalid JSON and wrong types fall back", () => {
  assert.deepEqual(parseConfig(null), DEFAULTS);
  assert.deepEqual(parseConfig("{nope"), DEFAULTS);
  assert.equal(parseConfig('{"windowTurns":"x","dryRun":false}').windowTurns, 10);
  assert.equal(parseConfig('{"dryRun":false}').dryRun, false);
  assert.equal(parseConfig('{"windowTurns":0}').windowTurns, 10);
});

function scrollerFixture({ scrollTop = 0 } = {}) {
  const win = new JSDOM('<div id="s"><i id="a"></i></div>').window;
  const scroller = win.document.getElementById("s");
  const state = { top: scrollTop, anchorTop: 200 };
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => state.top, set: (v) => (state.top = v) });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 800, height: 800 });
  const anchor = win.document.getElementById("a");
  anchor.getBoundingClientRect = () => ({ top: state.anchorTop - state.top, bottom: state.anchorTop - state.top + 50 });
  return { scroller, anchor, state };
}

test("scroll manager: refuses unsolicited sources, accepts explicit navigation", () => {
  const { scroller, state } = scrollerFixture({ scrollTop: 100 });
  const diagnostics = createDiagnostics({ warn() {} });
  const scroll = createScrollManager({ scroller, diagnostics });
  for (const source of ["send", "stream", "render", "queue", "resize", "restore"]) {
    assert.equal(scroll.scrollTo(source, 0), false);
  }
  assert.equal(state.top, 100);
  scroller.scrollTop = 0; // page-initiated write
  assert.equal(state.top, 100);
  assert.equal(scroll.scrollTo("prompt-nav", 40), true);
  assert.equal(state.top, 40);
  assert.equal(diagnostics.snapshot()["scroll.refused.stream"], 1);
  assert.equal(diagnostics.snapshot()["scroll.blocked.scrollTop"], 1);
  scroll.dispose();
});

test("scroll manager: preserve keeps the anchor at the same viewport offset", () => {
  const { scroller, anchor, state } = scrollerFixture({ scrollTop: 100 });
  const scroll = createScrollManager({ scroller });
  const drift = scroll.preserve(anchor, () => { state.anchorTop += 300; /* turns inserted above */ });
  assert.equal(drift, 300);
  assert.equal(state.top, 400);
  scroll.dispose();
});

test("observer hub: enforces the budget and batches into one flush", async () => {
  const dom = await loadFixture();
  const { document, MutationObserver } = dom.window;
  const diagnostics = createDiagnostics({ warn() {} });
  const hub = createObserverHub({ max: 2, MutationObserverCtor: MutationObserver, schedule: (fn) => setTimeout(fn, 1), diagnostics });
  const seen = [];
  const off = hub.subscribe(document.body, (batch) => seen.push(batch.length));
  hub.subscribe(document.body, () => {});
  assert.throws(() => hub.subscribe(document.body, () => {}), /budget/);
  for (let i = 0; i < 5; i++) document.body.append(document.createElement("i"));
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(diagnostics.snapshot()["observer.flush"], 1);
  off();
  assert.equal(hub.size(), 1);
  hub.disposeAll();
  assert.equal(hub.size(), 0);
});

test("virtualization: backend contract", () => {
  assert.throws(() => assertBackend({}), /mount/);
  assert.equal(assertBackend(createNoopBackend()).name, "noop");
});

test("prompt index: chronological user prompts with preview and search", async () => {
  const dom = await loadFixture();
  const index = buildPromptIndex(dom.window.document, chatgptAdapter);
  assert.deepEqual(index.map((p) => p.id), ["conversation-turn-1", "conversation-turn-3"]);
  assert.equal(index[0].preview, "First prompt about apples");
  assert.deepEqual(searchPrompts(index, "PEARS").map((p) => p.turnIndex), [2]);
  assert.equal(searchPrompts(index, "  ").length, 2);
});
