import { IDBFactory } from "fake-indexeddb";
import { DispatchBoundary, DryRunDispatcher } from "../src/chatgpt/queue/dispatch.js";
import { QueueEngine } from "../src/chatgpt/queue/queue.js";
import { QueueStore } from "../src/chatgpt/queue/store.js";

export class ManualClock {
  t = 1_000_000;
  #timers = [];
  now() {
    return this.t;
  }
  after(ms, fn) {
    const timer = { at: this.t + ms, fn, live: true };
    this.#timers.push(timer);
    return () => {
      timer.live = false;
    };
  }
  advance(ms) {
    this.t += ms;
    for (const timer of this.#timers.filter((x) => x.live && x.at <= this.t)) {
      timer.live = false;
      timer.fn();
    }
  }
}

/** Let queued IndexedDB callbacks and promise chains run. */
export async function settle(times = 20) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

export async function until(condition) {
  for (let i = 0; i < 200 && !condition(); i++) await settle(1);
  if (!condition()) throw new Error("condition never became true");
}

export class World {
  factory = new IDBFactory();
  clock = new ManualClock();
  dispatcher = new DryRunDispatcher();
  #n = 0;
  /** A new tab/restart: its own store connection and engine over the shared database. */
  async tab(tabId, overrides = {}, dispatcher = this.dispatcher) {
    const store = await QueueStore.open(this.factory);
    const engine = new QueueEngine({
      store,
      dispatch: new DispatchBoundary(dispatcher, { clock: this.clock, submitTimeoutMs: 10_000, stopTimeoutMs: 10_000 }),
      clock: this.clock,
      tabId,
      newId: () => `${tabId}-id${++this.#n}`,
      ...overrides,
    });
    return { engine, store };
  }
}

export const CONV = "conv-1";
