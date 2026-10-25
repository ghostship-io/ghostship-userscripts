import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DryRunDispatcher } from "../src/chatgpt/queue/dispatch.js";
import { CONV, World, settle, until } from "./queue-helpers.js";

const texts = async (tab) => (await tab.engine.list(CONV)).items.map((i) => `${i.text}:${i.status}`);

describe("ordering and sequential drain", () => {
  it("sends items in queue order, one per idle step, and never stops a running response", async () => {
    // Defect: draining out of order, sending while generating, or interrupting to drain.
    const w = new World();
    const { engine } = await w.tab("A");
    const a = await engine.enqueue(CONV, { text: "a" });
    const b = await engine.enqueue(CONV, { text: "b" });
    const c = await engine.enqueue(CONV, { text: "c" });
    await engine.move(c.id, 0); // c, a, b

    assert.deepEqual(await engine.step(CONV), { kind: "sent", itemId: c.id });
    assert.deepEqual(await engine.step(CONV), { kind: "waiting", reason: "generating" });
    w.dispatcher.finishGeneration();
    assert.deepEqual(await engine.step(CONV), { kind: "sent", itemId: a.id });
    w.dispatcher.finishGeneration();
    assert.deepEqual(await engine.step(CONV), { kind: "sent", itemId: b.id });
    w.dispatcher.finishGeneration();
    assert.deepEqual(await engine.step(CONV), { kind: "idle" });
    assert.deepEqual(w.dispatcher.actions(), [`submit:${c.id}`, `submit:${a.id}`, `submit:${b.id}`]);
  });

  it("moves an item to any index and rejects a bad index or a reorder during a send", async () => {
    // Defect: reorder corrupting positions or racing a claimed item.
    const w = new World();
    const { engine } = await w.tab("A");
    const [a, b, c] = [
      await engine.enqueue(CONV, { text: "a" }),
      await engine.enqueue(CONV, { text: "b" }),
      await engine.enqueue(CONV, { text: "c" }),
    ];
    await engine.move(a.id, 2);
    assert.deepEqual(await texts({ engine }), ["b:pending", "c:pending", "a:pending"]);
    await engine.move(a.id, 0);
    assert.deepEqual(await texts({ engine }), ["a:pending", "b:pending", "c:pending"]);
    await assert.rejects(engine.move(b.id, 3), { code: "invalid-order" });
    await engine.step(CONV); // a is now sent; reorder only concerns unsent items
    await engine.move(c.id, 0);
    assert.deepEqual(await texts({ engine }), ["a:sent", "c:pending", "b:pending"]);
  });
});

describe("edit, remove, pause", () => {
  it("sends the edited text, locks items being sent, and honors pause/resume", async () => {
    // Defect: stale text sent after an edit; edit of an in-flight item; pause ignored.
    const w = new World();
    const { engine } = await w.tab("A");
    const a = await engine.enqueue(CONV, { text: "old" });
    const b = await engine.enqueue(CONV, { text: "b" });
    await engine.edit(a.id, { text: "new" });
    await engine.pause(CONV);
    assert.deepEqual(await engine.step(CONV), { kind: "paused" });
    assert.deepEqual(w.dispatcher.log, []);
    await engine.resume(CONV);
    w.dispatcher.submitScript = ["hang"];
    const sending = engine.step(CONV);
    await until(() => w.dispatcher.log.length === 1);
    assert.equal(w.dispatcher.log[0].request.text, "new");
    await assert.rejects(engine.edit(a.id, { text: "x" }), { code: "item-locked" });
    await assert.rejects(engine.remove(a.id), { code: "item-locked" });
    await engine.remove(b.id);
    w.clock.advance(10_000);
    assert.deepEqual(await sending, { kind: "manual-review", itemId: a.id });
  });
});

