// The durable queue: ONE accumulating pending prompt per (account, conversation), plus at most one
// immutable in-flight snapshot of the text a send claimed. Appends, edits and the dispatch claim are
// each a single IndexedDB transaction, so two tabs appending at once serialize without lost text and
// a late append either joins the claimed snapshot or becomes the next sole pending prompt.
import { QueueError } from "./types.js";
import { LEGACY_ACCOUNT, keyOf } from "./store.js";
import { joinContributions, normalizeContribution } from "./text.js";

const STOP_ACTIONS = {
  "stop-timeout": "ChatGPT did not confirm the stop. Check the response, then press Interrupt & Send Next again.",
  "stop-not-idle": "The response may still be running. Wait for it to finish or stop it manually, then try again.",
  "state-unknown": "Could not tell whether a response is running. Check ChatGPT, then try again.",
};

const OPS_KEPT = 16;

export class QueueEngine {
  #store;
  #dispatch;
  #clock;
  #tabId;
  #newId;
  #leaseTtlMs;
  #editTtlMs;
  #tails = new Map();

  constructor(opts) {
    this.#store = opts.store;
    this.#dispatch = opts.dispatch;
    this.#clock = opts.clock;
    this.#tabId = opts.tabId;
    this.#newId = opts.newId ?? (() => crypto.randomUUID());
    this.#leaseTtlMs = opts.leaseTtlMs ?? 45_000;
    this.#editTtlMs = opts.editTtlMs ?? 30_000;
  }

  // ---- reading -------------------------------------------------------------

  /** Read-only: a waiting queue costs no write. */
  view(target) {
    const key = keyOf(target);
    return this.#store.read(async (tx) => this.#viewOf(await tx.getPending(key), await tx.getInflight(key), await tx.getState(key)));
  }

