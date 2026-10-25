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

test("runtime: unrecognised layout falls back to safe mode without touching the page", async () => {
  const dom = await loadFixture();
  const { window } = dom;
  window.document.querySelectorAll("[data-testid]").forEach((el) => el.removeAttribute("data-testid"));
  const warnings = [];
  window.console.warn = (m) => warnings.push(m);
  const before = window.document.documentElement.outerHTML;
  const runtime = createRuntime({ win: window, adapter: chatgptAdapter });
  assert.equal(runtime.mode, "safe");
  assert.equal(warnings.length, 1);
  assert.equal(window.document.documentElement.outerHTML, before);
  assert.equal(runtime.diagnostics.snapshot()["selfcheck.failed"], 1);
});

test("runtime: disabled by config does nothing", async () => {
  const dom = await loadFixture();
  const runtime = createRuntime({ win: dom.window, adapter: chatgptAdapter, config: { enabled: false } });
  assert.equal(runtime.mode, "off");
});