describe("restart persistence", () => {
  it("keeps items, order and pause across a restart, and quarantines a send the dead tab never reported", async () => {
    // Defect: lost queue on reload; auto-resend of an item whose delivery is unknown after a crash.
    const w = new World();
    const first = await w.tab("A");
    const a = await first.engine.enqueue(CONV, {
      text: "a",
      attachments: [{ name: "f.png", size: 1, type: "image/png", restorable: false }],
    });
    const b = await first.engine.enqueue(CONV, { text: "b" });
    const c = await first.engine.enqueue(CONV, { text: "c" });
    await first.engine.move(c.id, 0);
    await first.engine.pause(CONV);
    first.store.close();

    const second = await w.tab("A");
    const view = await second.engine.list(CONV);
    assert.equal(view.paused, true);
    assert.deepEqual(
      view.items.map((i) => [i.id, i.status]),
      [
        [c.id, "pending"],
        [a.id, "blocked"],
        [b.id, "pending"],
      ],
    );
    assert.equal(view.items[1].lastError?.code, "attachments-not-restorable");

    // crash mid-send: tab A claims c, dies without recording a result.
    await second.engine.resume(CONV);
    w.dispatcher.submitScript = ["hang"];
    void second.engine.step(CONV);
    await until(() => w.dispatcher.log.length === 1);
    second.store.close();

    w.clock.advance(20_000); // lease expires
    const third = await w.tab("A", {}, new DryRunDispatcher());
    const outcome = await third.engine.step(CONV);
    assert.deepEqual(outcome, { kind: "halted", itemId: c.id, status: "manual-review" });
    assert.equal((await third.engine.list(CONV)).items[0].lastError?.code, "orphaned-send");
  });

  it("holds the queue at a blocked item until files are reattached", async () => {
    // Defect: sending a message whose attachments cannot be restored, or skipping past it.
    const w = new World();
    const { engine } = await w.tab("A");
    const a = await engine.enqueue(CONV, {
      text: "a",
      attachments: [{ name: "f.png", size: 1, type: "image/png", restorable: false }],
    });
    await engine.enqueue(CONV, { text: "b" });
    assert.deepEqual(await engine.step(CONV), { kind: "halted", itemId: a.id, status: "blocked" });
    await engine.reattach(a.id, [{ name: "f.png", size: 1, type: "image/png", restorable: true }]);
    assert.deepEqual(await engine.step(CONV), { kind: "sent", itemId: a.id });
  });
});

describe("duplicate tabs", () => {
  it("lets one tab send; the other is refused until the lease expires, then recovers without double-sending", async () => {
    // Defect: two tabs sending the same queue; a dead sender's lease never expiring.
    const w = new World();
    const a = await w.tab("A");
    const b = await w.tab("B");
    await a.engine.enqueue(CONV, { text: "a" });
    await a.engine.enqueue(CONV, { text: "b" });

    const [ra, rb] = await Promise.all([a.engine.step(CONV), b.engine.step(CONV)]);
    const results = [ra, rb];
    assert.equal(results.filter((r) => r.kind === "sent").length, 1);
    assert.equal(results.filter((r) => r.kind === "not-leader").length, 1);
    assert.equal(w.dispatcher.log.length, 1);

    // The non-leader keeps being refused while the leader's lease is live.
    w.dispatcher.finishGeneration();
    const loser = ra.kind === "sent" ? b : a;
    const winner = ra.kind === "sent" ? a : b;
    assert.equal((await loser.engine.step(CONV)).kind, "not-leader");

    // Leader dies silently; after expiry the other tab takes over and continues.
    w.clock.advance(15_001);
    assert.equal((await loser.engine.step(CONV)).kind, "sent");
    assert.equal(w.dispatcher.log.length, 2);
    assert.notEqual(w.dispatcher.log[0].request.itemId, w.dispatcher.log[1].request.itemId);
    // A revived stale leader is fenced out and cannot send.
    w.dispatcher.finishGeneration();
    assert.equal((await winner.engine.step(CONV)).kind, "not-leader");
  });

  it("fences a sender whose lease was taken over between its lease check and its claim", async () => {
    // Defect: a stale tab claiming and sending an item after another tab took the lease.
    const w = new World();
    const a = await w.tab("A");
    const b = await w.tab("B");
    await a.engine.enqueue(CONV, { text: "a" });
    const readState = w.dispatcher.readState.bind(w.dispatcher);
    w.dispatcher.readState = async () => {
      const state = await readState();
      w.clock.advance(15_001); // A stalls past its lease; B takes over
      assert.equal(await b.engine.heartbeat(CONV), true);
      return state;
    };
    assert.equal((await a.engine.step(CONV)).kind, "not-leader");
    assert.deepEqual(w.dispatcher.log, []);
    assert.equal((await a.engine.list(CONV)).items[0].status, "pending");
  });
});

