import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/core/runtime.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { loadFixture, tick } from "./helpers.js";

test("runtime: active on the fixture, index follows DOM changes, dispose is clean", async () => {
  const dom = await loadFixture();
  const { window } = dom;
  const runtime = createRuntime({ win: window, adapter: chatgptAdapter });
  assert.equal(runtime.mode, "active");
  assert.equal(runtime.promptIndex.length, 2);
  const turn = window.document.createElement("article");
  turn.setAttribute("data-testid", "conversation-turn-5");
  turn.innerHTML = '<div data-message-author-role="user">Third prompt</div>';
  window.document.querySelector("[data-scroll-root]").append(turn);
  await tick(60);
  assert.equal(runtime.promptIndex.length, 3);
  assert.equal(runtime.observers.size(), 1);
  runtime.dispose();
  assert.equal(runtime.observers.size(), 0);
});

test("runtime: no composer falls back to safe mode without touching the page", async () => {
  const dom = await loadFixture();
  const { window } = dom;
  window.document.getElementById("prompt-textarea").removeAttribute("id");
  const warnings = [];
  window.console.warn = (m) => warnings.push(m);
  const before = window.document.documentElement.outerHTML;
  const runtime = createRuntime({ win: window, adapter: chatgptAdapter });
  assert.equal(runtime.mode, "safe");
  assert.equal(warnings.length, 1);
  assert.equal(window.document.documentElement.outerHTML, before);
  assert.equal(runtime.diagnostics.snapshot()["selfcheck.failed"], 1);
});

test("runtime: a composer without turns (new chat) runs composer-only, mounts the queue and leaves scrolling alone", async () => {
  const dom = await loadFixture();
  const { window } = dom;
  window.document.querySelectorAll("[data-testid],[data-message-author-role]").forEach((el) => { el.removeAttribute("data-testid"); el.removeAttribute("data-message-author-role"); });
  const mounted = [];
  const queueUi = () => {
    mounted.push("queue");
    return { dispose: () => mounted.push("disposed") };
  };
  const runtime = createRuntime({ win: window, adapter: chatgptAdapter, queueUi });
  assert.equal(runtime.mode, "composer-only");
  assert.deepEqual(mounted, ["queue"]);
  assert.deepEqual(runtime.promptIndex, []);
  assert.equal(runtime.diagnostics.snapshot()["selfcheck.failed"], undefined);
  runtime.dispose();
  assert.deepEqual(mounted, ["queue", "disposed"]);
});

test("runtime: disabled by config does nothing", async () => {
  const dom = await loadFixture();
  const runtime = createRuntime({ win: dom.window, adapter: chatgptAdapter, config: { enabled: false } });
  assert.equal(runtime.mode, "off");
});
