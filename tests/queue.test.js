// The queue engine: one accumulating pending prompt per account + conversation. Every test names the defect
// it catches. Nothing here touches ChatGPT: the dispatcher is the dry-run adapter.
import test from "node:test";
import assert from "node:assert/strict";
import { A, B, OTHER_ACCOUNT, World, until } from "./queue-helpers.js";
import { normalizeContribution } from "../src/chatgpt/queue/text.js";

const pendingOf = async (engine, target) => (await engine.view(target)).pending;
const textOf = async (engine, target) => (await pendingOf(engine, target))?.text;
const submits = (w) => w.dispatcher.log.filter((e) => e.type === "submit");

test("Enter A, B, C while generating: ONE pending prompt `A\\n\\nB\\n\\nC` with a stable id, and nothing is sent", async () => {
  // Defect: one row per contribution, or contributions separated by anything but exactly one blank line.
  const w = new World();
  const { engine } = await w.tab("t1");
  w.dispatcher.state = "generating";
  const first = await engine.append(A, { text: "A" });
  assert.equal(first.created, true);
  const ids = new Set([first.record.id]);
  const versions = [first.record.version];
  for (const part of ["B", "C"]) {
    const next = await engine.append(A, { text: part });
    assert.equal(next.created, false);
    ids.add(next.record.id);
    versions.push(next.record.version);
  }
  assert.equal(ids.size, 1, "the identity is stable");
  assert.deepEqual(versions, [1, 2, 3]);
  assert.equal(await textOf(engine, A), "A\n\nB\n\nC");
  for (let i = 0; i < 5; i++) assert.deepEqual(await engine.step(A), { kind: "waiting", reason: "generating" });
  assert.deepEqual(w.dispatcher.log, [], "zero native sends and zero stops while busy");
  assert.equal((await engine.view(A)).inflight, null);
});

test("contributions: internal newlines, indentation and code are kept; empty and whitespace-only input is ignored", async () => {
  // Defect: trimming away intentional formatting, or queueing blanks.
  const w = new World();
  const { engine } = await w.tab("t1");
  assert.deepEqual(await engine.append(A, { text: "   \n\t " }), { kind: "ignored" });
  assert.deepEqual(await engine.append(A, { text: "" }), { kind: "ignored" });
  assert.equal(await pendingOf(engine, A), null);
  await engine.append(A, { text: "\n\n  indented first\nsecond line\n\n```js\nconst a = 1;\n\n\nconst b = 2;\n```\n\n\n" });
  await engine.append(A, { text: "line one\r\nline two\r\n" });
  assert.equal(await textOf(engine, A), "  indented first\nsecond line\n\n```js\nconst a = 1;\n\n\nconst b = 2;\n```\n\nline one\nline two");
  assert.equal(normalizeContribution("a \n"), "a");
});

test("a repeated delivery of the same operation id is a no-op (double keydown + form submit)", async () => {
  // Defect: the same Enter counted twice and the text doubled.
  const w = new World();
  const { engine } = await w.tab("t1");
  await engine.append(A, { text: "once", opId: "op-1" });
  assert.equal((await engine.append(A, { text: "once", opId: "op-1" })).kind, "duplicate");
  assert.equal(await textOf(engine, A), "once");
  assert.equal((await pendingOf(engine, A)).version, 1);
});

test("two tabs appending concurrently serialize: every contribution lands exactly once", async () => {
  // Defect: a read-modify-write race losing one tab's text.
  const w = new World();
  const [t1, t2] = [await w.tab("t1"), await w.tab("t2")];
  const writes = [];
  for (let i = 0; i < 12; i++) writes.push(t1.engine.append(A, { text: `one-${i}` }), t2.engine.append(A, { text: `two-${i}` }));
  await Promise.all(writes);
  const record = await pendingOf(t1.engine, A);
  const parts = record.text.split("\n\n");
  assert.equal(parts.length, 24);
  assert.equal(new Set(parts).size, 24, "no duplicates");
  for (let i = 0; i < 12; i++) assert.ok(parts.includes(`one-${i}`) && parts.includes(`two-${i}`));
  assert.ok(parts.indexOf("one-3") < parts.indexOf("one-4"), "each tab's order is kept");
  assert.equal(record.version, 24);
});

