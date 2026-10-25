// Gate (a), queue level: fault injection through the dry-run dispatcher. Every
// scenario ends with the same two assertions: the dispatcher saw no protocol
// violation, and exactly the expected submits/stops happened (no duplicates).
import test from "node:test";
import assert from "node:assert/strict";
import { CONV, settle, until } from "../queue-helpers.js";
import { createFixture, guardedWorld, installPageGuards } from "./harness.js";

const clean = (w) => assert.deepEqual(w.dispatcher.violations, []);

test("stream in progress: the queue waits, never stops on its own, and sends once after the response ends", async () => {
  const w = guardedWorld();
  const { engine } = await w.tab("A");
  w.dispatcher.state = "generating";
  const a = await engine.enqueue(CONV, { text: "a" });
  for (let i = 0; i < 5; i++) assert.deepEqual(await engine.step(CONV), { kind: "waiting", reason: "generating" });
  assert.equal(w.dispatcher.submits(), 0);
  assert.equal(w.dispatcher.stops(), 0);
  w.dispatcher.finishGeneration();
  assert.deepEqual(await engine.step(CONV), { kind: "sent", itemId: a.id });
  assert.equal(w.dispatcher.submits(a.id), 1);
  clean(w);
});

test("delayed stop acknowledgment: Interrupt & Send Next sends nothing until a stop is confirmed", async () => {
  const w = guardedWorld();
  const { engine } = await w.tab("A");
  const a = await engine.enqueue(CONV, { text: "a" });
  w.dispatcher.state = "generating";
  w.dispatcher.stopScript = ["hang"];
  const pending = engine.interruptAndSendNext(CONV);
  await until(() => w.dispatcher.stops() === 1);
  w.clock.advance(10_000);
  assert.equal((await pending).kind, "interrupt-failed");
  assert.equal(w.dispatcher.submits(), 0, "no submit without a confirmed stop");
  assert.equal((await engine.list(CONV)).items[0].status, "pending");
  assert.deepEqual(await engine.interruptAndSendNext(CONV), { kind: "sent", itemId: a.id });
  assert.equal(w.dispatcher.stops(), 2);
  assert.equal(w.dispatcher.submits(a.id), 1);
  clean(w);
});

test("stop acknowledged but the response keeps running: nothing is sent", async () => {
  const w = guardedWorld();
  const { engine } = await w.tab("A");
  await engine.enqueue(CONV, { text: "a" });
  w.dispatcher.state = "generating";
  w.dispatcher.overrideState("generating", "generating");
  const outcome = await engine.interruptAndSendNext(CONV);
  assert.equal(outcome.kind, "interrupt-failed");
  assert.equal(w.dispatcher.submits(), 0);
});

for (const [name, script] of [
  ["thrown error", [new Error("socket closed")]],
  ["no answer", ["hang"]],
  ["explicit uncertain result", [{ kind: "uncertain", code: "no-ack", message: "?" }]],
]) {
  test(`ambiguous submit (${name}): quarantined for the user, never resent automatically, the queue halts behind it`, async () => {
    const w = guardedWorld();
    const { engine } = await w.tab("A");
    const a = await engine.enqueue(CONV, { text: "a" });
    const b = await engine.enqueue(CONV, { text: "b" });
    w.dispatcher.submitScript = script;
    const first = engine.step(CONV);
    await until(() => w.dispatcher.submits() === 1);
    w.clock.advance(10_000);
    assert.deepEqual(await first, { kind: "manual-review", itemId: a.id });
    for (let i = 0; i < 4; i++) {
      w.clock.advance(60_000);
      w.dispatcher.finishGeneration();
      assert.equal((await engine.step(CONV)).kind, "halted");
    }
    assert.equal(w.dispatcher.submits(), 1);
    assert.equal(w.dispatcher.submits(b.id), 0, "later prompts do not jump a prompt of unknown fate");
    clean(w);
  });
}

test("network loss: bounded retries with backoff, never before notBefore, then failed (no endless loop)", async () => {
  const w = guardedWorld();
  const { engine } = await w.tab("A");
  const a = await engine.enqueue(CONV, { text: "a" });
  const lost = { kind: "rejected", code: "network", message: "offline", retryable: true };
  w.dispatcher.submitScript = [lost, lost, lost, lost, lost];
  const kinds = [];
  for (let i = 0; i < 12; i++) {
    const out = await engine.step(CONV);
    kinds.push(out.kind);
    if (out.kind === "waiting" && out.reason === "backoff") w.clock.advance(out.until - w.clock.now());
    if (out.kind === "failed") break;
  }
  assert.equal(kinds.at(-1), "failed");
  assert.equal(w.dispatcher.submits(a.id), 3, "maxAttempts, no more");
  assert.equal((await engine.step(CONV)).kind, "halted", "a failed item is not retried without the user");
  assert.equal(w.dispatcher.submits(a.id), 3);
  clean(w);
});

