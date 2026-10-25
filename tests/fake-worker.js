// A stand-in for the Blob worker behind `createWorkerTimers`: a virtual clock the test advances by hand. Window timers
// can be frozen separately (`freezeWindowTimers`) to model a hidden tab whose own timers are throttled to nothing.

export class FakeWorker {
  now = 0;
  terminated = false;
  #timers = new Map();
  onmessage = null;
  onerror = null;

  postMessage(m) {
    if (m.op === "clear") this.#timers.delete(m.id);
    else this.#timers.set(m.id, { at: this.now + m.ms, every: m.op === "every" ? m.ms : null });
  }

  terminate() {
    this.terminated = true;
    this.#timers.clear();
  }

  active() {
    return this.#timers.size;
  }

  /** Moves the virtual clock forward, delivering every timer that comes due, in order. */
  advance(ms) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.#timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.at;
      if (timer.every) timer.at += timer.every;
      else this.#timers.delete(id);
      this.onmessage?.({ data: id });
    }
    this.now = end;
  }
}

/** Replaces the window's own timers by ones that never fire (a hidden tab that is throttled for good); returns the call log. */
export function freezeWindowTimers(win) {
  const calls = [];
  win.setTimeout = (fn, ms) => (calls.push(["setTimeout", ms]), 0);
  win.setInterval = (fn, ms) => (calls.push(["setInterval", ms]), 0);
  win.clearTimeout = () => undefined;
  win.clearInterval = () => undefined;
  return calls;
}

export function setHidden(win, hidden) {
  Object.defineProperty(win.document, "hidden", { configurable: true, get: () => hidden });
  win.document.dispatchEvent(new win.Event("visibilitychange"));
}
