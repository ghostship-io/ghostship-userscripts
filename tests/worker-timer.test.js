// Timers that keep their pace in a hidden tab: a worker carries them only while the page is hidden, and the same calls
// fall back to the window's timers where no worker can run.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerTimers } from "../src/core/worker-timer.js";
import { loadFixture } from "./helpers.js";
import { FakeWorker, setHidden } from "./fake-worker.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a visible page uses its own timers and never starts a worker; a hidden one hands them to the worker", async () => {
  const { window } = await loadFixture();
  let made = 0;
  const worker = new FakeWorker();
  const timers = createWorkerTimers({ win: window, createWorker: () => (made++, worker) });
  let fired = 0;
  timers.once(() => fired++, 5);
  await wait(30);
  assert.equal(fired, 1, "window timer");
  assert.equal(made, 0, "no worker while visible");

  setHidden(window, true);
  timers.once(() => fired++, 1000);
  timers.every(() => fired++, 1000);
  assert.equal(made, 1);
  assert.equal(timers.working, true);
  worker.advance(3000);
  assert.equal(fired, 1 + 1 + 3, "one once and three every, from the worker, none from the window");
  timers.dispose();
});

test("a cancelled timer never fires, and the worker is released shortly after the last timer ends", async () => {
  const { window } = await loadFixture();
  setHidden(window, true);
  const worker = new FakeWorker();
  const timers = createWorkerTimers({ win: window, createWorker: () => worker });
  let fired = 0;
  const cancel = timers.once(() => fired++, 100);
  const stop = timers.every(() => fired++, 100);
  cancel();
  worker.advance(250);
  assert.equal(fired, 2);
  stop();
  assert.equal(worker.active(), 0);
  assert.equal(worker.terminated, false, "kept briefly: a chain of short waits reuses it");
  const lingering = createWorkerTimers({ win: window, createWorker: () => new FakeWorker() });
  lingering.dispose();
  timers.dispose();
  assert.equal(worker.terminated, true);
});

test("where a worker cannot be made (a page policy) or dies, the timers move to the window's own and still fire", async () => {
  const { window } = await loadFixture();
  setHidden(window, true);
  let fired = 0;
  const blocked = createWorkerTimers({ win: window, createWorker: () => { throw new Error("blocked by policy"); } });
  blocked.once(() => fired++, 5);
  await wait(30);
  assert.equal(fired, 1);
  assert.equal(blocked.working, false);

  const worker = new FakeWorker();
  const dying = createWorkerTimers({ win: window, createWorker: () => worker });
  dying.once(() => fired++, 5);
  assert.equal(dying.working, true);
  worker.onerror({});
  assert.equal(dying.working, false);
  await wait(30);
  assert.equal(fired, 2, "re-armed on the window after the worker failed");
  blocked.dispose();
  dying.dispose();
});
