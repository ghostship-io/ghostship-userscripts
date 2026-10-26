// Version 1 stored one row per queued message. The upgrade folds the unsent rows of each conversation into the
// single accumulating prompt, in their original order, and must never merge, drop or resend anything else.
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { QueueStore, migrateLegacy } from "../src/chatgpt/queue/store.js";
import { QueueEngine } from "../src/chatgpt/queue/queue.js";
import { DispatchBoundary, DryRunDispatcher } from "../src/chatgpt/queue/dispatch.js";
import { ManualClock } from "./queue-helpers.js";

const row = (id, conversationId, position, status, extra = {}) => ({
  id, conversationId, text: `text-${id}`, attachments: [], model: null, status, position, version: 1, attempts: 0, notBefore: 0,
  attemptId: null, leaseToken: null, lastError: null, createdAt: 1, updatedAt: 1, sentAt: null, ...extra,
});

/** A database exactly as the previous release left it. */
async function legacyDatabase(rows, queues = []) {
  const factory = new IDBFactory();
  const open = factory.open("ghostship-chatgpt-queue", 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore("items", { keyPath: "id" }).createIndex("conversationId", "conversationId");
    db.createObjectStore("queues", { keyPath: "conversationId" });
    db.createObjectStore("leases", { keyPath: "conversationId" });
  };
  const db = await new Promise((resolve, reject) => ((open.onsuccess = () => resolve(open.result)), (open.onerror = () => reject(open.error))));
  await new Promise((resolve, reject) => {
    const tx = db.transaction(["items", "queues"], "readwrite");
    rows.forEach((r) => tx.objectStore("items").put(r));
    queues.forEach((q) => tx.objectStore("queues").put(q));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return factory;
}

const read = (store, key) => store.read(async (tx) => ({ pending: await tx.getPending(key), inflight: await tx.getInflight(key), state: await tx.getState(key) }));

test("migration: unsent rows fold into one prompt in their original order, one blank line apart, keeping the first id", async () => {
  // Defect: reordering, losing a row, or leaving several visible pending entries.
  const factory = await legacyDatabase([row("c", "conv", 2, "pending"), row("a", "conv", 0, "pending"), row("b", "conv", 1, "pending"), row("other", "elsewhere", 0, "pending")]);
  const store = await QueueStore.open(factory);
  const { pending, inflight } = await read(store, "unknown:conv");
  assert.equal(pending.text, "text-a\n\ntext-b\n\ntext-c");
  assert.equal(pending.id, "a");
  assert.equal(pending.status, "pending");
  assert.equal(inflight, undefined);
  assert.equal((await read(store, "unknown:elsewhere")).pending.text, "text-other", "conversations stay apart");
});

test("migration: delivered rows are dropped; a claimed or uncertain row becomes the in-flight record and is never merged or resent", async () => {
  // Defect: merging a message that may already be delivered into the next send.
  const factory = await legacyDatabase([
    row("done", "conv", 0, "sent", { sentAt: 5 }),
    row("maybe", "conv", 1, "manual-review"),
    row("next", "conv", 2, "pending"),
    row("later", "conv", 3, "pending"),
  ]);
  const store = await QueueStore.open(factory);
  const { pending, inflight } = await read(store, "unknown:conv");
  assert.equal(inflight.text, "text-maybe");
  assert.equal(inflight.status, "manual-review");
  assert.equal(pending.text, "text-next\n\ntext-later");
  assert.ok(!pending.text.includes("done"));

  const dispatcher = new DryRunDispatcher();
  const engine = new QueueEngine({ store, dispatch: new DispatchBoundary(dispatcher, { clock: new ManualClock() }), clock: new ManualClock(), tabId: "t" });
  assert.equal((await engine.step({ accountId: "unknown", conversationId: "conv" })).kind, "halted");
  assert.equal(dispatcher.log.length, 0, "nothing is resent after the upgrade");
});

test("migration: a `sending` row (claimed, outcome unknown) is quarantined the same way", async () => {
  // Defect: treating a claimed send as unsent and sending it again.
  const factory = await legacyDatabase([row("flying", "conv", 0, "sending", { attempts: 1 }), row("next", "conv", 1, "pending")]);
  const store = await QueueStore.open(factory);
  const { pending, inflight } = await read(store, "unknown:conv");
  assert.equal(inflight.id, "flying");
  assert.equal(inflight.status, "manual-review");
  assert.equal(pending.text, "text-next");
});

test("migration: failed or blocked rows keep their text but hold the prompt for the user; unrestorable files stay attached", async () => {
  // Defect: a row that needed a decision being sent unasked, or its files silently dropped.
  const file = { name: "f.png", size: 1, type: "image/png", restorable: false };
  const failed = await QueueStore.open(await legacyDatabase([row("f", "conv", 0, "failed"), row("p", "conv", 1, "pending")]));
  const f = (await read(failed, "unknown:conv")).pending;
  assert.equal(f.text, "text-f\n\ntext-p");
  assert.equal(f.status, "blocked");
  const blocked = await QueueStore.open(await legacyDatabase([row("b", "conv", 0, "blocked", { attachments: [file], lastError: { code: "attachments-not-restorable" } })]));
  const b = (await read(blocked, "unknown:conv")).pending;
  assert.equal(b.status, "blocked");
  assert.deepEqual(b.attachments, [file]);
});

test("migration: a paused queue stays held until Retry, and the original rows stay untouched as the recovery copy", async () => {
  // Defect: an upgrade that resumes a paused queue, or that destroys the source text.
  const factory = await legacyDatabase([row("a", "conv", 0, "pending"), row("b", "conv", 1, "pending")], [{ conversationId: "conv", paused: true }]);
  const store = await QueueStore.open(factory);
  const held = (await read(store, "unknown:conv")).pending;
  assert.equal(held.status, "blocked", "nothing is sent unasked after the upgrade");
  assert.equal(held.lastError.code, "legacy-paused");
  const originals = await store.legacyItems();
  assert.deepEqual(originals.map((r) => [r.id, r.text, r.status]).sort(), [["a", "text-a", "pending"], ["b", "text-b", "pending"]]);
  store.close();
  const again = await QueueStore.open(factory); // opening twice does not migrate twice
  assert.equal((await read(again, "unknown:conv")).pending.text, "text-a\n\ntext-b");
});

test("migrateLegacy is pure: a second uncertain row is held, not merged silently", () => {
  // Defect: two ambiguous rows collapsing into one record and hiding one of them.
  const out = migrateLegacy([row("m1", "c", 0, "manual-review"), row("m2", "c", 1, "manual-review")], [], 9);
  assert.equal(out.inflight.length, 1);
  assert.equal(out.pending[0].status, "blocked");
  assert.equal(out.pending[0].text, "text-m2");
});

test("a fresh install has nothing to migrate", async () => {
  const store = await QueueStore.open(new IDBFactory());
  assert.deepEqual(await store.legacyItems(), []);
  assert.equal((await read(store, "a:b")).pending, undefined);
});

/** A version 2 database exactly as the previous release left it (the engine then still had a Pause control). */
async function v2Database(records) {
  const factory = new IDBFactory();
  const open = factory.open("ghostship-chatgpt-queue", 2);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore("pending", { keyPath: "key" }).createIndex("conversationId", "conversationId");
    db.createObjectStore("inflight", { keyPath: "key" }).createIndex("conversationId", "conversationId");
    db.createObjectStore("state", { keyPath: "key" });
    db.createObjectStore("locks", { keyPath: "key" });
  };
  const db = await new Promise((resolve, reject) => ((open.onsuccess = () => resolve(open.result)), (open.onerror = () => reject(open.error))));
  await new Promise((resolve, reject) => {
    const tx = db.transaction(["pending", "state"], "readwrite");
    for (const { pending, state } of records) {
      tx.objectStore("pending").put(pending);
      tx.objectStore("state").put(state);
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return factory;
}
const v2Pending = (conversationId, text = "held text") => ({
  key: `acct:${conversationId}`, id: `id-${conversationId}`, accountId: "acct", conversationId, text, attachments: [], status: "pending",
  version: 3, createdAt: 1, updatedAt: 1, lastError: null, ops: [],
});
const v2State = (conversationId, paused) => ({ key: `acct:${conversationId}`, paused, editBy: null, editUntil: 0 });

test("upgrade 2 -> 3: a prompt whose queue was paused is blocked until Retry, and nothing sends without it", async () => {
  // Defect: the engine no longer reads `state.paused`, so a version 2 paused queue sent on its own once its conversation was idle.
  const factory = await v2Database([
    { pending: v2Pending("paused"), state: v2State("paused", true) },
    { pending: v2Pending("running"), state: v2State("running", false) },
  ]);
  const store = await QueueStore.open(factory);
  const held = await read(store, "acct:paused");
  assert.equal(held.pending.status, "blocked");
  assert.equal(held.pending.lastError.code, "legacy-paused");
  assert.equal(held.pending.text, "held text", "the text is kept");
  assert.equal(held.pending.version, 4);
  assert.equal(held.state.paused, false, "the stale flag is cleared");
  assert.equal((await read(store, "acct:running")).pending.status, "pending", "an unpaused queue is untouched");

  const clock = new ManualClock();
  const sent = [];
  const dispatcher = new DryRunDispatcher();
  const send = dispatcher.send?.bind(dispatcher);
  dispatcher.send = async (...args) => (sent.push(args), send ? send(...args) : { kind: "sent" });
  const engine = new QueueEngine({ store, dispatch: new DispatchBoundary(dispatcher), clock, tabId: "tab" });
  const A = { accountId: "acct", conversationId: "paused" };
  for (let i = 0; i < 3; i++) {
    clock.advance(10_000);
    const outcome = await engine.step(A);
    assert.notEqual(outcome.kind, "sent", "an idle conversation does not send a held prompt");
  }
  assert.equal(sent.length, 0, "nothing reached the dispatcher");
  assert.equal((await engine.view(A)).pending.status, "blocked");

  // Retry lifts the hold; only then can the prompt go.
  assert.equal((await engine.unblock(A)).kind, "unblocked");
  assert.equal((await engine.view(A)).pending.status, "pending");
  store.close();
  const again = await QueueStore.open(factory);
  assert.equal((await read(again, "acct:paused")).pending.status, "pending", "opening again does not re-hold a retried prompt");
});

test("upgrade 2 -> 3: a paused flag with no prompt, or a prompt already waiting on a decision, changes nothing else", async () => {
  const blocked = { ...v2Pending("b"), status: "blocked", lastError: { code: "attachments-not-restorable" } };
  const factory = await v2Database([
    { pending: v2Pending("empty-state"), state: v2State("other", true) },
    { pending: blocked, state: v2State("b", true) },
  ]);
  const store = await QueueStore.open(factory);
  assert.equal((await read(store, "acct:empty-state")).pending.status, "pending");
  assert.equal((await read(store, "acct:b")).pending.lastError.code, "attachments-not-restorable", "its own reason is kept");
});
