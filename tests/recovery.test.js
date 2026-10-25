// Recovery from ChatGPT's "Could not load this ChatGPT conversation" card: detect it, press ChatGPT's own
// "Try again" a bounded number of times, never while the owner types, say so quietly when it does not work.
// The page is a fixture; nothing here touches the network or chatgpt.com.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createRecovery } from "../src/chatgpt/recovery.js";
import { createDiagnostics } from "../src/core/diagnostics.js";
import { manualTimers } from "./helpers.js";
import { settle } from "./queue-helpers.js";

const CARD = `<div id="card" data-x="1"><h2>Could not load this ChatGPT conversation</h2><a href="#" role="button" id="retry">Try again</a></div>`;

function page({ card = true, url = "https://chatgpt.com/c/aaaa" } = {}) {
  const dom = new JSDOM(`<!doctype html><body><main id="main">${card ? CARD : ""}</main><form id="composer"><textarea id="prompt-textarea"></textarea></form><nav>nav</nav></body>`, { url, pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const log = { retryClicks: 0, sendClicks: 0 };
  const wire = () => {
    const retry = doc.getElementById("retry");
    retry?.addEventListener("click", (event) => {
      event.preventDefault();
      log.retryClicks++;
      page.onRetry?.();
    });
  };
  const page = {
    window, doc, log, onRetry: null,
    showCard() { doc.getElementById("main").innerHTML = CARD; wire(); },
    hideCard() { doc.getElementById("main").innerHTML = '<article data-testid="conversation-turn-1"><div data-message-author-role="user">hi</div></article>'; },
    navigate(path) { window.history.pushState({}, "", path); },
  };
  wire();
  return page;
}

function mount(p, options = {}) {
  const timers = manualTimers();
  const diagnostics = createDiagnostics(p.window.console);
  const recovery = createRecovery({ win: p.window, adapter: chatgptAdapter, diagnostics, timers, options });
  const advance = async (ms) => {
    await settle(3);
    timers.advance(ms);
    await settle(3);
  };
  return { recovery, timers, diagnostics, advance, counts: () => diagnostics.snapshot() };
}

test("the adapter finds the card and its Try again control, and nothing else", () => {
  // Defect: clicking a per-message "Try again", or matching on a class name that ChatGPT changes.
  const p = page();
  const found = chatgptAdapter.loadError(p.doc);
  assert.equal(found.control.id, "retry");
  assert.equal(found.card.id, "card");

  const inTurn = page({ card: false });
  inTurn.doc.getElementById("main").innerHTML = `<article data-testid="conversation-turn-1"><div data-message-author-role="assistant">x</div><button>Try again</button></article>`;
  assert.equal(chatgptAdapter.loadError(inTurn.doc), null, "a control inside a turn never counts");

  const elsewhere = page({ card: false });
  elsewhere.doc.getElementById("main").innerHTML = `<div><p>Something else went wrong</p><button>Try again</button></div>`;
  assert.equal(chatgptAdapter.loadError(elsewhere.doc), null, "the fixed failure message is required");

  const withTurns = page();
  withTurns.doc.getElementById("main").insertAdjacentHTML("beforeend", `<article data-testid="conversation-turn-1"></article>`);
  assert.equal(chatgptAdapter.loadError(withTurns.doc), null, "a page with turns is not the failure page");
});

test("error card -> one retry -> recovered: exactly one click, no status line", async () => {
  // Defect: retry storms, or a status line shown for a failure that recovered.
  const p = page();
  const t = mount(p);
  p.onRetry = () => p.hideCard();
  assert.equal(t.recovery.phase, "waiting");
  await t.advance(800);
  assert.equal(p.log.retryClicks, 1);
  await t.advance(600); // the page change is noticed on the next debounced pass
  assert.equal(t.recovery.phase, "idle", "the card went away: recovered");
  assert.equal(t.counts()["recovery.recovered"], 1);
  assert.equal(p.doc.querySelector("[data-gs-recovery]"), null);
  await t.advance(60_000);
  assert.equal(p.log.retryClicks, 1);
  t.recovery.dispose();
});

test("repeated failure stops after three attempts with a bounded backoff, then shows a quiet status line and never clicks again", async () => {
  // Defect: an endless retry/reload loop on a conversation that cannot load.
  const p = page();
  const t = mount(p);
  await t.advance(799);
  assert.equal(p.log.retryClicks, 0, "waits before the first retry");
  await t.advance(1);
  assert.equal(p.log.retryClicks, 1);
  await t.advance(6000 + 3999);
  assert.equal(p.log.retryClicks, 1, "second attempt only after the verify window and the backoff");
  await t.advance(1);
  assert.equal(p.log.retryClicks, 2);
  await t.advance(6000 + 12000);
  assert.equal(p.log.retryClicks, 3);
  await t.advance(6000);
  assert.equal(t.recovery.phase, "gave-up");
  const status = p.doc.querySelector("[data-gs-recovery]");
  assert.match(status.textContent, /after 3 tries/);
  assert.doesNotMatch(status.textContent, /\bnull\b|\bundefined\b/);
  await t.advance(3_600_000);
  assert.equal(p.log.retryClicks, 3, "the cap holds for the rest of the visit");
  assert.equal(t.counts()["recovery.gave-up"], 1);
  t.recovery.dispose();
  assert.equal(p.doc.querySelector("[data-gs-recovery]"), null, "dispose removes the status line");
});

test("a retry that brings the card back counts toward the cap; a later success clears the budget use", async () => {
  // Defect: losing count when the card re-renders between attempts.
  const p = page();
  const t = mount(p);
  p.onRetry = () => {
    if (p.log.retryClicks === 2) p.hideCard();
    else p.showCard(); // ChatGPT fails again and redraws the card
  };
  await t.advance(800);
  await t.advance(6000 + 4000);
  assert.equal(p.log.retryClicks, 2);
  await t.advance(600);
  assert.equal(t.recovery.phase, "idle");
  assert.equal(t.counts()["recovery.recovered"], 1);
  t.recovery.dispose();
});

test("never while the owner is typing: a recent key or text in the focused composer defers the retry without using an attempt", async () => {
  // Defect: stealing focus or interrupting a prompt being typed.
  const p = page();
  const t = mount(p);
  const input = p.doc.getElementById("prompt-textarea");
  input.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "a", bubbles: true }));
  await t.advance(800);
  assert.equal(p.log.retryClicks, 0, "typed a moment ago");
  assert.equal(t.recovery.attempts, 0);
  await t.advance(3500);
  assert.equal(p.log.retryClicks, 1);

  const q = page();
  const u = mount(q);
  const box = q.doc.getElementById("prompt-textarea");
  box.focus();
  box.value = "half a thought";
  await u.advance(30_000);
  assert.equal(q.log.retryClicks, 0, "text in the focused composer holds it off indefinitely");
  assert.equal(u.recovery.attempts, 0);
  box.value = "";
  await u.advance(2000);
  assert.equal(q.log.retryClicks, 1);
  t.recovery.dispose();
  u.recovery.dispose();
});

