// Timers that keep their pace while the tab is hidden. Chrome throttles window timers in a background tab (about one
// per second, about one per minute after five minutes hidden); a dedicated worker's timers are not throttled, and its
// message to the page still arrives. The worker is a Blob made of a few lines (no network, no page data goes in), is
// only used while the page is hidden, and is released shortly after the last timer ends. Where a page policy blocks
// the worker, or none exists (tests), the same calls fall back to the window's own timers.

const SOURCE = `
const live = new Map();
onmessage = (e) => {
  const m = e.data;
  if (m.op === "clear") {
    clearTimeout(live.get(m.id));
    live.delete(m.id);
  } else if (m.op === "once") {
    live.set(m.id, setTimeout(() => { live.delete(m.id); postMessage(m.id); }, m.ms));
  } else if (m.op === "every") {
    live.set(m.id, setInterval(() => postMessage(m.id), m.ms));
  }
};`;

const IDLE_RELEASE_MS = 2000;

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {(source: string) => Worker|null} [o.createWorker] defaults to a Blob worker; null or a throw means unavailable
 */
export function createWorkerTimers({ win, createWorker = blobWorker(win) }) {
  const doc = win.document;
  const entries = new Map(); // id -> { fn, ms, repeat, handle }
  let worker = null;
  let broken = false;
  let releaseTimer = null;
  let nextId = 0;

  const open = () => {
    if (worker || broken || !doc.hidden) return worker;
    try {
      worker = createWorker(SOURCE);
      if (!worker) throw new Error("no worker");
      worker.onmessage = (event) => {
        const entry = entries.get(event.data);
        if (!entry) return;
        if (!entry.repeat) entries.delete(event.data);
        entry.fn();
      };
      worker.onerror = () => fail();
    } catch {
      broken = true; // the caller arms its timer on the window
      close();
    }
    return worker;
  };

  const close = () => {
    worker?.terminate?.();
    worker = null;
  };

  // The worker cannot run here: every timer that was waiting on it moves to the window's own timers.
  function fail() {
    broken = true;
    close();
    for (const [id, entry] of entries) if (entry.handle === null) arm(id, entry, false);
  }

  function arm(id, entry, allowWorker) {
    const w = allowWorker ? open() : null;
    if (w) {
      entry.handle = null;
      w.postMessage({ op: entry.repeat ? "every" : "once", id, ms: entry.ms });
    } else if (entry.repeat) {
      entry.handle = win.setInterval(entry.fn, entry.ms);
    } else {
      entry.handle = win.setTimeout(() => {
        entries.delete(id);
        entry.fn();
      }, entry.ms);
    }
  }

  function add(fn, ms, repeat) {
    win.clearTimeout(releaseTimer);
    releaseTimer = null;
    const id = ++nextId;
    const entry = { fn, ms, repeat, handle: null };
    entries.set(id, entry);
    arm(id, entry, true);
    return () => {
      if (!entries.delete(id)) return;
      if (entry.handle !== null) (repeat ? win.clearInterval : win.clearTimeout).call(win, entry.handle);
      else worker?.postMessage({ op: "clear", id });
      if (!entries.size && worker && !releaseTimer) {
        releaseTimer = win.setTimeout(() => {
          releaseTimer = null;
          if (!entries.size) close();
        }, IDLE_RELEASE_MS);
      }
    };
  }

  return {
    /** Runs `fn` once after `ms`; returns the cancel function. */
    once: (fn, ms) => add(fn, ms, false),
    /** Runs `fn` every `ms` until cancelled. */
    every: (fn, ms) => add(fn, ms, true),
    /** True while a worker is carrying timers. */
    get working() {
      return worker !== null;
    },
    dispose() {
      for (const [, entry] of entries) {
        if (entry.handle !== null) (entry.repeat ? win.clearInterval : win.clearTimeout).call(win, entry.handle);
      }
      entries.clear();
      win.clearTimeout(releaseTimer);
      close();
    },
  };
}

function blobWorker(win) {
  return (source) => {
    if (typeof win.Worker !== "function" || typeof win.Blob !== "function" || typeof win.URL?.createObjectURL !== "function") return null;
    const url = win.URL.createObjectURL(new win.Blob([source], { type: "text/javascript" }));
    let made;
    try {
      made = new win.Worker(url);
    } catch (error) {
      win.URL.revokeObjectURL(url);
      throw error;
    }
    const terminate = made.terminate.bind(made);
    made.terminate = () => {
      terminate();
      win.URL.revokeObjectURL(url);
    };
    return made;
  };
}
