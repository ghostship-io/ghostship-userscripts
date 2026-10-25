/** Shared types for the durable ChatGPT message queue (logic only, no DOM). */

export type ItemStatus =
  | "pending" // waiting to be sent
  | "sending" // claimed by a sender; outcome not yet recorded
  | "sent" // the dispatcher accepted the submission
  | "failed" // definitely not delivered and out of retries (or not retryable)
  | "manual-review" // delivery uncertain; never retried without the user
  | "blocked"; // needs user action before it can be sent (e.g. reattach files)

export interface AttachmentRef {
  name: string;
  size: number;
  type: string;
  /** False when the file bytes cannot be restored after a reload. */
  restorable: boolean;
}

export interface ItemError {
  code: string;
  message: string;
  /** What the user can do about it. */
  action: string;
  at: number;
}

export interface QueueItem {
  /** Stable for the life of the item; doubles as the dispatcher idempotency key. */
  id: string;
  conversationId: string;
  text: string;
  attachments: AttachmentRef[];
  status: ItemStatus;
  /** Sort key within a conversation; unique per conversation. */
  position: number;
  /** Bumped by every user-visible change; used to detect edits that race a send. */
  version: number;
  /** Submissions started (each `sending` claim counts). */
  attempts: number;
  /** Earliest time a retry may be claimed. */
  notBefore: number;
  /** Identifies the current/last claim; finalization is compare-and-set on it. */
  attemptId: string | null;
  /** Lease token the current claim ran under. */
  leaseToken: number | null;
  lastError: ItemError | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
}

export interface ConversationQueueState {
  conversationId: string;
  paused: boolean;
}

export interface LeaseRecord {
  conversationId: string;
  holder: string;
  /** Fencing token: increases on every new acquisition. */
  token: number;
  expiresAt: number;
}

export type QueueErrorCode =
  | "not-found"
  | "item-locked"
  | "invalid-order"
  | "not-leader"
  | "lease-lost"
  | "stale-attempt"
  | "invalid-state";

export class QueueError extends Error {
  readonly code: QueueErrorCode;
  constructor(code: QueueErrorCode, message: string) {
    super(message);
    this.name = "QueueError";
    this.code = code;
  }
}

export interface Clock {
  now(): number;
  /** Schedules `fn` after `ms`; returns a cancel function. */
  after(ms: number, fn: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  after(ms, fn) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};