test("each route visit has its own budget; leaving the conversation drops the status line and any pending retry", async () => {
  // Defect: a conversation that failed once staying 'given up' after navigating away and back.
  const p = page();
  const t = mount(p);
  await t.advance(800 + 6000 + 4000 + 6000 + 12000 + 6000);
  assert.equal(p.log.retryClicks, 3);
  assert.equal(t.recovery.phase, "gave-up");
  p.navigate("/c/bbbb");
  p.hideCard();
  await t.advance(1000);
  assert.equal(t.recovery.phase, "idle");
  assert.equal(p.doc.querySelector("[data-gs-recovery]"), null);
  p.navigate("/c/aaaa");
  p.showCard();
  await t.advance(1500);
  assert.equal(p.log.retryClicks, 4, "a fresh visit retries again");
  t.recovery.dispose();

  const q = page();
  const u = mount(q);
  q.navigate("/c/cccc");
  q.hideCard();
  await u.advance(5000);
  assert.equal(q.log.retryClicks, 0, "a retry scheduled for the old route never fires on the new one");
  u.recovery.dispose();
});

test("a healthy page is left alone, and recovery never sends, reloads or touches anything but the Try again control", async () => {
  // Defect: side effects on a conversation that loaded fine.
  const p = page({ card: false });
  p.hideCard();
  const before = p.doc.documentElement.outerHTML;
  const t = mount(p);
  await t.advance(120_000);
  assert.equal(p.doc.documentElement.outerHTML, before);
  assert.equal(t.recovery.phase, "idle");
  assert.deepEqual(t.counts(), {});
  t.recovery.dispose();
});

test("the recovery is off when the config says so", async () => {
  // Defect: no way to disable a feature that clicks on the page.
  const { DEFAULTS, parseConfig } = await import("../src/core/config.js");
  assert.equal(DEFAULTS.recovery, true);
  assert.equal(parseConfig('{"recovery":false}').recovery, false);
});
