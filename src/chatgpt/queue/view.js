// Pure DOM rendering of the queue panel. It builds elements from a plain model
// and reports user intent through `on`; it never touches the native composer.
export const STYLE_ID = "gs-queue-style";

export const CSS = `
.gs-q{box-sizing:border-box;width:100%;max-width:100%;min-width:0;margin:0 0 8px;padding:8px 10px;border:1px solid rgba(127,127,127,.35);border-radius:12px;background:var(--main-surface-secondary,rgba(127,127,127,.1));color:inherit;font:inherit;font-size:14px;line-height:1.35}
.gs-q *{box-sizing:border-box;min-width:0}
.gs-q-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.gs-q-title{font-weight:600}
.gs-q-status{flex:1 1 8em;opacity:.75}
.gs-q-badge{padding:1px 8px;border:1px solid currentColor;border-radius:999px;font-size:12px;opacity:.8}
.gs-q button{min-height:32px;padding:4px 10px;border:1px solid rgba(127,127,127,.5);border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.gs-q button:disabled{opacity:.45;cursor:not-allowed}
.gs-q button:focus-visible,.gs-q textarea:focus-visible{outline:2px solid #2563eb;outline-offset:1px}
.gs-q .gs-q-primary{background:var(--text-primary,#111);color:var(--main-surface-primary,#fff);border-color:transparent;font-weight:600}
.gs-q-error{margin:6px 0 0;padding:6px 8px;border-radius:8px;border:1px solid #b91c1c;color:#b91c1c;overflow-wrap:anywhere}
.gs-q-list{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:4px}
.gs-q-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;align-items:center;padding:4px 0;border-top:1px solid rgba(127,127,127,.2)}
.gs-q-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.gs-q-chip{margin-left:6px;font-size:12px;opacity:.75;white-space:nowrap}
.gs-q-actions{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
.gs-q-note{grid-column:1/-1;margin:0;font-size:12px;opacity:.8;overflow-wrap:anywhere}
.gs-q-edit{grid-column:1/-1;display:grid;gap:4px}
.gs-q textarea{width:100%;max-width:100%;resize:vertical;font:inherit;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.5);border-radius:8px;padding:6px 8px}
.gs-q-add{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:flex-end}
.gs-q-add textarea{flex:1 1 12em}
@media (max-width:480px){.gs-q-item{grid-template-columns:minmax(0,1fr)}.gs-q-actions{justify-content:flex-start}.gs-q button{min-height:36px}}
`;

const STATUS_LABEL = {
  pending: "Queued",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  "manual-review": "Needs review",
  blocked: "Blocked",
};

const EDITABLE = new Set(["pending", "failed", "blocked"]);
const summarize = (text) => text.replace(/\s+/g, " ").trim();

function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) node.append(child);
  return node;
}

function button(doc, key, label, onClick, { label: aria, disabled, primary } = {}) {
  const node = el(doc, "button", {
    type: "button",
    "data-gs-key": key,
    "aria-label": aria,
    disabled,
    class: primary ? "gs-q-primary" : null,
  }, label);
  node.addEventListener("click", onClick);
  return node;
}

/** Why the Interrupt & Send Next button is unavailable, or null when it is usable. */
export function interruptBlocker({ items, interrupting }) {
  if (interrupting) return "Stopping the current response.";
  const head = items.find((i) => i.status !== "sent");
  if (!head) return "The queue is empty.";
  if (head.status === "sending") return "The next message is already being sent.";
  if (head.status !== "pending") return `Resolve the first message (${STATUS_LABEL[head.status]}) first.`;
  return null;
}