test("Edit: the whole text is replaced under the same id with a higher version; cancel leaves state intact", async () => {
  // Defect: edit creating a second prompt, appending instead of replacing, or losing the original on cancel.
  const w = new World();
  const { engine } = await w.tab("t1");
  const created = (await engine.append(A, { text: "A" })).record;
  await engine.append(A, { text: "B" });
  const begun = await engine.beginEdit(A);
  assert.equal(begun.record.text, "A\n\nB");
  await engine.endEdit(A); // cancel: nothing written
  assert.equal(await textOf(engine, A), "A\n\nB");
  assert.equal((await pendingOf(engine, A)).version, 2);

  const again = await engine.beginEdit(A);
  const saved = await engine.saveEdit(A, { baseVersion: again.record.version, baseText: again.record.text, text: "A\n\nB changed\n\nC" });
  assert.equal(saved.kind, "saved");
  const record = await pendingOf(engine, A);
  assert.equal(record.id, created.id);
  assert.equal(record.text, "A\n\nB changed\n\nC", "replaced, not duplicated");
  assert.equal(record.version, 3);
  assert.equal((await engine.view(A)).editing, false, "the edit session is released");
});

test("Edit: an empty save is refused, and a prompt deleted meanwhile reports `gone`", async () => {
  // Defect: saving an empty prompt, or resurrecting a deleted one.
  const w = new World();
  const { engine } = await w.tab("t1");
  await engine.append(A, { text: "keep me" });
  const begun = await engine.beginEdit(A);
  assert.equal((await engine.saveEdit(A, { baseVersion: 1, baseText: begun.record.text, text: "  \n " })).kind, "empty");
  assert.equal(await textOf(engine, A), "keep me");
  await engine.remove(A);
  assert.equal((await engine.saveEdit(A, { baseVersion: 1, baseText: "keep me", text: "late" })).kind, "gone");
  assert.equal(await pendingOf(engine, A), null);
});

test("Edit versus another tab: its appended text is rebased after the edit, any other divergence is a conflict, one editor at a time", async () => {
  // Defect: the edit silently overwriting text another tab queued meanwhile.
  const w = new World();
  const [t1, t2] = [await w.tab("t1"), await w.tab("t2")];
  await t1.engine.append(A, { text: "A" });
  const begun = await t1.engine.beginEdit(A);
  assert.equal((await t2.engine.beginEdit(A)).kind, "busy");
  await t2.engine.append(A, { text: "from the other tab" });
  const saved = await t1.engine.saveEdit(A, { baseVersion: begun.record.version, baseText: begun.record.text, text: "A edited" });
  assert.equal(saved.kind, "rebased");
  assert.equal(await textOf(t1.engine, A), "A edited\n\nfrom the other tab");

  const second = await t1.engine.beginEdit(A);
  await t1.engine.endEdit(A); // this tab's session lapses; the other tab rewrites the text wholesale
  const other = await t2.engine.beginEdit(A);
  await t2.engine.saveEdit(A, { baseVersion: other.record.version, baseText: other.record.text, text: "rewritten" });
  const conflict = await t1.engine.saveEdit(A, { baseVersion: second.record.version, baseText: second.record.text, text: "mine" });
  assert.equal(conflict.kind, "conflict");
  assert.equal(await textOf(t1.engine, A), "rewritten", "nothing was overwritten");
});

test("automatic dispatch stands aside while an edit is open, then sends the saved text", async () => {
  // Defect: dispatch racing a deliberate Edit and sending the old text.
  const w = new World();
  const { engine } = await w.tab("t1");
  await engine.append(A, { text: "old" });
  const begun = await engine.beginEdit(A);
  assert.deepEqual(await engine.step(A), { kind: "waiting", reason: "editing" });
  assert.equal(w.dispatcher.log.length, 0);
  await engine.saveEdit(A, { baseVersion: begun.record.version, baseText: begun.record.text, text: "new" });
  assert.equal((await engine.step(A)).kind, "sent");
  assert.equal(submits(w)[0].request.text, "new");
});

