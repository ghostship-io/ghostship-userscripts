// Gate (a), queue level: fault injection through the dry-run dispatcher against the single accumulating prompt.
// Every scenario ends with the same two assertions: the dispatcher saw no protocol violation, and exactly the
// expected submits/stops happened (no duplicates, nothing lost).
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { A, B, settle, until } from "../queue-helpers.js";
import { createFixture, guardedWorld, installPageGuards, runBundle } from "./harness.js";

const clean = (w) => assert.deepEqual(w.dispatcher.violations, []);
const pending = async (engine, target = A) => (await engine.view(target)).pending;

test("stream in progress: A, B, C accumulate into one prompt; the queue waits, never stops on its own, and sends the merged text once after the response ends", async () => {
  const w = guardedWorld();
  const { engine } = await w.tab("T1");
  w.dispatcher.state = "generating";
  for (const part of ["A", "B", "C"]) await engine.append(A, { text: part });
  for (let i = 0; i < 60; i++) {
    w.clock.advance(1_000);
    assert.deepEqual(await engine.step(A), { kind: "waiting", reason: "generating" });
  }
  assert.equal(w.dispatcher.submits(), 0);
  assert.equal(w.dispatcher.stops(), 0);
  assert.equal((await pending(engine)).text, "A\n\nB\n\nC");
  w.dispatcher.finishGeneration();
  assert.equal((await engine.step(A)).kind, "sent");
  assert.deepEqual(w.dispatcher.sentTexts(), ["A\n\nB\n\nC"]);
  w.dispatcher.finishGeneration();
  assert.equal((await engine.step(A)).kind, "idle");
  assert.equal(w.dispatcher.submits(), 1);
  clean(w);
});

test("the response is over but native Send is unavailable: nothing is sent until it is, then exactly once", async () => {
  const w = guardedWorld();
  const { engine } = await w.tab("T1");
  await engine.append(A, { text: "a" });
  w.dispatcher.sendReady = false;
  for (let i = 0; i < 20; i++) assert.deepEqual(await engine.step(A), { kind: "waiting", reason: "send-unavailable" });
  assert.equal(w.dispatcher.submits(), 0);
  w.dispatcher.sendReady = true;
  assert.equal((await engine.step(A)).kind, "sent");
  assert.equal(w.dispatcher.submits(), 1);
  clean(w);
});

test("delayed stop acknowledgment: Interrupt & Send Next sends nothing until a stop is confirmed", async () => {
  const w = guardedWorld();
  const { engine } = await w.tab("T1");
  await engine.append(A, { text: "a" });
  await engine.append(A, { text: "b" });
  w.dispatcher.state = "generating";
  w.dispatcher.stopScript = ["hang"];
  const hung = engine.steer(A, { native: false });
  await until(() => w.dispatcher.stops() === 1);
  w.clock.advance(10_000);
  assert.equal((await hung).kind, "interrupt-failed");
  assert.equal(w.dispatcher.submits(), 0, "no submit without a confirmed stop");
  assert.equal((await pending(engine)).status, "pending");
  assert.equal((await engine.steer(A, { native: false })).kind, "sent");
  assert.equal(w.dispatcher.stops(), 2);
  assert.deepEqual(w.dispatcher.sentTexts(), ["a\n\nb"]);
  clean(w);
});

test("stop acknowledged but the response keeps running: nothing is sent", async () => {
  const w = guardedWorld();
  const { engine } = await w.tab("T1");
  await engine.append(A, { text: "a" });
  w.dispatcher.state = "generating";
  w.dispatcher.overrideState("generating", "generating");
  assert.equal((await engine.steer(A, { native: false })).kind, "interrupt-failed");
  assert.equal(w.dispatcher.submits(), 0);
});

test("native Steer sends the whole combined message once; with no native path, a confirmed stop and one send", async () => {
  const native = guardedWorld();
  native.dispatcher.state = "generating";
  native.dispatcher.steerAvailable = true;
  const one = await native.tab("T1");
  await one.engine.append(A, { text: "a" });
  await one.engine.append(A, { text: "b" });
  assert.equal((await one.engine.steer(A)).kind, "sent");
  assert.deepEqual(native.dispatcher.sentTexts(), ["a\n\nb"]);
  assert.equal(native.dispatcher.stops(), 0);
  clean(native);

  const fallback = guardedWorld();
  fallback.dispatcher.state = "generating";
  const two = await fallback.tab("T1");
  await two.engine.append(A, { text: "a" });
  await two.engine.append(A, { text: "b" });
  assert.equal((await two.engine.steer(A)).kind, "sent");
  assert.deepEqual(fallback.dispatcher.actions().map((x) => x.split(":")[0]), ["stop", "submit"]);
  assert.deepEqual(fallback.dispatcher.sentTexts(), ["a\n\nb"]);
  clean(fallback);
});

