import test from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./virtualization-fixture.js";
import { createBoot } from "../src/core/boot.js";
import { createRuntime } from "../src/core/runtime.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createTurnBackend } from "../src/chatgpt/virtualization/backend.js";
import { createRail } from "../src/chatgpt/rail/rail.js";
import { IDBFactory } from "fake-indexeddb";
import { DryRunDispatcher } from "../src/chatgpt/queue/dispatch.js";
import { createQueueUi } from "../src/chatgpt/queue/controller.js";
import { persistentQueueUi } from "../src/chatgpt/queue/persistent.js";
import { ManualClock, until } from "./queue-helpers.js";

/** Manual timers so the debounce and the give-up cap are deterministic. */
function manualTimers() {
  let now = 0;
  let id = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      pending.set(++id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (h) => pending.delete(h),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    size: () => pending.size,
  };
}

function setup(fx, { maxWaitMs = 30000, queueUi: customQueueUi } = {}) {
  const timers = manualTimers();
  const log = { mounts: 0, queue: 0, queueDisposed: 0, warnings: [] };
  fx.win.console.warn = (m) => log.warnings.push(m);
  // Count live MutationObservers owned by the boot controller (the hub's own are separate).
  const RealMO = fx.win.MutationObserver;
  const live = new Set();
  fx.win.MutationObserver = class extends RealMO {
    observe(...a) {
      live.add(this);
      return super.observe(...a);
    }
    disconnect() {
      live.delete(this);
      return super.disconnect();
    }
  };
  const queueUi =
    customQueueUi ??
    (() => {
      log.queue++;
      return { dispose: () => log.queueDisposed++ };
    });
  const layoutCalls = { n: 0 };
  const adapter = Object.create(chatgptAdapter);
  adapter.layout = (...a) => (layoutCalls.n++, chatgptAdapter.layout.call(adapter, ...a));
  const boot = createBoot({
    win: fx.win,
    adapter,
    version: "9.9.9",
    maxWaitMs,
    timers,
    mount() {
      log.mounts++;
      const runtime = createRuntime({ win: fx.win, adapter, backend: createTurnBackend(), queueUi });
      const rail = runtime.mode === "active" || runtime.mode === "composer-only" ? createRail({ win: fx.win, adapter, runtime }) : null;
      return {
        runtime,
        dispose() {
          rail?.dispose();
          runtime.dispose();
        },
      };
    },
  });
  /** Deliver pending mutations, then let the debounce elapse and the page settle. */
  const flush = async (ms = 150) => {
    await fx.settle();
    timers.advance(ms);
    await fx.settle();
  };
  return { boot, timers, log, live, flush, layoutCalls, health: boot.health };
}

const rails = (fx) => fx.doc.querySelectorAll(".gs-pane").length;
const promptRows = (fx) => fx.doc.querySelectorAll(".gs-prompt").length;

test("turns that render after the script started: waits (untouched page), then goes active", async () => {
  const fx = createFixture({ turns: 0, width: 1600 });
  const form = fx.removeComposer();
  const before = fx.doc.documentElement.outerHTML;
  const { health, flush, log, live } = setup(fx);
  assert.equal(health.mode, "waiting");
  assert.deepEqual(health.missing, ["composer", "turns"]);
  assert.equal(health.version, "9.9.9");
  assert.equal(log.mounts, 0);
  assert.equal(fx.doc.documentElement.outerHTML, before, "nothing touched while waiting");
  assert.equal(live.size, 1, "one shared observer while waiting");

  fx.addComposer(form);
  await flush();
  assert.equal(health.mode, "composer-only", "composer rendered first, conversation still loading");
  for (let i = 0; i < 30; i++) fx.addTurn();
  await flush();
  assert.equal(health.mode, "active");
  assert.deepEqual(health.missing, []);
  assert.equal(log.mounts, 2, "composer-only upgraded to the full feature set once");
  assert.equal(rails(fx), 1, "the old rail was torn down");
  assert.ok(promptRows(fx) > 0);
  assert.equal(log.queueDisposed, 1);
  assert.equal(fx.doc.querySelectorAll("[data-gs-state='active']").length > 0, true);
});

