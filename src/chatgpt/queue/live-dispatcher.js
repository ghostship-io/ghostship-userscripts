// The live transport: fills ChatGPT's real composer and clicks its Send / Stop
// buttons through the adapter's selectors. It is the only file in src/ allowed
// to click (see the banned-primitive test). It fails closed: whenever the page
// is not in the expected shape it sends nothing and says why.

const norm = (text) => text.replace(/\s+/g, " ").trim();

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {object} o.adapter composerInput / sendButton / stopButton / userTurnCount
 * @param {number} [o.pollMs]
 * @param {number} [o.buttonWaitMs] how long to wait for Send to become enabled after filling
 * @param {number} [o.ackMs] how long to wait for evidence that a click was accepted
 * @param {number} [o.stopWaitMs] how long to wait for the Stop button to go away
 */
export function createLiveDispatcher({ win, adapter, pollMs = 50, buttonWaitMs = 2000, ackMs = 5000, stopWaitMs = 5000 }) {
  const doc = win.document;
  // Item ids already clicked on this page: a second submit of the same id never clicks again.
  const clicked = new Set();

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

  const isField = (el) => el.tagName === "TEXTAREA" || el.tagName === "INPUT";
  const read = (el) => norm(isField(el) ? el.value : el.textContent ?? "");

  function write(el, text) {
    el.focus?.();
    if (isField(el)) {
      // React tracks the value through the prototype setter; assigning `.value` directly would be ignored.
      const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      return true;
    }
    const selection = win.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    return text === "" ? doc.execCommand("delete") : doc.execCommand("insertText", false, text);
  }

  const reject = (code, message, retryable = true) => ({ kind: "rejected", code, message, retryable });
  const generating = () => Boolean(adapter.stopButton(doc));

  return {
    async readState() {
      if (!adapter.composerInput(doc)) return "unknown";
      return generating() ? "generating" : "idle";
    },

    async submit({ itemId, text, attachments }) {
      if (clicked.has(itemId)) {
        return { kind: "uncertain", code: "already-attempted", message: "This message was already submitted from this page." };
      }
      if (attachments.length) {
        return reject("attachments-unsupported", "Messages with attachments cannot be sent by the queue yet.", false);
      }
      const input = adapter.composerInput(doc);
      if (!input) return reject("composer-missing", "The ChatGPT composer was not found; nothing was sent.");
      if (generating()) return reject("busy", "A response is still streaming; nothing was sent.");
      if (read(input) !== "") return reject("composer-not-empty", "The composer holds a draft; it was left untouched and nothing was sent.");

      const abandon = (code, message) => {
        write(input, ""); // we put this text there ourselves, into a composer verified empty above
        return reject(code, message);
      };
      if (!write(input, text) || read(input) !== norm(text)) {
        return abandon("composer-fill-failed", "The text could not be placed in the composer; nothing was sent.");
      }
      const send = await waitFor(() => {
        const button = adapter.sendButton(doc);
        return button && !button.disabled ? button : null;
      }, buttonWaitMs);
      if (!send) return abandon("send-button-missing", "The Send button was not found or stayed disabled; nothing was sent.");
      if (generating()) return abandon("busy", "A response started streaming; nothing was sent.");

      const turnsBefore = adapter.userTurnCount(doc);
      clicked.add(itemId);
      send.click();
      const evidence = await waitFor(
        () => adapter.userTurnCount(doc) > turnsBefore || generating() || read(input) === "",
        ackMs,
      );
      return evidence
        ? { kind: "accepted" }
        : { kind: "uncertain", code: "submit-unacknowledged", message: "Send was clicked but ChatGPT showed no sign of accepting it." };
    },

    async stop() {
      const button = adapter.stopButton(doc);
      if (!button) return { kind: "failed", code: "stop-button-missing", message: "The Stop control was not found." };
      button.click();
      const gone = await waitFor(() => !adapter.stopButton(doc), stopWaitMs);
      return gone
        ? { kind: "confirmed" }
        : { kind: "ambiguous", code: "stop-unconfirmed", message: "Stop was clicked but the response did not end." };
    },
  };
}
