import type { DispatchBoundary, SubmitResult } from "./dispatch.ts";
import type { QueueStore, Tx } from "./store.ts";
import {
  QueueError,
  type AttachmentRef,
  type Clock,
  type ItemError,
  type ItemStatus,
  type LeaseRecord,
  type QueueItem,
} from "./types.ts";

export interface QueueEngineOptions {
  store: QueueStore;
  dispatch: DispatchBoundary;
  clock: Clock;
  /** Identifies this tab/sender in the cross-tab lease. */
  tabId: string;
  newId?: () => string;
  leaseTtlMs?: number;
  /** Total submissions allowed per item before a definite failure is final. */
  maxAttempts?: number;
  /** Delay before retry n (1-based); the last entry repeats. */
  retryBackoffMs?: number[];
}

export type StepOutcome =
  | { kind: "idle" }
  | { kind: "paused" }
  | { kind: "not-leader"; holder: string; expiresAt: number }
  | { kind: "busy"; itemId: string }
  | { kind: "halted"; itemId: string; status: ItemStatus }
  | { kind: "waiting"; reason: "generating" | "unknown-state" | "backoff"; until?: number }
  | { kind: "sent"; itemId: string }
  | { kind: "retry-scheduled"; itemId: string; notBefore: number }
  | { kind: "failed"; itemId: string }
  | { kind: "manual-review"; itemId: string };

export type InterruptOutcome =
  | StepOutcome
  | { kind: "interrupt-failed"; itemId: string; error: ItemError }
  /** The stop went through but the queue head changed, so nothing was sent. */
  | { kind: "interrupt-aborted"; reason: "head-changed" };

const DEFAULT_BACKOFF = [1_000, 5_000];

const STOP_ACTIONS: Record<string, string> = {
  "stop-timeout": "ChatGPT did not confirm the stop. Check the response, then press Interrupt & Send Next again.",
  "stop-not-idle": "The response may still be running. Wait for it to finish or stop it manually, then try again.",
  "state-unknown": "Could not tell whether a response is running. Check ChatGPT, then try again.",
};

export class QueueEngine {
  readonly #store: QueueStore;
  readonly #dispatch: DispatchBoundary;
  readonly #clock: Clock;
  readonly #tabId: string;
  readonly #newId: () => string;
  readonly #leaseTtlMs: number;
  readonly #maxAttempts: number;
  readonly #backoff: number[];
  readonly #tails = new Map<string, Promise<unknown>>();

  constructor(opts: QueueEngineOptions) {
    this.#store = opts.store;
    this.#dispatch = opts.dispatch;
    this.#clock = opts.clock;
    this.#tabId = opts.tabId;
    this.#newId = opts.newId ?? (() => crypto.randomUUID());
    this.#leaseTtlMs = opts.leaseTtlMs ?? 15_000;
    this.#maxAttempts = opts.maxAttempts ?? 3;
    this.#backoff = opts.retryBackoffMs ?? DEFAULT_BACKOFF;
  }

  // ---- user-facing queue editing (any tab, no lease needed) ----------------