test("an abandoned edit session expires, so a closed tab cannot freeze the queue", async () => {
  // Defect: a crashed editor holding the queue forever.
  const w = new World();
  const { engine } = await w.tab("t1", { editTtlMs: 5_000 });
  await engine.append(A, { text: "x" });
  await engine.beginEdit(A);
  assert.equal((await engine.step(A)).kind, "waiting");
  w.clock.advance(6_000);
  assert.equal((await engine.step(A)).kind, "sent");
});

test("Delete removes the whole prompt and nothing is sent; Pause holds automatic dispatch but not an explicit Steer", async () => {
  // Defect: delete leaving text behind; pause ignored; pause also blocking the user's own Steer.
  const w = new World();
  const { engine } = await w.tab("t1");
  await engine.append(A, { text: "a" });
  await engine.append(A, { text: "b" });
  await engine.pause(A);
  assert.deepEqual(await engine.step(A), { kind: "paused" });
  assert.equal(w.dispatcher.log.length, 0);
  assert.equal((await engine.remove(A)).kind, "removed");
  assert.equal(await pendingOf(engine, A), null);
  assert.equal((await engine.remove(A)).kind, "none");
  await engine.resume(A);
  assert.equal((await engine.step(A)).kind, "idle");
  assert.equal(w.dispatcher.log.length, 0);

  await engine.append(A, { text: "c" });
  await engine.pause(A);
  assert.equal((await engine.steer(A, { native: false })).kind, "sent", "an explicit action works while paused");
  assert.equal(submits(w).length, 1);
});

test("passive completion sends the whole merged text once, only when native Send is available", async () => {
  // Defect: sending while the response runs, while Send is unavailable, or sending twice.
  const w = new World();
  const { engine } = await w.tab("t1");
  for (const part of ["A", "B", "C"]) await engine.append(A, { text: part });
  w.dispatcher.state = "generating";
  assert.equal((await engine.step(A)).reason, "generating");
  w.dispatcher.finishGeneration();
  w.dispatcher.sendReady = false;
  for (let i = 0; i < 4; i++) assert.deepEqual(await engine.step(A), { kind: "waiting", reason: "send-unavailable" });
  assert.equal(w.dispatcher.log.length, 0);
  w.dispatcher.sendReady = true;
  const outcome = await engine.step(A);
  assert.equal(outcome.kind, "sent");
  assert.equal(submits(w).length, 1);
  assert.equal(submits(w)[0].request.text, "A\n\nB\n\nC");
  assert.equal(await pendingOf(engine, A), null);
  assert.equal((await engine.view(A)).inflight, null, "acknowledged");
  w.dispatcher.finishGeneration();
  assert.equal((await engine.step(A)).kind, "idle");
  assert.equal(submits(w).length, 1, "never sent twice");
});

test("waiting is not an attempt: a long wait for Stop to clear changes no state and writes nothing", async () => {
  // Defect: the shipped queue burned its retries on `Send not found` while Stop was showing.
  const w = new World();
  const { engine, store } = await w.tab("t1");
  await engine.append(A, { text: "a" });
  w.dispatcher.state = "generating";
  const before = JSON.stringify(await store.read((tx) => tx.getPending("acct-1:conv-A")));
  for (let i = 0; i < 80; i++) {
    w.clock.advance(1_000);
    assert.equal((await engine.step(A)).kind, "waiting");
  }
  assert.equal(JSON.stringify(await store.read((tx) => tx.getPending("acct-1:conv-A"))), before);
  assert.equal(await store.read((tx) => tx.getLease("acct-1:conv-A")), undefined, "no lease taken just to wait");
  assert.equal(w.dispatcher.log.length, 0);
  w.dispatcher.finishGeneration();
  assert.equal((await engine.step(A)).kind, "sent");
  assert.equal(submits(w).length, 1);
});

