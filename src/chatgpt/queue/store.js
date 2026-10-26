const DB_NAME = "ghostship-chatgpt-queue";
const DB_VERSION = 3;

/** Account the legacy (version 1) queues were stored without; the first account that opens the conversation claims them. */
export const LEGACY_ACCOUNT = "unknown";

export const keyOf = (target) => `${target.accountId}:${target.conversationId}`;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Version 1 stored one row per queued message. Version 2 stores one accumulating `pending` record per
 * (account, conversation) plus at most one immutable `inflight` snapshot. Rows are folded in their
 * original order, separated by one blank line; delivered rows are dropped; a row whose send was
 * claimed or whose delivery is uncertain becomes the `inflight` record and is never merged into the
 * pending text. A row that failed, was blocked or sits behind a second uncertain row is merged (its
 * text is kept) but the record is marked blocked, so nothing that needs a decision is sent unasked.
 * The v1 `items` store is left untouched as the recovery copy.
 */
export function migrateLegacy(items, legacyQueues, now) {
  const byConversation = new Map();
  for (const item of [...items].sort((a, b) => a.position - b.position)) {
    if (!byConversation.has(item.conversationId)) byConversation.set(item.conversationId, []);
    byConversation.get(item.conversationId).push(item);
  }
  const paused = new Map(legacyQueues.map((q) => [q.conversationId, q.paused === true]));
  const out = { pending: [], inflight: [], state: [] };
  for (const [conversationId, rows] of byConversation) {
    const key = keyOf({ accountId: LEGACY_ACCOUNT, conversationId });
    const merge = [];
    let uncertain = null;
    let needsDecision = null;
    for (const row of rows) {
      if (row.status === "sent") continue;
      if (row.status === "sending" || row.status === "manual-review") {
        if (!uncertain) {
          uncertain = row;
          continue;
        }
        needsDecision = "legacy-uncertain";
      } else if (row.status === "failed") {
        needsDecision = "legacy-failed";
      } else if (row.status === "blocked") {
        needsDecision = row.lastError?.code ?? "attachments-not-restorable";
      }
      merge.push(row);
    }
    // Pausing is gone: a queue that was paused stays held (Retry lifts it) instead of sending on its own.
    if (paused.get(conversationId) && merge.length) needsDecision ??= "legacy-paused";
    if (uncertain) {
      out.inflight.push({
        key,
        accountId: LEGACY_ACCOUNT,
        conversationId,
        id: uncertain.id,
        sourceId: uncertain.id,
        text: uncertain.text,
        attachments: uncertain.attachments ?? [],
        status: "manual-review",
        attempts: Math.max(1, uncertain.attempts ?? 1),
        leaseToken: null,
        claimedAt: uncertain.updatedAt ?? now,
        lastError: {
          code: "legacy-uncertain",
          message: "This message was in flight when the queue was upgraded, so its delivery is unknown.",
          action: "Check the conversation in ChatGPT. Mark it delivered if it is there, or restore it to the queue if it is not.",
          at: now,
        },
      });
    }
    if (merge.length) {
      const attachments = merge.flatMap((row) => row.attachments ?? []);
      const lost = attachments.filter((a) => !a.restorable);
      const code = lost.length ? "attachments-not-restorable" : needsDecision;
      out.pending.push({
        key,
        id: merge[0].id,
        accountId: LEGACY_ACCOUNT,
        conversationId,
        text: merge.map((row) => row.text).join("\n\n"),
        attachments,
        status: code ? "blocked" : "pending",
        version: Math.max(...merge.map((row) => row.version ?? 1)) + 1,
        createdAt: merge[0].createdAt ?? now,
        updatedAt: now,
        lastError: code ? legacyError(code, lost, now) : null,
        ops: [],
      });
    }
  }
  return out;
}

function legacyError(code, lost, now) {
  if (code === "attachments-not-restorable") {
    return { code, message: `Cannot restore ${lost.map((a) => a.name).join(", ")}.`, action: "Reattach the files, then retry.", at: now };
  }
  if (code === "legacy-paused") {
    return { code, message: "This queue was paused before the queue was upgraded, so it is held.", action: "Press Retry to let it send.", at: now };
  }
  return {
    code,
    message: "Some of these messages needed a decision before the queue was upgraded (a failed, blocked or uncertain send).",
    action: "Read the combined text, edit it if needed, then press Retry.",
    at: now,
  };
}

/** The pending record `record`, blocked so that only an explicit Retry lets it send. */
const heldRecord = (record, now) => ({ ...record, status: "blocked", version: record.version + 1, updatedAt: now, lastError: legacyError("legacy-paused", [], now) });

/**
 * Version 2 stored a per-conversation `paused` flag in `state` that the engine no longer reads, so a paused queue
 * would send on its own once its conversation is idle. Inside the upgrade transaction every paused queue's pending
 * prompt becomes a blocked one (Retry lifts it) and the flag is cleared.
 */
function holdPausedQueues(tx, now) {
  const states = tx.objectStore("state").getAll();
  states.onsuccess = () => {
    for (const state of states.result) {
      if (state.paused !== true) continue;
      tx.objectStore("state").put({ ...state, paused: false });
      const pending = tx.objectStore("pending").get(state.key);
      pending.onsuccess = () => {
        if (pending.result && pending.result.status === "pending") tx.objectStore("pending").put(heldRecord(pending.result, now));
      };
    }
  };
}

