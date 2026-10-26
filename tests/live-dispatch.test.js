// The live dispatcher against a fake ChatGPT page built from DOM fixtures. Nothing here touches the network or the real
// site: "Send" and "Stop" are buttons on a jsdom page.
import test from "node:test";
import assert from "node:assert/strict";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createLiveDispatcher } from "../src/chatgpt/queue/live-dispatcher.js";
import { selectDispatcher } from "../src/chatgpt/queue/select.js";
import { DryRunDispatcher } from "../src/chatgpt/queue/dispatch.js";
import { DEFAULTS } from "../src/core/config.js";
import { World } from "./queue-helpers.js";
import { TARGET, fakePage } from "./fake-page.js";

/** A dispatcher with short real waits and a hand-driven clock for the "long wait" rules. */
function dispatcherFor(page, opts = {}) {
  const clock = { t: 1_000_000 };
  const dispatcher = createLiveDispatcher({
    win: page.window,
    adapter: chatgptAdapter,
    pollMs: 1,
    arriveMs: 0,
    controlSettleMs: 0,
    settleMs: 500,
    sendWaitMs: 40,
    steerWaitMs: 15,
    ackMs: 40,
    stopWaitMs: 40,
    composerLostMs: 10_000,
    now: () => clock.t,
    ...opts,
  });
  return Object.assign(dispatcher, { clock });
}

const request = (itemId, text, extra = {}) => ({ itemId, ...TARGET, text, attachments: [], ...extra });

async function engineOn(page, opts) {
  const w = new World();
  const dispatcher = dispatcherFor(page, opts);
  const tab = await w.tab("A", {}, dispatcher);
  return { w, dispatcher, engine: tab.engine, store: tab.store };
}

test("Stop is showing and no Send exists for 60+ seconds: the queue waits, with zero attempts and zero clicks; one send once it settles", async () => {
  // Defect: the shipped dispatcher exhausted its retries with `Send button was not found` while Stop was visible.
  const page = await fakePage();
  page.send.remove();
  page.send = null;
  page.startStreaming();
  const { engine, dispatcher, w } = await engineOn(page);
  await engine.append(TARGET, { text: "first" });
  await engine.append(TARGET, { text: "second" });
  const before = JSON.stringify((await engine.view(TARGET)).pending);

  for (let second = 0; second < 90; second++) {
    dispatcher.clock.t += 1_000;
    w.clock.advance(1_000);
    const outcome = await engine.step(TARGET);
    assert.deepEqual(outcome, { kind: "waiting", reason: "generating" });
  }
  assert.deepEqual(page.log, [], "no click of any kind");
  assert.equal(JSON.stringify((await engine.view(TARGET)).pending), before, "the prompt is untouched: no attempt counted, no error recorded");
  assert.equal((await engine.view(TARGET)).inflight, null);

  page.finishStreaming();
  assert.deepEqual(await engine.step(TARGET), { kind: "waiting", reason: "settling" }, "a short settle before staging");
  dispatcher.clock.t += 1_000;
  assert.equal((await engine.step(TARGET)).kind, "sent");
  assert.deepEqual(page.sends(), ["send:first\n\nsecond"]);
  assert.equal(page.text(), "", "the composer is left empty");
  page.finishStreaming();
  dispatcher.clock.t += 1_000;
  assert.equal((await engine.step(TARGET)).kind, "idle");
  assert.equal(page.sends().length, 1);
});

test("a missing data-testid is not read as idle: a labelled Stop, or a reply still marked streaming, both mean generating", async () => {
  // Defect: treating the absence of one selector as "response finished" and sending into a running response.
  const labelled = await fakePage();
  labelled.startStreaming();
  labelled.stop.removeAttribute("data-testid");
  labelled.stop.setAttribute("aria-label", "Stop streaming");
  assert.equal(chatgptAdapter.generating(labelled.doc), true);
  assert.deepEqual(await dispatcherFor(labelled).readiness(TARGET), { state: "waiting", reason: "generating" });

  const marked = await fakePage();
  marked.doc.querySelector("[data-scroll-root]").insertAdjacentHTML("beforeend", `<article data-testid="conversation-turn-9"><div data-message-author-role="assistant" class="result-streaming">…</div></article>`);
  assert.equal(chatgptAdapter.generating(marked.doc), true);
  assert.equal((await dispatcherFor(marked).readiness(TARGET)).reason, "generating");
  assert.deepEqual(marked.log, []);

  const idle = await fakePage();
  assert.equal(chatgptAdapter.generating(idle.doc), false);
});