test("a late contribution never changes what is in flight: it becomes the next single pending prompt, sent separately", async () => {
  // Defect: mutating a message that may already have left, or merging a new thought into a delivered one.
  const w = new World();
  const { engine } = await w.tab("t1");
  await engine.append(A, { text: "A" });
  await engine.append(A, { text: "B" });
  w.dispatcher.submitScript = ["hang"];
  const sending = engine.step(A);
  await until(() => submits(w).length === 1);
  const view = await engine.view(A);
  assert.equal(view.inflight.text, "A\n\nB");
  assert.equal(view.pending, null);

  await engine.append(A, { text: "late" });
  await engine.append(A, { text: "later" });
  const after = await engine.view(A);
  assert.equal(after.inflight.text, "A\n\nB", "the snapshot is immutable");
  assert.equal(after.pending.text, "late\n\nlater");
  assert.equal((await engine.view(A)).inflight.id, view.inflight.id);
  w.clock.advance(10_000);
  assert.equal((await sending).kind, "manual-review", "an unanswered submit is uncertain, never retried");
});

test("append versus dispatch: whichever commits first, every contribution is sent or pending exactly once", async () => {
  // Defect: a late append lost at the claim boundary.
  for (let delay = 0; delay < 6; delay++) {
    const w = new World();
    const [t1, t2] = [await w.tab("t1"), await w.tab("t2")];
    await t1.engine.append(A, { text: "A" });
    const step = t1.engine.step(A);
    for (let i = 0; i < delay; i++) await Promise.resolve();
    const append = t2.engine.append(A, { text: "late" });
    const [outcome] = await Promise.all([step, append]);
    const rest = (await pendingOf(t1.engine, A))?.text;
    const sentText = submits(w)[0]?.request.text;
    assert.ok(outcome.kind === "sent" || outcome.kind === "waiting", `delay ${delay}: ${outcome.kind}`);
    const seen = [sentText, rest].filter(Boolean).join("\n\n").split("\n\n").sort();
    assert.deepEqual(seen, ["A", "late"], `delay ${delay}: nothing lost, nothing doubled`);
    if (sentText?.includes("late")) assert.equal(rest, undefined, "joined the snapshot atomically");
    assert.ok(submits(w).length <= 1);
  }
});

for (const [name, script] of [
  ["thrown error", [new Error("socket closed")]],
  ["no answer", ["hang"]],
  ["explicit uncertain result", [{ kind: "uncertain", code: "no-ack", message: "?" }]],
]) {
  test(`ambiguous submit (${name}): quarantined, never resent, later text accumulates but automatic dispatch halts`, async () => {
    // Defect: blind retry of a message that may have been delivered, or mixing new text into it.
    const w = new World();
    const { engine } = await w.tab("t1");
    await engine.append(A, { text: "first" });
    w.dispatcher.submitScript = script;
    const first = engine.step(A);
    await until(() => submits(w).length === 1);
    w.clock.advance(10_000);
    assert.equal((await first).kind, "manual-review");
    await engine.append(A, { text: "second" });
    for (let i = 0; i < 4; i++) {
      w.clock.advance(60_000);
      w.dispatcher.finishGeneration();
      assert.equal((await engine.step(A)).kind, "halted");
    }
    assert.equal(submits(w).length, 1);
    const view = await engine.view(A);
    assert.equal(view.inflight.status, "manual-review");
    assert.equal(view.inflight.text, "first");
    assert.equal(view.pending.text, "second", "kept apart from the uncertain message");

    // The user checks ChatGPT: it did go out.
    await engine.markDelivered(A);
    assert.equal((await engine.step(A)).kind, "sent");
    assert.deepEqual(submits(w).map((e) => e.request.text), ["first", "second"]);
  });
}

test("ambiguous send the user finds undelivered: Restore puts its text back in front of the new pending text", async () => {
  // Defect: losing the uncertain message, or reordering it behind later text.
  const w = new World();
  const { engine } = await w.tab("t1");
  await engine.append(A, { text: "first" });
  w.dispatcher.submitScript = [{ kind: "uncertain", code: "no-ack", message: "?" }];
  await engine.step(A);
  await engine.append(A, { text: "second" });
  const restored = await engine.restoreInflight(A);
  assert.equal(restored.record.text, "first\n\nsecond");
  assert.equal((await engine.view(A)).inflight, null);
  w.dispatcher.finishGeneration();
  assert.equal((await engine.step(A)).kind, "sent");
  assert.equal(submits(w).at(-1).request.text, "first\n\nsecond");
});