/** Typed accessors valid only inside one `QueueStore.transact` callback. */
export class Tx {
  #tx;
  constructor(tx) {
    this.#tx = tx;
  }

  getPending(key) {
    return request(this.#tx.objectStore("pending").get(key));
  }
  putPending(record) {
    return request(this.#tx.objectStore("pending").put(record));
  }
  deletePending(key) {
    return request(this.#tx.objectStore("pending").delete(key));
  }
  getInflight(key) {
    return request(this.#tx.objectStore("inflight").get(key));
  }
  putInflight(record) {
    return request(this.#tx.objectStore("inflight").put(record));
  }
  deleteInflight(key) {
    return request(this.#tx.objectStore("inflight").delete(key));
  }
  async getState(key) {
    return (await request(this.#tx.objectStore("state").get(key))) ?? { key, editBy: null, editUntil: 0 };
  }
  putState(state) {
    return request(this.#tx.objectStore("state").put(state));
  }
  getLease(key) {
    return request(this.#tx.objectStore("locks").get(key));
  }
  putLease(lease) {
    return request(this.#tx.objectStore("locks").put(lease));
  }
  deleteLease(key) {
    return request(this.#tx.objectStore("locks").delete(key));
  }
  allPending() {
    return request(this.#tx.objectStore("pending").getAll());
  }
  allInflight() {
    return request(this.#tx.objectStore("inflight").getAll());
  }
  pendingOf(conversationId) {
    return request(this.#tx.objectStore("pending").index("conversationId").getAll(conversationId));
  }
  inflightOf(conversationId) {
    return request(this.#tx.objectStore("inflight").index("conversationId").getAll(conversationId));
  }
}

/**
 * IndexedDB persistence. Every state transition runs inside exactly one
 * readwrite transaction through `transact`; a thrown error aborts it, so a
 * transition is either fully applied or not at all. IndexedDB serializes
 * overlapping readwrite transactions across tabs, which is what makes the
 * lease, the append and the claim atomic.
 */
export class QueueStore {
  #db;
  constructor(db) {
    this.#db = db;
  }

  static async open(factory = globalThis.indexedDB, name = DB_NAME, now = () => Date.now()) {
    const open = factory.open(name, DB_VERSION);
    open.onupgradeneeded = (event) => {
      const db = open.result;
      const tx = open.transaction;
      if (event.oldVersion >= 2) {
        // Version 2 -> 3: pausing is gone, and a prompt whose queue was paused must stay held until Retry.
        holdPausedQueues(tx, now());
        return;
      }
      const pending = db.createObjectStore("pending", { keyPath: "key" });
      pending.createIndex("conversationId", "conversationId");
      const inflight = db.createObjectStore("inflight", { keyPath: "key" });
      inflight.createIndex("conversationId", "conversationId");
      db.createObjectStore("state", { keyPath: "key" });
      db.createObjectStore("locks", { keyPath: "key" });
      if (event.oldVersion < 1) return;
      // Version 1 -> 3: fold the per-message rows into accumulators inside the upgrade transaction.
      const rows = tx.objectStore("items").getAll();
      const queues = tx.objectStore("queues").getAll();
      queues.onsuccess = () => {
        const migrated = migrateLegacy(rows.result, queues.result, now());
        for (const record of migrated.pending) tx.objectStore("pending").put(record);
        for (const record of migrated.inflight) tx.objectStore("inflight").put(record);
        for (const record of migrated.state) tx.objectStore("state").put({ ...record, paused: false });
        db.deleteObjectStore("queues");
        db.deleteObjectStore("leases");
      };
    };
    const db = await request(open);
    // A newer release upgrading the database must not wait for this page: step aside.
    db.onversionchange = () => db.close();
    return new QueueStore(db);
  }

  close() {
    this.#db.close();
  }

  /** The untouched version 1 rows: the recovery copy of everything the migration folded. */
  async legacyItems() {
    if (!this.#db.objectStoreNames.contains("items")) return [];
    return request(this.#db.transaction("items").objectStore("items").getAll());
  }

  transact(fn) {
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(["pending", "inflight", "state", "locks"], "readwrite");
      let result;
      let failure;
      let failed = false;
      tx.oncomplete = () => (failed ? reject(failure) : resolve(result));
      tx.onabort = () => reject(failed ? failure : tx.error);
      tx.onerror = () => undefined; // surfaced through onabort
      fn(new Tx(tx)).then(
        (value) => {
          result = value;
        },
        (error) => {
          failed = true;
          failure = error;
          try {
            tx.abort();
          } catch {
            // already finished
          }
        },
      );
    });
  }

  /** A read-only view of one transaction; used by the per-tick snapshot so a waiting queue writes nothing. */
  read(fn) {
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(["pending", "inflight", "state", "locks"], "readonly");
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error);
      fn(new Tx(tx)).then(
        (value) => {
          result = value;
        },
        (error) => {
          try {
            tx.abort();
          } catch {
            // already finished
          }
          reject(error);
        },
      );
    });
  }
}
