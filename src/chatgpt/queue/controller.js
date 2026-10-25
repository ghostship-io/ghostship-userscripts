// Mounts the queue panel directly above the native composer and wires it to the
// queue engine. Every send and stop goes through the injected dispatcher, which
// is the dry-run adapter by default; this file has no way to reach ChatGPT.
import { DispatchBoundary } from "./dispatch.js";
import { QueueEngine } from "./queue.js";
import { QueueStore } from "./store.js";
import { systemClock } from "./types.js";
import { CSS, STYLE_ID, renderPanel } from "./view.js";

const MESSAGES = {
  "not-leader": "Another tab is sending for this conversation.",
  "interrupt-aborted": "The first message changed while the response was stopping, so nothing was sent.",
};

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {object} o.adapter ChatGPT adapter (composer, conversationId)
 * @param {object} o.dispatcher DispatchAdapter; the dry-run adapter unless a live one is injected
 * @param {object} [o.diagnostics]
 * @param {IDBFactory} [o.indexedDB]
 * @param {number} [o.pollMs] Background refresh/drain period; 0 disables it (tests call `tick`).
 */
export function createQueueUi({
  win,
  adapter,
  dispatcher,
  diagnostics,
  indexedDB = win.indexedDB,
  clock = systemClock,
  tabId = globalThis.crypto.randomUUID(),
  pollMs = 1000,
  engineOptions = {},
}) {
  const doc = win.document;
  const composer = adapter.composer(doc);
  if (!composer || !indexedDB) {
    diagnostics?.count("queue.unmounted");
    return { mounted: false, reason: composer ? "no-indexeddb" : "no-composer", dispose() {} };
  }

  let conversationId = adapter.conversationId(win);
  const model = {
    items: [],
    paused: false,
    interrupting: false,
    error: null,
    note: null,
    edit: null,
    draft: "",
    collapsed: false,
    confirmClear: false,
    dryRun: dispatcher.dryRun === true,
  };
  let engine = null;
  let store = null;
  let disposed = false;
  let timer = null;
  let chain = Promise.resolve();

  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.append(style);
  }
  const root = doc.createElement("section");
  root.className = "gs-q";
  root.setAttribute("data-gs-queue", "");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Message queue");
  composer.before(root);

  const run = (fn) => {
    const next = chain.then(fn).catch((error) => {
      diagnostics?.count("queue.action.failed");
      model.error = { message: error instanceof Error ? error.message : String(error), action: "" };
      render();
    });
    chain = next;
    return next;
  };

  // Rebuilding the DOM would drop the caret and any IME composition in the
  // inputs, so the background poll only repaints when something visible changed.
  let painted = null;
  function render(focusKey) {
    const { items, paused, interrupting, error, note, edit, dryRun, collapsed, confirmClear } = model;
    const signature = JSON.stringify({ items, paused, interrupting, error, note, dryRun, collapsed, confirmClear, editing: edit?.id ?? null });
    if (signature === painted && !focusKey) return;
    painted = signature;
    const active = doc.activeElement;
    const key = focusKey ?? (root.contains(active) ? active.getAttribute("data-gs-key") : null);
    renderPanel(doc, root, model, handlers);
    if (!key) return;
    const wanted = root.querySelector(`[data-gs-key="${CSS_ESCAPE(key)}"]`);
    (wanted && !wanted.disabled ? wanted : root.querySelector("button:not(:disabled)"))?.focus({ preventScroll: true });
  }

  async function reload() {
    const view = await engine.list(conversationId);
    model.items = view.items;
    model.paused = view.paused;
    if (model.edit && !view.items.some((i) => i.id === model.edit.id && i.status !== "sent")) model.edit = null;
    render();
  }

  const act = (fn, focusKey) =>
    run(async () => {
      model.error = null;
      model.confirmClear = false;
      await fn();
      await reload();
      if (focusKey) render(focusKey);
    });

  const handlers = {
    draft: (text) => {
      model.draft = text;
    },
    editDraft: (text) => {
      if (model.edit) model.edit.text = text;
    },
    add: (text) => {
      if (!text.trim()) return;
      model.draft = "";
      // The model is stamped when the page can tell; otherwise the row simply shows no chip.
      const modelName = adapter.currentModel?.(doc) ?? null;
      return act(() => engine.enqueue(conversationId, { text, model: modelName }), "add:input");
    },
    startEdit: (item) => {
      model.edit = { id: item.id, text: item.text };
      render(`${item.id}:edit`);
    },
    cancelEdit: () => {
      const id = model.edit?.id;
      model.edit = null;
      render(id ? `${id}:edit` : undefined);
    },
    saveEdit: (id, text) =>
      act(async () => {
        model.edit = null;
        await engine.edit(id, { text });
      }, `${id}:edit`),
    move: (id, to, focusKey) => act(() => engine.move(id, to), focusKey),
    remove: (id) => act(() => engine.remove(id), "add:input"),
    retry: (id) => act(() => engine.retry(id)),
    markDelivered: (id) => act(() => engine.markDelivered(id)),
    toggleCollapsed: () => {
      model.collapsed = !model.collapsed;
      model.confirmClear = false;
      render("head:toggle");
    },
    // Clearing discards drafts, so it takes a second press.
    clear() {
      if (!model.confirmClear) {
        model.confirmClear = true;
        render("head:clear");
        return;
      }
      return act(() => engine.clear(conversationId), "head:clear");
    },
    disarmClear: () => {
      model.confirmClear = false;
      render("head:clear");
    },
    togglePause: () => act(() => (model.paused ? engine.resume(conversationId) : engine.pause(conversationId))),
    interrupt() {
      model.interrupting = true;
      model.error = null;
      model.confirmClear = false;
      render("head:interrupt");
      return run(async () => {
        try {
          const outcome = await engine.interruptAndSendNext(conversationId);
          model.error = interruptError(outcome);
          diagnostics?.count(`queue.interrupt.${outcome.kind}`);
        } finally {
          model.interrupting = false;
        }
        await reload();
      });
    },
  };

  /** One background pass: follow navigation, keep the DOM in place, drain sequentially. */
  function tick() {
    return run(async () => {
      if (!engine || model.interrupting) return;
      const current = adapter.conversationId(win);
      if (current !== conversationId) {
        const previous = conversationId;
        await engine.release(previous).catch(() => undefined);
        conversationId = current;
        // A new chat's first send creates its conversation: the rest of the draft queue follows it.
        if (previous === "new" && current !== "new") {
          const moved = await engine.adoptAfterFirstSend(previous, current).catch(() => 0);
          if (moved) diagnostics?.count("queue.adopted");
        }
        model.edit = null;
      }
      const home = adapter.composer(doc);
      if (home && (!root.isConnected || root.nextElementSibling !== home)) home.before(root);
      const outcome = await engine.step(conversationId);
      model.note = MESSAGES[outcome.kind] ?? null;
      await reload();
    });
  }

  const ready = QueueStore.open(indexedDB).then(async (opened) => {
    if (disposed) return opened.close();
    store = opened;
    engine = new QueueEngine({
      store,
      dispatch: new DispatchBoundary(dispatcher, { clock }),
      clock,
      tabId,
      ...engineOptions,
    });
    await run(reload);
    if (pollMs > 0) timer = win.setInterval(tick, pollMs);
  });
  ready.catch(() => {
    diagnostics?.count("queue.store.failed");
    model.error = { message: "The queue could not open its storage.", action: "Reload the page; queued messages are kept." };
    render();
  });
  render();

  const onPageHide = () => engine?.release(conversationId).catch(() => undefined);
  win.addEventListener("pagehide", onPageHide);

  return {
    mounted: true,
    root,
    ready,
    tick,
    /** Resolves when every queued UI action has finished. */
    settled: () => chain,
    dispose() {
      disposed = true;
      if (timer) win.clearInterval(timer);
      win.removeEventListener("pagehide", onPageHide);
      root.remove();
      doc.getElementById(STYLE_ID)?.remove();
      engine?.release(conversationId).catch(() => undefined).finally(() => store?.close());
    },
  };
}

function interruptError(outcome) {
  if (outcome.kind === "interrupt-failed") return { message: outcome.error.message, action: outcome.error.action };
  if (outcome.kind === "halted") return { message: `The first message is ${outcome.status}.`, action: "Resolve it before sending the next." };
  if (outcome.kind === "failed" || outcome.kind === "manual-review") {
    return { message: "The message was not confirmed sent.", action: "See the message below for what to do." };
  }
  const message = MESSAGES[outcome.kind];
  return message ? { message, action: "" } : null;
}

const CSS_ESCAPE = (value) => value.replace(/["\\]/g, "\\$&");