test("a send that definitely did not leave returns its text to the front of the queue, held until the user acts", async () => {
  // Defect: dropping the text on a rejected send, or retrying a rejection on its own.
  const w = new World();
  const { engine } = await w.tab("t1");
  await engine.append(A, { text: "first" });
  w.dispatcher.submitScript = [{ kind: "rejected", code: "send-unavailable", message: "Send never enabled.", action: "Check the page." }];
  const outcome = await engine.step(A);
  assert.equal(outcome.kind, "rejected");
  await engine.append(A, { text: "typed meanwhile" });
  const view = await engine.view(A);
  assert.equal(view.pending.text, "first\n\ntyped meanwhile");
  assert.equal(view.pending.status, "blocked");
  assert.equal(view.inflight, null);
  for (let i = 0; i < 3; i++) assert.equal((await engine.step(A)).kind, "halted");
  assert.equal(submits(w).length, 1, "no automatic retry");
  await engine.unblock(A);
  assert.equal((await engine.step(A)).kind, "sent");
  assert.equal(submits(w).length, 2);
});

test("a page that turns out not ready after the claim (wait) restores the prompt without a hold or an attempt", async () => {
  // Defect: a state race converting into an error and a stuck queue.
  const w = new World();
  const { engine } = await w.tab("t1");
  const created = (await engine.append(A, { text: "a" })).record;
  w.dispatcher.submitScript = [{ kind: "wait", reason: "generating" }];
  assert.deepEqual(await engine.step(A), { kind: "waiting", reason: "generating" });
  const view = await engine.view(A);
  assert.equal(view.pending.status, "pending");
  assert.equal(view.pending.id, created.id);
  assert.equal(view.pending.text, "a");
  assert.equal(view.inflight, null);
  assert.equal((await engine.step(A)).kind, "sent");
});

test("duplicate tabs: three tabs racing a drain submit the prompt exactly once", async () => {
  // Defect: split-brain senders.
  const w = new World();
  const tabs = [await w.tab("t1"), await w.tab("t2"), await w.tab("t3")];
  await tabs[0].engine.append(A, { text: "once" });
  for (let round = 0; round < 6; round++) {
    await Promise.all(tabs.map((t) => t.engine.step(A)));
    w.dispatcher.finishGeneration();
  }
  assert.equal(submits(w).length, 1);
});

test("reload mid-send: the restarted tab quarantines the unreported send and resends nothing", async () => {
  // Defect: a reloaded page re-sending what the previous page was in the middle of sending.
  const w = new World();
  const first = await w.tab("t1");
  await first.engine.append(A, { text: "a" });
  w.dispatcher.submitScript = ["hang"];
  void first.engine.step(A); // this tab dies here
  await until(() => submits(w).length === 1);
  const reloaded = await w.tab("t1-reloaded");
  assert.equal((await reloaded.engine.step(A)).kind, "not-leader", "the dead tab's lease still holds");
  w.clock.advance(60_000);
  w.dispatcher.finishGeneration();
  await reloaded.engine.append(A, { text: "new thought" });
  assert.equal((await reloaded.engine.step(A)).kind, "halted");
  const view = await reloaded.engine.view(A);
  assert.equal(view.inflight.status, "manual-review");
  assert.equal(view.pending.text, "new thought");
  assert.equal(submits(w).length, 1);
});

test("each account + conversation has its own prompt, paused flag and edit session; a send carries its own destination", async () => {
  // Defect: A's text showing up in, or being sent to, B (or to the same conversation id of another account).
  const w = new World();
  const { engine } = await w.tab("t1");
  await engine.append(A, { text: "for A" });
  await engine.append(B, { text: "for B" });
  await engine.append(OTHER_ACCOUNT, { text: "for the other account" });
  await engine.pause(B);
  await engine.beginEdit(OTHER_ACCOUNT);
  assert.equal(await textOf(engine, A), "for A");
  assert.equal(await textOf(engine, B), "for B");
  assert.equal((await engine.step(B)).kind, "paused");
  assert.equal((await engine.step(OTHER_ACCOUNT)).kind, "waiting");
  assert.equal((await engine.step(A)).kind, "sent");
  assert.deepEqual(submits(w).map((e) => [e.request.accountId, e.request.conversationId, e.request.text]), [["acct-1", "conv-A", "for A"]]);
  assert.equal(await textOf(engine, B), "for B", "B untouched");
  await engine.append(A, { text: "A again" });
  assert.equal(await textOf(engine, A), "A again", "A's next prompt starts fresh and never mixes with B's");
});

