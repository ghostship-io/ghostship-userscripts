// The live transport: fills ChatGPT's real composer and clicks its Send / Stop buttons through the
// adapter's selectors. It is the only file in src/ allowed to click (see the banned-primitive test).
// It fails closed: whenever the page is not in the expected shape it sends nothing and says why.
// Waiting (a response is running or settling, Send is not there yet) is a normal answer, not a failure:
// `readiness` and a not-ready `submit` consume nothing and nothing is retried by the dispatcher.
import { createComposerIO } from "./composer.js";

const norm = (text) => text.replace(/\s+/g, " ").trim();

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {object} o.adapter composerInput / sendButton / steerButton / stopButton / generating / userTurnCount / accountId / conversationId
 * @param {number} [o.pollMs]
 * @param {number} [o.settleMs] how long the response must have been over before a send is staged
 * @param {number} [o.sendWaitMs] how long to wait for native Send to enable once the text is in the composer
 * @param {number} [o.steerWaitMs] how long to wait for a native steer control to appear before falling back
 * @param {number} [o.ackMs] how long to wait for evidence that a click was accepted
 * @param {number} [o.stopWaitMs] how long to wait for the Stop button to go away
 * @param {number} [o.composerLostMs] how long a missing composer is tolerated before the prompt is held
 * @param {() => number} [o.now]
 */