describe("Interrupt & Send Next", () => {
  const setup = async () => {
    const w = new World();
    const { engine } = await w.tab("A");
    const a = await engine.enqueue(CONV, { text: "a" });
    const b = await engine.enqueue(CONV, { text: "b" });
    w.dispatcher.state = "generating";
    return { w, engine, a, b };
  };

  it("submits exactly the next item, and only after the stop is confirmed", async () => {
    // Defect: sending before the stop lands, or sending more than one item.
    const { w, engine, a } = await setup();
    const out = await engine.interruptAndSendNext(CONV);
    assert.deepEqual(out, { kind: "sent", itemId: a.id });
    assert.deepEqual(w.dispatcher.actions(), ["stop", `submit:${a.id}`]);
    assert.deepEqual(await texts({ engine }), ["a:sent", "b:pending"]);
  });

  it("without a running response just sends the next item, no stop", async () => {
    // Defect: stopping when there is nothing to stop.
    const { w, engine, a } = await setup();
    w.dispatcher.state = "idle";
    await engine.interruptAndSendNext(CONV);
    assert.deepEqual(w.dispatcher.actions(), [`submit:${a.id}`]);
  });

  for (const [name, stop, code] of [
    ["fails", { kind: "failed", code: "stop-rejected", message: "button missing" }, "stop-rejected"],
    ["is ambiguous", { kind: "ambiguous", code: "stop-unclear", message: "?" }, "stop-unclear"],
    ["throws", new Error("boom"), "stop-threw"],
  ]) {
    it(`leaves the item pending with an actionable error when the stop ${name}`, async () => {
      // Defect: sending after an unconfirmed interrupt.
      const { w, engine, a } = await setup();
      w.dispatcher.stopScript = [stop];
      const out = await engine.interruptAndSendNext(CONV);
      assert.equal(out.kind, "interrupt-failed");
      assert.equal(out.error.code, code);
      assert.deepEqual(w.dispatcher.actions(), ["stop"]);
      const item = (await engine.list(CONV)).items[0];
      assert.equal(item.id, a.id);
      assert.equal(item.status, "pending");
      assert.ok(item.lastError.action.length > 0);
    });
  }

  it("leaves the item pending when the stop times out", async () => {
    // Defect: an unacknowledged stop treated as success.
    const { w, engine } = await setup();
    w.dispatcher.stopScript = ["hang"];
    const pending = engine.interruptAndSendNext(CONV);
    await until(() => w.dispatcher.log.length === 1);
    w.clock.advance(10_000);
    const out = await pending;
    assert.equal(out.kind, "interrupt-failed");
    assert.equal(out.error.code, "stop-timeout");
    assert.deepEqual(w.dispatcher.actions(), ["stop"]);
  });

  it("does not send when a confirmed stop still reads as generating", async () => {
    // Defect: trusting the stop acknowledgment without confirming the conversation is idle.
    const { w, engine } = await setup();
    w.dispatcher.overrideState("generating", "generating"); // pre-check, post-stop check
    const out = await engine.interruptAndSendNext(CONV);
    assert.equal(out.kind, "interrupt-failed");
    assert.equal(out.error.code, "stop-not-idle");
    assert.deepEqual(w.dispatcher.actions(), ["stop"]);
  });

  it("refuses to send when the state cannot be read", async () => {
    // Defect: assuming idle when ChatGPT state is unknown.
    const { w, engine } = await setup();
    w.dispatcher.stateError = new Error("no composer");
    const out = await engine.interruptAndSendNext(CONV);
    assert.equal(out.kind, "interrupt-failed");
    assert.deepEqual(w.dispatcher.log, []);
  });

  for (const change of ["edit", "remove"]) {
    it(`sends nothing if the head is ${change === "edit" ? "edited" : "removed"} after the stop is confirmed`, async () => {
      // Defect: submitting an item other than the one the user chose, or text they just changed.
      const { w, engine, a } = await setup();
      const original = w.dispatcher.stop.bind(w.dispatcher);
      w.dispatcher.stop = async (req) => {
        const result = await original(req);
        if (change === "edit") await engine.edit(a.id, { text: "changed" });
        else await engine.remove(a.id);
        return result;
      };
      const out = await engine.interruptAndSendNext(CONV);
      assert.deepEqual(out, { kind: "interrupt-aborted", reason: "head-changed" });
      assert.deepEqual(w.dispatcher.actions(), ["stop"]);
    });
  }

  it("renews the lease after a slow stop instead of losing the send", async () => {
    // Defect: a stop that outlives the lease TTL making the confirmed interrupt unsendable.
    const w = new World();
    const { engine } = await w.tab("A", { leaseTtlMs: 5_000 });
    const a = await engine.enqueue(CONV, { text: "a" });
    w.dispatcher.state = "generating";
    const original = w.dispatcher.stop.bind(w.dispatcher);
    w.dispatcher.stop = async (req) => {
      w.clock.advance(9_000);
      return original(req);
    };
    assert.deepEqual(await engine.interruptAndSendNext(CONV), { kind: "sent", itemId: a.id });
  });

  it("halts instead of skipping an item that needs attention", async () => {
    // Defect: jumping past a failed head to send a later item.
    const { w, engine, a } = await setup();
    w.dispatcher.state = "idle";
    w.dispatcher.submitScript = [{ kind: "rejected", code: "x", message: "m", retryable: false }];
    assert.equal((await engine.step(CONV)).kind, "failed");
    assert.deepEqual(await engine.interruptAndSendNext(CONV), { kind: "halted", itemId: a.id, status: "failed" });
    assert.equal(w.dispatcher.log.length, 1);
  });
});