  #viewOf(pending, inflight, state) {
    const editing = state.editBy !== null && state.editUntil > this.#clock.now();
    return { pending: pending ?? null, inflight: inflight ?? null, paused: state.paused === true, editing, editBy: editing ? state.editBy : null };
  }

  // ---- user-facing editing (any tab, no lease needed) -----------------------

  /**
   * Adds one contribution to the conversation's single pending prompt (creating it if there is none),
   * separated from the existing text by exactly one blank line. `opId` makes a repeated delivery of
   * the same keystroke or form event a no-op.
   */
  append(target, input) {
    const key = keyOf(target);
    const text = normalizeContribution(input.text);
    return this.#store.transact(async (tx) => {
      if (text === "") return { kind: "ignored" };
      const now = this.#clock.now();
      const existing = await tx.getPending(key);
      if (existing && input.opId && existing.ops.includes(input.opId)) return { kind: "duplicate", record: existing };
      const ops = (existing?.ops ?? []).concat(input.opId ? [input.opId] : []).slice(-OPS_KEPT);
      const record = existing
        ? { ...existing, text: joinContributions(existing.text, text), attachments: existing.attachments.concat(input.attachments ?? []), version: existing.version + 1, updatedAt: now, ops }
        : {
            key,
            id: this.#newId(),
            accountId: target.accountId,
            conversationId: target.conversationId,
            text,
            attachments: input.attachments ?? [],
            status: "pending",
            version: 1,
            createdAt: now,
            updatedAt: now,
            lastError: null,
            ops,
          };
      applyAttachmentGate(record, now);
      await tx.putPending(record);
      return { kind: "appended", record, created: !existing };
    });
  }

  /** Claims the edit session for this tab: automatic dispatch stands aside while it is open. */
  beginEdit(target) {
    const key = keyOf(target);
    return this.#store.transact(async (tx) => {
      const pending = await tx.getPending(key);
      if (!pending) return { kind: "none" };
      const state = await tx.getState(key);
      const now = this.#clock.now();
      if (state.editBy && state.editBy !== this.#tabId && state.editUntil > now) return { kind: "busy", by: state.editBy };
      await tx.putState({ ...state, editBy: this.#tabId, editUntil: now + this.#editTtlMs });
      return { kind: "ok", record: pending };
    });
  }

  /** Keeps this tab's edit session alive; false when it was lost (the prompt was deleted or sent). */
  renewEdit(target) {
    const key = keyOf(target);
    return this.#store.transact(async (tx) => {
      const state = await tx.getState(key);
      if (state.editBy !== this.#tabId || !(await tx.getPending(key))) return false;
      await tx.putState({ ...state, editUntil: this.#clock.now() + this.#editTtlMs });
      return true;
    });
  }

  endEdit(target) {
    const key = keyOf(target);
    return this.#store.transact(async (tx) => {
      const state = await tx.getState(key);
      if (state.editBy === this.#tabId) await tx.putState({ ...state, editBy: null, editUntil: 0 });
    });
  }

  /**
   * Replaces the whole pending text, keeping its identity. If other tabs appended while this edit was
   * open and the original text is intact, their additions are kept after the edited text (`rebased`);
   * any other divergence is a `conflict` and nothing is written.
   */
  saveEdit(target, edit) {
    const key = keyOf(target);
    const text = normalizeContribution(edit.text);
    return this.#store.transact(async (tx) => {
      const pending = await tx.getPending(key);
      const state = await tx.getState(key);
      const release = () => (state.editBy === this.#tabId ? tx.putState({ ...state, editBy: null, editUntil: 0 }) : undefined);
      if (!pending) {
        await release();
        return { kind: "gone" };
      }
      if (text === "") return { kind: "empty" };
      let next;
      let kind = "saved";
      if (pending.version === edit.baseVersion) {
        next = text;
      } else if (pending.text.startsWith(edit.baseText)) {
        next = text + pending.text.slice(edit.baseText.length);
        kind = "rebased";
      } else {
        return { kind: "conflict", record: pending };
      }
      const now = this.#clock.now();
      const record = { ...pending, text: next, version: pending.version + 1, updatedAt: now };
      // The user looked at it and changed it: a hold for a transient reason is lifted, one for files stays.
      if (record.status === "blocked" && record.lastError?.code !== "attachments-not-restorable") {
        record.status = "pending";
        record.lastError = null;
      }
      applyAttachmentGate(record, now);
      await tx.putPending(record);
      await release();
      return { kind, record };
    });
  }

  /** Deletes the whole pending prompt. An in-flight snapshot is not touched. */
  remove(target) {
    const key = keyOf(target);
    return this.#store.transact(async (tx) => {
      const pending = await tx.getPending(key);
      if (!pending) return { kind: "none" };
      await tx.deletePending(key);
      const state = await tx.getState(key);
      if (state.editBy) await tx.putState({ ...state, editBy: null, editUntil: 0 });
      return { kind: "removed", record: pending };
    });
  }

  pause(target) {
    return this.#setPaused(target, true);
  }

  resume(target) {
    return this.#setPaused(target, false);
  }

  /** Lifts a hold the user has looked at; `dropAttachments` is the explicit consent to send without unrestorable files. */
  unblock(target, { dropAttachments = false } = {}) {
    const key = keyOf(target);
    return this.#store.transact(async (tx) => {
      const pending = await tx.getPending(key);
      if (!pending || pending.status !== "blocked") return { kind: "none" };
      const record = { ...pending, version: pending.version + 1, updatedAt: this.#clock.now() };
      if (dropAttachments) record.attachments = record.attachments.filter((a) => a.restorable);
      record.status = "pending";
      record.lastError = null;
      applyAttachmentGate(record, record.updatedAt);
      await tx.putPending(record);
      return { kind: "unblocked", record };
    });
  }

  /** The user saw in ChatGPT that an uncertain send did go out. */
  markDelivered(target) {
    const key = keyOf(target);
    return this.#store.transact(async (tx) => {
      const inflight = await tx.getInflight(key);
      if (!inflight || inflight.status !== "manual-review") throw new QueueError("invalid-state", "There is no uncertain send to confirm.");
      await tx.deleteInflight(key);
      return { kind: "delivered" };
    });
  }

  /** The user saw that an uncertain send did not go out: its text returns to the front of the pending prompt. */
  restoreInflight(target) {
    const key = keyOf(target);
    return this.#store.transact(async (tx) => {
      const inflight = await tx.getInflight(key);
      if (!inflight || inflight.status !== "manual-review") throw new QueueError("invalid-state", "There is no uncertain send to restore.");
      await tx.deleteInflight(key);
      const record = await this.#restore(tx, inflight, null);
      return { kind: "restored", record };
    });
  }

  /**
   * Versions before 2 stored queues without an account. The first account to open such a conversation
   * takes the legacy record over, once; nothing is copied, so no message can exist twice.
   */
  adoptLegacy(target) {
    if (target.accountId === LEGACY_ACCOUNT) return Promise.resolve(0);
    const key = keyOf(target);
    const legacy = keyOf({ accountId: LEGACY_ACCOUNT, conversationId: target.conversationId });
    return this.#store.transact(async (tx) => {
      if ((await tx.getPending(key)) || (await tx.getInflight(key))) return 0;
      const [pending, inflight, state] = [await tx.getPending(legacy), await tx.getInflight(legacy), await tx.getState(legacy)];
      if (!pending && !inflight) return 0;
      if (pending) {
        await tx.deletePending(legacy);
        await tx.putPending({ ...pending, key, accountId: target.accountId });
      }
      if (inflight) {
        await tx.deleteInflight(legacy);
        await tx.putInflight({ ...inflight, key, accountId: target.accountId });
      }
      if (state.paused) {
        await tx.putState({ ...state, key });
        await tx.putState({ ...state, paused: false, editBy: null, editUntil: 0 });
      }
      return 1;
    });
  }

  // ---- sending (lease holder only) -----------------------------------------

  /**
   * Automatic dispatch, one step. Never stops a response and never retries: while the response is
   * running, settling, or Send is unavailable it answers `waiting` and changes nothing.
   */
  step(target) {
    return this.#serial(keyOf(target), async () => {
      if (target.conversationId === "new") return { kind: "waiting", reason: "unresolved-conversation" };
      let view = await this.view(target);
      if (view.inflight?.status === "sending") {
        // Either another tab is mid-send, or its tab is gone and acquiring the lease quarantines the send.
        const lease = await this.#acquire(target);
        if (!lease.ok) return lease.outcome;
        view = await this.view(target);
      }
      const gate = this.#gate(view, false);
      if (gate) return gate;

      const ready = await this.#dispatch.readiness(target);
      if (ready.state === "waiting") return { kind: "waiting", reason: ready.reason };
      if (ready.state === "blocked") return this.#hold(target, view.pending, ready);

      const lease = await this.#acquire(target);
      if (!lease.ok) return lease.outcome;
      const claimed = await this.#claim(target, lease.token, false);
      if (claimed.kind !== "claimed") return claimed;
      return this.#deliver(target, claimed.snapshot, "submit");
    });
  }

  /**
   * Explicit user action on the whole pending prompt. With `native` and a positively detected native
   * steer path it uses that; otherwise, if a response is running, it stops it and only once the stop
   * is confirmed submits the text once. Any doubt leaves the prompt pending with an actionable error.
   */
  steer(target, { native = true } = {}) {
    return this.#serial(keyOf(target), async () => {
      if (target.conversationId === "new") return { kind: "waiting", reason: "unresolved-conversation" };
      const view = await this.view(target);
      const gate = this.#gate(view, true);
      if (gate) return gate;
      const state = await this.#dispatch.readState(target);
      if (state === "unknown") return this.#interruptFailed(target, "state-unknown", "Could not read the conversation state.");

      let lease = await this.#acquire(target);
      if (!lease.ok) return lease.outcome;
      if (state === "generating") {
        if (native) {
          const claimed = await this.#claim(target, lease.token, true);
          if (claimed.kind !== "claimed") return claimed;
          const outcome = await this.#deliver(target, claimed.snapshot, "steer");
          if (outcome.kind !== "unsupported") return outcome;
        }
        const stop = await this.#dispatch.stop(target);
        if (stop.kind !== "confirmed") return this.#interruptFailed(target, stop.code, stop.message);
        // The stop may have outlived the lease; renew (or lose it to another tab) before claiming.
        lease = await this.#acquire(target);
        if (!lease.ok) return lease.outcome;
      }
      const claimed = await this.#claim(target, lease.token, true);
      if (claimed.kind === "gone") return { kind: "interrupt-aborted", reason: "pending-changed" };
      if (claimed.kind !== "claimed") return claimed;
      return this.#deliver(target, claimed.snapshot, "submit");
    });
  }

  /** Renews the lease; call periodically while this tab is the active sender. */
  async heartbeat(target) {
    return (await this.#acquire(target)).ok;
  }

  release(target) {
    const key = keyOf(target);
    return this.#store.transact(async (tx) => {
      const lease = await tx.getLease(key);
      if (lease?.holder === this.#tabId) await tx.deleteLease(key);
    });
  }

  // ---- internals -----------------------------------------------------------

  #serial(key, fn) {
    const run = (this.#tails.get(key) ?? Promise.resolve()).then(fn, fn);
    this.#tails.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }

  #setPaused(target, paused) {
    const key = keyOf(target);
    return this.#store.transact(async (tx) => {
      await tx.putState({ ...(await tx.getState(key)), paused });
    });
  }

  /** Why nothing may be sent now, or null. `explicit` is a user action: pause does not stop it. */
  #gate(view, explicit) {
    const { pending, inflight } = view;
    if (inflight?.status === "manual-review") return { kind: "halted", itemId: inflight.id, status: "manual-review" };
    if (inflight) return { kind: "busy", itemId: inflight.id };
    if (!pending) return { kind: "idle" };
    if (pending.status !== "pending") return { kind: "halted", itemId: pending.id, status: pending.status };
    if (view.editing) return explicit ? { kind: "editing" } : { kind: "waiting", reason: "editing" };
    if (view.paused && !explicit) return { kind: "paused" };
    return null;
  }

  /** The dispatcher found the page unusable for a reason only the user can fix: hold the prompt, once. */
  async #hold(target, pending, blocked) {
    const key = keyOf(target);
    await this.#store.transact(async (tx) => {
      const record = await tx.getPending(key);
      if (!record || record.id !== pending.id || record.status !== "pending") return;
      await tx.putPending({ ...record, status: "blocked", lastError: errorOf(blocked, this.#clock.now()), updatedAt: this.#clock.now() });
    });
    return { kind: "halted", itemId: pending.id, status: "blocked" };
  }

  /**
   * Acquires or renews this tab's lease. A fresh acquisition (first, or after
   * expiry) gets a new fencing token and, in the same transaction, turns any
   * snapshot still `sending` under an older token into manual-review: its
   * sender is gone and we cannot know whether it was delivered.
   */
  #acquire(target) {
    const key = keyOf(target);
    return this.#store.transact(async (tx) => {
      const now = this.#clock.now();
      const current = await tx.getLease(key);
      if (current && current.expiresAt > now && current.holder !== this.#tabId) {
        return { ok: false, outcome: { kind: "not-leader", holder: current.holder, expiresAt: current.expiresAt } };
      }
      const keep = current !== undefined && current.holder === this.#tabId && current.expiresAt > now;
      const token = keep ? current.token : (current?.token ?? 0) + 1;
      await tx.putLease({ key, holder: this.#tabId, token, expiresAt: now + this.#leaseTtlMs });
      if (!keep) {
        const inflight = await tx.getInflight(key);
        if (inflight?.status === "sending" && inflight.leaseToken !== token) {
          await tx.putInflight({ ...inflight, status: "manual-review", lastError: orphanError(now) });
        }
      }
      return { ok: true, token };
    });
  }

  /**
   * The only place the pending prompt becomes an in-flight snapshot: one transaction moves the text,
   * so every append lands either in this snapshot (committed before it) or in the next pending prompt.
   */
  async #claim(target, token, explicit) {
    const key = keyOf(target);
    return this.#store
      .transact(async (tx) => {
        const lease = await tx.getLease(key);
        const now = this.#clock.now();
        if (!lease || lease.holder !== this.#tabId || lease.token !== token || lease.expiresAt <= now) {
          throw new QueueError("lease-lost", "Another tab holds the sender lease.");
        }
        const view = this.#viewOf(await tx.getPending(key), await tx.getInflight(key), await tx.getState(key));
        const gate = this.#gate(view, explicit);
        if (gate) return gate.kind === "idle" ? { kind: "gone" } : gate;
        const { pending } = view;
        const snapshot = {
          key,
          id: this.#newId(),
          sourceId: pending.id,
          accountId: pending.accountId,
          conversationId: pending.conversationId,
          text: pending.text,
          attachments: pending.attachments,
          version: pending.version,
          status: "sending",
          attempts: 1,
          leaseToken: token,
          claimedAt: now,
          lastError: null,
        };
        await tx.putInflight(snapshot);
        await tx.deletePending(key);
        await tx.putLease({ ...lease, expiresAt: now + this.#leaseTtlMs });
        return { kind: "claimed", snapshot };
      })
      .catch(async (error) => {
        if (error instanceof QueueError && error.code === "lease-lost") return this.#notLeader(key);
        throw error;
      });
  }

  async #notLeader(key) {
    const lease = await this.#store.transact((tx) => tx.getLease(key));
    return { kind: "not-leader", holder: lease?.holder ?? "unknown", expiresAt: lease?.expiresAt ?? 0 };
  }

  async #deliver(target, snapshot, via) {
    const request = {
      itemId: snapshot.id,
      sourceId: snapshot.sourceId,
      accountId: snapshot.accountId,
      conversationId: snapshot.conversationId,
      text: snapshot.text,
      attachments: snapshot.attachments,
    };
    const result = await this.#dispatch[via](request);
    return this.#record(snapshot, result);
  }

  /** Records a send result; compare-and-set on the snapshot id so stale results are dropped. */
  #record(snapshot, result) {
    return this.#store.transact(async (tx) => {
      const current = await tx.getInflight(snapshot.key);
      if (!current || current.id !== snapshot.id || (current.status !== "sending" && current.status !== "manual-review")) {
        return { kind: "busy", itemId: snapshot.id };
      }
      const now = this.#clock.now();
      if (result.kind === "accepted") {
        await tx.deleteInflight(snapshot.key);
        return { kind: "sent", itemId: snapshot.id };
      }
      if (result.kind === "uncertain") {
        await tx.putInflight({
          ...current,
          status: "manual-review",
          lastError: {
            code: result.code,
            message: result.message,
            action: "Check the conversation in ChatGPT. Mark the message delivered if it is there, or restore it to the queue if it is not.",
            at: now,
          },
        });
        return { kind: "manual-review", itemId: snapshot.id };
      }
      // Nothing left the page: the text goes back to the front of the pending prompt.
      await tx.deleteInflight(snapshot.key);
      if (result.kind === "rejected") {
        const record = await this.#restore(tx, current, { code: result.code, message: result.message, action: result.action ?? "Fix the problem in ChatGPT, then press Retry.", at: now });
        return { kind: "rejected", itemId: snapshot.id, error: record.lastError };
      }
      await this.#restore(tx, current, null);
      return result.kind === "unsupported" ? { kind: "unsupported" } : { kind: "waiting", reason: result.reason ?? "not-ready" };
    });
  }

  async #restore(tx, snapshot, error) {
    const now = this.#clock.now();
    const later = await tx.getPending(snapshot.key);
    const record = {
      key: snapshot.key,
      id: snapshot.sourceId,
      accountId: snapshot.accountId,
      conversationId: snapshot.conversationId,
      text: joinContributions(snapshot.text, later?.text),
      attachments: snapshot.attachments.concat(later?.attachments ?? []),
      status: error ? "blocked" : (later?.status ?? "pending"),
      version: Math.max(later?.version ?? 0, snapshot.version ?? 0) + 1,
      createdAt: later?.createdAt ?? now,
      updatedAt: now,
      lastError: error ?? later?.lastError ?? null,
      ops: later?.ops ?? [],
    };
    applyAttachmentGate(record, now);
    await tx.putPending(record);
    return record;
  }

  async #interruptFailed(target, code, message) {
    const key = keyOf(target);
    const error = {
      code,
      message,
      action: STOP_ACTIONS[code] ?? "The response was not confirmed stopped. Nothing was sent; check ChatGPT and try again.",
      at: this.#clock.now(),
    };
    await this.#store.transact(async (tx) => {
      const pending = await tx.getPending(key);
      if (pending?.status === "pending") await tx.putPending({ ...pending, lastError: error });
    });
    return { kind: "interrupt-failed", error };
  }
}

function errorOf(blocked, at) {
  return { code: blocked.code, message: blocked.message, action: blocked.action ?? "Fix the problem in ChatGPT, then press Retry.", at };
}

function applyAttachmentGate(record, now) {
  const lost = record.attachments.filter((a) => !a.restorable);
  if (lost.length) {
    record.status = "blocked";
    record.lastError = {
      code: "attachments-not-restorable",
      message: `Cannot restore ${lost.map((a) => a.name).join(", ")}.`,
      action: "Send without the files, or delete the prompt and reattach them.",
      at: now,
    };
  } else if (record.lastError?.code === "attachments-not-restorable") {
    record.status = "pending";
    record.lastError = null;
  }
}

function orphanError(now) {
  return {
    code: "orphaned-send",
    message: "The tab that was sending this message stopped before reporting the result.",
    action: "Check the conversation in ChatGPT. Mark the message delivered if it is there, or restore it to the queue if it is not.",
    at: now,
  };
}