for (const editable of ["textarea", "contenteditable"]) {
  test(`live send (${editable}): the whole merged text, blank lines intact, is staged, Send is clicked once, the prompt is gone`, async () => {
    // Defect: a live queue that never reaches the page, flattens the blank lines, or sends twice.
    const page = await fakePage({ editable, sendOnlyWithText: true });
    const { engine, dispatcher } = await engineOn(page);
    for (const part of ["A", "B\nsecond line", "C"]) await engine.append(TARGET, { text: part });
    dispatcher.clock.t += 5_000;
    assert.equal((await engine.step(TARGET)).kind, "sent");
    assert.deepEqual(page.sends(), ["send:A\n\nB\nsecond line\n\nC"]);
    assert.equal(page.text(), "");
    assert.equal(page.doc.querySelectorAll('[data-message-author-role="user"]').length, 3);
    assert.equal((await engine.view(TARGET)).pending, null);
  });
}

test("Send never becomes enabled after the response settled: the staged text is taken back, nothing is clicked, and the prompt is held (not retried)", async () => {
  // Defect: leaving the user's composer filled, or looping on a missing Send button.
  const page = await fakePage({ sendMissing: true });
  const { engine, dispatcher } = await engineOn(page);
  await engine.append(TARGET, { text: "x" });
  dispatcher.clock.t += 5_000;
  const outcome = await engine.step(TARGET);
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.error.code, "send-unavailable");
  assert.equal(page.text(), "", "the text it placed is taken back out");
  assert.deepEqual(page.log, []);
  for (let i = 0; i < 4; i++) assert.equal((await engine.step(TARGET)).kind, "halted");
  const view = await engine.view(TARGET);
  assert.equal(view.pending.text, "x");
  assert.equal(view.pending.status, "blocked");
  assert.deepEqual(page.log, []);
});

test("a user draft in the composer is never overwritten: the queue waits for it to clear", async () => {
  // Defect: clobbering what the user is typing.
  const page = await fakePage();
  page.type("my own half-written thought");
  const { engine, dispatcher } = await engineOn(page);
  await engine.append(TARGET, { text: "queued" });
  dispatcher.clock.t += 5_000;
  for (let i = 0; i < 3; i++) assert.deepEqual(await engine.step(TARGET), { kind: "waiting", reason: "composer-has-draft" });
  assert.equal(page.text(), "my own half-written thought");
  assert.deepEqual(page.log, []);
});

test("the prompt belongs to its conversation and account: on any other page nothing is typed or clicked", async () => {
  // Defect: A's text being typed into whichever conversation is visible when the response ends.
  const page = await fakePage({ profile: "Some Person" });
  const account = chatgptAdapter.accountId(page.doc);
  assert.match(account, /^acct-[0-9a-f]{16}$/);
  assert.ok(!account.includes("Some"), "the label is hashed, never kept");
  const { engine, dispatcher } = await engineOn(page);
  const elsewhere = { accountId: account, conversationId: "another-conversation" };
  await engine.append(elsewhere, { text: "not for this page" });
  dispatcher.clock.t += 5_000;
  assert.deepEqual(await engine.step(elsewhere), { kind: "waiting", reason: "other-conversation" });

  const otherAccount = { accountId: "acct-0000000000000000", conversationId: "fixture" };
  await engine.append(otherAccount, { text: "wrong account" });
  assert.deepEqual(await engine.step(otherAccount), { kind: "waiting", reason: "other-conversation" });
  assert.equal(page.text(), "");
  assert.deepEqual(page.log, []);
});