describe("races", () => {
  it("serializes concurrent steps in one tab into a single send", async () => {
    // Defect: double submit of the head when two triggers fire at once.
    const w = new World();
    const { engine } = await w.tab("A");
    await engine.enqueue(CONV, { text: "a" });
    await engine.enqueue(CONV, { text: "b" });
    const outs = await Promise.all([engine.step(CONV), engine.step(CONV), engine.step(CONV)]);
    assert.equal(outs.filter((o) => o.kind === "sent").length, 1);
    assert.equal(w.dispatcher.log.length, 1);
    assert.equal(w.dispatcher.state, "generating");
  });

  it("waits, without sending, while a response runs or the state is unknown", async () => {
    // Defect: draining into a response the user started natively.
    const w = new World();
    const { engine } = await w.tab("A");
    await engine.enqueue(CONV, { text: "a" });
    w.dispatcher.state = "generating";
    assert.deepEqual(await engine.step(CONV), { kind: "waiting", reason: "generating" });
    w.dispatcher.state = "unknown";
    assert.deepEqual(await engine.step(CONV), { kind: "waiting", reason: "unknown-state" });
    assert.deepEqual(w.dispatcher.log, []);
  });
});

describe("bounded retries", () => {
  it("retries a definite non-delivery with backoff, then fails after maxAttempts", async () => {
    // Defect: runaway or immediate retry loops.
    const w = new World();
    const { engine } = await w.tab("A", { maxAttempts: 3, retryBackoffMs: [1_000, 5_000] });
    const a = await engine.enqueue(CONV, { text: "a" });
    const reject = { kind: "rejected", code: "composer-busy", message: "m", retryable: true };
    w.dispatcher.submitScript = [reject, reject, reject, reject];

    let out = await engine.step(CONV);
    assert.deepEqual(out, { kind: "retry-scheduled", itemId: a.id, notBefore: w.clock.t + 1_000 });
    assert.equal((await engine.step(CONV)).kind, "waiting"); // backoff not elapsed
    assert.equal(w.dispatcher.log.length, 1);
    w.clock.advance(1_000);
    out = await engine.step(CONV);
    assert.deepEqual(out, { kind: "retry-scheduled", itemId: a.id, notBefore: w.clock.t + 5_000 });
    w.clock.advance(5_000);
    assert.deepEqual(await engine.step(CONV), { kind: "failed", itemId: a.id });
    w.clock.advance(60_000);
    assert.deepEqual(await engine.step(CONV), { kind: "halted", itemId: a.id, status: "failed" });
    assert.equal(w.dispatcher.log.length, 3);

    // The user, not the loop, restarts a failed item.
    await engine.retry(a.id);
    const restarted = await engine.step(CONV); // fresh budget: a new retryable rejection is scheduled, not failed
    assert.equal(restarted.kind, "retry-scheduled");
    assert.equal((await engine.list(CONV)).items[0].attempts, 1);
  });

  it("does not retry a non-retryable rejection", async () => {
    // Defect: retrying something that can never succeed.
    const w = new World();
    const { engine } = await w.tab("A");
    const a = await engine.enqueue(CONV, { text: "a" });
    w.dispatcher.submitScript = [{ kind: "rejected", code: "too-long", message: "m", retryable: false }];
    assert.deepEqual(await engine.step(CONV), { kind: "failed", itemId: a.id });
    assert.equal(w.dispatcher.log.length, 1);
  });
});

