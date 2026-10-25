// Pure DOM rendering of the queue card. It builds elements from a plain model
// and reports user intent through `on`; it never touches the native composer.
// Every core action is a visible control: there is no overflow ("...") menu.
export const STYLE_ID = "gs-queue-style";

export const CSS = `
.gs-q{box-sizing:border-box;width:100%;max-width:100%;min-width:0;margin:0 0 8px;padding:6px 8px;border:1px solid rgba(127,127,127,.3);border-radius:16px;background:var(--main-surface-secondary,rgba(127,127,127,.1));color:inherit;font:inherit;font-size:14px;line-height:1.35}
.gs-q *{box-sizing:border-box;min-width:0}
.gs-q svg{width:1.1em;height:1.1em;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.gs-q button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:4px 10px;border:1px solid rgba(127,127,127,.45);border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.gs-q button:hover:not(:disabled){background:rgba(127,127,127,.15)}
.gs-q button:disabled{opacity:.45;cursor:not-allowed}
.gs-q button:focus-visible,.gs-q textarea:focus-visible{outline:2px solid #2563eb;outline-offset:1px}
.gs-q-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.gs-q-toggle{border-color:transparent!important;padding:4px 6px!important}
.gs-q-toggle svg{transition:transform .15s}
.gs-q-toggle[aria-expanded="false"] svg{transform:rotate(-90deg)}
.gs-q-title{font-weight:600}
.gs-q-status{opacity:.7;font-size:12px}
.gs-q-badge{padding:1px 8px;border:1px solid currentColor;border-radius:999px;font-size:12px;opacity:.8}
.gs-q-spacer{flex:1 1 0}
.gs-q-head-actions{display:flex;flex-wrap:wrap;gap:6px}
.gs-q .gs-q-interrupt{border-color:currentColor;font-weight:600}
.gs-q .gs-q-armed{border-color:#b91c1c;color:#b91c1c}
.gs-q-error{margin:6px 0 0;padding:6px 8px;border-radius:8px;border:1px solid #b91c1c;color:#b91c1c;overflow-wrap:anywhere}
.gs-q-list{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:2px}
.gs-q-item{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:2px 10px;padding:4px 2px;border-top:1px solid rgba(127,127,127,.18)}
.gs-q-item.gs-q-dragging{opacity:.5}
.gs-q-item.gs-q-drop-before{box-shadow:0 -2px 0 #2563eb}
.gs-q-item.gs-q-drop-after{box-shadow:0 2px 0 #2563eb}
.gs-q-num{display:inline-flex;align-items:center;justify-content:center;min-width:2em;padding:2px 6px;border:1px solid rgba(127,127,127,.4);border-radius:8px;font-size:13px}
.gs-q-main{display:flex;gap:12px;align-items:baseline;overflow:hidden}
.gs-q-name{flex:0 1 45%;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-q-preview{flex:1 1 0;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-q-state{flex:none;font-size:12px;padding:0 6px;border-radius:6px;background:rgba(127,127,127,.25)}
.gs-q-model{grid-column:3;padding:1px 8px;border-radius:8px;background:rgba(127,127,127,.2);font-size:12px;white-space:nowrap}
.gs-q-actions{grid-column:4;display:flex;flex-wrap:wrap;align-items:center;gap:2px;justify-content:flex-end}
.gs-q .gs-q-icon{border-color:transparent;padding:4px 6px}
.gs-q .gs-q-handle{touch-action:none;cursor:grab}
.gs-q-note{grid-column:1/-1;margin:0;font-size:12px;opacity:.8;overflow-wrap:anywhere}
.gs-q-edit{grid-column:2/-1;display:grid;gap:4px}
.gs-q-edit .gs-q-actions{justify-content:flex-start}
.gs-q textarea{width:100%;max-width:100%;resize:vertical;font:inherit;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.5);border-radius:8px;padding:6px 8px}
.gs-q-add{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;align-items:flex-end}
.gs-q-add textarea{flex:1 1 12em}
@media (max-width:560px){
.gs-q-head-actions{flex:1 1 100%}
.gs-q-head-actions button{flex:1 1 auto}
.gs-q-item{grid-template-columns:auto minmax(0,1fr) auto}
.gs-q-main{display:block}
.gs-q-name,.gs-q-preview{display:block}
.gs-q-model{grid-column:2/-1;justify-self:start}
.gs-q-actions{grid-column:1/-1;justify-content:flex-end}
.gs-q button{min-height:36px}
}
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

// Minimal 24x24 stroke icons, drawn with currentColor.
const ICONS = {
  chevron: ["M6 9l6 6 6-6"],
  interrupt: ["M5 5l7 7-7 7", "M13 5l7 7-7 7"],
  pause: ["M9 5v14", "M15 5v14"],
  play: ["M7 5l12 7-12 7z"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  grip: ["M9 6h.01", "M15 6h.01", "M9 12h.01", "M15 12h.01", "M9 18h.01", "M15 18h.01"],
  pencil: ["M4 20l4-1 11-11-3-3L5 16z", "M14 7l3 3"],
  remove: ["M12 21a9 9 0 100-18 9 9 0 000 18z", "M9 9l6 6", "M15 9l-6 6"],
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

function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) node.append(child);
  return node;
}

function button(doc, key, content, onClick, { label, disabled, className, title, pressed, expanded } = {}) {
  const node = el(
    doc,
    "button",
    { type: "button", "data-gs-key": key, "aria-label": label, disabled, class: className, title, "aria-expanded": expanded == null ? null : String(expanded) },
    content,
  );
  node.addEventListener("click", onClick);
  return node;
}

/** Splits a message into a short title (first line) and a muted one-line preview of the rest. */
export function summarize(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { title: lines[0] ?? "(empty message)", preview: lines.slice(1).join(" ") };
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

/**
 * Index the dragged row would land on, given the other rows' vertical extents
 * (top/bottom in the same order as the rows) and the pointer's y.
 */
export function dropIndex(rects, y) {
  let index = 0;
  for (const rect of rects) {
    if (y > rect.top + (rect.bottom - rect.top) / 2) index += 1;
  }
  return index;
}

/** Builds the card. `model`: {items, paused, interrupting, error, note, dryRun, edit, collapsed, confirmClear, draft}. */
export function renderPanel(doc, root, model, on) {
  const unsent = model.items.filter((i) => i.status !== "sent");
  const sentCount = model.items.length - unsent.length;
  const blocker = interruptBlocker(model);
  const clearable = model.items.some((i) => i.status !== "sending");
  const statusBits = [];
  if (model.paused) statusBits.push("paused");
  if (sentCount) statusBits.push(`${sentCount} sent`);

  const interruptBtn = button(doc, "head:interrupt", [icon(doc, "interrupt"), "Interrupt & Send Next"], () => on.interrupt(), {
    className: "gs-q-interrupt",
    disabled: blocker !== null,
    title: blocker,
  });
  if (model.interrupting) interruptBtn.setAttribute("aria-busy", "true");

  const head = el(doc, "div", { class: "gs-q-head" }, [
    button(doc, "head:toggle", icon(doc, "chevron"), () => on.toggleCollapsed(), {
      className: "gs-q-toggle",
      label: model.collapsed ? "Expand queue" : "Collapse queue",
      expanded: !model.collapsed,
    }),
    el(doc, "span", { class: "gs-q-title" }, `Queue (${unsent.length})`),
    el(doc, "span", { class: "gs-q-status", role: "status", "aria-live": "polite" }, statusBits.join(" · ")),
    model.dryRun ? el(doc, "span", { class: "gs-q-badge", title: "Dry run: nothing is sent to ChatGPT" }, "Dry run") : null,
    el(doc, "span", { class: "gs-q-spacer" }),
    el(doc, "div", { class: "gs-q-head-actions" }, [
      interruptBtn,
      button(doc, "head:pause", [icon(doc, model.paused ? "play" : "pause"), model.paused ? "Resume" : "Pause"], () => on.togglePause(), {
        label: model.paused ? "Resume queue" : "Pause queue",
      }),
      button(doc, "head:clear", [icon(doc, "trash"), model.confirmClear ? "Confirm clear" : "Clear"], () => on.clear(), {
        label: model.confirmClear ? "Confirm clearing the queue" : "Clear queue",
        disabled: !clearable,
        className: model.confirmClear ? "gs-q-armed" : null,
      }),
    ]),
  ]);

  const children = [head];
  const message = model.error ?? (model.note ? { message: model.note, action: "" } : null);
  if (message) {
    children.push(el(doc, "p", { class: "gs-q-error", role: model.error ? "alert" : "status" }, `${message.message} ${message.action}`.trim()));
  }

  if (!model.collapsed) {
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
    children.push(el(doc, "div", { class: "gs-q-add" }, [input, button(doc, "add:submit", "Add to queue", () => on.add(input.value))]));
  }

  root.replaceChildren(...children);
  root.onkeydown = (event) => {
    if (event.key === "Escape" && model.confirmClear) on.disarmClear();
  };
}

function renderItem(doc, item, index, count, model, on) {
  const li = el(doc, "li", { class: "gs-q-item", "data-id": item.id, "data-status": item.status });
  const editing = model.edit?.id === item.id;
  const number = el(doc, "span", { class: "gs-q-num", "aria-label": `Message ${index + 1} of ${count}` }, String(index + 1));

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
      number,
      el(doc, "div", { class: "gs-q-edit" }, [
        area,
        el(doc, "div", { class: "gs-q-actions" }, [
          button(doc, `${item.id}:save`, "Save", () => on.saveEdit(item.id, area.value), { className: "gs-q-interrupt" }),
          button(doc, `${item.id}:cancel`, "Cancel", () => on.cancelEdit()),
        ]),
      ]),
    );
    return li;
  }

  const { title, preview } = summarize(item.text);
  const locked = item.status === "sending";
  const main = el(doc, "div", { class: "gs-q-main", title: item.text }, [
    el(doc, "span", { class: "gs-q-name" }, title),
    preview ? el(doc, "span", { class: "gs-q-preview" }, preview) : null,
    item.status !== "pending" ? el(doc, "span", { class: "gs-q-state" }, STATUS_LABEL[item.status] ?? item.status) : null,
  ]);
  li.append(number, main);
  // Only shown when the page could tell which model the message will use.
  if (item.model) li.append(el(doc, "span", { class: "gs-q-model", title: "Model for this message" }, item.model));

  const handle = button(doc, `${item.id}:handle`, icon(doc, "grip"), () => undefined, {
    className: "gs-q-icon gs-q-handle",
    label: `Reorder message ${index + 1}: drag, or use the arrow keys`,
    disabled: locked || count < 2,
  });
  attachReorder(doc, handle, li, item, index, on);

  const actions = el(doc, "div", { class: "gs-q-actions", role: "group", "aria-label": `Actions for message ${index + 1}` });
  actions.append(handle);
  if (EDITABLE.has(item.status)) {
    actions.append(button(doc, `${item.id}:edit`, icon(doc, "pencil"), () => on.startEdit(item), { className: "gs-q-icon", label: `Edit message ${index + 1}` }));
  }
  if (item.status === "failed" || item.status === "manual-review") {
    actions.append(button(doc, `${item.id}:retry`, "Retry", () => on.retry(item.id)));
    actions.append(button(doc, `${item.id}:delivered`, "Mark delivered", () => on.markDelivered(item.id)));
  }
  actions.append(
    button(doc, `${item.id}:remove`, icon(doc, "remove"), () => on.remove(item.id), {
      className: "gs-q-icon",
      label: `Remove message ${index + 1}`,
      disabled: locked,
    }),
  );
  li.append(actions);

  // Alt+Arrow anywhere in the row, or a bare arrow on the handle, reorders.
  li.addEventListener("keydown", (event) => {
    if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || locked) return;
    if (!event.altKey && event.target !== handle) return;
    event.preventDefault();
    on.move(item.id, index + (event.key === "ArrowUp" ? -1 : 1), `${item.id}:handle`);
  });

  if (item.lastError) {
    li.append(el(doc, "p", { class: "gs-q-note", "data-gs-note": item.lastError.code }, `${item.lastError.message} ${item.lastError.action}`));
  }
  return li;
}

/** Pointer drag on the handle (mouse, pen and touch). Visual feedback is class toggles only; the move commits on release. */
function attachReorder(doc, handle, li, item, index, on) {
  let drag = null;
  const rows = () => [...li.parentElement.children];
  const target = (y) => {
    const others = rows().filter((row) => row !== li);
    const index = dropIndex(others.map((row) => row.getBoundingClientRect()), y);
    return { index, row: others[index] ?? others[others.length - 1], before: index < others.length };
  };
  const clearMarks = () => rows().forEach((row) => row.classList.remove("gs-q-drop-before", "gs-q-drop-after", "gs-q-dragging"));
  const finish = (commitY) => {
    if (!drag) return;
    const { index: to } = commitY == null ? { index: index } : target(commitY);
    drag = null;
    clearMarks();
    if (to !== index) on.move(item.id, to, `${item.id}:handle`);
  };
  handle.addEventListener("pointerdown", (event) => {
    if (handle.disabled || (event.button != null && event.button !== 0)) return;
    drag = { id: event.pointerId };
    handle.setPointerCapture?.(event.pointerId);
    li.classList.add("gs-q-dragging");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag) return;
    rows().forEach((row) => row.classList.remove("gs-q-drop-before", "gs-q-drop-after"));
    const { row, before } = target(event.clientY);
    row?.classList.add(before ? "gs-q-drop-before" : "gs-q-drop-after");
  });
  handle.addEventListener("pointerup", (event) => finish(event.clientY));
  handle.addEventListener("pointercancel", () => finish(null));
}