for (const [name, script] of [
  ["thrown error", [new Error("socket closed")]],
  ["no answer", ["hang"]],
  ["explicit uncertain result", [{ kind: "uncertain", code: "no-ack", message: "?" }]],
]) {
  test(`ambiguous submit (${name}): quarantined, never resent automatically; later text waits behind it, kept apart`, async () => {
    const w = guardedWorld();
    const { engine } = await w.tab("T1");
    await engine.append(A, { text: "first" });
    w.dispatcher.submitScript = script;
    const first = engine.step(A);
    await until(() => w.dispatcher.submits() === 1);
    w.clock.advance(10_000);
    assert.equal((await first).kind, "manual-review");
    await engine.append(A, { text: "second" });
    for (let i = 0; i < 4; i++) {
      w.clock.advance(60_000);
      w.dispatcher.finishGeneration();
      assert.equal((await engine.step(A)).kind, "halted");
    }
    assert.equal(w.dispatcher.submits(), 1);
    assert.equal((await pending(engine)).text, "second", "never mixed with the uncertain message");
    clean(w);
  });
}

test("a rejected send (nothing left the page): the text is kept, the prompt is held, and there is no automatic retry", async () => {
  const w = guardedWorld();
  const { engine } = await w.tab("T1");
  await engine.append(A, { text: "a" });
  w.dispatcher.submitScript = [{ kind: "rejected", code: "send-unavailable", message: "no Send", action: "check" }];
  assert.equal((await engine.step(A)).kind, "rejected");
  for (let i = 0; i < 12; i++) {
    w.clock.advance(60_000);
    assert.equal((await engine.step(A)).kind, "halted");
  }
  assert.equal(w.dispatcher.submits(), 1);
  assert.equal((await pending(engine)).text, "a");
  clean(w);
});

test("reload mid-send: the restarted tab quarantines the unreported send and resends nothing", async () => {
  const w = guardedWorld();
  const first = await w.tab("T1");
  await first.engine.append(A, { text: "a" });
  w.dispatcher.submitScript = ["hang"];
  void first.engine.step(A); // this tab dies here
  await until(() => w.dispatcher.submits() === 1);
  w.clock.advance(60_000); // its lease expires
  const reloaded = await w.tab("T1-reloaded");
  w.dispatcher.finishGeneration();
  assert.equal((await reloaded.engine.step(A)).kind, "halted");
  const view = await reloaded.engine.view(A);
  assert.equal(view.inflight.status, "manual-review");
  assert.equal(w.dispatcher.submits(), 1);
  clean(w);
});

test("duplicate tabs: three tabs racing a long accumulation submit each snapshot exactly once, never losing a late contribution", async () => {
  const w = guardedWorld();
  const tabs = [await w.tab("T1"), await w.tab("T2"), await w.tab("T3")];
  const contributions = [];
  for (let i = 0; i < 6; i++) {
    const text = `m${i}`;
    contributions.push(text);
    await tabs[i % 3].engine.append(A, { text });
    await Promise.all(tabs.map((t) => t.engine.step(A)));
    w.dispatcher.finishGeneration();
    w.clock.advance(1_000);
    await settle(2);
  }
  for (let round = 0; round < 10; round++) {
    await Promise.all(tabs.map((t) => t.engine.step(A)));
    w.dispatcher.finishGeneration();
  }
  const sent = w.dispatcher.sentTexts().flatMap((t) => t.split("\n\n"));
  assert.deepEqual([...sent].sort(), [...contributions].sort(), "every contribution sent exactly once");
  assert.equal(w.dispatcher.stops(), 0);
  clean(w);
});

test("duplicate tabs: a racing Interrupt & Send Next from two tabs stops once and submits once", async () => {
  const w = guardedWorld();
  const [a, b] = [await w.tab("T1"), await w.tab("T2")];
  await a.engine.append(A, { text: "next" });
  w.dispatcher.state = "generating";
  const [x, y] = await Promise.all([a.engine.steer(A, { native: false }), b.engine.steer(A, { native: false })]);
  assert.deepEqual([x.kind, y.kind].sort(), ["not-leader", "sent"]);
  assert.equal(w.dispatcher.stops(), 1);
  assert.equal(w.dispatcher.submits(), 1);
  clean(w);
});

