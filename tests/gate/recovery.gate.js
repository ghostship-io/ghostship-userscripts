// Gate (a), recovery: the built userscript on a page that shows ChatGPT's load-failure card presses ChatGPT's own
// "Try again" once and nothing else: no native Send/Stop click, no form submit, no network request. The cap and the
// backoff are covered with manual timers in tests/recovery.test.js; here the bundle runs with the real ones.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installPageGuards, runBundle } from "./harness.js";

const CARD = `<div id="card"><h2>Could not load this ChatGPT conversation</h2><button type="button" id="retry">Try again</button></div>`;
const TURN = '<article data-testid="conversation-turn-1"><div data-message-author-role="user">hi</div><button type="button" id="retry">Try again</button></article>';

function page(main) {
  const dom = new JSDOM(`<!doctype html><body><main id="main">${main}</main><form id="composer"><textarea id="prompt-textarea"></textarea></form></body>`, { url: "https://chatgpt.com/c/aaaa", pretendToBeVisual: true, runScripts: "outside-only" });
  return { dom, win: dom.window, doc: dom.window.document, main: dom.window.document.getElementById("main") };
}
const until = async (condition, ms = 4000) => {
  const start = Date.now();
  while (!condition() && Date.now() - start < ms) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(condition(), "condition never became true");
};

test("bundle: a load-failure card gets exactly one retry (then recovers), with no send, stop, submit or network request", async () => {
  const fx = page(CARD);
  const guards = installPageGuards(fx);
  let retries = 0;
  fx.doc.getElementById("retry").addEventListener("click", () => {
    retries++;
    fx.main.innerHTML = '<article data-testid="conversation-turn-1"><div data-message-author-role="user">hi</div></article>';
  });
  runBundle(fx);
  await until(() => retries === 1);
  await new Promise((resolve) => setTimeout(resolve, 1500)); // a second click would show here
  assert.equal(retries, 1);
  assert.deepEqual(guards.report(), { nativeClicks: [], formSubmits: 0, network: [] });
  assert.equal(fx.doc.querySelector("[data-gs-recovery]"), null);
  assert.equal(fx.win.__ghostshipUserscripts.diagnostics()["recovery.retry"], 1);
  fx.win.close();
});

test("bundle: a page with conversation turns is never retried, even with a per-message Try again on it", async () => {
  const fx = page(TURN);
  const guards = installPageGuards(fx);
  let clicks = 0;
  fx.doc.getElementById("retry").addEventListener("click", () => clicks++);
  runBundle(fx);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(clicks, 0);
  assert.deepEqual(guards.report(), { nativeClicks: [], formSubmits: 0, network: [] });
  fx.win.close();
});
