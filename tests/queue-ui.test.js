// The queue card and its wiring to ChatGPT's native composer, against the fake page. No separate input exists: the
// native composer is the only place text is entered or edited.
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { DryRunDispatcher } from "../src/chatgpt/queue/dispatch.js";
import { createLiveDispatcher } from "../src/chatgpt/queue/live-dispatcher.js";
import { createQueueUi } from "../src/chatgpt/queue/controller.js";
import { ManualClock, settle } from "./queue-helpers.js";
import { createWorkerTimers } from "../src/core/worker-timer.js";
import { FakeWorker, freezeWindowTimers, setHidden } from "./fake-worker.js";
import { fakePage } from "./fake-page.js";

/** Mounts the queue on a fake page. `live` drives the real dispatcher against the page; otherwise the dry-run adapter. */
async function mount({ page, factory = new IDBFactory(), clock = new ManualClock(), tabId = "tab-1", live = false, dispatcher, liveOptions = {}, uiOptions = {} } = {}) {
  page ??= await fakePage();
  const { window } = page;
  const t = { now: 1_000_000 };
  dispatcher ??= live
    ? createLiveDispatcher({ win: window, adapter: chatgptAdapter, pollMs: 1, arriveMs: 0, settleMs: 0, placeWaitMs: 15, sendWaitMs: 40, steerWaitMs: 15, ackMs: 40, stopWaitMs: 40, now: () => t.now, ...liveOptions })
    : new DryRunDispatcher();
  const ui = createQueueUi({ win: window, adapter: chatgptAdapter, dispatcher, indexedDB: factory, clock, tabId, pollMs: 0, ...uiOptions });
  await ui.ready;
  await ui.settled();
  const $ = (sel) => ui.root.querySelector(sel);
  const $$ = (sel) => [...ui.root.querySelectorAll(sel)];
  const key = (k) => ui.root.querySelector(`[data-gs-key="${k}"]`);
  const click = async (k) => {
    assert.ok(key(k), `no control ${k}`);
    key(k).click();
    await ui.settled();
  };
  const press = async (init, target = page.input) => {
    const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    await ui.settled();
    return event;
  };
  const enter = async (text, init = {}) => {
    page.type(text);
    return press({ key: "Enter", ...init });
  };
  const tick = async () => {
    t.now += 1_000;
    clock.advance(1_000);
    await ui.tick();
    await ui.settled();
  };
  const queued = () => $(".gs-q-text")?.textContent ?? null;
  const rows = () => $$(".gs-q-text").length;
  const navigate = async (id) => {
    window.history.pushState({}, "", `/c/${id}`);
    await tick();
  };
  return { page, ui, window, doc: window.document, factory, clock, t, $, $$, key, click, press, enter, tick, queued, rows, navigate, dispatcher };
}