test("an unsaved new chat is never a destination", async () => {
  // Defect: queueing into a conversation that does not exist yet and sending it elsewhere.
  const w = new World();
  const { engine } = await w.tab("t1");
  const fresh = { accountId: "acct-1", conversationId: "new" };
  await engine.append(fresh, { text: "x" });
  assert.deepEqual(await engine.step(fresh), { kind: "waiting", reason: "unresolved-conversation" });
  assert.deepEqual(await engine.steer(fresh), { kind: "waiting", reason: "unresolved-conversation" });
  assert.equal(w.dispatcher.log.length, 0);
});

test("attachments that cannot be restored hold the prompt; the text is kept, never silently dropped", async () => {
  // Defect: sending without the files, or discarding them when contributions are combined.
  const w = new World();
  const { engine } = await w.tab("t1");
  const file = { name: "f.png", size: 1, type: "image/png", restorable: false };
  const first = await engine.append(A, { text: "see file", attachments: [file] });
  assert.equal(first.record.status, "blocked");
  await engine.append(A, { text: "and more" });
  const record = await pendingOf(engine, A);
  assert.equal(record.status, "blocked");
  assert.deepEqual(record.attachments, [file]);
  assert.equal(record.text, "see file\n\nand more");
  for (let i = 0; i < 3; i++) assert.equal((await engine.step(A)).kind, "halted");
  assert.equal((await engine.steer(A, { native: false })).kind, "halted");
  assert.equal(w.dispatcher.log.length, 0);
  assert.equal((await engine.unblock(A, { dropAttachments: true })).record.attachments.length, 0);
  assert.equal((await engine.step(A)).kind, "sent");
});

test("Steer with a positively detected native path sends the whole text once and never presses Stop", async () => {
  // Defect: stopping a response when ChatGPT could steer it, or sending only part of the accumulated text.
  const w = new World();
  w.dispatcher.state = "generating";
  w.dispatcher.steerAvailable = true;
  const { engine } = await w.tab("t1");
  for (const part of ["A", "B", "C"]) await engine.append(A, { text: part });
  const outcome = await engine.steer(A);
  assert.equal(outcome.kind, "sent");
  assert.deepEqual(w.dispatcher.actions().map((a) => a.split(":")[0]), ["steer"]);
  assert.equal(w.dispatcher.log[0].request.text, "A\n\nB\n\nC");
  assert.equal(await pendingOf(engine, A), null);
});

test("Steer without a native path falls back to a confirmed stop, then exactly one combined message", async () => {
  // Defect: sending before the stop took effect, or sending twice.
  const w = new World();
  w.dispatcher.state = "generating";
  const { engine } = await w.tab("t1");
  for (const part of ["A", "B"]) await engine.append(A, { text: part });
  const outcome = await engine.steer(A);
  assert.equal(outcome.kind, "sent");
  assert.deepEqual(w.dispatcher.actions().map((a) => a.split(":")[0]), ["stop", "submit"]);
  assert.equal(submits(w)[0].request.text, "A\n\nB");
});