export function createLiveDispatcher({
  win,
  adapter,
  pollMs = 50,
  settleMs = 600,
  sendWaitMs = 8000,
  steerWaitMs = 1500,
  ackMs = 6000,
  stopWaitMs = 5000,
  composerLostMs = 15_000,
  now = () => Date.now(),
}) {
  const doc = win.document;
  const io = createComposerIO(win);
  // Snapshot ids already clicked on this page: a second submit of the same id never clicks again.
  const clicked = new Set();
  let lastBusy = -Infinity;
  let composerMissingSince = null;

  const waitFor = (probe, ms) =>
    new Promise((resolve) => {
      const started = Date.now();
      const poll = () => {
        const hit = probe();
        if (hit) return resolve(hit);
        if (Date.now() - started >= ms) return resolve(null);
        win.setTimeout(poll, pollMs);
      };
      poll();
    });

  const generating = () => adapter.generating(doc);
  const onTarget = (target) => adapter.conversationId(win) === target.conversationId && adapter.accountId(doc) === target.accountId;
  const enabled = (button) => (button && !button.disabled && button.getAttribute("aria-disabled") !== "true" ? button : null);

  /** Why a send must not start now, or null. Read-only. */
  function notReady(target, { allowGenerating = false } = {}) {
    if (!onTarget(target)) return { state: "waiting", reason: "other-conversation" };
    const input = adapter.composerInput(doc);
    if (!input) {
      composerMissingSince ??= now();
      if (now() - composerMissingSince >= composerLostMs) {
        return {
          state: "blocked",
          code: "composer-lost",
          message: "The ChatGPT composer has not been found for a while; nothing was sent.",
          action: "Reload the page or open the conversation again, then press Retry.",
        };
      }
      return { state: "waiting", reason: "composer-missing" };
    }
    composerMissingSince = null;
    if (!allowGenerating) {
      if (generating()) {
        lastBusy = now();
        return { state: "waiting", reason: "generating" };
      }
      if (now() - lastBusy < settleMs) return { state: "waiting", reason: "settling" };
    }
    if (io.hasText(input)) return { state: "waiting", reason: "composer-has-draft" };
    return null;
  }

  const unstage = (input, text) => {
    // Only take out what we put there; anything the user typed since stays.
    if (norm(io.read(input)) === norm(text)) io.write(input, "");
  };

  /** Puts `text` into the empty composer and waits for `control()` to be enabled; clears it again on failure. */
  async function stage(target, text, control, ms, { allowGenerating }) {
    const input = adapter.composerInput(doc);
    if (!io.write(input, text) || norm(io.read(input)) !== norm(text)) {
      unstage(input, text);
      return { failed: { kind: "rejected", code: "composer-fill-failed", message: "The text could not be placed in the composer; nothing was sent.", action: "Reload the page, then press Retry." } };
    }
    const button = await waitFor(() => {
      if (!onTarget(target)) return "left";
      if (!allowGenerating && generating()) return "busy";
      return enabled(control());
    }, ms);
    if (button === "left") {
      unstage(input, text);
      return { failed: { kind: "wait", reason: "other-conversation" } };
    }
    if (button === "busy") {
      unstage(input, text);
      return { failed: { kind: "wait", reason: "generating" } };
    }
    if (!button) {
      unstage(input, text);
      return { missing: true };
    }
    return { input, button };
  }

  // While steering, a running response is the starting point, not evidence; a normal send also counts a response that starts.
  async function click(itemId, button, turnsBefore, target, { steering = false } = {}) {
    // Confirm site, account and conversation immediately before the click.
    if (!onTarget(target)) {
      return { kind: "wait", reason: "other-conversation" };
    }
    clicked.add(itemId);
    button.click();
    const evidence = await waitFor(() => {
      const input = adapter.composerInput(doc);
      return adapter.userTurnCount(doc) > turnsBefore || (!steering && generating()) || (input !== null && io.read(input) === "");
    }, ackMs);
    return evidence
      ? { kind: "accepted" }
      : { kind: "uncertain", code: "submit-unacknowledged", message: "Send was clicked but ChatGPT showed no sign of accepting it." };
  }

  const attachmentsRefused = {
    kind: "rejected",
    code: "attachments-unsupported",
    message: "Messages with attachments cannot be sent by the queue yet; nothing was sent.",
    action: "Send without the files, or delete the prompt and send it from ChatGPT.",
  };

  return {
    async readState() {
      if (!adapter.composerInput(doc)) return "unknown";
      return generating() ? "generating" : "idle";
    },

    async readiness(target) {
      return notReady(target) ?? { state: "ready" };
    },

    async submit({ itemId, accountId, conversationId, text, attachments }) {
      const target = { accountId, conversationId };
      if (clicked.has(itemId)) {
        return { kind: "uncertain", code: "already-attempted", message: "This message was already submitted from this page." };
      }
      if (attachments.length) return attachmentsRefused;
      const not = notReady(target);
      if (not) return not.state === "blocked" ? { kind: "rejected", code: not.code, message: not.message, action: not.action } : { kind: "wait", reason: not.reason };

      const staged = await stage(target, text, () => adapter.sendButton(doc), sendWaitMs, { allowGenerating: false });
      if (staged.failed) return staged.failed;
      if (staged.missing) {
        return { kind: "rejected", code: "send-unavailable", message: "ChatGPT's Send button did not become available; nothing was sent.", action: "Check the page, then press Retry." };
      }
      return click(itemId, staged.button, adapter.userTurnCount(doc), target);
    },

    /** The native steer control, only if the page shows one once the text is in; otherwise `unsupported`. */
    async steer({ itemId, accountId, conversationId, text, attachments }) {
      const target = { accountId, conversationId };
      if (clicked.has(itemId)) {
        return { kind: "uncertain", code: "already-attempted", message: "This message was already submitted from this page." };
      }
      if (attachments.length) return attachmentsRefused;
      if (!generating()) return { kind: "wait", reason: "not-generating" };
      const not = notReady(target, { allowGenerating: true });
      if (not) return not.state === "blocked" ? { kind: "rejected", code: not.code, message: not.message, action: not.action } : { kind: "wait", reason: not.reason };

      const staged = await stage(target, text, () => adapter.steerButton(doc), steerWaitMs, { allowGenerating: true });
      if (staged.failed) return staged.failed;
      if (staged.missing) return { kind: "unsupported" };
      return click(itemId, staged.button, adapter.userTurnCount(doc), target, { steering: true });
    },

    async stop() {
      const button = adapter.stopButton(doc);
      if (!button) return { kind: "failed", code: "stop-button-missing", message: "The Stop control was not found." };
      button.click();
      const gone = await waitFor(() => !generating(), stopWaitMs);
      return gone
        ? { kind: "confirmed" }
        : { kind: "ambiguous", code: "stop-unconfirmed", message: "Stop was clicked but the response did not end." };
    },
  };
}