test("a new chat with only the composer is composer-only, not safe: queue mounted, rail empty", async () => {
  const fx = createFixture({ turns: 0, width: 1600 });
  fx.win.history.replaceState(null, "", "/");
  const { health, log } = setup(fx);
  assert.equal(health.mode, "composer-only");
  assert.deepEqual(health.missing, ["turns"]);
  assert.equal(health.route, "new");
  assert.equal(log.queue, 1);
  assert.equal(rails(fx), 1);
  assert.equal(promptRows(fx), 0);
  assert.match(fx.doc.querySelector(".gs-empty").textContent, /No prompts yet/);
  fx.scroller.scrollTop = 50;
  assert.equal(fx.rawTop(), 0, "scroll sim has no content; page scrolling is not intercepted by an inert runtime");
  assert.equal(fx.doc.querySelector("[data-gs-state]"), null, "no virtualization on an empty chat");
});

test("route change (pushState and popstate) tears down and re-initializes", async () => {
  const fx = createFixture({ turns: 30, width: 1600 });
  const { health, flush, log } = setup(fx);
  assert.equal(health.mode, "active");
  assert.equal(log.mounts, 1);
  const rows = promptRows(fx);

  // Same URL again: nothing to do.
  fx.win.history.replaceState(null, "", "/c/fixture");
  await flush();
  assert.equal(log.mounts, 1);

  // Navigate to another conversation whose turns replace the old ones.
  fx.replaceThread(12);
  fx.win.history.pushState({}, "", "/c/aaaaaaaa-0000-0000-0000-000000000001");
  await flush();
  assert.equal(log.mounts, 2);
  assert.equal(health.route, "conversation");
  assert.equal(health.mode, "active");
  assert.equal(rails(fx), 1);
  assert.equal(promptRows(fx), 12);
  assert.notEqual(promptRows(fx), rows);
  assert.equal(log.queueDisposed, 1);

  // Back to a new chat: no turns, composer-only.
  fx.replaceThread(0);
  fx.win.history.pushState({}, "", "/");
  await flush();
  assert.equal(health.mode, "composer-only");
  assert.equal(health.route, "new");
  assert.equal(log.mounts, 3);

  // popstate (browser back) re-initializes too.
  fx.replaceThread(8);
  fx.win.history.replaceState({}, "", "/c/bbbbbbbb-0000-0000-0000-000000000002");
  fx.win.dispatchEvent(new fx.win.Event("popstate"));
  await flush();
  assert.equal(health.mode, "active");
  assert.equal(promptRows(fx), 8);
  assert.equal(log.mounts, 4);
});

test("the conversation root replaced without a URL change re-initializes", async () => {
  const fx = createFixture({ turns: 20, width: 1600 });
  const { health, flush, log } = setup(fx);
  assert.equal(log.mounts, 1);
  fx.replaceThread(9);
  await flush();
  assert.equal(log.mounts, 2);
  assert.equal(health.mode, "active");
  assert.equal(promptRows(fx), 9);
  assert.equal(fx.doc.querySelectorAll(".gs-pane").length, 1);
});

test("bounded wait: gives up visibly after the cap, stops observing, and a route change re-arms it", async () => {
  const fx = createFixture({ turns: 0, width: 1600 });
  fx.removeComposer();
  const { health, timers, log, live, flush } = setup(fx, { maxWaitMs: 5000 });
  assert.equal(health.mode, "waiting");
  timers.advance(4999);
  assert.equal(health.mode, "waiting");
  timers.advance(2);
  assert.equal(health.mode, "safe");
  assert.equal(health.reason, "timeout");
  assert.deepEqual(health.missing, ["composer", "turns"]);
  assert.equal(log.warnings.filter((m) => /layout not found/.test(m)).length, 1, "gives up visibly, once");
  assert.equal(live.size, 0, "no observer while idle");
  assert.equal(health.diagnostics()["boot.timeout"], 1);

  // The page finishes rendering later and the user navigates: a fresh bounded wait finds it.
  const form = fx.doc.createElement("form");
  form.innerHTML = '<textarea id="prompt-textarea"></textarea>';
  fx.addComposer(form);
  for (let i = 0; i < 5; i++) fx.addTurn();
  fx.win.history.pushState({}, "", "/c/cccccccc-0000-0000-0000-000000000003");
  await flush();
  assert.equal(health.mode, "active");
  assert.equal(log.mounts, 1);
});

