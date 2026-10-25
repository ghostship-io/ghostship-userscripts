/** Shared types for the durable ChatGPT message queue (logic only, no DOM). */

export class QueueError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "QueueError";
    this.code = code;
  }
}

export const systemClock = {
  now: () => Date.now(),
  after(ms, fn) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};

/**
 * @typedef {"pending"|"sending"|"sent"|"failed"|"manual-review"|"blocked"} ItemStatus
 *   pending: waiting; sending: claimed, outcome unrecorded; sent: accepted by the dispatcher;
 *   failed: definitely not delivered, out of retries; manual-review: delivery uncertain, never
 *   retried without the user; blocked: needs user action (e.g. reattach files).
 *
 * @typedef {{name: string, size: number, type: string, restorable: boolean}} AttachmentRef
 * @typedef {{code: string, message: string, action: string, at: number}} ItemError
 *
 * @typedef {object} QueueItem
 * @property {string} id Stable; doubles as the dispatcher idempotency key.
 * @property {string} conversationId
 * @property {string} text
 * @property {AttachmentRef[]} attachments
 * @property {string|null} model Model the message will use, when known at queue time.
 * @property {ItemStatus} status
 * @property {number} position Sort key within a conversation.
 * @property {number} version Bumped by every user-visible change; detects edits racing a send.
 * @property {number} attempts Submissions started.
 * @property {number} notBefore Earliest time a retry may be claimed.
 * @property {string|null} attemptId Current/last claim; finalization is compare-and-set on it.
 * @property {number|null} leaseToken Lease token the current claim ran under.
 * @property {ItemError|null} lastError
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number|null} sentAt
 *
 * @typedef {{now(): number, after(ms: number, fn: () => void): () => void}} Clock
 */