test("A and B stay separate through A -> B -> A, concurrent appends from two tabs and a lease handoff: no lost text, no wrong destination", async () => {
  const w = guardedWorld();
  const [one, two] = [await w.tab("T1"), await w.tab("T2")];
  w.dispatcher.state = "generating";
  await Promise.all([one.engine.append(A, { text: "a1" }), two.engine.append(A, { text: "a2" }), one.engine.append(B, { text: "b1" }), two.engine.append(B, { text: "b2" })]);
  await one.engine.append(A, { text: "a3" });
  w.dispatcher.finishGeneration();
  assert.equal((await one.engine.step(A)).kind, "sent");
  assert.equal((await two.engine.step(A)).kind, "idle");
  w.clock.advance(60_000);
  w.dispatcher.finishGeneration();
  assert.equal((await two.engine.step(B)).kind, "sent");
  const sent = w.dispatcher.log.filter((e) => e.type === "submit").map((e) => [e.request.conversationId, [...e.request.text.split("\n\n")].sort().join("+")]);
  assert.deepEqual(sent.sort(), [["conv-A", "a1+a2+a3"], ["conv-B", "b1+b2"]]);
  clean(w);
});

test("failed attachments: a prompt whose files cannot be restored is held, nothing is sent, and the text is kept", async () => {
  const w = guardedWorld();
  const { engine } = await w.tab("T1");
  const file = { name: "f.png", size: 1, type: "image/png", restorable: false };
  await engine.append(A, { text: "see file", attachments: [file] });
  await engine.append(A, { text: "and this" });
  for (let i = 0; i < 3; i++) assert.equal((await engine.step(A)).kind, "halted");
  assert.equal((await engine.steer(A, { native: false })).kind, "halted");
  assert.equal(w.dispatcher.submits(), 0);
  assert.equal(w.dispatcher.stops(), 0);
  const held = await pending(engine);
  assert.deepEqual(held.attachments, [file]);
  assert.equal(held.text, "see file\n\nand this");
  clean(w);
});

test("cancellation: a deleted prompt is never sent; one being sent keeps its text while a new one starts", async () => {
  const w = guardedWorld();
  const { engine } = await w.tab("T1");
  await engine.append(A, { text: "a" });
  await engine.remove(A);
  assert.equal((await engine.step(A)).kind, "idle");
  await engine.append(A, { text: "b" });
  w.dispatcher.submitScript = ["hang"];
  const sending = engine.step(A);
  await until(() => w.dispatcher.submits() === 1);
  await engine.append(A, { text: "c" });
  assert.equal((await engine.view(A)).inflight.text, "b");
  assert.equal((await pending(engine)).text, "c");
  w.clock.advance(10_000);
  await sending;
  assert.deepEqual(w.dispatcher.sentTexts(), ["b"], "the deleted prompt never left");
  clean(w);
});

test("persist and resume: a prompt queued in A is untouched while B is on screen and goes out once, into A, when A is back and idle", async () => {
  const w = guardedWorld();
  const { engine } = await w.tab("T1");
  w.dispatcher.state = "generating";
  await engine.append(A, { text: "left behind" });
  assert.deepEqual(await engine.step(A), { kind: "waiting", reason: "generating" });
  // The owner moves to B, which is idle and has nothing queued: only B is ever stepped, A's record just waits.
  w.dispatcher.finishGeneration();
  for (let i = 0; i < 30; i++) {
    w.clock.advance(60_000);
    assert.deepEqual(await engine.step(B), { kind: "idle" });
  }
  assert.equal(w.dispatcher.submits(), 0, "nothing is sent while A is not on screen");
  assert.equal((await pending(engine)).text, "left behind", "A's prompt is still there, unchanged");
  assert.deepEqual([...(await engine.queuedConversations(A.accountId))], [A.conversationId], "and flagged for the sidebar");
  // A is opened again, its response long over.
  assert.equal((await engine.step(A)).kind, "sent");
  assert.deepEqual(w.dispatcher.sentTexts(), ["left behind"]);
  assert.deepEqual(w.dispatcher.log.map((e) => e.request.conversationId), [A.conversationId], "into A, never B");
  assert.equal(w.dispatcher.stops(), 0);
  w.dispatcher.finishGeneration();
  assert.equal((await engine.step(A)).kind, "idle");
  assert.equal(w.dispatcher.submits(), 1, "exactly once");
  clean(w);
});

