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
 * @typedef {{accountId: string, conversationId: string}} Target
 *   What a record belongs to, fixed when its first text is queued; never "whatever is on screen".
 *
 * @typedef {{name: string, size: number, type: string, restorable: boolean}} AttachmentRef
 * @typedef {{code: string, message: string, action: string, at: number}} ItemError
 *
 * @typedef {object} PendingRecord The ONE accumulating prompt of a target.
 * @property {string} key `${accountId}:${conversationId}`
 * @property {string} id Stable across appends and edits.
 * @property {string} text Contributions joined by exactly one blank line.
 * @property {AttachmentRef[]} attachments
 * @property {"pending"|"blocked"} status blocked: needs the user (files, composer lost, Send unavailable).
 * @property {number} version Bumped by every change; an edit compares against it.
 * @property {ItemError|null} lastError
 * @property {string[]} ops Recently applied operation ids (idempotent appends).
 *
 * @typedef {object} InflightRecord The immutable text a send claimed; at most one per target.
 * @property {string} id Doubles as the dispatcher's idempotency key.
 * @property {string} sourceId Id of the pending record it was claimed from.
 * @property {string} text Never modified once claimed.
 * @property {"sending"|"manual-review"} status sending: outcome unrecorded; manual-review: delivery uncertain, never retried without the user.
 * @property {number} attempts Real Send clicks started; waiting never counts.
 * @property {number|null} leaseToken
 *
 * @typedef {{now(): number, after(ms: number, fn: () => void): () => void}} Clock
 */
