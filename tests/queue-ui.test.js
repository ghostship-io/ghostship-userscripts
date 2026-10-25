import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { createRuntime } from "../src/core/runtime.js";
import { DEFAULTS } from "../src/core/config.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { DryRunDispatcher } from "../src/chatgpt/queue/dispatch.js";
import { createQueueUi } from "../src/chatgpt/queue/controller.js";
import { CSS } from "../src/chatgpt/queue/view.js";
import { loadFixture } from "./helpers.js";
import { ManualClock, until } from "./queue-helpers.js";

async function mountUi({ form = false, dispatcher = new DryRunDispatcher() } = {}) {
  const dom = await loadFixture();
  const { window } = dom;
  if (form) {
    const area = window.document.querySelector("#prompt-textarea");
    const wrap = window.document.createElement("form");
    area.replaceWith(wrap);
    wrap.append(area);
  }
  const clock = new ManualClock();
  const ui = createQueueUi({
    win: window,
    adapter: chatgptAdapter,
    dispatcher,
    indexedDB: new IDBFactory(),
    clock,
    tabId: "ui-tab",
    pollMs: 0,
  });
  await ui.ready;
  await ui.settled();
  const $ = (sel) => ui.root.querySelector(sel);
  const $$ = (sel) => [...ui.root.querySelectorAll(sel)];
  const key = (k) => ui.root.querySelector(`[data-gs-key="${k}"]`);
  const click = async (k) => {
    key(k).click();
    await ui.settled();
  };
  const add = async (text) => {
    key("add:input").value = text;
    key("add:input").dispatchEvent(new window.Event("input", { bubbles: true }));
    await click("add:submit");
  };
  const rows = () => $$(".gs-q-item").map((li) => li.querySelector(".gs-q-text")?.textContent ?? li.querySelector("textarea").value);
  const ids = () => $$(".gs-q-item").map((li) => li.dataset.id);
  const press = async (target, init) => {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    await ui.settled();
  };
  return { dom, window, doc: window.document, ui, clock, dispatcher, $, $$, key, click, add, rows, ids, press };
}

test("queue ui: panel sits directly above the composer and leaves the composer untouched, with no overflow control", async () => {
  // Defect: panel inserted elsewhere / composer mutated / a hidden "…" menu hiding core actions.
  for (const form of [false, true]) {
    const before = await loadFixture();
    const composerBefore = before.window.document.querySelector("#prompt-textarea").outerHTML;
    const t = await mountUi({ form });
    const composer = chatgptAdapter.composer(t.doc);
    assert.equal(composer.previousElementSibling, t.ui.root);
    assert.equal(t.doc.querySelector("#prompt-textarea").outerHTML, composerBefore);
    assert.equal(composer.hasAttribute("style"), false);
    const labels = t.$$("button").map((b) => `${b.textContent} ${b.getAttribute("aria-label") ?? ""}`);
    assert.equal(labels.filter((l) => l.includes("Interrupt & Send Next")).length, 1);
    assert.ok(!labels.some((l) => /[…⋯⋮]|\.\.\.|more|menu/i.test(l)), `unexpected overflow control: ${labels}`);
    assert.match(t.$(".gs-q-badge").textContent, /Dry run/);
    t.ui.dispose();
    assert.equal(t.doc.querySelector("[data-gs-queue]"), null);
  }
});