test("Interrupt & Send Next: stop failures leave the prompt pending with an actionable error and send nothing", async () => {
  // Defect: pressing Send into a response that is still running.
  const w = new World();
  w.dispatcher.state = "generating";
  const { engine } = await w.tab("t1");
  await engine.append(A, { text: "urgent" });

  w.dispatcher.stopScript = ["hang"];
  const hung = engine.steer(A, { native: false });
  await until(() => w.dispatcher.log.length === 1);
  w.clock.advance(10_000);
  const timedOut = await hung;
  assert.equal(timedOut.kind, "interrupt-failed");
  assert.equal(timedOut.error.code, "stop-timeout");

  w.dispatcher.stopScript = [{ kind: "confirmed" }];
  w.dispatcher.overrideState("generating", "generating"); // acknowledged, yet the page still reads busy
  const stillBusy = await engine.steer(A, { native: false });
  assert.equal(stillBusy.error.code, "stop-not-idle");

  w.dispatcher.stateError = new Error("no composer");
  assert.equal((await engine.steer(A, { native: false })).error.code, "state-unknown");
  assert.equal(submits(w).length, 0);
  const view = await engine.view(A);
  assert.equal(view.pending.status, "pending");
  assert.ok(view.pending.lastError.action.length > 0);
  w.dispatcher.stateError = null;
  assert.equal((await engine.steer(A, { native: false })).kind, "sent");
  assert.equal(submits(w).length, 1);
});

test("Delete or edit during the stop: nothing is sent", async () => {
  // Defect: sending a prompt the user just deleted or began editing while the stop was in progress.
  for (const interfere of ["delete", "edit"]) {
    const w = new World();
    w.dispatcher.state = "generating";
    const { engine } = await w.tab("t1");
    await engine.append(A, { text: "x" });
    w.dispatcher.stopScript = ["hang"];
    const pending = engine.steer(A, { native: false });
    await until(() => w.dispatcher.log.length === 1);
    if (interfere === "delete") await engine.remove(A);
    else await engine.beginEdit(A);
    w.dispatcher.stopScript = [];
    w.dispatcher.state = "idle";
    w.clock.advance(10_000);
    await pending;
    assert.equal(submits(w).length, 0, interfere);
  }
});

test("two tabs racing Interrupt & Send Next stop once and submit once", async () => {
  // Defect: a double stop or a double send from two tabs.
  const w = new World();
  const [a, b] = [await w.tab("t1"), await w.tab("t2")];
  w.dispatcher.state = "generating";
  await a.engine.append(A, { text: "next" });
  const [x, y] = await Promise.all([a.engine.steer(A, { native: false }), b.engine.steer(A, { native: false })]);
  assert.deepEqual([x.kind, y.kind].sort(), ["not-leader", "sent"]);
  assert.equal(w.dispatcher.actions().filter((s) => s === "stop").length, 1);
  assert.equal(submits(w).length, 1);
});

test("a legacy record from before accounts is taken over once by the first account that opens the conversation", async () => {
  // Defect: stranding migrated text under an account key nobody opens, or copying it to two accounts.
  const w = new World();
  const { engine } = await w.tab("t1");
  const legacy = { accountId: "unknown", conversationId: "conv-A" };
  await engine.append(legacy, { text: "migrated" });
  assert.equal(await engine.adoptLegacy(A), 1);
  assert.equal(await textOf(engine, A), "migrated");
  assert.equal(await pendingOf(engine, legacy), null);
  assert.equal(await engine.adoptLegacy(OTHER_ACCOUNT), 0);
  assert.equal(await engine.adoptLegacy(A), 0);
});

test("a prompt held for a transient reason can still be paused, steered and retried; only unrestorable files keep Steer refused", async () => {
  // Defect: a Blocked prompt that nothing but a reload could clear.
  const w = new World();
  const { engine } = await w.tab("t1");
  await engine.append(A, { text: "x" });
  w.dispatcher.submitScript = [{ kind: "rejected", code: "composer-fill-failed", message: "did not appear", action: "check" }];
  assert.equal((await engine.step(A)).kind, "rejected");
  assert.equal((await engine.view(A)).pending.status, "blocked");
  assert.equal((await engine.step(A)).kind, "halted", "automatic dispatch stays off");
  await engine.pause(A);
  await engine.resume(A);
  assert.equal((await engine.steer(A, { native: false })).kind, "sent", "an explicit Steer is the user's decision");
  assert.equal(submits(w).length, 2);

  await engine.append(A, { text: "files", attachments: [{ name: "f", size: 1, type: "", restorable: false }] });
  assert.equal((await engine.steer(A, { native: false })).kind, "halted");
  assert.equal(submits(w).length, 2);
});
