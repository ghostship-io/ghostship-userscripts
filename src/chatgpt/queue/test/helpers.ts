import { IDBFactory } from "fake-indexeddb";
import { DispatchBoundary, DryRunDispatcher } from "../dispatch.ts";
import { QueueEngine, type QueueEngineOptions } from "../queue.ts";
import { QueueStore } from "../store.ts";
import type { Clock } from "../types.ts";

export class ManualClock implements Clock {
  t = 1_000_000;
  #timers: { at: number; fn: () => void; live: boolean }[] = [];
  now() {
    return this.t;
  }
  after(ms: number, fn: () => void) {
    const timer = { at: this.t + ms, fn, live: true };
    this.#timers.push(timer);
    return () => {
      timer.live = false;
    };
  }
  advance(ms: number) {
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

export async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await settle(1);
  if (!condition()) throw new Error("condition never became true");
}

export interface Tab {
  engine: QueueEngine;
  store: QueueStore;
}

export class World {
  factory = new IDBFactory();
  clock = new ManualClock();
  dispatcher = new DryRunDispatcher();
  #n = 0;
  /** A new tab/restart: its own store connection and engine over the shared database. */
  async tab(tabId: string, overrides: Partial<QueueEngineOptions> = {}, dispatcher = this.dispatcher): Promise<Tab> {
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