/** Builds the panel body. `model`: {items, paused, interrupting, error, note, dryRun, edit}. */
export function renderPanel(doc, root, model, on) {
  const unsent = model.items.filter((i) => i.status !== "sent");
  const sentCount = model.items.length - unsent.length;
  const blocker = interruptBlocker(model);
  const statusBits = [`${unsent.length} queued`];
  if (model.paused) statusBits.push("paused");
  if (sentCount) statusBits.push(`${sentCount} sent`);

  const head = el(doc, "div", { class: "gs-q-head" }, [
    el(doc, "span", { class: "gs-q-title" }, "Queue"),
    el(doc, "span", { class: "gs-q-status", role: "status", "aria-live": "polite" }, statusBits.join(" · ")),
    model.dryRun ? el(doc, "span", { class: "gs-q-badge", title: "Dry run: nothing is sent to ChatGPT" }, "Dry run") : null,
    button(doc, "head:pause", model.paused ? "Resume" : "Pause", () => on.togglePause(), {
      label: model.paused ? "Resume queue" : "Pause queue",
    }),
    sentCount ? button(doc, "head:clear", "Clear sent", () => on.clearSent()) : null,
    // The explicit Interrupt & Send Next control; there is deliberately no overflow menu.
    button(doc, "head:interrupt", "Interrupt & Send Next", () => on.interrupt(), { primary: true, disabled: blocker !== null }),
  ].filter(Boolean));
  const interruptBtn = head.querySelector('[data-gs-key="head:interrupt"]');
  if (blocker) interruptBtn.setAttribute("title", blocker);
  if (model.interrupting) interruptBtn.setAttribute("aria-busy", "true");

  const children = [head];
  const message = model.error ?? (model.note ? { message: model.note, action: "" } : null);
  if (message) {
    children.push(el(doc, "p", { class: "gs-q-error", role: model.error ? "alert" : "status" }, `${message.message} ${message.action}`.trim()));
  }

  const list = el(doc, "ol", { class: "gs-q-list", "aria-label": "Queued messages" });
  unsent.forEach((item, index) => list.append(renderItem(doc, item, index, unsent.length, model, on)));
  children.push(list);

  const input = el(doc, "textarea", {
    rows: 1,
    "data-gs-key": "add:input",
    "aria-label": "Message to queue",
    placeholder: "Queue a message",
  });
  input.value = model.draft ?? "";
  input.addEventListener("input", () => on.draft(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      on.add(input.value);
    }
  });
  children.push(
    el(doc, "div", { class: "gs-q-add" }, [input, button(doc, "add:submit", "Add to queue", () => on.add(input.value))]),
  );

  root.replaceChildren(...children);
}

function renderItem(doc, item, index, count, model, on) {
  const li = el(doc, "li", { class: "gs-q-item", "data-id": item.id, "data-status": item.status });
  const editing = model.edit?.id === item.id;

  if (editing) {
    const area = el(doc, "textarea", { rows: 3, "data-gs-key": `${item.id}:edit`, "aria-label": "Edit queued message" });
    area.value = model.edit.text;
    area.addEventListener("input", () => on.editDraft(area.value));
    area.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        on.cancelEdit();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        on.saveEdit(item.id, area.value);
      }
    });
    li.append(
      el(doc, "div", { class: "gs-q-edit" }, [
        area,
        el(doc, "div", { class: "gs-q-actions" }, [
          button(doc, `${item.id}:save`, "Save", () => on.saveEdit(item.id, area.value), { primary: true }),
          button(doc, `${item.id}:cancel`, "Cancel", () => on.cancelEdit()),
        ]),
      ]),
    );
    return li;
  }

  const text = summarize(item.text) || "(empty message)";
  li.append(
    el(doc, "div", {}, [
      el(doc, "span", { class: "gs-q-text", title: item.text }, text),
      el(doc, "span", { class: "gs-q-chip" }, STATUS_LABEL[item.status] ?? item.status),
    ]),
  );

  const actions = el(doc, "div", { class: "gs-q-actions", role: "group", "aria-label": "Message actions" });
  const locked = item.status === "sending";
  actions.append(
    button(doc, `${item.id}:up`, "Up", () => on.move(item.id, index - 1), { label: "Move up", disabled: locked || index === 0 }),
    button(doc, `${item.id}:down`, "Down", () => on.move(item.id, index + 1), { label: "Move down", disabled: locked || index === count - 1 }),
  );
  if (EDITABLE.has(item.status)) actions.append(button(doc, `${item.id}:edit`, "Edit", () => on.startEdit(item)));
  if (item.status === "failed" || item.status === "manual-review") {
    actions.append(button(doc, `${item.id}:retry`, "Retry", () => on.retry(item.id)));
    actions.append(button(doc, `${item.id}:delivered`, "Mark delivered", () => on.markDelivered(item.id)));
  }
  actions.append(button(doc, `${item.id}:remove`, "Remove", () => on.remove(item.id), { disabled: locked }));
  actions.addEventListener("keydown", (event) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown") || locked) return;
    event.preventDefault();
    on.move(item.id, index + (event.key === "ArrowUp" ? -1 : 1), `${item.id}:${event.key === "ArrowUp" ? "up" : "down"}`);
  });
  li.append(actions);

  if (item.lastError) {
    li.append(el(doc, "p", { class: "gs-q-note", "data-gs-note": item.lastError.code }, `${item.lastError.message} ${item.lastError.action}`));
  }
  return li;
}
