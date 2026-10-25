// Pure DOM rendering of the queue card. It builds elements from a plain model and reports user intent
// through `on`; it never touches the native composer. The card shows the ONE pending prompt, never rows.
// Every core action is a visible control: there is no overflow ("...") menu.
export const STYLE_ID = "gs-queue-style";

export const CSS = `
.gs-q{box-sizing:border-box;width:100%;max-width:100%;min-width:0;margin:0 0 8px;padding:6px 8px;border:1px solid rgba(127,127,127,.3);border-radius:16px;background:var(--main-surface-secondary,rgba(127,127,127,.1));color:inherit;font:inherit;font-size:14px;line-height:1.35}
.gs-q[hidden]{display:none}
.gs-q *{box-sizing:border-box;min-width:0}
.gs-q svg{width:1.1em;height:1.1em;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.gs-q button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:4px 10px;border:1px solid rgba(127,127,127,.45);border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.gs-q button:hover:not(:disabled){background:rgba(127,127,127,.15)}
.gs-q button:disabled{opacity:.45;cursor:not-allowed}
.gs-q button:focus-visible{outline:2px solid #2563eb;outline-offset:1px}
.gs-q-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.gs-q-title{font-weight:600}
.gs-q-status{opacity:.75;font-size:12px}
.gs-q-badge{padding:1px 8px;border:1px solid currentColor;border-radius:999px;font-size:12px;opacity:.8}
.gs-q-spacer{flex:1 1 0}
.gs-q-actions{display:flex;flex-wrap:wrap;gap:6px}
.gs-q .gs-q-primary{border-color:currentColor;font-weight:600}
.gs-q-note{margin:6px 0 0;padding:6px 8px;border-radius:8px;border:1px solid rgba(127,127,127,.4);overflow-wrap:anywhere}
.gs-q-note[role="alert"]{border-color:#b91c1c;color:#b91c1c}
.gs-q-text{margin:6px 0 0;padding:6px 8px;max-height:9em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border-top:1px solid rgba(127,127,127,.18)}
.gs-q-inflight{margin:6px 0 0;display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center}
@media (max-width:560px){
.gs-q-actions{flex:1 1 100%}
.gs-q-actions button{flex:1 1 auto}
.gs-q button{min-height:36px}
}
`;

// Minimal 24x24 stroke icons, drawn with currentColor.
const ICONS = {
  interrupt: ["M5 5l7 7-7 7", "M13 5l7 7-7 7"],
  steer: ["M5 12h14", "M13 6l6 6-6 6"],
  pause: ["M9 5v14", "M15 5v14"],
  play: ["M7 5l12 7-12 7z"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  pencil: ["M4 20l4-1 11-11-3-3L5 16z", "M14 7l3 3"],
  queue: ["M12 5v14", "M5 12h14"],
};

function icon(doc, name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = doc.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const present = (value) => value !== null && value !== undefined && value !== false;

/** Builds an element. null / undefined / false attributes and children are skipped: they never render as text. */
export function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (!present(value)) continue;
    node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) if (present(child)) node.append(child);
  return node;
}

function button(doc, key, content, onClick, { label, disabled, className, title } = {}) {
  const node = el(doc, "button", { type: "button", "data-gs-key": key, "aria-label": label, disabled, class: className, title }, content);
  node.addEventListener("click", onClick);
  return node;
}

const WAITING = {
  generating: "Waiting for response",
  settling: "Waiting for response",
  "send-unavailable": "Waiting for Send",
  "composer-has-draft": "Waiting for the composer to be empty",
  "composer-missing": "Waiting for ChatGPT",
  "unknown-state": "Waiting for ChatGPT",
  "unresolved-conversation": "Open the conversation to send",
  editing: "Editing",
};

/** The one status line: what the queue is doing right now, or null. */
export function statusOf(model) {
  if (model.edit) return "Editing";
  if (model.busy === "interrupting") return "Stopping the response";
  if (model.busy === "steering") return "Steering";
  if (model.inflight?.status === "sending") return "Sending";
  if (model.inflight?.status === "manual-review") return "Needs review";
  if (!model.pending) return null;
  if (model.pending.status === "blocked") return "Blocked";
  if (model.paused) return "Paused";
  if (model.editingElsewhere) return "Being edited in another tab";
  return WAITING[model.waiting] ?? "Queued";
}

/** Why Steer / Interrupt & Send Next are unavailable, or null when usable. */
export function actionBlocker(model) {
  if (model.busy) return "Working on it.";
  if (model.edit) return "Save or cancel the edit first.";
  if (!model.pending) return "Nothing is queued.";
  if (model.inflight) return model.inflight.status === "sending" ? "The previous message is still being sent." : "Resolve the message that needs review first.";
  if (model.pending.status !== "pending") return "Resolve the hold on the queued prompt first.";
  return null;
}