test("a burst of page mutations costs one layout check, not one per mutation", async () => {
  const fx = createFixture({ turns: 20, width: 1600 });
  const { health, flush, layoutCalls, log } = setup(fx);
  await flush();
  const before = layoutCalls.n;
  for (let i = 0; i < 300; i++) fx.thread.lastElementChild.append(fx.doc.createElement("span"));
  await flush();
  assert.ok(layoutCalls.n - before <= 3, `layout checks: ${layoutCalls.n - before}`);
  assert.equal(log.mounts, 1);
  assert.equal(health.mode, "active");
});

test("a runtime that dropped to safe mode on this layout is not retried until the layout changes", async () => {
  const fx = createFixture({ turns: 12, width: 1600 });
  fx.elements().forEach((e) => (e.innerHTML = "<div>x</div>")); // turns without roles: unknown markup
  const { health, flush, log } = setup(fx);
  assert.equal(health.mode, "safe");
  assert.equal(log.mounts, 1);
  await flush();
  fx.thread.lastElementChild.append(fx.doc.createElement("span"));
  await flush();
  assert.equal(log.mounts, 1, "no retry loop on unknown markup");
  fx.replaceThread(0);
  await flush();
  assert.equal(health.mode, "composer-only");
  assert.equal(log.mounts, 2);
});

test("a throwing mount is contained and not retried on the same layout", async () => {
  const fx = createFixture({ turns: 10, width: 1600 });
  const timers = manualTimers();
  let mounts = 0;
  const warnings = [];
  fx.win.console.warn = (m) => warnings.push(m);
  const boot = createBoot({ win: fx.win, adapter: chatgptAdapter, version: "1", timers, mount: () => (mounts++, (() => { throw new Error("boom"); })()) });
  assert.equal(boot.health.mode, "safe");
  assert.equal(boot.health.reason, "mount-error");
  fx.thread.lastElementChild.append(fx.doc.createElement("span"));
  await fx.settle();
  timers.advance(300);
  assert.equal(mounts, 1);
  assert.equal(warnings.length, 1);
});

test("dispose restores history, removes everything and stops observing", async () => {
  const fx = createFixture({ turns: 20, width: 1600 });
  const push = fx.win.history.pushState;
  const before = fx.doc.documentElement.outerHTML;
  const { boot, live, log } = setup(fx);
  assert.notEqual(fx.win.history.pushState, push);
  boot.dispose();
  assert.equal(fx.win.history.pushState, push);
  assert.equal(live.size, 0);
  assert.equal(fx.doc.documentElement.outerHTML, before);
  assert.equal(log.queueDisposed, 1);
});

test("health reports version, mode and missing selectors without conversation ids", async () => {
  const fx = createFixture({ turns: 10, width: 1600 });
  const { health } = setup(fx);
  fx.win.history.pushState({}, "", "/c/dddddddd-0000-0000-0000-000000000004");
  const text = JSON.stringify({ version: health.version, mode: health.mode, missing: health.missing, route: health.route });
  assert.doesNotMatch(text, /dddddddd/);
  assert.equal(health.version, "9.9.9");
  assert.ok(["active", "composer-only", "waiting", "safe", "off"].includes(health.mode));
});