test("navigating away while the text is staged: it is taken back out and nothing is clicked", async () => {
  // Defect: the click landing in a different conversation than the one the prompt was queued for.
  const page = await fakePage({ sendOnlyWithText: true });
  const dispatcher = dispatcherFor(page, { sendWaitMs: 200 });
  page.input.addEventListener("input", () => {
    page.send?.disabled !== undefined && page.window.history.pushState({}, "", "/c/somewhere-else");
  });
  dispatcher.clock.t += 5_000;
  const result = await dispatcher.submit(request("s1", "queued text"));
  assert.deepEqual(result, { kind: "wait", reason: "other-conversation" });
  assert.equal(page.text(), "");
  assert.deepEqual(page.log, []);
});

test("Steer with a native steer control present clicks only that control, once, and never Stop", async () => {
  // Defect: stopping a response when ChatGPT offered to steer it.
  const page = await fakePage({ steer: true });
  page.startStreaming();
  const { engine } = await engineOn(page);
  await engine.append(TARGET, { text: "A" });
  await engine.append(TARGET, { text: "B" });
  assert.equal((await engine.steer(TARGET)).kind, "sent");
  assert.deepEqual(page.log, ["steer:A\n\nB"]);
  assert.equal(page.streaming, true, "the running response was not interrupted");
});

test("Steer with no native steer control: the staged text is withdrawn, Stop is clicked, and the whole text is sent once after the stop", async () => {
  // Defect: guessing at a steer path, leaving text in the composer, or sending before the stop took effect.
  const page = await fakePage();
  page.startStreaming();
  const { engine, dispatcher } = await engineOn(page);
  await engine.append(TARGET, { text: "A" });
  await engine.append(TARGET, { text: "B" });
  dispatcher.clock.t += 5_000;
  assert.equal((await engine.steer(TARGET)).kind, "sent");
  assert.deepEqual(page.log, ["stop", "send:A\n\nB"]);
});

test("Interrupt when Stop has no effect: nothing is sent and the prompt stays pending with an error", async () => {
  // Defect: pressing Send into a response that is still running.
  const page = await fakePage({ stopWorks: false });
  page.startStreaming();
  const { engine } = await engineOn(page);
  await engine.append(TARGET, { text: "urgent" });
  const outcome = await engine.steer(TARGET, { native: false });
  assert.equal(outcome.kind, "interrupt-failed");
  assert.equal(outcome.error.code, "stop-unconfirmed");
  assert.deepEqual(page.log, ["stop"]);
  assert.equal((await engine.view(TARGET)).pending.status, "pending");
});

test("a click ChatGPT never acknowledges goes to review and is never clicked again", async () => {
  // Defect: blind retry of a message that may have been delivered.
  const page = await fakePage({ acknowledges: false });
  const { engine, dispatcher, w } = await engineOn(page);
  await engine.append(TARGET, { text: "maybe sent" });
  dispatcher.clock.t += 5_000;
  assert.equal((await engine.step(TARGET)).kind, "manual-review");
  for (let i = 0; i < 3; i++) {
    w.clock.advance(60_000);
    dispatcher.clock.t += 60_000;
    assert.equal((await engine.step(TARGET)).kind, "halted");
  }
  assert.deepEqual(page.sends(), ["send:maybe sent"]);
});

test("the dispatcher itself refuses to click twice for one snapshot", async () => {
  // Defect: a re-entrant or repeated submit of the same snapshot doubling the message.
  const page = await fakePage();
  const dispatcher = dispatcherFor(page);
  dispatcher.clock.t += 5_000;
  assert.equal((await dispatcher.submit(request("same", "once"))).kind, "accepted");
  page.finishStreaming();
  dispatcher.clock.t += 5_000;
  assert.equal((await dispatcher.submit(request("same", "once"))).kind, "uncertain");
  assert.equal(page.sends().length, 1);
});

