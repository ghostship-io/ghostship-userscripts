// Mounts the queue card directly above the native composer and wires it to the queue engine. The
// native composer is the only place text is entered or edited: while a response runs, plain Enter
// there appends to the conversation's one pending prompt instead of sending or steering. Every send
// and stop goes through the injected dispatcher; this file has no way to reach ChatGPT itself.
import { createObserverHub } from "../../core/observers.js";
import { createWorkerTimers } from "../../core/worker-timer.js";
import { createComposerIO } from "./composer.js";
import { DispatchBoundary } from "./dispatch.js";
import { QueueEngine } from "./queue.js";
import { QueueStore } from "./store.js";
import { createQueueMarkers } from "./markers.js";
import { joinContributions } from "./text.js";
import { systemClock } from "./types.js";
import { CSS, STYLE_ID, renderPanel } from "./view.js";

const MESSAGES = {
  "not-leader": "Another tab is sending for this conversation.",
  "interrupt-aborted": "The queued prompt changed while the response was stopping, so nothing was sent.",
  editing: "Save or cancel the edit first.",
};
const CHANNEL = "ghostship-chatgpt-queue";
const RELOAD_EVERY = 5; // ticks between quiet reloads when no cross-tab message arrived

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {object} o.adapter ChatGPT adapter (composer, conversationId, accountId, generating, ...)
 * @param {object} o.dispatcher the dry-run adapter unless a live one is injected
 * @param {object} [o.diagnostics]
 * @param {IDBFactory} [o.indexedDB]
 * @param {number} [o.pollMs] Background refresh/dispatch period; 0 disables it (tests call `tick`).
 * @param {number} [o.hiddenPollMs] Period of the hidden-tab ticker (worker timers, not throttled); defaults to `pollMs`.
 * @param {{once: Function, every: Function, dispose(): void}} [o.timers] shared with the dispatcher; hidden-tab safe
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
  hiddenPollMs = pollMs,
  timers = createWorkerTimers({ win }),
  engineOptions = {},
  BroadcastChannelCtor = win.BroadcastChannel ?? globalThis.BroadcastChannel,
}) {
  const doc = win.document;
  const composer = adapter.composer(doc);
  if (!composer || !indexedDB) {
    diagnostics?.count("queue.unmounted");
    return { mounted: false, reason: composer ? "no-indexeddb" : "no-composer", dispose() {} };
  }

  const io = createComposerIO(win);
  // A profile label that is momentarily not rendered must not look like another account.
  let lastAccount = null;
  const targetNow = () => {
    const read = adapter.accountId(doc);
    const accountId = read === "unknown" && lastAccount ? lastAccount : read;
    lastAccount = accountId;
    return { accountId, conversationId: adapter.conversationId(win) };
  };
  let target = targetNow();
  const model = {
    pending: null,
    inflight: null,
    editingElsewhere: false,
    edit: null, // {target, input, baseVersion, baseText, draft}
    busy: null,
    waiting: null,
    error: null,
    note: null,
    dryRun: dispatcher.dryRun === true,
  };
  let engine = null;
  let store = null;
  let channel = null;
  let disposed = false;
  let dispatching = false;
  let submitting = false;
  let timer = null;
  let hiddenTicker = null;
  let queuedIds = new Set();
  let queuedStale = true;
  let lastGenerating = false;
  let ticks = 0;
  let reloadSeq = 0;
  let opSeq = 0;
  let dispatchChain = Promise.resolve();
  let actionChain = Promise.resolve();

  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.append(style);
  }
  const root = doc.createElement("section");
  root.className = "gs-q";
  root.hidden = true;
  root.setAttribute("data-gs-queue", "");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Message queue");
  composer.before(root);

  const fail = (error) => {
    diagnostics?.count("queue.action.failed");
    model.error = { message: error instanceof Error ? error.message : String(error), action: "" };
    render();
  };
  // User actions never wait behind a dispatch in progress; dispatch work is serialized on its own chain.
  const chained = (which) => (fn) => {
    const next = (which === "action" ? actionChain : dispatchChain).then(fn).catch(fail);
    if (which === "action") actionChain = next;
    else dispatchChain = next;
    return next;
  };
  const act = chained("action");
  const dispatch = chained("dispatch");

  // Rebuilding the DOM would drop focus, so the poll only repaints when something visible changed.
  let painted = null;
  function render(focusKey) {
    const { pending, inflight, editingElsewhere, edit, busy, waiting, error, note, dryRun } = model;
    const signature = JSON.stringify({ pending, inflight, editingElsewhere, editing: edit?.baseVersion ?? null, busy, waiting, error, note, dryRun });
    if (signature === painted && !focusKey) return;
    painted = signature;
    const active = doc.activeElement;
    const key = focusKey ?? (root.contains(active) ? active.getAttribute("data-gs-key") : null);
    renderPanel(doc, root, model, handlers);
    if (!key) return;
    const wanted = root.querySelector(`[data-gs-key="${CSS_ESCAPE(key)}"]`);
    (wanted && !wanted.disabled ? wanted : root.querySelector("button:not(:disabled)"))?.focus({ preventScroll: true });
  }

  const markers = createQueueMarkers({ doc, adapter });

  /** Which conversations hold a queued prompt, for the sidebar markers; re-read when anything may have changed. */
  async function refreshQueued() {
    queuedStale = false;
    try {
      queuedIds = await engine.queuedConversations(target.accountId);
    } catch {
      queuedStale = true;
    }
  }
  const paintMarkers = () => markers.sync(queuedIds);

  const notify = () => {
    try {
      channel?.postMessage({ from: tabId, key: `${target.accountId}:${target.conversationId}` });
    } catch {
      // closed channel
    }
  };

  async function reload() {
    const seq = ++reloadSeq;
    const asked = target;
    const view = await engine.view(asked);
    if (seq !== reloadSeq || asked !== target) return; // a newer view or another conversation took over
    model.pending = view.pending;
    model.inflight = view.inflight;
    model.editingElsewhere = view.editing && view.editBy !== tabId;
    if (!view.pending) model.waiting = null;
    if (!view.pending && !view.inflight && !model.edit) model.error = null;
    if (model.edit && !view.pending) endEditLocally("gone");
    await refreshQueued();
    paintMarkers();
    syncHidden();
    render();
  }

  // ---- edit session (the pending text lives in the native composer meanwhile) ----

  function endEditLocally(why) {
    const edit = model.edit;
    if (!edit) return;
    model.edit = null;
    const typed = edit.input.isConnected ? io.read(edit.input) : "";
    // The pending prompt is gone: nothing the user wrote or had drafted may be lost.
    io.write(edit.input, why === "gone" ? joinContributions(edit.draft, typed) : edit.draft);
    if (why === "gone") model.error = { message: "The queued prompt was sent or deleted while you were editing.", action: "Your text is in the composer." };
  }

  async function startEdit() {
    if (model.edit || !engine || !model.pending) return;
    const t = target;
    const input = adapter.composerInput(doc);
    if (!input) return;
    const begun = await engine.beginEdit(t);
    if (begun.kind === "busy") {
      model.note = "Another tab is editing this prompt.";
      return render();
    }
    if (begun.kind !== "ok") return reload();
    model.error = null;
    model.note = null;
    model.edit = { target: t, input, baseVersion: begun.record.version, baseText: begun.record.text, draft: io.read(input) };
    io.write(input, begun.record.text);
    input.focus?.();
    await reload();
    render("head:save");
    input.focus?.();
    notify();
  }

  async function saveEdit() {
    const edit = model.edit;
    if (!edit || submitting) return;
    submitting = true;
    try {
      const result = await engine.saveEdit(edit.target, { baseVersion: edit.baseVersion, baseText: edit.baseText, text: io.read(edit.input) });
      if (result.kind === "saved" || result.kind === "rebased") {
        model.edit = null;
        io.write(edit.input, edit.draft);
        model.note = result.kind === "rebased" ? "Text added from another tab while you were editing was kept." : null;
        model.error = null;
      } else if (result.kind === "conflict") {
        model.pending = result.record;
        model.error = {
          message: "The queued prompt changed in another tab while you were editing.",
          action: "Your edit is still in the composer. Cancel to discard it and edit the new text.",
        };
      } else if (result.kind === "empty") {
        model.note = "An empty prompt is not saved. Use Delete to remove the queued prompt.";
      } else {
        endEditLocally("gone");
      }
      await reload();
      notify();
    } finally {
      submitting = false;
    }
  }

  async function cancelEdit() {
    const edit = model.edit;
    if (!edit) return;
    model.edit = null;
    io.write(edit.input, edit.draft);
    model.error = null;
    model.note = null;
    await engine.endEdit(edit.target);
    await reload();
  }

  // ---- appending from the native composer ------------------------------------

  async function appendFromComposer(source) {
    const t = target;
    const input = adapter.composerInput(doc);
    if (!input || submitting) return;
    const text = io.read(input);
    if (text.trim() === "") return;
    submitting = true;
    try {
      model.error = null;
      model.note = null;
      const result = await engine.append(t, { text, attachments: adapter.composerAttachments?.(doc) ?? [], opId: `${tabId}:${++opSeq}` });
      diagnostics?.count(`queue.append.${source}`);
      // Cleared only after the write is confirmed, and only if the composer still holds what was queued.
      if (result.kind !== "ignored" && input.isConnected && io.read(input) === text) io.write(input, "");
      await reload();
      notify();
    } finally {
      submitting = false;
    }
  }

  const submitComposer = (source) => {
    if (dispatching) {
      model.note = "Sending the queued prompt; try again in a moment.";
      return render();
    }
    if (!engine) {
      model.note = "The queue is starting; your text is still in the composer.";
      return render();
    }
    return act(() => (model.edit ? saveEdit() : appendFromComposer(source)));
  };

  // ---- native composer interception (capture phase, targeted) ----------------

  const inComposer = (event) => {
    const input = adapter.composerInput(doc);
    return input && event.target instanceof win.Node && (input === event.target || input.contains(event.target));
  };
  /** Hijack the send gesture only while a response runs (or an edit is open), and never in an unsaved new chat. */
  const hijacking = () => dispatching || model.edit !== null || (adapter.generating(doc) && target.conversationId !== "new");

  function onKeydown(event) {
    if (!inComposer(event)) return;
    if (event.key === "Escape" && model.edit) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void act(cancelEdit);
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    if (!hijacking()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void submitComposer("enter");
  }

  // A form submit that did not come from our Enter handler (a native Send / steer button).
  function onSubmit(event) {
    const input = adapter.composerInput(doc);
    if (!input || !event.target?.contains?.(input) || !hijacking()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void submitComposer("submit");
  }

  function onClick(event) {
    if (dispatching || !hijacking()) return;
    const hit = event.target?.closest?.("button");
    const input = adapter.composerInput(doc);
    if (!hit || !input || !hit.closest("form")?.contains(input)) return;
    if (hit !== adapter.sendButton(doc) && hit !== adapter.steerButton(doc)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void submitComposer("button");
  }

  win.addEventListener("keydown", onKeydown, true);
  win.addEventListener("submit", onSubmit, true);
  win.addEventListener("click", onClick, true);

  // ---- actions ----------------------------------------------------------------

  const outcomeNote = (outcome) => {
    if (outcome.kind === "interrupt-failed") return { message: outcome.error.message, action: outcome.error.action };
    if (outcome.kind === "rejected") return { message: outcome.error.message, action: outcome.error.action };
    if (outcome.kind === "halted") return { message: `The queued prompt is ${outcome.status}.`, action: "Resolve it first." };
    if (outcome.kind === "manual-review") return { message: "Send was clicked but ChatGPT showed no sign of accepting it.", action: "Check the conversation, then mark it delivered or restore it." };
    if (outcome.kind === "waiting" && outcome.reason !== "editing") return { message: `Not sent yet: ${outcome.reason}.`, action: "It will go out when the page is ready." };
    const message = MESSAGES[outcome.kind] ?? (outcome.kind === "waiting" ? MESSAGES.editing : null);
    return message ? { message, action: "" } : null;
  };

  const explicit = (busy, run) => () => {
    if (!engine || model.edit) return undefined;
    const t = target;
    model.busy = busy;
    model.error = null;
    model.note = null;
    render("head:steer");
    return dispatch(async () => {
      try {
        const outcome = await run(t);
        const note = outcomeNote(outcome);
        model.error = note && { ...note, source: "action" };
        diagnostics?.count(`queue.${busy}.${outcome.kind}`);
      } finally {
        model.busy = null;
        dispatching = false;
      }
      await reload();
      notify();
    });
  };

  const handlers = {
    startEdit: () => act(startEdit),
    saveEdit: () => act(saveEdit),
    cancelEdit: () => act(cancelEdit),
    remove: () =>
      act(async () => {
        const t = target;
        model.error = null;
        if (model.edit) {
          const edit = model.edit;
          model.edit = null;
          io.write(edit.input, edit.draft);
        }
        await engine.remove(t);
        await reload();
        notify();
      }),
    unblock: (dropAttachments) =>
      act(async () => {
        await engine.unblock(target, { dropAttachments });
        await reload();
        notify();
      }),
    markDelivered: () =>
      act(async () => {
        await engine.markDelivered(target);
        await reload();
        notify();
      }),
    restoreInflight: () =>
      act(async () => {
        await engine.restoreInflight(target);
        await reload();
        notify();
      }),
    steer: explicit("steering", (t) => engine.steer(t, { native: true })),
  };

  // ---- background pass ---------------------------------------------------------

  async function followNavigation() {
    const now = targetNow();
    if (now.accountId === target.accountId && now.conversationId === target.conversationId) return false;
    const previous = target;
    if (model.edit) endEditLocally("cancel");
    await engine.release(previous).catch(() => undefined);
    target = now;
    Object.assign(model, { pending: null, inflight: null, editingElsewhere: false, waiting: null, error: null, note: null });
    await engine.adoptLegacy(now).catch(() => 0);
    ticks = RELOAD_EVERY;
    return true;
  }

  /** One background pass: follow navigation, keep the DOM in place, dispatch when ready. */
  function tick() {
    return dispatch(async () => {
      if (!engine || model.busy) return;
      await followNavigation();
      paintMarkers();
      const home = adapter.composer(doc);
      if (home && (!root.isConnected || root.nextElementSibling !== home)) home.before(root);
      if (model.edit && !(await engine.renewEdit(model.edit.target))) endEditLocally("gone");
      if (model.pending || model.inflight) {
        let outcome;
        try {
          outcome = await engine.step(target);
        } finally {
          dispatching = false;
        }
        model.waiting = outcome.kind === "waiting" ? outcome.reason : null;
        if (outcome.kind === "not-leader") model.note = MESSAGES["not-leader"];
        else if (model.note === MESSAGES["not-leader"]) model.note = null;
        if (outcome.kind === "sent") notify();
        // A failure found by the background pass shows until the page recovers; one from an explicit action stays until the next action.
        if (outcome.kind === "rejected" || outcome.kind === "manual-review") model.error = { ...outcomeNote(outcome), source: "auto" };
        else if (model.error?.source === "auto") model.error = null;
        await reload();
      } else if (++ticks >= RELOAD_EVERY) {
        ticks = 0;
        await reload();
      } else {
        render();
      }
    });
  }

  // ---- wake-ups: the pass runs when something relevant happened, not only on the poll ----------------------
  // A hidden tab's window timers are throttled (about one a second, about one a minute after five minutes), so while a
  // prompt waits in a hidden page its pass is driven by a worker ticker, and by the page itself: the response ending
  // (the Stop control going away) wakes it at once through an observer, which runs in hidden tabs too.
  let waking = false;
  let again = false;
  function wake() {
    if (disposed || !engine) return;
    if (waking) {
      again = true;
      return;
    }
    waking = true;
    void tick().finally(() => {
      waking = false;
      if (again) {
        again = false;
        wake();
      }
    });
  }

  const hub = createObserverHub({ max: 1, MutationObserverCtor: win.MutationObserver, schedule: (fn) => Promise.resolve().then(fn) });
  let unobserve = null;
  function syncHidden() {
    const want = doc.hidden === true && Boolean(model.pending || model.inflight) && !disposed;
    if (want && !hiddenTicker && hiddenPollMs > 0) hiddenTicker = timers.every(wake, hiddenPollMs);
    else if (!want && hiddenTicker) (hiddenTicker(), (hiddenTicker = null));
    if (want && !unobserve && doc.body) {
      lastGenerating = adapter.generating(doc);
      unobserve = hub.subscribe(doc.body, () => {
        const now = adapter.generating(doc);
        if (lastGenerating && !now) wake();
        lastGenerating = now;
      }, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "disabled", "data-is-streaming"] });
    } else if (!want && unobserve) (unobserve(), (unobserve = null));
  }
  const onVisibility = () => {
    syncHidden();
    if (doc.hidden !== true) wake();
  };
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("focus", wake);
  win.addEventListener("pageshow", wake);

  const ready = QueueStore.open(indexedDB, undefined, () => clock.now()).then(async (opened) => {
    if (disposed) return opened.close();
    store = opened;
    engine = new QueueEngine({
      store,
      dispatch: new DispatchBoundary(dispatcher, { clock, onAction: () => (dispatching = true) }),
      clock,
      tabId,
      ...engineOptions,
    });
    try {
      channel = BroadcastChannelCtor ? new BroadcastChannelCtor(CHANNEL) : null;
      channel?.unref?.();
      if (channel) {
        channel.onmessage = (event) => {
          if (event.data?.from === tabId) return;
          if (event.data?.key === `${target.accountId}:${target.conversationId}`) void act(reload);
          else void act(async () => (await refreshQueued(), paintMarkers()));
        };
      }
    } catch {
      channel = null;
    }
    await engine.adoptLegacy(target).catch(() => 0);
    await act(reload);
    if (pollMs > 0) timer = win.setInterval(tick, pollMs);
  });
  ready.catch(() => {
    diagnostics?.count("queue.store.failed");
    model.error = { message: "The queue could not open its storage.", action: "Reload the page; queued messages are kept." };
    render();
  });
  render();

  const onPageHide = () => engine?.release(target).catch(() => undefined);
  win.addEventListener("pagehide", onPageHide);

  return {
    mounted: true,
    root,
    ready,
    tick,
    /** Runs the background pass now (coalesced); called on route changes, focus and visibility changes. */
    wake,
    /** Resolves when every queued UI action and dispatch pass has finished. */
    settled: () => Promise.all([actionChain, dispatchChain]).then(() => undefined),
    dispose() {
      disposed = true;
      if (timer) win.clearInterval(timer);
      hiddenTicker?.();
      unobserve?.();
      hub.disposeAll();
      doc.removeEventListener("visibilitychange", onVisibility);
      win.removeEventListener("focus", wake);
      win.removeEventListener("pageshow", wake);
      markers.dispose();
      timers.dispose();
      for (const [name, fn] of [["keydown", onKeydown], ["submit", onSubmit], ["click", onClick], ["pagehide", onPageHide]]) {
        win.removeEventListener(name, fn, name === "pagehide" ? undefined : true);
      }
      if (model.edit) endEditLocally("cancel");
      channel?.close();
      root.remove();
      doc.getElementById(STYLE_ID)?.remove();
      engine?.release(target).catch(() => undefined).finally(() => store?.close());
    },
  };
}

const CSS_ESCAPE = (value) => value.replace(/["\\]/g, "\\$&");