/** Builds the card. `model`: {pending, inflight, paused, edit, busy, waiting, error, note, dryRun, generating, composerHasText, editingElsewhere}. */
export function renderPanel(doc, root, model, on) {
  const { pending, inflight } = model;
  const canQueue = model.generating && !model.edit;
  const visible = pending || inflight || model.error || model.note || model.edit || (canQueue && model.composerHasText);
  root.hidden = !visible;
  if (!visible) {
    root.replaceChildren();
    return;
  }
  const blocker = actionBlocker(model);
  const status = statusOf(model);
  const children = [];

  const actions = [];
  if (canQueue) {
    actions.push(
      button(doc, "head:queue", [icon(doc, "queue"), "Queue"], () => on.queueDraft(), {
        label: "Add the composer text to the queued prompt",
        disabled: !model.composerHasText || model.busy,
      }),
    );
  }
  if (model.edit) {
    actions.push(
      button(doc, "head:save", "Save", () => on.saveEdit(), { className: "gs-q-primary", label: "Save the edited prompt" }),
      button(doc, "head:cancel", "Cancel", () => on.cancelEdit(), { label: "Cancel the edit" }),
      button(doc, "head:delete", [icon(doc, "trash"), "Delete"], () => on.remove(), { label: "Delete the queued prompt", disabled: model.busy }),
    );
  } else if (pending) {
    actions.push(
      button(doc, "head:edit", [icon(doc, "pencil"), "Edit"], () => on.startEdit(), { label: "Edit the queued prompt", disabled: model.busy || model.editingElsewhere }),
      button(doc, "head:delete", [icon(doc, "trash"), "Delete"], () => on.remove(), { label: "Delete the queued prompt", disabled: model.busy }),
      button(doc, "head:steer", [icon(doc, "steer"), "Steer"], () => on.steer(), {
        label: "Steer: send the queued prompt now",
        disabled: blocker !== null,
        title: blocker,
      }),
      button(doc, "head:interrupt", [icon(doc, "interrupt"), "Interrupt & Send Next"], () => on.interrupt(), {
        className: "gs-q-primary",
        disabled: blocker !== null,
        title: blocker,
      }),
      button(doc, "head:pause", [icon(doc, model.paused ? "play" : "pause"), model.paused ? "Resume" : "Pause"], () => on.togglePause(), {
        label: model.paused ? "Resume the queue" : "Pause the queue",
        disabled: pending.status !== "pending",
      }),
    );
  }

  children.push(
    el(doc, "div", { class: "gs-q-head" }, [
      el(doc, "span", { class: "gs-q-title" }, `Queue (${pending ? 1 : 0})`),
      el(doc, "span", { class: "gs-q-status", role: "status", "aria-live": "polite" }, status),
      model.dryRun ? el(doc, "span", { class: "gs-q-badge", title: "Dry run: nothing is sent to ChatGPT" }, "Dry run") : null,
      el(doc, "span", { class: "gs-q-spacer" }),
      el(doc, "div", { class: "gs-q-actions", role: "group", "aria-label": "Queue actions" }, actions),
    ]),
  );

  const message = model.error ?? pending?.lastError ?? inflight?.lastError ?? (model.note ? { message: model.note, action: "" } : null);
  if (message) {
    const alert = Boolean(model.error ?? pending?.lastError ?? inflight?.lastError);
    children.push(el(doc, "p", { class: "gs-q-note", role: alert ? "alert" : "status", "data-gs-note": message.code }, `${message.message ?? ""} ${message.action ?? ""}`.trim()));
  }

  if (inflight?.status === "manual-review") {
    children.push(
      el(doc, "div", { class: "gs-q-inflight" }, [
        button(doc, "inflight:delivered", "Mark delivered", () => on.markDelivered(), { label: "The message did reach ChatGPT" }),
        button(doc, "inflight:restore", "Restore to queue", () => on.restoreInflight(), { label: "The message did not reach ChatGPT; put it back in the queue" }),
      ]),
    );
  }

  if (pending) {
    if (pending.status === "blocked") {
      const files = pending.lastError?.code === "attachments-not-restorable";
      children.push(
        el(doc, "div", { class: "gs-q-inflight" }, [
          files ? button(doc, "head:drop-files", "Send without files", () => on.unblock(true), { label: "Drop the files that cannot be restored and queue the text" }) : button(doc, "head:retry", "Retry", () => on.unblock(false), { label: "Try sending the queued prompt again" }),
        ]),
      );
    }
    children.push(el(doc, "div", { class: "gs-q-text", "data-gs-key": "queued-text", "data-id": pending.id, "data-version": pending.version }, pending.text));
  }

  root.replaceChildren(...children);
}