test("fails closed: attachments are refused, a lost composer is waited for and then held, a busy page is waited on", async () => {
  // Defect: sending (or overwriting a draft) when the page is not in the expected shape.
  const attach = await fakePage();
  const withFile = await dispatcherFor(attach).submit(request("f", "x", { attachments: [{ name: "f.png", size: 1, type: "image/png", restorable: true }] }));
  assert.equal(withFile.code, "attachments-unsupported");
  assert.deepEqual(attach.log, []);

  const lost = await fakePage();
  const dispatcher = dispatcherFor(lost);
  lost.input.remove();
  assert.equal(await dispatcher.readState(), "unknown");
  assert.deepEqual(await dispatcher.readiness(TARGET), { state: "waiting", reason: "composer-missing" });
  dispatcher.clock.t += 20_000;
  const held = await dispatcher.readiness(TARGET);
  assert.equal(held.state, "blocked");
  assert.equal(held.code, "composer-lost");
  assert.deepEqual(lost.log, []);

  const busy = await fakePage();
  busy.startStreaming();
  assert.deepEqual(await dispatcherFor(busy).submit(request("b", "x")), { kind: "wait", reason: "generating" });
  assert.deepEqual(busy.log, []);
});

test("through the queue a lost composer is waited for first, then held once: no retry storm", async () => {
  // Defect: retrying a vanished composer forever.
  const page = await fakePage();
  const { engine, dispatcher } = await engineOn(page);
  await engine.append(TARGET, { text: "x" });
  page.input.remove();
  for (let i = 0; i < 5; i++) {
    dispatcher.clock.t += 1_000;
    assert.deepEqual(await engine.step(TARGET), { kind: "waiting", reason: "composer-missing" });
  }
  dispatcher.clock.t += 20_000;
  assert.deepEqual(await engine.step(TARGET), { kind: "halted", itemId: (await engine.view(TARGET)).pending.id, status: "blocked" });
  assert.equal((await engine.view(TARGET)).pending.lastError.code, "composer-lost");
  assert.deepEqual(page.log, []);
});

test("the published default is live; dry run is an explicit opt-in", async () => {
  // Defect: shipping the dry-run dispatcher (or silently dropping the opt-in) after the owner's decision.
  const page = await fakePage();
  const args = { win: page.window, adapter: chatgptAdapter };
  const live = selectDispatcher({ config: DEFAULTS, ...args });
  assert.equal(live.dryRun, undefined);
  assert.ok(!(live instanceof DryRunDispatcher));
  assert.ok(selectDispatcher({ config: { ...DEFAULTS, dryRun: true }, ...args }) instanceof DryRunDispatcher);
});

// ---- the composer race from live use: placement confirmed late (#630) ----

test("placement the editor applies LATE is read back after it settles: the text counts as placed and is sent once, never blocked", async () => {
  // Defect: one immediate read-back right after the write said `could not place the text` while the text was arriving.
  const page = await fakePage({ editable: "contenteditable", sendOnlyWithText: true });
  page.fill = 60; // the editor shows the text 60 ms after the write
  const { engine, dispatcher } = await engineOn(page, { placeWaitMs: 600 });
  await engine.append(TARGET, { text: "first\n\nsecond" });
  dispatcher.clock.t += 5_000;
  assert.equal((await engine.step(TARGET)).kind, "sent");
  assert.deepEqual(page.sends(), ["send:first\n\nsecond"]);
  assert.equal((await engine.view(TARGET)).pending, null);
  assert.equal(page.text(), "");
});

test("placement slower than the wait: the step waits; when the text lands, the composer holding exactly the queued text is ours and is sent", async () => {
  // Defect: the late text read as a user draft (`composer-has-draft`), then a hold that never cleared.
  const page = await fakePage({ editable: "contenteditable", sendOnlyWithText: true });
  page.fill = 120;
  const { engine, dispatcher } = await engineOn(page, { placeWaitMs: 20 });
  await engine.append(TARGET, { text: "queued text" });
  dispatcher.clock.t += 5_000;
  assert.deepEqual(await engine.step(TARGET), { kind: "waiting", reason: "placing-text" });
  assert.deepEqual((await engine.view(TARGET)).pending.status, "pending", "not blocked by a placement still in progress");
  await new Promise((resolve) => setTimeout(resolve, 200)); // the text arrives after the step gave up
  assert.equal(page.text(), "queued text");
  assert.deepEqual(await dispatcher.readiness(TARGET, "queued text"), { state: "ready" });
  assert.deepEqual(await dispatcher.readiness(TARGET), { state: "waiting", reason: "composer-has-draft" }, "without the queued text it is still a draft");
  const outcome = await engine.step(TARGET);
  assert.equal(outcome.kind, "sent");
  assert.deepEqual(page.sends(), ["send:queued text"], "sent once");
});