test("legacy multi-row queues are consolidated in order without resending anything (bundled store, fake IndexedDB)", async () => {
  const factory = new IDBFactory();
  const open = factory.open("ghostship-chatgpt-queue", 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore("items", { keyPath: "id" }).createIndex("conversationId", "conversationId");
    db.createObjectStore("queues", { keyPath: "conversationId" });
    db.createObjectStore("leases", { keyPath: "conversationId" });
  };
  const db = await new Promise((resolve) => (open.onsuccess = () => resolve(open.result)));
  const row = (id, position, status) => ({ id, conversationId: "conv-A", text: id, attachments: [], status, position, version: 1, attempts: 0, createdAt: 1, updatedAt: 1 });
  await new Promise((resolve) => {
    const tx = db.transaction("items", "readwrite");
    [row("sent-one", 0, "sent"), row("one", 1, "pending"), row("two", 2, "pending"), row("three", 3, "pending")].forEach((r) => tx.objectStore("items").put(r));
    tx.oncomplete = resolve;
  });
  db.close();
  const w = guardedWorld();
  w.factory = factory;
  const { engine } = await w.tab("T1");
  const legacy = { accountId: "unknown", conversationId: "conv-A" };
  assert.equal((await pending(engine, legacy)).text, "one\n\ntwo\n\nthree");
  assert.equal(w.dispatcher.submits(), 0, "the upgrade sends nothing");
  clean(w);
});

test("component rerender and virtualized jumps during a drain: queue and page stay consistent, nothing extra is sent", async () => {
  const { createRuntime } = await import("../../src/core/runtime.js");
  const { createTurnBackend } = await import("../../src/chatgpt/virtualization/backend.js");
  const { chatgptAdapter } = await import("../../src/chatgpt/adapter.js");
  const { DEFAULTS } = await import("../../src/core/config.js");
  const fx = createFixture({ turns: 40 });
  const page = installPageGuards(fx);
  const backend = createTurnBackend();
  const runtime = createRuntime({ win: fx.win, adapter: chatgptAdapter, backend, config: { ...DEFAULTS } });
  await fx.settle();
  assert.equal(runtime.mode, "active");

  const w = guardedWorld();
  const { engine } = await w.tab("T1");
  const contributions = ["a", "b", "c"];
  for (let round = 0; round < 3; round++) {
    await engine.append(A, { text: contributions[round] });
    await engine.step(A);
    fx.remount(); // React re-renders every turn node
    await fx.settle();
    const before = fx.rawTop();
    assert.equal(backend.setWindow(5 + round * 10), true); // direct navigation to an old turn
    await fx.settle();
    assert.notEqual(fx.rawTop(), before, "the explicit jump really moved the viewport");
    w.dispatcher.finishGeneration();
  }
  assert.deepEqual(w.dispatcher.sentTexts(), contributions);
  assert.equal(page.isClean(), true, JSON.stringify(page.report()));
  assert.equal(runtime.mode, "active");
  clean(w);
  runtime.dispose();
});

test("bundle: Enter while generating queues in the native composer; no native Send/Stop click, form submit or network request", async () => {
  const fx = createFixture({ turns: 6 });
  const guards = installPageGuards(fx);
  fx.win.indexedDB = new IDBFactory();
  fx.doc.body.insertAdjacentHTML("afterbegin", '<nav><a href="/c/fixture"><span data-thread-title="true">here</span></a><a href="/c/elsewhere"><span data-thread-title="true">there</span></a></nav>');
  runBundle(fx);
  await fx.settle();
  const input = fx.doc.querySelector("#prompt-textarea");
  const panel = () => fx.doc.querySelector("[data-gs-queue]");
  await until(() => panel() !== null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (const part of ["first thought", "second thought"]) {
    input.value = part;
    input.dispatchEvent(new fx.win.Event("input", { bubbles: true }));
    const enter = new fx.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, true);
    await until(() => input.value === "");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await until(() => panel().querySelector(".gs-q-text")?.textContent === "first thought\n\nsecond thought");
  assert.equal(panel().querySelectorAll(".gs-q-text").length, 1);
  assert.equal(panel().querySelector("textarea"), null, "no separate input");
  assert.doesNotMatch(panel().textContent, /\bnull\b|\bundefined\b/);
  // The card is the bubble with three small icons below its text; the sidebar row of the conversation carries a pencil.
  assert.deepEqual([...panel().querySelectorAll("button")].map((b) => b.getAttribute("data-gs-key")), ["head:edit", "head:delete", "head:steer"]);
  assert.equal(panel().firstElementChild.className, "gs-q-text");
  assert.equal(fx.doc.querySelectorAll("a[href='/c/fixture'] [data-gs-queued]").length, 1);
  assert.equal(fx.doc.querySelectorAll("a[href='/c/elsewhere'] [data-gs-queued]").length, 0);
  assert.deepEqual(guards.report(), { nativeClicks: [], formSubmits: 0, network: [] });
  fx.win.close(); // the queue polls on a timer; closing the window stops it
});
