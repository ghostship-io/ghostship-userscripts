import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

export async function loadFixture(name = "chatgpt-thread.html") {
  const html = await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return new JSDOM(html, { url: "https://chatgpt.com/c/fixture", pretendToBeVisual: true });
}

export const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/** Manual timers so the debounce and the give-up cap are deterministic. */
export function manualTimers() {
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