test("queue ui: add, edit, reorder and remove by keyboard persist through the engine", async () => {
  // Defect: UI state diverging from the durable queue, or an action unreachable without a pointer.
  const t = await mountUi();
  await t.add("first");
  await t.add("second");
  await t.add("third");
  assert.deepEqual(t.rows(), ["first", "second", "third"]);
  assert.equal(t.key("add:input").value, "");

  const [a, b, c] = t.ids();
  await t.press(t.key(`${c}:up`), { key: "ArrowUp", altKey: true });
  assert.deepEqual(t.rows(), ["first", "third", "second"]);
  assert.equal(t.doc.activeElement.dataset.gsKey, `${c}:up`, "focus follows the moved item");

  await t.click(`${a}:edit`);
  const area = t.key(`${a}:edit`);
  area.value = "first, edited";
  area.dispatchEvent(new t.window.Event("input", { bubbles: true }));
  await t.press(area, { key: "Escape" });
  assert.deepEqual(t.rows(), ["first", "third", "second"], "Escape cancels the edit");
  await t.click(`${a}:edit`);
  t.key(`${a}:edit`).value = "first, edited";
  await t.press(t.key(`${a}:edit`), { key: "Enter", ctrlKey: true });
  assert.deepEqual(t.rows(), ["first, edited", "third", "second"]);

  await t.click(`${b}:remove`);
  assert.deepEqual(t.rows(), ["first, edited", "third"]);
  assert.equal(t.$(".gs-q-status").textContent, "2 queued");
});

test("queue ui: Interrupt & Send Next is disabled when empty, while the stop is in flight, and behind an unresolved message", async () => {
  // Defect: a double-press during a stop, or sending past an item that needs attention.
  const dispatcher = new DryRunDispatcher("generating");
  const t = await mountUi({ dispatcher });
  assert.equal(t.key("head:interrupt").disabled, true, "empty queue");
  await t.add("go");
  assert.equal(t.key("head:interrupt").disabled, false);

  dispatcher.stopScript = ["hang"];
  t.key("head:interrupt").click();
  assert.equal(t.key("head:interrupt").disabled, true, "disabled synchronously on press");
  assert.equal(t.key("head:interrupt").getAttribute("aria-busy"), "true");
  await until(() => dispatcher.log.length === 1);
  t.clock.advance(10_000);
  await t.ui.settled();
  assert.equal(dispatcher.log.filter((e) => e.type === "stop").length, 1);
  assert.equal(t.key("head:interrupt").disabled, false, "re-enabled once the stop resolved");
  assert.equal(t.key("head:interrupt").hasAttribute("aria-busy"), false);

  dispatcher.state = "idle";
  dispatcher.submitScript = [{ kind: "uncertain", code: "no-ack", message: "No acknowledgment." }];
  await t.click("head:interrupt");
  assert.match(t.$(".gs-q-chip").textContent, /Needs review/);
  assert.equal(t.key("head:interrupt").disabled, true, "head needs review");
  assert.match(t.key("head:interrupt").title, /Needs review/);
});

test("queue ui: a confirmed stop sends exactly the next message, in order, through the dry-run dispatcher", async () => {
  // Defect: submit before stop, more than one message sent, or a live send in dry-run mode.
  const dispatcher = new DryRunDispatcher("generating");
  const t = await mountUi({ dispatcher });
  await t.add("one");
  await t.add("two");
  const [first] = t.ids();
  await t.click("head:interrupt");
  assert.deepEqual(dispatcher.actions(), ["stop", `submit:${first}`]);
  assert.deepEqual(t.rows(), ["two"]);
  assert.match(t.$(".gs-q-status").textContent, /1 queued · 1 sent/);
  assert.equal(t.$(".gs-q-error"), null);
});

test("queue ui: interrupt failures are surfaced with an action and nothing is sent", async () => {
  // Defect: a failed or ambiguous stop silently swallowed, or the item sent anyway.
  const cases = [
    [{ kind: "failed", code: "stop-rejected", message: "The Stop control was not found." }, /Stop control was not found/],
    [{ kind: "ambiguous", code: "stop-unclear", message: "Could not tell if the response stopped." }, /Could not tell/],
    [new Error("boom"), /boom/],
  ];
  for (const [script, pattern] of cases) {
    const dispatcher = new DryRunDispatcher("generating");
    const t = await mountUi({ dispatcher });
    await t.add("keep me");
    dispatcher.stopScript = [script];
    await t.click("head:interrupt");
    const alert = t.$('[role="alert"]');
    assert.match(alert.textContent, pattern);
    assert.deepEqual(dispatcher.actions(), ["stop"]);
    assert.deepEqual(t.rows(), ["keep me"]);
    assert.match(t.$(".gs-q-chip").textContent, /Queued/);
    assert.match(t.$(".gs-q-note").textContent, /Nothing was sent|try again|check/i);
    assert.equal(t.key("head:interrupt").disabled, false, "the user can try again");
  }
});

