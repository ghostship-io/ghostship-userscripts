import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig, DEFAULTS } from "../src/core/config.js";
import { createScrollManager } from "../src/core/scroll-manager.js";
import { createObserverHub } from "../src/core/observers.js";
import { createDiagnostics } from "../src/core/diagnostics.js";
import { computeWindow, assertBackend, createNoopBackend } from "../src/core/virtualization.js";
import { buildPromptIndex, searchPrompts } from "../src/core/prompt-index.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { loadFixture, tick } from "./helpers.js";

test("config: defaults, invalid JSON and wrong types fall back", () => {
  assert.deepEqual(parseConfig(null), DEFAULTS);
  assert.deepEqual(parseConfig("{nope"), DEFAULTS);
  assert.equal(parseConfig('{"windowTurns":"x","dryRun":false}').windowTurns, 10);
  assert.equal(parseConfig('{"dryRun":false}').dryRun, false);
  assert.equal(parseConfig('{"windowTurns":0}').windowTurns, 10);
});

test("scroll manager: refuses unsolicited sources, accepts explicit navigation", () => {
  const scroller = { scrollTop: 100 };
  const diagnostics = createDiagnostics({ warn() {} });
  const scroll = createScrollManager({ scroller, diagnostics });
  for (const source of ["send", "stream", "render", "queue", "resize", "restore"]) {
    assert.equal(scroll.scrollTo(source, 0), false);
  }
  assert.equal(scroller.scrollTop, 100);
  assert.equal(scroll.scrollTo("prompt-nav", 40), true);
  assert.equal(scroller.scrollTop, 40);
  assert.equal(diagnostics.snapshot()["scroll.refused.stream"], 1);
});

test("scroll manager: preserve keeps the anchor at the same viewport offset", () => {
  const scroller = { scrollTop: 500 };
  let top = 200;
  const anchor = { getBoundingClientRect: () => ({ top }) };
  const scroll = createScrollManager({ scroller });
  const drift = scroll.preserve(anchor, () => { top += 300; /* turns inserted above */ });
  assert.equal(drift, 300);
  assert.equal(scroller.scrollTop, 800);
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

test("virtualization: window math and backend contract", () => {
  assert.deepEqual(computeWindow(4, 3, 10), { start: 0, end: 4 });
  assert.deepEqual(computeWindow(100, 99, 10), { start: 90, end: 100 });
  assert.deepEqual(computeWindow(100, 50, 10), { start: 45, end: 55 });
  assert.deepEqual(computeWindow(100, 0, 10), { start: 0, end: 10 });
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
