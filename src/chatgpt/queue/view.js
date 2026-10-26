// Pure DOM rendering of the queue card. It builds elements from a plain model and reports user intent
// through `on`; it never touches the native composer. The card shows the ONE pending prompt, never rows.
// Every core action is a visible control: there is no overflow ("...") menu.
export const STYLE_ID = "gs-queue-style";

export const CSS = `
.gs-q{box-sizing:border-box;width:100%;max-width:100%;min-width:0;margin:0 0 8px;padding:10px 12px 6px;border-radius:var(--radius-2xl,16px);background:var(--color-surface-elevated-secondary,var(--main-surface-secondary,rgba(127,127,127,.1)));box-shadow:var(--elevation-prominent,0 0 0 1px rgba(127,127,127,.3));color:inherit;font:inherit;font-size:14px;line-height:1.4}
.gs-q[hidden]{display:none}
.gs-q *{box-sizing:border-box;min-width:0}
.gs-q svg{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.gs-q button{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:2px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.gs-q button:hover:not(:disabled){background:rgba(127,127,127,.18)}
.gs-q button:disabled{opacity:.4;cursor:not-allowed}
.gs-q button:focus-visible{outline:2px solid currentColor;outline-offset:1px}
.gs-q .gs-q-icon{width:24px;height:24px;padding:0;border-radius:999px}
.gs-q-text{max-height:9em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.gs-q-foot{display:flex;align-items:center;gap:2px;margin-top:4px}
.gs-q-status{opacity:.65;font-size:12px}
.gs-q-badge{margin-left:6px;padding:0 6px;border:1px solid currentColor;border-radius:999px;font-size:11px;opacity:.7}
.gs-q-spacer{flex:1 1 0}
.gs-q-actions{display:flex;gap:2px}
.gs-q-note{margin:0 0 6px;padding:4px 8px;border-radius:8px;border:1px solid rgba(127,127,127,.4);font-size:13px;overflow-wrap:anywhere}
.gs-q-note[role="alert"]{border-color:#b91c1c;color:#b91c1c}
.gs-q-inflight{margin:6px 0 0;display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center}
.gs-q-inflight button{border:1px solid rgba(127,127,127,.45)}
`;