test("queue ui: pause stops the background drain and resume restores it", async () => {
  // Defect: pause being cosmetic, or draining while paused.
  const dispatcher = new DryRunDispatcher();
  const t = await mountUi({ dispatcher });
  await t.add("queued");
  await t.click("head:pause");
  assert.equal(t.key("head:pause").textContent, "Resume");
  assert.match(t.$(".gs-q-status").textContent, /paused/);
  await t.ui.tick();
  assert.deepEqual(dispatcher.log, []);
  await t.click("head:pause");
  assert.equal(t.key("head:pause").textContent, "Pause");
  await t.ui.tick();
  assert.equal(dispatcher.log.length, 1);
});

test("queue ui: the panel is put back above the composer if the page re-renders it away", async () => {
  // Defect: the queue disappearing after a React re-render of the composer area.
  const t = await mountUi({ form: true });
  t.ui.root.remove();
  await t.ui.tick();
  assert.equal(chatgptAdapter.composer(t.doc).previousElementSibling, t.ui.root);
});

test("queue ui: without a composer the page is left untouched", async () => {
  // Defect: mounting into an unrecognised layout.
  const dom = await loadFixture();
  dom.window.document.querySelector("#prompt-textarea").remove();
  const before = dom.window.document.documentElement.outerHTML;
  const ui = createQueueUi({ win: dom.window, adapter: chatgptAdapter, dispatcher: new DryRunDispatcher(), indexedDB: new IDBFactory(), pollMs: 0 });
  assert.equal(ui.mounted, false);
  assert.equal(dom.window.document.documentElement.outerHTML, before);
});

test("queue ui: runtime mounts and disposes the panel, and a queue failure never disables the rest", async () => {
  // Defect: queue errors taking down the runtime, or leaking the panel after dispose.
  const dom = await loadFixture();
  const warnings = [];
  dom.window.console.warn = (m) => warnings.push(m);
  const queueUi = ({ win, adapter, diagnostics }) =>
    createQueueUi({ win, adapter, diagnostics, dispatcher: new DryRunDispatcher(), indexedDB: new IDBFactory(), pollMs: 0 });
  const runtime = createRuntime({ win: dom.window, adapter: chatgptAdapter, queueUi, config: DEFAULTS });
  assert.equal(runtime.mode, "active");
  assert.ok(dom.window.document.querySelector("[data-gs-queue]"));
  runtime.dispose();
  assert.equal(dom.window.document.querySelector("[data-gs-queue]"), null);

  const broken = await loadFixture();
  broken.window.console.warn = (m) => warnings.push(m);
  const survivor = createRuntime({ win: broken.window, adapter: chatgptAdapter, queueUi: () => { throw new Error("nope"); }, config: DEFAULTS });
  assert.equal(survivor.mode, "active");
  assert.equal(survivor.diagnostics.snapshot()["queue.mount.failed"], 1);
});

test("queue ui: stylesheet declares no fixed pixel widths, so narrow screens cannot overflow horizontally", () => {
  // Defect: a fixed-width rule forcing horizontal overflow on mobile layouts (jsdom has no layout engine).
  assert.doesNotMatch(CSS, /(?<![-\w])(min-)?width:\s*\d+px/);
  assert.match(CSS, /max-width:100%/);
  assert.match(CSS, /@media \(max-width:480px\)/);
});