test("reload mid-send: the restarted tab quarantines the unreported send and resends nothing", async () => {
  const w = guardedWorld();
  const first = await w.tab("A");
  const a = await first.engine.enqueue(CONV, { text: "a" });
  const b = await first.engine.enqueue(CONV, { text: "b" });
  w.dispatcher.submitScript = ["hang"];
  void first.engine.step(CONV); // this tab dies here
  await until(() => w.dispatcher.submits() === 1);
  w.clock.advance(60_000); // its lease expires
  const reloaded = await w.tab("A-reloaded");
  w.dispatcher.finishGeneration();
  assert.equal((await reloaded.engine.step(CONV)).kind, "halted");
  const items = (await reloaded.engine.list(CONV)).items;
  assert.deepEqual(items.map((i) => [i.id, i.status]), [[a.id, "manual-review"], [b.id, "pending"]]);
  assert.equal(w.dispatcher.submits(), 1);
  clean(w);
});

test("duplicate tabs: three tabs racing a long queue submit every item exactly once", async () => {
  const w = guardedWorld();
  const tabs = [await w.tab("A"), await w.tab("B"), await w.tab("C")];
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push((await tabs[0].engine.enqueue(CONV, { text: `m${i}` })).id);
  for (let round = 0; round < 40; round++) {
    await Promise.all(tabs.map((t) => t.engine.step(CONV)));
    w.dispatcher.finishGeneration();
    w.clock.advance(1_000);
    await settle(2);
  }
  for (const id of ids) assert.equal(w.dispatcher.submits(id), 1, `item ${id}`);
  assert.deepEqual(w.dispatcher.actions(), ids.map((id) => `submit:${id}`), "in queue order");
  assert.equal(w.dispatcher.stops(), 0);
  clean(w);
});

test("duplicate tabs: a racing Interrupt & Send Next from two tabs stops once and submits once", async () => {
  const w = guardedWorld();
  const [a, b] = [await w.tab("A"), await w.tab("B")];
  const item = await a.engine.enqueue(CONV, { text: "next" });
  w.dispatcher.state = "generating";
  const [x, y] = await Promise.all([a.engine.interruptAndSendNext(CONV), b.engine.interruptAndSendNext(CONV)]);
  assert.deepEqual([x.kind, y.kind].sort(), ["not-leader", "sent"]);
  assert.equal(w.dispatcher.stops(), 1);
  assert.equal(w.dispatcher.submits(item.id), 1);
  clean(w);
});

test("failed attachments: a message whose files cannot be restored is held, nothing is sent", async () => {
  const w = guardedWorld();
  const { engine } = await w.tab("A");
  const a = await engine.enqueue(CONV, { text: "see file", attachments: [{ name: "f.png", size: 1, type: "image/png", restorable: false }] });
  for (let i = 0; i < 3; i++) assert.equal((await engine.step(CONV)).kind, "halted");
  assert.equal((await engine.interruptAndSendNext(CONV)).kind, "halted");
  assert.equal(w.dispatcher.submits(), 0);
  assert.equal(w.dispatcher.stops(), 0);
  await engine.reattach(a.id, [{ name: "f.png", size: 1, type: "image/png", restorable: true }]);
  assert.deepEqual(await engine.step(CONV), { kind: "sent", itemId: a.id });
  clean(w);
});

test("cancellation: a removed or paused item is never sent; one being sent cannot be cancelled", async () => {
  const w = guardedWorld();
  const { engine } = await w.tab("A");
  const a = await engine.enqueue(CONV, { text: "a" });
  const b = await engine.enqueue(CONV, { text: "b" });
  await engine.pause(CONV);
  assert.deepEqual(await engine.step(CONV), { kind: "paused" });
  await engine.remove(a.id);
  await engine.resume(CONV);
  w.dispatcher.submitScript = ["hang"];
  const sending = engine.step(CONV);
  await until(() => w.dispatcher.submits() === 1);
  await assert.rejects(engine.remove(b.id), { code: "item-locked" });
  w.clock.advance(10_000);
  await sending;
  assert.equal(w.dispatcher.submits(a.id), 0, "the cancelled prompt never left");
  assert.equal(w.dispatcher.submits(b.id), 1);
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
  const { engine } = await w.tab("A");
  const ids = [(await engine.enqueue(CONV, { text: "a" })).id, (await engine.enqueue(CONV, { text: "b" })).id, (await engine.enqueue(CONV, { text: "c" })).id];
  for (let round = 0; round < 3; round++) {
    await engine.step(CONV);
    fx.remount(); // React re-renders every turn node
    await fx.settle();
    const before = fx.rawTop();
    assert.equal(backend.setWindow(5 + round * 10), true); // direct navigation to an old turn
    await fx.settle();
    assert.notEqual(fx.rawTop(), before, "the explicit jump really moved the viewport");
    w.dispatcher.finishGeneration();
  }
  assert.deepEqual(w.dispatcher.actions(), ids.map((id) => `submit:${id}`));
  assert.equal(page.isClean(), true, JSON.stringify(page.report()));
  assert.equal(runtime.mode, "active");
  clean(w);
  runtime.dispose();
});