const noNullText = (ui) => assert.doesNotMatch(ui.root.textContent, /\bnull\b|\bundefined\b|\[object/);

test("the card sits directly above the native composer, has no separate input and no overflow control, and hides when nothing is queued", async () => {
  // Defect: the shipped panel had its own `Queue a message` textarea, an ellipsis menu and always occupied space.
  const t = await mount();
  const composer = chatgptAdapter.composer(t.doc);
  assert.equal(composer.previousElementSibling, t.ui.root);
  assert.equal(t.ui.root.hidden, true);
  assert.equal(t.$$("textarea, input").length, 0);
  assert.equal(composer.hasAttribute("style"), false);

  t.page.startStreaming();
  await t.enter("a thought");
  assert.equal(t.ui.root.hidden, false);
  assert.equal(t.$$("textarea, input").length, 0, "the native composer is the only input");
  assert.doesNotMatch(t.ui.root.textContent, /Queue a message/);
  const labels = t.$$("button").map((b) => `${b.textContent} ${b.getAttribute("aria-label") ?? ""}`);
  assert.ok(!labels.some((l) => /[…⋯⋮]|\.\.\.|\bmore\b|menu/i.test(l)), `unexpected overflow control: ${labels}`);
  for (const wanted of ["Edit", "Delete", "Steer"]) assert.ok(labels.some((l) => l.includes(wanted)), wanted);
  assert.equal(t.$$("button").length, 3, "Edit, Delete and Steer are the only controls");
  for (const gone of ["Interrupt", "Pause", "Resume", "Queue"]) assert.ok(!labels.some((l) => l.includes(gone)), `${gone} is gone`);
  assert.ok(!t.$(".gs-q-handle, [class*=drag], ol, li"), "no rows, grips or reorder controls");
  assert.equal(t.$(".gs-q-title"), null, "no header: the card is the text and its icons");
  // The text is the bubble; its icons sit below it, at the right.
  assert.equal(t.ui.root.firstElementChild.className, "gs-q-text");
  assert.equal(t.ui.root.lastElementChild.className, "gs-q-foot");
  assert.deepEqual(t.$$(".gs-q-foot button").map((b) => b.getAttribute("data-gs-key")), ["head:edit", "head:delete", "head:steer"]);
  assert.ok(t.$$(".gs-q-foot button").every((b) => b.classList.contains("gs-q-icon") && b.textContent === ""), "icons only");
  t.ui.dispose();
  assert.equal(t.doc.querySelector("[data-gs-queue]"), null);
});

test("Enter A, Enter B, Enter C while generating: one card row `A\\n\\nB\\n\\nC`, count 1, composer cleared, zero native sends", async () => {
  // Defect: Enter steering natively, creating a row per Enter, or the count growing with each addition.
  const t = await mount();
  t.page.startStreaming();
  for (const part of ["A", "B", "C"]) {
    const event = await t.enter(part);
    assert.equal(event.defaultPrevented, true, "the native send is suppressed");
    assert.equal(t.page.text(), "", "the composer is cleared once the write is confirmed");
  }
  assert.equal(t.rows(), 1);
  assert.equal(t.queued(), "A\n\nB\n\nC");
  assert.deepEqual(t.page.log, [], "zero native sends and zero stops");
  assert.equal(t.ui.root.querySelector(".gs-q-text").dataset.version, "3");
  noNullText(t.ui);
});

test("outside a running response Enter is left to ChatGPT; Shift+Enter, IME composition and empty Enter never queue", async () => {
  // Defect: swallowing the user's normal sends, breaking IME input, or queueing blanks.
  const t = await mount();
  const idle = await t.enter("normal message");
  assert.equal(idle.defaultPrevented, false);
  assert.equal(t.page.text(), "normal message");
  assert.equal(t.ui.root.hidden, true);

  t.page.startStreaming();
  t.page.type("line one");
  assert.equal((await t.press({ key: "Enter", shiftKey: true })).defaultPrevented, false, "Shift+Enter stays a newline");
  assert.equal((await t.press({ key: "Enter", isComposing: true })).defaultPrevented, false, "IME composition is left alone");
  assert.equal((await t.press({ key: "Enter", keyCode: 229 })).defaultPrevented, false);
  assert.equal(t.page.text(), "line one");
  assert.equal(t.rows(), 0);

  t.page.type("   ");
  const blank = await t.press({ key: "Enter" });
  assert.equal(blank.defaultPrevented, true, "not sent natively either");
  assert.equal(t.rows(), 0, "whitespace-only is ignored");
});

test("a form submit or native Send/steer click while generating appends too, and one gesture counted twice queues once", async () => {
  // Defect: the form path bypassing the Enter handler, or Enter + submit doubling the text.
  const t = await mount({ page: await fakePage({ steer: true }) });
  t.page.startStreaming();
  t.page.type("via submit");
  const submit = new t.window.Event("submit", { bubbles: true, cancelable: true });
  t.page.form.dispatchEvent(submit);
  await t.ui.settled();
  assert.equal(submit.defaultPrevented, true);
  assert.equal(t.queued(), "via submit");

  t.page.type("via steer button");
  t.page.steerButton.click();
  await t.ui.settled();
  assert.equal(t.queued(), "via submit\n\nvia steer button");
  assert.deepEqual(t.page.log, [], "the native steer control was not triggered");

  t.page.type("once");
  await Promise.all([t.press({ key: "Enter" }), t.press({ key: "Enter" })]);
  t.page.form.dispatchEvent(new t.window.Event("submit", { bubbles: true, cancelable: true }));
  await t.ui.settled();
  assert.equal(t.queued(), "via submit\n\nvia steer button\n\nonce");
});

test("whenever ChatGPT offers to steer, Send goes to the queue by default, even where it shows no Stop control", async () => {
  // Defect: a page whose running response shows only a Steer control (no Stop, no streaming marker) steered natively.
  const t = await mount({ page: await fakePage({ steer: true }) });
  t.page.startStreaming();
  t.page.type("first");
  t.page.stop.remove(); // only the steer control marks the running response
  t.doc.querySelectorAll(".result-streaming, [data-is-streaming='true']").forEach((e) => e.remove());
  assert.ok(t.page.steerButton, "the native steer control is on offer");
  const enter = await t.press({ key: "Enter" });
  assert.equal(enter.defaultPrevented, true, "Enter is not left to ChatGPT");
  await t.ui.settled();
  assert.equal(t.queued(), "first");
  t.page.type("second");
  t.page.steerButton.click();
  await t.ui.settled();
  assert.equal(t.queued(), "first\n\nsecond", "the native Steer button queues too");
  assert.deepEqual(t.page.log, [], "nothing was steered natively");
});

test("text typed while generating without Enter shows no card and no Queue button: Enter is the way in", async () => {
  // Defect: a separate Queue button next to the native composer.
  const t = await mount();
  t.page.startStreaming();
  t.page.type("typed");
  await t.press({ key: "a" });
  assert.equal(t.key("head:queue"), null);
  assert.equal(t.ui.root.hidden, true);
  assert.equal(t.page.text(), "typed", "the draft stays in the composer");
});

test("Edit puts the whole text in the native composer; Enter saves it under the same id (version up, nothing sent); Cancel restores the previous draft", async () => {
  // Defect: edit appending a duplicate, sending to ChatGPT, or losing the user's unrelated draft.
  const t = await mount();
  t.page.startStreaming();
  await t.enter("A");
  await t.enter("B");
  const id = t.$(".gs-q-text").dataset.id;
  const version = Number(t.$(".gs-q-text").dataset.version);

  t.page.type("an unrelated draft");
  await t.click("head:edit");
  assert.equal(t.page.text(), "A\n\nB", "the entire accumulated text is in the native composer");
  assert.match(t.$(".gs-q-status").textContent, /Editing/);
  assert.equal(t.key("head:steer"), null, "no competing actions while editing");

  // Cancel
  await t.press({ key: "Escape" });
  assert.equal(t.page.text(), "an unrelated draft");
  assert.equal(t.queued(), "A\n\nB");
  assert.equal(t.$(".gs-q-text").dataset.version, String(version));

  // Save
  await t.click("head:edit");
  t.page.type("A\n\nB rewritten\n\nC");
  const event = await t.press({ key: "Enter" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(t.queued(), "A\n\nB rewritten\n\nC");
  assert.equal(t.$(".gs-q-text").dataset.id, id);
  assert.equal(Number(t.$(".gs-q-text").dataset.version), version + 1);
  assert.equal(t.rows(), 1);
  assert.equal(t.page.text(), "an unrelated draft", "the draft is back");
  assert.deepEqual(t.page.log, [], "an edit is never submitted to ChatGPT");
  noNullText(t.ui);
});

test("editing while another tab queues more: the addition is kept after the edit and the user is told", async () => {
  // Defect: an edit silently overwriting what another tab just queued.
  const factory = new IDBFactory();
  const one = await mount({ factory, tabId: "tab-1" });
  const two = await mount({ factory, tabId: "tab-2", page: await fakePage() });
  for (const t of [one, two]) t.page.startStreaming();
  await one.enter("first");
  await one.click("head:edit");
  two.window.history.replaceState({}, "", "/c/fixture");
  await two.tick();
  assert.equal(two.queued(), "first");
  assert.match(two.$(".gs-q-status").textContent, /another tab/);
  await two.enter("from tab two");
  one.page.type("first, edited");
  await one.press({ key: "Enter" });
  assert.equal(one.queued(), "first, edited\n\nfrom tab two");
  assert.match(one.ui.root.textContent, /another tab/);
  one.ui.dispose();
  two.ui.dispose();
});

test("Delete removes the whole queued prompt, even during an edit, and restores the draft", async () => {
  // Defect: delete leaving text behind or the edit text leaking into the composer.
  const t = await mount();
  t.page.startStreaming();
  await t.enter("gone soon");
  t.page.type("my draft");
  await t.click("head:edit");
  await t.click("head:delete");
  assert.equal(t.queued(), null);
  assert.equal(t.page.text(), "my draft", "the draft is back");
  assert.equal(t.ui.root.hidden, true, "nothing left to show");
});

test("the card never renders literal null/undefined, in any state", async () => {
  // Defect: the shipped view appended null children, which the DOM turns into the text `null`.
  const t = await mount({ dispatcher: new DryRunDispatcher() });
  noNullText(t.ui);
  t.page.startStreaming();
  t.page.type("x");
  await t.press({ key: "a" });
  noNullText(t.ui);
  await t.enter("x");
  noNullText(t.ui);
  await t.click("head:edit");
  noNullText(t.ui);
  await t.click("head:cancel");
  t.dispatcher.state = "generating";
  t.dispatcher.stopScript = [{ kind: "failed", code: "stop-button-missing", message: "no stop" }];
  await t.click("head:steer");
  noNullText(t.ui);
  assert.ok(t.$(".gs-q-note"), "the failure is shown as text");
});

test("while the response runs the card says `Waiting for response`; when Send is available the prompt goes out once", async () => {
  // Defect: the shipped queue reported `send-button-missing` instead of waiting.
  const t = await mount({ live: true, page: await fakePage({ sendOnlyWithText: true }) });
  t.page.startStreaming();
  await t.enter("A");
  await t.enter("B");
  for (let i = 0; i < 4; i++) await t.tick();
  assert.match(t.$(".gs-q-status").textContent, /Waiting for response/);
  assert.equal(t.$(".gs-q-note"), null, "no error while waiting");
  assert.deepEqual(t.page.log, []);
  t.page.finishStreaming();
  for (let i = 0; i < 4; i++) await t.tick();
  assert.deepEqual(t.page.sends(), ["send:A\n\nB"]);
  assert.equal(t.queued(), null);
});

test("Steer sends the whole text once: through the native control when the page has one, otherwise a confirmed stop and then one send", async () => {
  // Defect: steering with part of the text, or sending before the stop.
  const steerable = await mount({ live: true, page: await fakePage({ steer: true }) });
  steerable.page.startStreaming();
  await steerable.enter("A");
  await steerable.enter("B");
  await steerable.click("head:steer");
  assert.deepEqual(steerable.page.log, ["steer:A\n\nB"]);
  assert.equal(steerable.queued(), null);

  const plain = await mount({ live: true });
  plain.page.startStreaming();
  await plain.enter("A");
  await plain.enter("B");
  await plain.click("head:steer");
  assert.deepEqual(plain.page.log, ["stop", "send:A\n\nB"]);
  assert.equal(plain.queued(), null);
});

test("a Steer whose stop is not confirmed leaves the prompt queued with an actionable message and sends nothing", async () => {
  // Defect: an ambiguous stop turning into a send, or the error disappearing.
  const t = await mount({ live: true, page: await fakePage({ stopWorks: false }) });
  t.page.startStreaming();
  await t.enter("urgent");
  await t.click("head:steer");
  assert.deepEqual(t.page.log, ["stop"]);
  assert.equal(t.queued(), "urgent");
  assert.match(t.$(".gs-q-note").textContent, /not confirm|did not end|Nothing was sent|still be running/i);
});

test("an unacknowledged send needs review: the card offers Mark delivered / Restore, and nothing is sent again", async () => {
  // Defect: blind resend of an ambiguous message.
  const t = await mount({ live: true, page: await fakePage({ acknowledges: false }) });
  t.page.startStreaming();
  await t.enter("maybe");
  t.page.finishStreaming();
  for (let i = 0; i < 4; i++) await t.tick();
  assert.match(t.$(".gs-q-status").textContent, /Needs review/);
  assert.deepEqual(t.page.sends(), ["send:maybe"]);
  await t.click("inflight:restore");
  assert.equal(t.queued(), "maybe");
});

test("A -> B -> A: each conversation shows and keeps its own prompt; A's text is never shown in, or sent to, B", async () => {
  // Defect: UI bleed or a wrong-destination send after a client-side navigation.
  const t = await mount({ live: true });
  t.page.startStreaming();
  await t.enter("for A");
  await t.navigate("conv-b");
  assert.equal(t.queued(), null, "B starts empty");
  await t.enter("for B");
  assert.equal(t.queued(), "for B");
  t.page.finishStreaming();
  for (let i = 0; i < 4; i++) await t.tick();
  assert.deepEqual(t.page.sends(), ["send:for B"], "only B's own prompt went out on B's page");
  t.page.finishStreaming();
  await t.navigate("fixture");
  assert.equal(t.queued(), "for A", "A is restored exactly");
  for (let i = 0; i < 4; i++) await t.tick();
  assert.deepEqual(t.page.sends(), ["send:for B", "send:for A"]);
});

test("a navigation during an edit cancels it and gives the old page's composer its draft back", async () => {
  // Defect: the edit text leaking into the next conversation.
  const t = await mount();
  t.page.startStreaming();
  await t.enter("queued");
  t.page.type("draft");
  await t.click("head:edit");
  await t.navigate("conv-b");
  assert.equal(t.page.text(), "draft");
  assert.equal(t.queued(), null);
});

test("an idle card costs nothing: unchanged state means no repaint, and focus survives the poll", async () => {
  // Defect: whole-card repaints on every observation dropped focus and the caret.
  const t = await mount({ dispatcher: new DryRunDispatcher("generating") });
  t.page.startStreaming();
  await t.enter("x");
  await t.tick(); // the first pass settles the status line
  t.key("head:edit").focus();
  const records = [];
  const observer = new t.window.MutationObserver((r) => records.push(...r));
  observer.observe(t.ui.root, { childList: true, subtree: true, characterData: true, attributes: true });
  for (let i = 0; i < 5; i++) await t.tick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  observer.disconnect();
  assert.equal(records.length, 0);
  assert.equal(t.doc.activeElement, t.key("head:edit"));
});

test("dry run is labelled, and nothing it does reaches the page", async () => {
  const t = await mount({ dispatcher: new DryRunDispatcher() });
  t.page.startStreaming();
  await t.enter("x");
  assert.match(t.$(".gs-q-badge").textContent, /Dry run/);
});

test("a new unsaved chat is not intercepted", async () => {
  // Defect: swallowing Enter where there is no destination to queue to.
  const page = await fakePage();
  page.window.history.replaceState({}, "", "/");
  const t = await mount({ page });
  page.startStreaming();
  const event = await t.enter("hello");
  assert.equal(event.defaultPrevented, false);
  assert.equal(t.rows(), 0);
});

test("a Blocked card keeps Steer usable, and Retry works without a reload", async () => {
  // Defect: the owner's live bug: Blocked with Steer disabled and nothing to press but a reload.
  const t = await mount({ live: true, page: await fakePage({ editable: "contenteditable", sendOnlyWithText: true }) });
  t.page.startStreaming();
  await t.enter("held text");
  t.page.finishStreaming();
  t.page.fill = "never";
  for (let i = 0; i < 6; i++) await t.tick();
  assert.match(t.$(".gs-q-status").textContent, /Blocked/);
  assert.equal(t.key("head:steer").disabled, false);
  assert.deepEqual(t.page.log, []);

  t.page.fill = "now";
  await t.click("head:retry");
  assert.match(t.$(".gs-q-status").textContent, /Queued|Waiting/);
  for (let i = 0; i < 4; i++) await t.tick();
  assert.deepEqual(t.page.sends(), ["send:held text"], "Retry sent it without a reload");
  assert.equal(t.queued(), null);
});

// ---- persist across navigation, resume, hidden tab, sidebar markers -------------------------------------------

const status = (t) => t.$(".gs-q-status")?.textContent ?? null;

test("a prompt queued in A waits in the store while B is on screen and goes out when A is opened again and idle, never into B", async () => {
  // Defect: the queue held only for the conversation on screen, or sent A's text into whatever page was open.
  const t = await mount({ live: true, liveOptions: { arriveMs: 1200 } });
  t.page.holds("fixture");
  t.page.startStreaming();
  await t.enter("for A");
  assert.equal(t.queued(), "for A");

  await t.navigate("conv-b");
  t.page.holds("conv-b");
  t.page.finishStreaming(); // B is idle; A's own response ended while it was out of sight
  for (let i = 0; i < 5; i++) await t.tick();
  assert.deepEqual(t.page.sends(), [], "nothing is sent into B");
  assert.equal(t.queued(), null, "B shows no prompt of A");

  await t.navigate("fixture");
  t.page.holds("fixture");
  await t.tick();
  assert.equal(t.queued(), "for A", "A's prompt is back");
  assert.match(status(t), /load/i, "A's page has only just shown its turns: it is still loading");
  assert.deepEqual(t.page.sends(), []);
  for (let i = 0; i < 4; i++) await t.tick();
  assert.deepEqual(t.page.sends(), ["send:for A"], "once the conversation has loaded and is idle it goes out, once");
  assert.equal(t.queued(), null);
});

test("on returning to a conversation that is still answering, the queue keeps waiting and sends when the response ends", async () => {
  // Defect: sending into a response that was still running when the conversation was reopened.
  const t = await mount({ live: true, liveOptions: { arriveMs: 1200 } });
  t.page.holds("fixture");
  t.page.startStreaming();
  await t.enter("next");
  await t.navigate("conv-b");
  t.page.holds("conv-b");
  await t.navigate("fixture");
  t.page.holds("fixture"); // the page behind the route shows A again, still streaming
  for (let i = 0; i < 6; i++) await t.tick();
  assert.deepEqual(t.page.log, [], "no send and no stop");
  assert.match(status(t), /Waiting for response/);
  t.page.finishStreaming();
  for (let i = 0; i < 5; i++) await t.tick();
  assert.deepEqual(t.page.sends(), ["send:next"]);
});

test("the route changes before the page does: a page that still holds another conversation never gets the prompt, and the card says why", async () => {
  // Defect: the URL already named A while the page behind it was still B's, so A's text went into B.
  const t = await mount({ live: true, liveOptions: { arriveMs: 0 } });
  t.page.holds("fixture");
  t.page.startStreaming();
  await t.enter("for A");
  await t.navigate("conv-b");
  t.page.holds("conv-b");
  t.page.finishStreaming();
  await t.navigate("fixture"); // the URL is A's; the page still says B
  for (let i = 0; i < 6; i++) await t.tick();
  assert.deepEqual(t.page.log, [], "held: nothing staged, nothing clicked");
  assert.equal(t.page.text(), "", "the composer was not touched");
  assert.match(status(t), /Waiting for the conversation to open/);
  t.page.holds("fixture");
  for (let i = 0; i < 3; i++) await t.tick();
  assert.deepEqual(t.page.sends(), ["send:for A"]);
});

test("Send found by its label: ChatGPT's composer has no test ids, only a submit button called Send", async () => {
  // Defect (the owner's live report): "Send button did not become available" on a page whose Send has no data-testid.
  const t = await mount({ live: true, page: await fakePage({ sendLabel: true }) });
  assert.equal(chatgptAdapter.sendButton(t.doc).getAttribute("aria-label"), "Send");
  t.page.startStreaming();
  await t.enter("labelled");
  t.page.finishStreaming();
  for (let i = 0; i < 4; i++) await t.tick();
  assert.deepEqual(t.page.sends(), ["send:labelled"]);
  assert.equal(t.queued(), null);
});

/** A live queue whose every timer is worker-carried (virtual) while the window's own timers are frozen: a throttled hidden tab. */
async function hiddenTab({ ticker, observer }) {
  const page = await fakePage();
  const worker = new FakeWorker();
  if (!observer) page.window.MutationObserver = class { observe() {} disconnect() {} };
  const timers = createWorkerTimers({ win: page.window, createWorker: () => worker });
  const t = await mount({ page, live: true, liveOptions: { timers, arriveMs: 0, placeWaitMs: 60_000, sendWaitMs: 60_000, ackMs: 60_000, stopWaitMs: 60_000 }, uiOptions: { timers, hiddenPollMs: ticker ? 1000 : 0 } });
  page.holds("fixture");
  page.startStreaming();
  await t.enter("while hidden");
  const calls = freezeWindowTimers(page.window);
  setHidden(page.window, true);
  await t.ui.settled();
  // Five minutes and more pass hidden: the window's timers are gone (throttled), the clocks keep moving.
  t.t.now += 6 * 60_000;
  t.clock.advance(6 * 60_000);
  const pump = async (ms) => {
    for (let spent = 0; spent < ms; spent += 50) {
      worker.advance(50);
      await settle(6); // not `settled()`: the dispatch in progress is itself waiting for the next worker tick
    }
    await t.ui.settled();
  };
  return { t, page, worker, calls, pump };
}

test("a hidden tab for more than five minutes: the response ending wakes the queue at once and the prompt goes out, with the window's timers frozen", async () => {
  // Defect: dispatch rode on throttled window timers, so a queued prompt waited minutes after the response ended.
  const { t, page, calls, pump } = await hiddenTab({ ticker: false, observer: true });
  page.finishStreaming();
  await pump(2_000);
  assert.deepEqual(page.sends(), ["send:while hidden"], "sent exactly once");
  assert.equal(t.queued(), null);
  assert.deepEqual(calls.filter(([name]) => name === "setInterval"), [], "no window interval was needed");
});

test("a hidden tab where no observer can run: the worker ticker still finds the finished response", async () => {
  // Defect: a page policy that blocks the observer left a hidden queue with no way to notice the response ending.
  const { page, worker, pump } = await hiddenTab({ ticker: true, observer: false });
  assert.ok(worker.active() > 0, "the ticker runs while a prompt waits in a hidden tab");
  await pump(1_000);
  assert.deepEqual(page.sends(), [], "still answering: nothing sent");
  page.finishStreaming();
  await pump(3_000);
  assert.deepEqual(page.sends(), ["send:while hidden"]);
});

test("nothing runs while idle: with no queued prompt the hidden ticker and observer are off, and returning to the tab wakes the queue", async () => {
  // Defect: a polling loop burning CPU in the background with nothing to send.
  const page = await fakePage();
  const worker = new FakeWorker();
  const timers = createWorkerTimers({ win: page.window, createWorker: () => worker });
  const t = await mount({ page, live: true, liveOptions: { timers }, uiOptions: { timers, hiddenPollMs: 1000 } });
  setHidden(page.window, true);
  await t.ui.settled();
  assert.equal(worker.active(), 0, "no ticker for an empty queue");
  setHidden(page.window, false);
  page.holds("fixture");
  page.startStreaming();
  await t.enter("shown again");
  page.finishStreaming();
  await t.ui.wake();
  await t.ui.settled();
  for (let i = 0; i < 3; i++) await t.tick();
  assert.deepEqual(page.sends(), ["send:shown again"]);
});

test("a conversation with a queued prompt carries a pencil in the sidebar, the open one and the ones left behind; it follows the queue and survives a re-render", async () => {
  // Defect: a queue left in another conversation was invisible until you went back to it.
  const t = await mount({ dispatcher: new DryRunDispatcher("generating") });
  const rows = () => [...t.doc.querySelectorAll("[data-gs-queued]")].map((m) => m.closest("a").getAttribute("href"));
  t.page.sidebar(["fixture", "conv-b", "conv-c"]);
  t.page.startStreaming();
  await t.enter("here");
  assert.deepEqual(rows(), ["/c/fixture"], "the conversation on screen");

  await t.navigate("conv-b");
  await t.enter("there");
  assert.deepEqual(rows().sort(), ["/c/conv-b", "/c/fixture"], "A keeps its pencil while B is open");

  t.page.sidebar(["fixture", "conv-b", "conv-c"]); // ChatGPT re-renders its sidebar
  assert.deepEqual(rows(), []);
  await t.tick();
  assert.deepEqual(rows().sort(), ["/c/conv-b", "/c/fixture"], "put back on the next pass");

  await t.click("head:delete");
  assert.deepEqual(rows(), ["/c/fixture"], "deleting B's prompt takes B's pencil off");
  t.ui.dispose();
  assert.deepEqual(rows(), [], "disposing removes every marker");
});
