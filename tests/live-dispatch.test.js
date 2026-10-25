// The live dispatcher against a fake ChatGPT page built from DOM fixtures. Nothing here
// touches the network or the real site: "Send" and "Stop" are buttons on a jsdom page.
import test from "node:test";
import assert from "node:assert/strict";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createLiveDispatcher } from "../src/chatgpt/queue/live-dispatcher.js";
import { selectDispatcher } from "../src/chatgpt/queue/select.js";
import { DryRunDispatcher } from "../src/chatgpt/queue/dispatch.js";
import { DEFAULTS } from "../src/core/config.js";
import { CONV, World, until } from "./queue-helpers.js";
import { loadFixture } from "./helpers.js";

/** A page that behaves like ChatGPT's composer: Send enables on input, a send starts streaming, Stop ends it. */
async function fakePage({ editable = "textarea", acknowledges = true, stopWorks = true } = {}) {
  const dom = await loadFixture();
  const { window } = dom;
  const doc = window.document;
  const old = doc.querySelector("#prompt-textarea");
  const form = doc.createElement("form");
  form.id = "composer";
  let input;
  if (editable === "textarea") {
    input = old;
  } else {
    input = doc.createElement("div");
    input.id = "prompt-textarea";
    input.setAttribute("contenteditable", "true");
    old.remove();
    // jsdom has no execCommand; emulate what ProseMirror does with insertText / delete.
    doc.execCommand = (command, _ui, value) => {
      input.textContent = command === "insertText" ? value : "";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      return true;
    };
  }
  form.append(input);
  doc.querySelector("main").append(form);

  const page = { window, doc, input, form, log: [], streaming: false, send: null, stop: null };
  const text = () => (editable === "textarea" ? input.value : input.textContent);
  const clear = () => (editable === "textarea" ? (input.value = "") : (input.textContent = ""));
  page.type = (value) => {
    if (editable === "textarea") input.value = value;
    else input.textContent = value;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  const syncSend = () => page.send && (page.send.disabled = text().trim() === "");
  const addTurn = (role, content) => {
    const turn = doc.createElement("article");
    turn.setAttribute("data-testid", `conversation-turn-${100 + doc.querySelectorAll("article").length}`);
    turn.innerHTML = `<div data-message-author-role="${role}"></div>`;
    turn.firstChild.textContent = content;
    doc.querySelector("[data-scroll-root]").append(turn);
  };
  page.startStreaming = () => {
    page.streaming = true;
    page.send?.remove();
    page.send = null;
    page.stop = doc.createElement("button");
    page.stop.type = "button";
    page.stop.setAttribute("data-testid", "stop-button");
    page.stop.addEventListener("click", () => {
      page.log.push("stop");
      if (stopWorks) page.finishStreaming();
    });
    form.append(page.stop);
  };
  page.finishStreaming = () => {
    page.streaming = false;
    page.stop?.remove();
    page.stop = null;
    page.mountSend();
    addTurn("assistant", "reply");
  };
  page.mountSend = () => {
    page.send = doc.createElement("button");
    page.send.type = "button";
    page.send.setAttribute("data-testid", "send-button");
    page.send.addEventListener("click", () => {
      if (page.send.disabled) return;
      page.log.push(`send:${text().trim()}`);
      if (!acknowledges) return;
      addTurn("user", text().trim());
      clear();
      page.startStreaming();
    });
    form.append(page.send);
    syncSend();
  };
  input.addEventListener("input", syncSend);
  page.mountSend();
  page.sends = () => page.log.filter((e) => e.startsWith("send:"));
  page.dispatcher = (opts = {}) =>
    createLiveDispatcher({ win: window, adapter: chatgptAdapter, pollMs: 1, buttonWaitMs: 40, ackMs: 40, stopWaitMs: 40, ...opts });
  page.text = text;
  return page;
}

const request = (itemId, text, extra = {}) => ({ itemId, attemptId: `${itemId}-a`, conversationId: CONV, text, attachments: [], ...extra });

for (const editable of ["textarea", "contenteditable"]) {
  test(`live send (${editable}): the queue fills the composer, clicks Send once, and records the item as sent`, async () => {
    // Defect: a live queue that never reaches the page, or sends twice.
    const page = await fakePage({ editable });
    const w = new World();
    const { engine } = await w.tab("A", {}, page.dispatcher());
    const a = await engine.enqueue(CONV, { text: "first message" });
    const b = await engine.enqueue(CONV, { text: "second message" });

    assert.deepEqual(await engine.step(CONV), { kind: "sent", itemId: a.id });
    assert.deepEqual(page.sends(), ["send:first message"]);
    assert.equal(page.text(), "", "the composer is left empty");
    assert.equal(page.doc.querySelectorAll('[data-message-author-role="user"]').length, 3);

    // The reply is streaming: the queue waits and never presses Stop on its own.
    for (let i = 0; i < 3; i++) assert.deepEqual(await engine.step(CONV), { kind: "waiting", reason: "generating" });
    assert.deepEqual(page.log, ["send:first message"]);

    page.finishStreaming();
    assert.deepEqual(await engine.step(CONV), { kind: "sent", itemId: b.id });
    assert.deepEqual(page.sends(), ["send:first message", "send:second message"]);
    assert.deepEqual((await engine.list(CONV)).items.map((i) => i.status), ["sent", "sent"]);
  });
}

test("interrupt then send: Stop is clicked first, the stream really ends, and only the next item is sent", async () => {
  // Defect: sending before the stop took effect, or sending more than the next item.
  const page = await fakePage();
  page.type("");
  page.startStreaming();
  const w = new World();
  const { engine } = await w.tab("A", {}, page.dispatcher());
  const a = await engine.enqueue(CONV, { text: "urgent" });
  await engine.enqueue(CONV, { text: "later" });

  assert.deepEqual(await engine.interruptAndSendNext(CONV), { kind: "sent", itemId: a.id });
  assert.deepEqual(page.log, ["stop", "send:urgent"]);
  assert.equal((await engine.list(CONV)).items[1].status, "pending");
});

test("interrupt when Stop has no effect: nothing is sent and the item stays pending with an error", async () => {
  // Defect: pressing Send into a response that is still running.
  const page = await fakePage({ stopWorks: false });
  page.startStreaming();
  const w = new World();
  const { engine } = await w.tab("A", {}, page.dispatcher());
  await engine.enqueue(CONV, { text: "urgent" });
  const outcome = await engine.interruptAndSendNext(CONV);
  assert.equal(outcome.kind, "interrupt-failed");
  assert.equal(outcome.error.code, "stop-unconfirmed");
  assert.deepEqual(page.log, ["stop"]);
  assert.equal((await engine.list(CONV)).items[0].status, "pending");
});

test("fails closed: no composer, no Send button, a user draft, or attachments all send nothing", async () => {
  // Defect: sending (or overwriting the user's draft) when the page is not in the expected shape.
  const missingComposer = await fakePage();
  const dispatcher = missingComposer.dispatcher();
  missingComposer.input.remove();
  assert.equal(await dispatcher.readState(), "unknown");
  assert.deepEqual(await dispatcher.submit(request("i1", "x")), {
    kind: "rejected", code: "composer-missing", message: "The ChatGPT composer was not found; nothing was sent.", retryable: true,
  });
  assert.deepEqual(missingComposer.log, []);

  const noSend = await fakePage();
  noSend.send.remove();
  const rejected = await noSend.dispatcher().submit(request("i2", "x"));
  assert.equal(rejected.code, "send-button-missing");
  assert.equal(noSend.text(), "", "the text it placed is taken back out");
  assert.deepEqual(noSend.log, []);

  const draft = await fakePage();
  draft.type("my own half-written thought");
  const refused = await draft.dispatcher().submit(request("i3", "queued"));
  assert.equal(refused.code, "composer-not-empty");
  assert.equal(draft.text(), "my own half-written thought", "the draft is untouched");
  assert.deepEqual(draft.log, []);

  const streaming = await fakePage();
  streaming.startStreaming();
  assert.equal((await streaming.dispatcher().submit(request("i5", "x"))).code, "busy");
  assert.deepEqual(streaming.log, []);

  const attach = await fakePage();
  const withFile = await attach.dispatcher().submit(request("i4", "x", { attachments: [{ name: "f.png", size: 1, type: "image/png", restorable: true }] }));
  assert.equal(withFile.code, "attachments-unsupported");
  assert.equal(withFile.retryable, false);
  assert.deepEqual(attach.log, []);
});

test("through the queue, a missing composer waits rather than sends, and a vanished Send button retries within bounds", async () => {
  // Defect: the engine pressing on when the composer or Send button is gone (no endless loop either).
  const gone = await fakePage();
  const w = new World();
  const { engine } = await w.tab("A", { retryBackoffMs: [1000] }, gone.dispatcher());
  await engine.enqueue(CONV, { text: "x" });
  gone.input.remove();
  assert.deepEqual(await engine.step(CONV), { kind: "waiting", reason: "unknown-state" });

  const noSend = await fakePage();
  const w2 = new World();
  const t2 = await w2.tab("A", { maxAttempts: 2, retryBackoffMs: [1000] }, noSend.dispatcher());
  const b = await t2.engine.enqueue(CONV, { text: "x" });
  noSend.send.remove();
  assert.equal((await t2.engine.step(CONV)).kind, "retry-scheduled");
  w2.clock.advance(1000);
  assert.deepEqual(await t2.engine.step(CONV), { kind: "failed", itemId: b.id });
  assert.deepEqual(noSend.log, []);
});

test("a click ChatGPT never acknowledges goes to manual review and is never clicked again", async () => {
  // Defect: blind retry of a message that may have been delivered.
  const page = await fakePage({ acknowledges: false });
  const w = new World();
  const { engine } = await w.tab("A", {}, page.dispatcher());
  const a = await engine.enqueue(CONV, { text: "maybe sent" });
  assert.deepEqual(await engine.step(CONV), { kind: "manual-review", itemId: a.id });
  for (let i = 0; i < 3; i++) {
    w.clock.advance(60_000);
    assert.equal((await engine.step(CONV)).kind, "halted");
  }
  assert.deepEqual(page.sends(), ["send:maybe sent"]);
});

test("the dispatcher itself refuses to click twice for one item", async () => {
  // Defect: a re-entrant or repeated submit of the same item doubling the message.
  const page = await fakePage();
  const dispatcher = page.dispatcher();
  assert.equal((await dispatcher.submit(request("same", "once"))).kind, "accepted");
  page.finishStreaming();
  assert.equal((await dispatcher.submit(request("same", "once"))).kind, "uncertain");
  assert.equal(page.sends().length, 1);
});

test("reload while another tab holds the lease: no duplicate send, and after expiry the item is quarantined, not resent", async () => {
  // Defect: a reloaded page re-sending the item the previous page was in the middle of sending.
  const oldPage = await fakePage({ acknowledges: false });
  const w = new World();
  const first = await w.tab("before-reload", {}, oldPage.dispatcher({ ackMs: 10_000 }));
  const a = await first.engine.enqueue(CONV, { text: "in flight" });
  const sending = first.engine.step(CONV);
  await until(() => oldPage.sends().length === 1);

  const newPage = await fakePage();
  const second = await w.tab("after-reload", {}, newPage.dispatcher());
  assert.equal((await second.engine.step(CONV)).kind, "not-leader");
  assert.equal((await second.engine.step(CONV)).kind, "not-leader");
  assert.deepEqual(newPage.log, [], "the reloaded page sent nothing while the lease was held");

  w.clock.advance(20_000); // the old page never comes back; its lease expires
  assert.deepEqual(await second.engine.step(CONV), { kind: "halted", itemId: a.id, status: "manual-review" });
  assert.deepEqual(newPage.log, []);
  oldPage.type(""); // the old page finally shows a sign of life; its late result must not trigger any new click
  await sending;
  assert.deepEqual(newPage.log, []);
  assert.equal(oldPage.sends().length, 1);
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