test("a different draft is still a draft: the composer holding other text is never treated as the queued text", async () => {
  // Defect: the fix swallowing a real user draft.
  const page = await fakePage();
  page.type("something else");
  const { engine, dispatcher } = await engineOn(page);
  await engine.append(TARGET, { text: "queued text" });
  dispatcher.clock.t += 5_000;
  assert.deepEqual(await engine.step(TARGET), { kind: "waiting", reason: "composer-has-draft" });
  assert.equal(page.text(), "something else");
  assert.deepEqual(page.log, []);
});

test("text that truly never appears is waited out twice, then held; the hold never stops Steer, and Retry works without a reload", async () => {
  // Defect: a Blocked prompt with Steer disabled that only a page reload could clear.
  const page = await fakePage({ editable: "contenteditable", sendOnlyWithText: true });
  page.fill = "never";
  const { engine, dispatcher } = await engineOn(page, { placeWaitMs: 15 });
  await engine.append(TARGET, { text: "x" });
  dispatcher.clock.t += 5_000;
  assert.deepEqual(await engine.step(TARGET), { kind: "waiting", reason: "placing-text" });
  assert.deepEqual(await engine.step(TARGET), { kind: "waiting", reason: "placing-text" });
  const held = await engine.step(TARGET);
  assert.equal(held.kind, "rejected");
  assert.equal(held.error.code, "composer-fill-failed");
  assert.equal((await engine.view(TARGET)).pending.status, "blocked");
  assert.equal((await engine.step(TARGET)).kind, "halted", "no automatic retry");
  assert.deepEqual(page.log, []);

  page.fill = "now"; // the page recovers
  const steered = await engine.steer(TARGET, { native: false });
  assert.equal(steered.kind, "sent", "an explicit Steer lifts the hold");
  assert.deepEqual(page.sends(), ["send:x"]);

  await engine.append(TARGET, { text: "y" });
  page.fill = "never";
  for (let i = 0; i < 3; i++) await engine.steer(TARGET, { native: false });
  assert.equal((await engine.view(TARGET)).pending.status, "blocked");
  page.fill = "now";
  await engine.unblock(TARGET);
  page.finishStreaming();
  dispatcher.clock.t += 5_000;
  assert.equal((await engine.step(TARGET)).kind, "sent", "Retry then sends, no reload");
});

test("a Send that ChatGPT ignores for a moment after it appears is not clicked until it has stayed enabled; clicking at once is unacknowledged", async () => {
  // Defect (found live): the click came 10 ms after Send appeared, ChatGPT did not submit, and the prompt went to review.
  const eager = await fakePage({ armMs: 300 });
  eager.startStreaming();
  const a = await engineOn(eager, { controlSettleMs: 0, sendWaitMs: 2000, ackMs: 60 });
  await a.engine.append(TARGET, { text: "too soon" });
  eager.finishStreaming();
  a.dispatcher.clock.t += 5_000;
  assert.equal((await a.engine.step(TARGET)).kind, "manual-review", "an immediate click is ignored by the page");
  assert.deepEqual(eager.log, ["ignored-click"]);

  const patient = await fakePage({ armMs: 300 });
  patient.startStreaming();
  const b = await engineOn(patient, { controlSettleMs: 350, sendWaitMs: 2000, ackMs: 200 });
  await b.engine.append(TARGET, { text: "waits" });
  patient.finishStreaming();
  b.dispatcher.clock.t += 5_000;
  assert.equal((await b.engine.step(TARGET)).kind, "sent");
  assert.deepEqual(patient.sends(), ["send:waits"]);
});