  enqueue(conversationId: string, input: { text: string; attachments?: AttachmentRef[] }): Promise<QueueItem> {
    return this.#store.transact(async (tx) => {
      const items = await tx.itemsOf(conversationId);
      const now = this.#clock.now();
      const attachments = input.attachments ?? [];
      const item: QueueItem = {
        id: this.#newId(),
        conversationId,
        text: input.text,
        attachments,
        status: "pending",
        position: items.length ? items[items.length - 1]!.position + 1 : 0,
        version: 1,
        attempts: 0,
        notBefore: 0,
        attemptId: null,
        leaseToken: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        sentAt: null,
      };
      applyAttachmentGate(item, now);
      await tx.putItem(item);
      return item;
    });
  }

  edit(id: string, patch: { text?: string; attachments?: AttachmentRef[] }): Promise<QueueItem> {
    return this.#mutate(id, (item, now) => {
      if (item.status === "sending" || item.status === "sent" || item.status === "manual-review") {
        throw new QueueError("item-locked", `Item ${id} is ${item.status} and cannot be edited.`);
      }
      if (patch.text !== undefined) item.text = patch.text;
      if (patch.attachments !== undefined) item.attachments = patch.attachments;
      item.version += 1;
      item.status = "pending";
      item.attempts = 0;
      item.notBefore = 0;
      item.lastError = null;
      applyAttachmentGate(item, now);
    });
  }

  /** Clears a `blocked` item once the user has reattached its files. */
  reattach(id: string, attachments: AttachmentRef[]): Promise<QueueItem> {
    return this.edit(id, { attachments });
  }

  remove(id: string): Promise<void> {
    return this.#store.transact(async (tx) => {
      const item = await tx.getItem(id);
      if (!item) throw new QueueError("not-found", `Item ${id} does not exist.`);
      if (item.status === "sending") throw new QueueError("item-locked", `Item ${id} is being sent.`);
      await tx.deleteItem(id);
    });
  }

  /** Moves an unsent item to `toIndex` among the unsent items of its conversation. */
  move(id: string, toIndex: number): Promise<QueueItem[]> {
    return this.#store.transact(async (tx) => {
      const target = await tx.getItem(id);
      if (!target) throw new QueueError("not-found", `Item ${id} does not exist.`);
      const unsent = (await tx.itemsOf(target.conversationId)).filter((i) => i.status !== "sent");
      if (unsent.some((i) => i.status === "sending")) {
        throw new QueueError("item-locked", "The queue cannot be reordered while a message is being sent.");
      }
      const from = unsent.findIndex((i) => i.id === id);
      if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= unsent.length) {
        throw new QueueError("invalid-order", `Index ${toIndex} is outside 0..${unsent.length - 1}.`);
      }
      const positions = unsent.map((i) => i.position);
      const [moved] = unsent.splice(from, 1);
      unsent.splice(toIndex, 0, moved!);
      const now = this.#clock.now();
      for (const [i, item] of unsent.entries()) {
        item.position = positions[i]!;
        item.version += 1;
        item.updatedAt = now;
        await tx.putItem(item);
      }
      return unsent;
    });
  }

  pause(conversationId: string): Promise<void> {
    return this.#setPaused(conversationId, true);
  }

  resume(conversationId: string): Promise<void> {
    return this.#setPaused(conversationId, false);
  }

  /** The user chose to resend a failed or uncertain item. Resets the retry budget. */
  retry(id: string): Promise<QueueItem> {
    return this.#mutate(id, (item) => {
      if (item.status !== "failed" && item.status !== "manual-review") {
        throw new QueueError("invalid-state", `Item ${id} is ${item.status}; only failed or manual-review items can be retried.`);
      }
      item.status = "pending";
      item.attempts = 0;
      item.notBefore = 0;
      item.attemptId = null;
      item.lastError = null;
    });
  }

  /** The user confirmed in ChatGPT that an uncertain or failed item did go out. */
  markDelivered(id: string): Promise<QueueItem> {
    return this.#mutate(id, (item, now) => {
      if (item.status !== "failed" && item.status !== "manual-review") {
        throw new QueueError("invalid-state", `Item ${id} is ${item.status}; nothing to confirm.`);
      }
      item.status = "sent";
      item.sentAt = now;
      item.lastError = null;
    });
  }

  clearSent(conversationId: string): Promise<number> {
    return this.#store.transact(async (tx) => {
      const sent = (await tx.itemsOf(conversationId)).filter((i) => i.status === "sent");
      for (const item of sent) await tx.deleteItem(item.id);
      return sent.length;
    });
  }

  list(conversationId: string): Promise<{ paused: boolean; items: QueueItem[] }> {
    return this.#store.transact(async (tx) => ({
      paused: (await tx.getQueue(conversationId))?.paused ?? false,
      items: await tx.itemsOf(conversationId),
    }));
  }

  // ---- sending (lease holder only) -----------------------------------------

  /** Sequential drain, one step. Never stops a response; waits for it to finish. */
  step(conversationId: string): Promise<StepOutcome> {
    return this.#serial(conversationId, async () => {
      const lease = await this.#acquire(conversationId);
      if (!lease.ok) return lease.outcome;
      const view = await this.#view(conversationId);
      if (view.paused) return { kind: "paused" };
      const gate = this.#headGate(view.head);
      if (gate) return gate;
      const head = view.head!;
      if (head.notBefore > this.#clock.now()) {
        return { kind: "waiting", reason: "backoff", until: head.notBefore };
      }
      const state = await this.#dispatch.readState(conversationId);
      if (state !== "idle") return { kind: "waiting", reason: state === "generating" ? "generating" : "unknown-state" };
      return this.#send(head, lease.token);
    });
  }

  /**
   * Explicit user action. If a response is running, stops it and, only once the
   * stop is confirmed, submits exactly the next item. Any doubt leaves the item
   * pending with an actionable error and sends nothing.
   */
  interruptAndSendNext(conversationId: string): Promise<InterruptOutcome> {
    return this.#serial(conversationId, async (): Promise<InterruptOutcome> => {
      const lease = await this.#acquire(conversationId);
      if (!lease.ok) return lease.outcome;
      let token = lease.token;
      const view = await this.#view(conversationId);
      const gate = this.#headGate(view.head);
      if (gate) return gate;
      const head = view.head!;

      const state = await this.#dispatch.readState(conversationId);
      if (state === "unknown") {
        return this.#interruptFailed(head, "state-unknown", "Could not read the conversation state.");
      }
      if (state === "generating") {
        const stop = await this.#dispatch.stop(conversationId);
        if (stop.kind !== "confirmed") return this.#interruptFailed(head, stop.code, stop.message);
        // The stop may have outlived the lease; renew (or lose it to another tab) before claiming.
        const renewed = await this.#acquire(conversationId);
        if (!renewed.ok) return renewed.outcome;
        token = renewed.token;
        const after = await this.#view(conversationId);
        const next = after.head;
        if (!next || next.id !== head.id || next.version !== head.version || next.status !== "pending") {
          return { kind: "interrupt-aborted", reason: "head-changed" };
        }
        return this.#send(next, token);
      }
      return this.#send(head, token);
    });
  }

  /** Renews the lease; call periodically while this tab is the active sender. */
  async heartbeat(conversationId: string): Promise<boolean> {
    return (await this.#acquire(conversationId)).ok;
  }

  release(conversationId: string): Promise<void> {
    return this.#store.transact(async (tx) => {
      const lease = await tx.getLease(conversationId);
      if (lease?.holder === this.#tabId) await tx.deleteLease(conversationId);
    });
  }

  // ---- internals -----------------------------------------------------------

  #serial<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.#tails.get(conversationId) ?? Promise.resolve()).then(fn, fn);
    this.#tails.set(conversationId, run.catch(() => undefined));
    return run;
  }

  async #mutate(id: string, fn: (item: QueueItem, now: number) => void): Promise<QueueItem> {
    return this.#store.transact(async (tx) => {
      const item = await tx.getItem(id);
      if (!item) throw new QueueError("not-found", `Item ${id} does not exist.`);
      const now = this.#clock.now();
      fn(item, now);
      item.updatedAt = now;
      await tx.putItem(item);
      return item;
    });
  }

  #setPaused(conversationId: string, paused: boolean): Promise<void> {
    return this.#store.transact(async (tx) => {
      await tx.putQueue({ conversationId, paused });
    });
  }

  async #view(conversationId: string): Promise<{ paused: boolean; head: QueueItem | undefined }> {
    const { paused, items } = await this.list(conversationId);
    return { paused, head: items.find((i) => i.status !== "sent") };
  }

  #headGate(head: QueueItem | undefined): StepOutcome | null {
    if (!head) return { kind: "idle" };
    if (head.status === "sending") return { kind: "busy", itemId: head.id };
    // An item that needs attention holds the queue: later prompts may depend on it.
    if (head.status !== "pending") return { kind: "halted", itemId: head.id, status: head.status };
    return null;
  }

  /**
   * Acquires or renews this tab's lease. A fresh acquisition (first, or after
   * expiry) gets a new fencing token and, in the same transaction, turns any
   * item still `sending` under an older token into manual-review: its sender is
   * gone and we cannot know whether it was delivered.
   */
  async #acquire(
    conversationId: string,
  ): Promise<{ ok: true; token: number } | { ok: false; outcome: Extract<StepOutcome, { kind: "not-leader" }> }> {
    return this.#store.transact(async (tx) => {
      const now = this.#clock.now();
      const current = await tx.getLease(conversationId);
      if (current && current.expiresAt > now && current.holder !== this.#tabId) {
        return { ok: false as const, outcome: { kind: "not-leader" as const, holder: current.holder, expiresAt: current.expiresAt } };
      }
      const keep = current !== undefined && current.holder === this.#tabId && current.expiresAt > now;
      const token = keep ? current.token : (current?.token ?? 0) + 1;
      await tx.putLease({ conversationId, holder: this.#tabId, token, expiresAt: now + this.#leaseTtlMs });
      if (!keep) {
        for (const item of await tx.itemsOf(conversationId)) {
          if (item.status === "sending" && item.leaseToken !== token) {
            item.status = "manual-review";
            item.lastError = orphanError(now);
            item.updatedAt = now;
            await tx.putItem(item);
          }
        }
      }
      return { ok: true as const, token };
    });
  }

  async #checkLease(tx: Tx, conversationId: string, token: number): Promise<LeaseRecord> {
    const lease = await tx.getLease(conversationId);
    const now = this.#clock.now();
    if (!lease || lease.holder !== this.#tabId || lease.token !== token || lease.expiresAt <= now) {
      throw new QueueError("lease-lost", "Another tab holds the sender lease.");
    }
    return lease;
  }

  /** Claim -> submit -> record. The claim is the only place an item becomes `sending`. */
  async #send(head: QueueItem, token: number): Promise<StepOutcome> {
    const attemptId = this.#newId();
    const claimed = await this.#store
      .transact(async (tx) => {
        const lease = await this.#checkLease(tx, head.conversationId, token);
        const fresh = await tx.getItem(head.id);
        const first = (await tx.itemsOf(head.conversationId)).find((i) => i.status !== "sent");
        if (!fresh || first?.id !== fresh.id || fresh.status !== "pending" || fresh.version !== head.version) {
          return null;
        }
        const now = this.#clock.now();
        fresh.status = "sending";
        fresh.attempts += 1;
        fresh.attemptId = attemptId;
        fresh.leaseToken = token;
        fresh.lastError = null;
        fresh.updatedAt = now;
        await tx.putItem(fresh);
        await tx.putLease({ ...lease, expiresAt: now + this.#leaseTtlMs });
        return fresh;
      })
      .catch((error: unknown) => {
        if (error instanceof QueueError && error.code === "lease-lost") return "lease-lost" as const;
        throw error;
      });
    if (claimed === "lease-lost") return this.#notLeader(head.conversationId);
    if (!claimed) return { kind: "busy", itemId: head.id };

    const result = await this.#dispatch.submit({
      itemId: claimed.id,
      attemptId,
      conversationId: claimed.conversationId,
      text: claimed.text,
      attachments: claimed.attachments,
    });
    return this.#record(claimed.id, attemptId, result);
  }

  async #notLeader(conversationId: string): Promise<StepOutcome> {
    const lease = await this.#store.transact((tx) => tx.getLease(conversationId));
    return { kind: "not-leader", holder: lease?.holder ?? "unknown", expiresAt: lease?.expiresAt ?? 0 };
  }

  /** Records a submit result; compare-and-set on `attemptId` so stale results are dropped. */
  #record(id: string, attemptId: string, result: SubmitResult): Promise<StepOutcome> {
    return this.#store.transact(async (tx): Promise<StepOutcome> => {
      const item = await tx.getItem(id);
      if (!item || item.attemptId !== attemptId || (item.status !== "sending" && item.status !== "manual-review")) {
        return { kind: "busy", itemId: id };
      }
      const now = this.#clock.now();
      item.updatedAt = now;
      let outcome: StepOutcome;
      if (result.kind === "accepted") {
        item.status = "sent";
        item.sentAt = now;
        item.lastError = null;
        outcome = { kind: "sent", itemId: id };
      } else if (result.kind === "uncertain") {
        item.status = "manual-review";
        item.lastError = {
          code: result.code,
          message: result.message,
          action: "Check the conversation in ChatGPT. Mark the message delivered if it is there, or retry it if it is not.",
          at: now,
        };
        outcome = { kind: "manual-review", itemId: id };
      } else if (result.retryable && item.attempts < this.#maxAttempts) {
        item.status = "pending";
        item.notBefore = now + this.#backoff[Math.min(item.attempts, this.#backoff.length) - 1]!;
        item.lastError = {
          code: result.code,
          message: result.message,
          action: `Will retry automatically (attempt ${item.attempts} of ${this.#maxAttempts}).`,
          at: now,
        };
        outcome = { kind: "retry-scheduled", itemId: id, notBefore: item.notBefore };
      } else {
        item.status = "failed";
        item.lastError = {
          code: result.code,
          message: result.message,
          action: "The message was not sent. Edit or retry it, or remove it from the queue.",
          at: now,
        };
        outcome = { kind: "failed", itemId: id };
      }
      await tx.putItem(item);
      return outcome;
    });
  }

  async #interruptFailed(head: QueueItem, code: string, message: string): Promise<InterruptOutcome> {
    const error: ItemError = {
      code,
      message,
      action: STOP_ACTIONS[code] ?? "The response was not confirmed stopped. Nothing was sent; check ChatGPT and try again.",
      at: this.#clock.now(),
    };
    await this.#store.transact(async (tx) => {
      const item = await tx.getItem(head.id);
      if (item && item.status === "pending") {
        item.lastError = error;
        await tx.putItem(item);
      }
    });
    return { kind: "interrupt-failed", itemId: head.id, error };
  }
}

function applyAttachmentGate(item: QueueItem, now: number): void {
  const lost = item.attachments.filter((a) => !a.restorable);
  if (lost.length === 0) return;
  item.status = "blocked";
  item.lastError = {
    code: "attachments-not-restorable",
    message: `Cannot restore ${lost.map((a) => a.name).join(", ")}.`,
    action: "Reattach the files, then the message can be sent.",
    at: now,
  };
}

function orphanError(now: number): ItemError {
  return {
    code: "orphaned-send",
    message: "The tab that was sending this message stopped before reporting the result.",
    action: "Check the conversation in ChatGPT. Mark the message delivered if it is there, or retry it if it is not.",
    at: now,
  };
}