test("queue survives the new-chat first send: route change and turns remount the page features, not the queue", async () => {
  const fx = createFixture({ turns: 0, width: 1600 });
  fx.win.history.replaceState(null, "", "/");
  const clock = new ManualClock();
  const dispatcher = new DryRunDispatcher();
  const submitted = [];
  const realSubmit = dispatcher.submit.bind(dispatcher);
  dispatcher.submit = async (request) => {
    submitted.push(request.text);
    if (submitted.length === 1) {
      // What ChatGPT does on the first send of a new chat: the URL gains an id and turns render.
      fx.win.history.pushState({}, "", "/c/eeeeeeee-0000-0000-0000-000000000005");
      fx.addTurn();
    }
    const result = await realSubmit(request);
    dispatcher.state = "idle"; // the reply finished
    return result;
  };
  let created = 0;
  let queueDiagnostics = null;
  const queueUi = persistentQueueUi((ctx) => {
    created++;
    queueDiagnostics = ctx.diagnostics;
    return createQueueUi({ win: ctx.win, adapter: ctx.adapter, diagnostics: ctx.diagnostics, dispatcher, indexedDB: new IDBFactory(), clock, tabId: "tab-1", pollMs: 0 });
  });
  const { boot, health, flush, log } = setup(fx, { queueUi });
  assert.equal(health.mode, "composer-only");
  const panel = fx.doc.querySelector("[data-gs-queue]");
  assert.ok(panel, "queue panel mounted in the new chat");

  const add = async (text) => {
    const input = panel.querySelector('[data-gs-key="add:input"]');
    input.value = text;
    input.dispatchEvent(new fx.win.Event("input", { bubbles: true }));
    panel.querySelector('[data-gs-key="add:submit"]').click();
    await boot.runtime().queue.settled();
  };
  const step = async () => {
    const { queue } = boot.runtime();
    await queue.tick();
    await queue.settled();
  };
  await boot.runtime().queue.ready;
  await boot.runtime().queue.settled();
  const names = () => [...panel.querySelectorAll(".gs-q-item")].map((li) => li.querySelector(".gs-q-name")?.textContent ?? "");
  await add("first");
  await add("second");
  assert.deepEqual(names(), ["first", "second"]);

  // First pass sends "first"; the page navigates to the new conversation and renders its turns.
  await step();
  assert.deepEqual(submitted, ["first"]);
  await flush(); // boot notices the route change and the new turns and rebuilds the page features
  assert.equal(health.mode, "active");
  assert.ok(log.mounts >= 2, "page features were re-initialized");
  assert.equal(created, 1, "the queue was not re-created");
  assert.equal(fx.doc.querySelector("[data-gs-queue]"), panel, "same panel, not rebuilt");
  assert.equal(panel.nextElementSibling, chatgptAdapter.composer(fx.doc));

  // Next passes follow the navigation, adopt the draft queue and send the second message exactly once.
  clock.advance(5000);
  await step();
  await until(() => submitted.length >= 2);
  for (let i = 0; i < 3; i++) {
    clock.advance(5000);
    await step();
  }
  assert.deepEqual(submitted, ["first", "second"], "each message dispatched exactly once");
  assert.equal(dispatcher.log.filter((e) => e.type === "submit").length, 2);
  assert.equal(queueDiagnostics.snapshot()["queue.adopted"], 1, "the draft queue followed the new conversation");
  boot.dispose();
});

test("while running, streaming mutations cost no script DOM writes and a bounded number of cheap layout checks", async () => {
  const fx = createFixture({ turns: 25, width: 1600 });
  const { health, flush, layoutCalls } = setup(fx);
  await flush();
  assert.equal(health.mode, "active");

  // Count selector work the boot tick performs.
  const Doc = fx.win.Document.prototype;
  const queries = { n: 0 };
  const realQ = Doc.querySelector;
  const realQA = Doc.querySelectorAll;
  Doc.querySelector = function (...a) { queries.n++; return realQ.apply(this, a); };
  Doc.querySelectorAll = function (...a) { queries.n++; return realQA.apply(this, a); };

  const own = [];
  const mo = new fx.win.MutationObserver((records) => own.push(...records));
  mo.observe(fx.doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  const target = fx.thread.lastElementChild.firstElementChild;
  const BURST = 300;
  const before = layoutCalls.n;
  for (let i = 0; i < BURST; i++) target.append(fx.doc.createTextNode("tok "));
  await fx.settle();
  // Everything recorded so far is the test's own writes; let the debounced tick and the page features react.
  await flush();
  await fx.settle();
  Doc.querySelector = realQ;
  Doc.querySelectorAll = realQA;
  // Boot itself writes nothing. The rail may refresh the minimap of the growing turn (its visible job), but only there and rarely.
  const outside = own.filter((r) => !(r.type === "childList" && r.target === target) && !r.target.closest?.(".gs-minimap") && !r.target.closest?.(".gs-caption") && !r.target.classList?.contains("gs-caption"));
  assert.deepEqual(outside.map((r) => `${r.type}:${r.target.className || r.target.tagName}`), [], "no script writes outside the minimap");
  assert.equal(health.diagnostics()["boot.restart"], undefined, "streaming never restarts the page features");
  const rebuilds = own.filter((r) => r.target.classList?.contains("gs-bars") && r.removedNodes.length > 0).length;
  assert.ok(rebuilds <= 2, `minimap rebuilds during the burst: ${rebuilds}`);
  assert.ok(layoutCalls.n - before <= 3, `layout checks: ${layoutCalls.n - before}`);
  assert.ok(queries.n < 400, `selector calls during the whole burst: ${queries.n}`);
  mo.disconnect();
});