describe("ambiguous delivery", () => {
  for (const [name, script] of [
    ["an uncertain result", [{ kind: "uncertain", code: "no-ack", message: "m" }]],
    ["a thrown error", [new Error("net down")]],
  ]) {
    it(`sends ${name} to manual review and never blindly retries it`, async () => {
      // Defect: re-sending a message that may already have been delivered.
      const w = new World();
      const { engine } = await w.tab("A");
      const a = await engine.enqueue(CONV, { text: "a" });
      await engine.enqueue(CONV, { text: "b" });
      w.dispatcher.submitScript = [...script];
      assert.deepEqual(await engine.step(CONV), { kind: "manual-review", itemId: a.id });
      w.dispatcher.finishGeneration();
      w.clock.advance(1_000_000);
      assert.deepEqual(await engine.step(CONV), { kind: "halted", itemId: a.id, status: "manual-review" });
      assert.deepEqual(await engine.interruptAndSendNext(CONV), {
        kind: "halted",
        itemId: a.id,
        status: "manual-review",
      });
      assert.equal(w.dispatcher.log.length, 1);
      await assert.rejects(engine.edit(a.id, { text: "z" }), { code: "item-locked" });
    });
  }

  it("treats a submit timeout as uncertain, and lets the user resolve it either way", async () => {
    // Defect: timeout read as failure (and resent); no way out of manual review.
    const w = new World();
    const { engine } = await w.tab("A");
    const a = await engine.enqueue(CONV, { text: "a" });
    const b = await engine.enqueue(CONV, { text: "b" });
    w.dispatcher.submitScript = ["hang"];
    const pending = engine.step(CONV);
    await until(() => w.dispatcher.log.length === 1);
    w.clock.advance(10_000);
    assert.deepEqual(await pending, { kind: "manual-review", itemId: a.id });
    assert.equal((await engine.list(CONV)).items[0].lastError?.code, "submit-timeout");

    await engine.markDelivered(a.id);
    w.dispatcher.finishGeneration();
    assert.deepEqual(await engine.step(CONV), { kind: "sent", itemId: b.id });

    w.dispatcher.finishGeneration();
    const c = await engine.enqueue(CONV, { text: "c" });
    w.dispatcher.submitScript = [{ kind: "uncertain", code: "no-ack", message: "m" }];
    await engine.step(CONV);
    await engine.retry(c.id);
    w.dispatcher.finishGeneration();
    assert.deepEqual(await engine.step(CONV), { kind: "sent", itemId: c.id });
  });

  it("drops a late result for a superseded attempt", async () => {
    // Defect: a stale submit result overwriting a newer decision.
    const w = new World();
    const { engine } = await w.tab("A");
    const a = await engine.enqueue(CONV, { text: "a" });
    let resolveLate;
    w.dispatcher.submit = async (req) => {
      w.dispatcher.log.push({ type: "submit", request: req });
      return new Promise((resolve) => (resolveLate = resolve));
    };
    const pending = engine.step(CONV);
    await until(() => w.dispatcher.log.length === 1);
    w.clock.advance(10_000);
    assert.equal((await pending).kind, "manual-review");
    await engine.retry(a.id); // user chose to retry; new attempt will get a new attemptId
    resolveLate({ kind: "accepted" });
    await settle();
    assert.equal((await engine.list(CONV)).items[0].status, "pending");
  });
});

describe("clear", () => {
  it("removes everything except a message whose send is still in flight", async () => {
    // Defect: clearing the queue deletes an item mid-send, losing track of an uncertain delivery.
    const w = new World();
    const { engine } = await w.tab("A");
    await engine.enqueue(CONV, { text: "a" });
    await engine.enqueue(CONV, { text: "b" });
    w.dispatcher.submitScript = ["hang"];
    const sending = engine.step(CONV);
    await until(() => w.dispatcher.log.length === 1);
    assert.equal(await engine.clear(CONV), 1);
    assert.deepEqual(await texts({ engine }), ["a:sending"]);
    w.clock.advance(10_000);
    await sending;
    assert.equal(await engine.clear(CONV), 1);
    assert.deepEqual(await texts({ engine }), []);
  });
});
