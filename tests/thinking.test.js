import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createThinkingExpander } from "../src/chatgpt/thinking.js";
import { createDiagnostics } from "../src/core/diagnostics.js";

const box = (top, height = 24) => ({ left: 0, top, width: 200, height, right: 200, bottom: top + height, x: 0, y: top });

/** A conversation of assistant turns, each with one collapsed trace at the given on-screen position. */
function page(traces) {
  const html = traces
    .map((t, i) => `<section data-turn-key="t${i}"><div><button type="button" aria-expanded="false" id="b${i}">${t.label ?? "Worked for 12s"}</button></div></section>`)
    .join("");
  const dom = new JSDOM(
    `<!doctype html><body><div data-scroll-root><div data-thread-find-target="conversation">${html}</div></div><form><div contenteditable="true" role="textbox"></div><button type="button" aria-expanded="false" id="picker">Thinking effort</button><button type="button" aria-expanded="false" id="send2">Thought for the day</button></form></body>`,
    { url: "https://chatgpt.com/c/x", pretendToBeVisual: true },
  );
  const { window } = dom;
  const doc = window.document;
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  doc.querySelector("[data-scroll-root]").getBoundingClientRect = () => box(0, 800);
  const inactive = new Set();
  traces.forEach((t, i) => {
    const b = doc.getElementById(`b${i}`);
    b.getBoundingClientRect = () => box(t.top);
    if (t.inactive) inactive.add(doc.querySelector(`[data-turn-key="t${i}"]`));
    b.addEventListener("click", () => b.setAttribute("aria-expanded", "true"));
  });
  const listeners = { index: new Set(), scroll: new Set() };
  const runtime = {
    isTurnActive: (el) => !inactive.has(el),
    onIndexChange: (fn) => (listeners.index.add(fn), () => listeners.index.delete(fn)),
    scroll: { onScroll: (fn) => (listeners.scroll.add(fn), () => listeners.scroll.delete(fn)) },
  };
  const diagnostics = createDiagnostics({ warn() {} });
  const wait = (ms = 200) => new Promise((r) => window.setTimeout(r, ms));
  const expanded = () => traces.map((_, i) => doc.getElementById(`b${i}`).getAttribute("aria-expanded"));
  return { window, doc, runtime, listeners, diagnostics, wait, expanded };
}

test("a trace in view is expanded; ones above the viewport, below it or in skipped turns are left alone until they scroll into view", async () => {
  const p = page([{ top: -300 }, { top: 100 }, { top: 700 }, { top: 2000 }, { top: 300, inactive: true }]);
  const x = createThinkingExpander({ win: p.window, adapter: chatgptAdapter, runtime: p.runtime, diagnostics: p.diagnostics });
  await p.wait();
  assert.deepEqual(p.expanded(), ["false", "true", "true", "false", "false"]);
  assert.equal(p.diagnostics.snapshot()["thinking.expanded"], 2);
  // Scrolling brings the far one into view: it opens after the scroll settles.
  p.doc.getElementById("b3").getBoundingClientRect = () => box(400);
  p.listeners.scroll.forEach((fn) => fn("user"));
  await p.wait();
  assert.equal(p.expanded()[3], "true");
  // ... and the one above, scrolling up to it.
  p.doc.getElementById("b0").getBoundingClientRect = () => box(50);
  p.listeners.scroll.forEach((fn) => fn("user"));
  await p.wait();
  assert.equal(p.expanded()[0], "true");
  x.dispose();
});

test("a trace the owner collapses again stays collapsed; nothing is pressed twice, and nothing outside a turn is ever pressed", async () => {
  const p = page([{ top: 100 }, { top: 200, label: "Thought for 4s" }, { top: 300, label: "Stopped thinking" }]);
  let clicks = 0;
  p.doc.addEventListener("click", () => clicks++, true);
  const x = createThinkingExpander({ win: p.window, adapter: chatgptAdapter, runtime: p.runtime, diagnostics: p.diagnostics });
  await p.wait();
  assert.equal(clicks, 3, "each of the three traces once");
  p.doc.getElementById("b1").setAttribute("aria-expanded", "false"); // the owner closes it
  p.listeners.index.forEach((fn) => fn());
  p.listeners.scroll.forEach((fn) => fn("user"));
  await p.wait();
  assert.equal(clicks, 3);
  assert.equal(p.expanded()[1], "false");
  assert.equal(p.doc.getElementById("picker").getAttribute("aria-expanded"), "false", "the model picker's Thinking effort is not a trace");
  assert.equal(p.doc.getElementById("send2").getAttribute("aria-expanded"), "false", "nothing in the composer");
  x.dispose();
});

test("only a few traces open per pass, bottom first, and a stopped expander does nothing", async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ top: 20 + i * 60 }));
  const p = page(many);
  const order = [];
  many.forEach((_, i) => p.doc.getElementById(`b${i}`).addEventListener("click", () => order.push(i)));
  const x = createThinkingExpander({ win: p.window, adapter: chatgptAdapter, runtime: p.runtime, diagnostics: p.diagnostics, options: { maxPerPass: 4 } });
  await p.wait(500);
  assert.equal(order.length, 12, "all of them, a few at a time");
  assert.deepEqual(order.slice(0, 4), [11, 10, 9, 8], "bottom first, so none of the measured positions moves");
  x.dispose();
  const q = page([{ top: 100 }]);
  const y = createThinkingExpander({ win: q.window, adapter: chatgptAdapter, runtime: q.runtime });
  y.dispose();
  await q.wait();
  assert.deepEqual(q.expanded(), ["false"]);
  assert.equal(q.listeners.index.size + q.listeners.scroll.size, 0, "unsubscribed");
});