// Minimal 24x24 stroke icons, drawn with currentColor.
const ICONS = {
  steer: ["M5 12h14", "M13 6l6 6-6 6"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  pencil: ["M4 20l4-1 11-11-3-3L5 16z", "M14 7l3 3"],
  check: ["M5 12l5 5 9-10"],
  close: ["M6 6l12 12", "M18 6L6 18"],
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
  "other-conversation": "Waiting for the conversation to open",
  loading: "Waiting for the conversation to load",
  "unknown-state": "Waiting for ChatGPT",
  "unresolved-conversation": "Open the conversation to send",
  editing: "Editing",
};

/** The one status line: what the queue is doing right now, or null. */
export function statusOf(model) {
  if (model.edit) return "Editing";
  if (model.busy === "steering") return "Steering";
  if (model.inflight?.status === "sending") return "Sending";
  if (model.inflight?.status === "manual-review") return "Needs review";
  if (!model.pending) return null;
  if (model.pending.status === "blocked") return "Blocked";
  if (model.editingElsewhere) return "Being edited in another tab";
  return WAITING[model.waiting] ?? "Queued";
}

/** Why Steer is unavailable, or null when usable. */
export function actionBlocker(model) {
  if (model.busy) return "Working on it.";
  if (model.edit) return "Save or cancel the edit first.";
  if (!model.pending) return "Nothing is queued.";
  if (model.inflight) return model.inflight.status === "sending" ? "The previous message is still being sent." : "Resolve the message that needs review first.";
  if (model.pending.status !== "pending" && model.pending.lastError?.code === "attachments-not-restorable") return "Send without the files or delete the prompt first.";
  return null;
}

const iconButton = (doc, key, name, onClick, label, { disabled, title } = {}) =>
  button(doc, key, icon(doc, name), onClick, { label, disabled, className: "gs-q-icon", title: title ?? label });

/**
 * Builds the card: the one pending prompt as a bubble, with its status at the bottom left and the few icons
 * (Edit, Delete, Steer) at the bottom right. Steer sends it now: through ChatGPT's own steer when the page offers one,
 * otherwise by stopping the response and sending it.
 * `model`: {pending, inflight, edit, busy, waiting, error, note, dryRun, editingElsewhere}.
 */
export function renderPanel(doc, root, model, on) {
  const { pending, inflight } = model;
  const visible = pending || inflight || model.error || model.note || model.edit;
  root.hidden = !visible;
  if (!visible) {
    root.replaceChildren();
    return;
  }
  const blocker = actionBlocker(model);
  const children = [];

  const message = model.error ?? pending?.lastError ?? inflight?.lastError ?? (model.note ? { message: model.note, action: "" } : null);
  if (message) {
    const alert = Boolean(model.error ?? pending?.lastError ?? inflight?.lastError);
    children.push(el(doc, "p", { class: "gs-q-note", role: alert ? "alert" : "status", "data-gs-note": message.code }, `${message.message ?? ""} ${message.action ?? ""}`.trim()));
  }

  if (pending) children.push(el(doc, "div", { class: "gs-q-text", "data-gs-key": "queued-text", "data-id": pending.id, "data-version": pending.version }, pending.text));

  const actions = [];
  if (model.edit) {
    actions.push(
      iconButton(doc, "head:save", "check", () => on.saveEdit(), "Save the edited prompt"),
      iconButton(doc, "head:cancel", "close", () => on.cancelEdit(), "Cancel the edit"),
      iconButton(doc, "head:delete", "trash", () => on.remove(), "Delete the queued prompt", { disabled: model.busy }),
    );
  } else if (pending) {
    actions.push(
      iconButton(doc, "head:edit", "pencil", () => on.startEdit(), "Edit the queued prompt", { disabled: model.busy || model.editingElsewhere }),
      iconButton(doc, "head:delete", "trash", () => on.remove(), "Delete the queued prompt", { disabled: model.busy }),
      iconButton(doc, "head:steer", "steer", () => on.steer(), "Steer: send the queued prompt now", { disabled: blocker !== null, title: blocker ?? "Steer: send the queued prompt now" }),
    );
  }
  const status = statusOf(model);
  if (pending || status) {
    children.push(
      el(doc, "div", { class: "gs-q-foot" }, [
        el(doc, "span", { class: "gs-q-status", role: "status", "aria-live": "polite" }, status),
        model.dryRun ? el(doc, "span", { class: "gs-q-badge", title: "Dry run: nothing is sent to ChatGPT" }, "Dry run") : null,
        el(doc, "span", { class: "gs-q-spacer" }),
        el(doc, "div", { class: "gs-q-actions", role: "group", "aria-label": "Queue actions" }, actions),
      ]),
    );
  }

  if (inflight?.status === "manual-review") {
    children.push(
      el(doc, "div", { class: "gs-q-inflight" }, [
        button(doc, "inflight:delivered", "Mark delivered", () => on.markDelivered(), { label: "The message did reach ChatGPT" }),
        button(doc, "inflight:restore", "Restore to queue", () => on.restoreInflight(), { label: "The message did not reach ChatGPT; put it back in the queue" }),
      ]),
    );
  }

  if (pending?.status === "blocked") {
    const files = pending.lastError?.code === "attachments-not-restorable";
    children.push(
      el(doc, "div", { class: "gs-q-inflight" }, [
        files ? button(doc, "head:drop-files", "Send without files", () => on.unblock(true), { label: "Drop the files that cannot be restored and queue the text" }) : button(doc, "head:retry", "Retry", () => on.unblock(false), { label: "Try sending the queued prompt again" }),
      ]),
    );
  }

  root.replaceChildren(...children);
}
