// The live transport: fills ChatGPT's real composer and clicks its Send / Stop buttons through the
// adapter's selectors. It is the only file in src/ allowed to click (see the banned-primitive test).
// It fails closed: whenever the page is not in the expected shape it sends nothing and says why.
// Waiting (a response is running or settling, Send is not there yet) is a normal answer, not a failure:
// `readiness` and a not-ready `submit` consume nothing and nothing is retried by the dispatcher.
import { createComposerIO } from "./composer.js";
import { clickAsOwn } from "./own-click.js";

const norm = (text) => text.replace(/\s+/g, " ").trim();

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {object} o.adapter composerInput / sendButton / steerButton / stopButton / generating / userTurnCount / accountId / conversationId
 * @param {number} [o.pollMs]
 * @param {{once(fn: () => void, ms: number): () => void}} [o.timers] timers for the waits below; hidden-tab safe ones in the page
 * @param {number} [o.arriveMs] how long a conversation must have shown its turns before anything is sent into it
 * @param {number} [o.settleMs] how long the response must have been over before a send is staged
 * @param {number} [o.controlSettleMs] how long Send / Steer must have stayed enabled before it is clicked (ChatGPT ignores a click that comes the instant its button appears: its handler still holds the old state)
 * @param {number} [o.sendWaitMs] how long to wait for native Send to enable once the text is in the composer
 * @param {number} [o.placeWaitMs] how long the composer gets to show the staged text (its editor applies input asynchronously)
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
  arriveMs = 1200,
  timers = { once: (fn, ms) => { const handle = win.setTimeout(fn, ms); return () => win.clearTimeout(handle); } },
  settleMs = 600,
  controlSettleMs = 450,
  sendWaitMs = 8000,
  placeWaitMs = 1500,
  steerWaitMs = 600,
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
  // Consecutive placements that never showed up, per target: a few are waited out, then the prompt is held.
  const placeFailures = new Map();
  const PLACE_FAILURES_BEFORE_HOLD = 3;

  const waitFor = (probe, ms) =>
    new Promise((resolve) => {
      const started = Date.now();
      const poll = () => {
        const hit = probe();
        if (hit) return resolve(hit);
        if (Date.now() - started >= ms) return resolve(null);
        timers.once(poll, pollMs);
      };
      poll();
    });

  const generating = () => adapter.generating(doc);
  // The URL changes before the page behind it does: the page's own conversation stamp must agree too. A conversation
  // started in this very page keeps ChatGPT's local key (`local-...`) under its server URL, so that stamp cannot be
  // compared with the URL; such a page is trusted only once it has stayed the same page for `arriveMs` (see `loaded`).
  const onTarget = (target) => {
    if (adapter.conversationId(win) !== target.conversationId || adapter.accountId(doc) !== target.accountId) return false;
    const held = adapter.pageConversationId?.(doc);
    return held === null || held === undefined || held === target.conversationId || held.startsWith("local-");
  };
  // A conversation just opened shows its turns before its response state (Stop, Steer, streaming) is known.
  // It counts as loaded once its own turns have been on the page for `arriveMs`.
  let arrival = null;
  const loaded = (target) => {
    const key = `${target.accountId}:${target.conversationId}`;
    if (adapter.turns(doc).length === 0) {
      arrival = null;
      return false;
    }
    const page = adapter.pageElement(doc);
    if (arrival?.key !== key || arrival.page !== page) arrival = { key, page, since: now() };
    return now() - arrival.since >= arriveMs;
  };
  const enabled = (button) => (button && !button.disabled && button.getAttribute("aria-disabled") !== "true" ? button : null);

  /** Why a send must not start now, or null. Read-only. */
  function notReady(target, { allowGenerating = false, text = null } = {}) {
    if (!onTarget(target)) {
      arrival = null;
      return { state: "waiting", reason: "other-conversation" };
    }
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
    if (!loaded(target)) return { state: "waiting", reason: "loading" };
    if (!allowGenerating) {
      if (generating()) {
        lastBusy = now();
        return { state: "waiting", reason: "generating" };
      }
      if (now() - lastBusy < settleMs) return { state: "waiting", reason: "settling" };
    }
    // The composer already holding exactly the queued text is our own placement arriving late, not a draft.
    if (io.hasText(input) && !(text !== null && norm(io.read(input)) === norm(text))) return { state: "waiting", reason: "composer-has-draft" };
    return null;
  }

  const unstage = (text) => {
    // Only take out what we put there; anything the user typed since stays.
    const input = adapter.composerInput(doc);
    if (input && norm(io.read(input)) === norm(text)) io.write(input, "");
  };

  /**
   * Makes the composer hold `text`. The editor applies input asynchronously, so one immediate read says nothing:
   * the text counts as placed once reads, a poll apart, agree it is there. Already holding exactly the text counts too.
   */
  async function place(text) {
    const holds = () => {
      const input = adapter.composerInput(doc);
      return input !== null && norm(io.read(input)) === norm(text);
    };
    if (!holds()) {
      const input = adapter.composerInput(doc);
      if (!input || io.write(input, text) === false) return false;
    }
    let streak = 0;
    return Boolean(await waitFor(() => (holds() ? ++streak >= 2 : ((streak = 0), false)), placeWaitMs));
  }

  /** Puts `text` into the empty composer and waits for `control()` to be enabled; takes it out again on failure. */
  async function stage(target, text, control, ms, { allowGenerating }) {
    const key = `${target.accountId}:${target.conversationId}`;
    if (!(await place(text))) {
      unstage(text);
      const failures = (placeFailures.get(key) ?? 0) + 1;
      if (failures < PLACE_FAILURES_BEFORE_HOLD) {
        placeFailures.set(key, failures);
        return { failed: { kind: "wait", reason: "placing-text" } };
      }
      placeFailures.delete(key);
      return { failed: { kind: "rejected", code: "composer-fill-failed", message: "The text did not appear in the composer after several tries; nothing was sent.", action: "Check the composer, then press Retry, Steer or Interrupt & Send Next." } };
    }
    placeFailures.delete(key);
    let enabledSince = null;
    const button = await waitFor(() => {
      if (!onTarget(target)) return "left";
      if (!allowGenerating && generating()) return "busy";
      const found = enabled(control());
      if (!found) {
        enabledSince = null;
        return null;
      }
      enabledSince ??= Date.now();
      return Date.now() - enabledSince >= controlSettleMs ? found : null;
    }, ms + controlSettleMs);
    if (button === "left") {
      unstage(text);
      return { failed: { kind: "wait", reason: "other-conversation" } };
    }
    if (button === "busy") {
      unstage(text);
      return { failed: { kind: "wait", reason: "generating" } };
    }
    if (!button) {
      unstage(text);
      return { missing: true };
    }
    return { button };
  }

  // While steering, a running response is the starting point, not evidence; a normal send also counts a response that starts.
  async function click(itemId, button, turnsBefore, target, { steering = false } = {}) {
    // Confirm site, account and conversation immediately before the click.
    if (!onTarget(target)) {
      return { kind: "wait", reason: "other-conversation" };
    }
    clicked.add(itemId);
    clickAsOwn(() => button.click());
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

    async readiness(target, text = null) {
      return notReady(target, { text }) ?? { state: "ready" };
    },

    async submit({ itemId, accountId, conversationId, text, attachments }) {
      const target = { accountId, conversationId };
      if (clicked.has(itemId)) {
        return { kind: "uncertain", code: "already-attempted", message: "This message was already submitted from this page." };
      }
      if (attachments.length) return attachmentsRefused;
      const not = notReady(target, { text });
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
      const not = notReady(target, { allowGenerating: true, text });
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
