import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createFixture } from "./virtualization-fixture.js";
import { createRuntime } from "../src/core/runtime.js";
import { DEFAULTS } from "../src/core/config.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createTurnBackend } from "../src/chatgpt/virtualization/backend.js";
import { createRail } from "../src/chatgpt/rail/rail.js";

function mount(fx) {
  const runtime = createRuntime({ win: fx.win, adapter: chatgptAdapter, backend: createTurnBackend(), config: { ...DEFAULTS } });
  const rail = createRail({ win: fx.win, adapter: chatgptAdapter, runtime });
  return { runtime, rail };
}
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });

test("the live header is a plain <header> without #page-header; the button joins the row, beside the outermost wrapper of the last native button", () => {
  const dom = new JSDOM(
    `<!doctype html><body><div data-app-shell-active-page="true"><header id="h"><div class="row"><div class="acts"><button id="more">More</button><button id="share">Share</button></div><div class="wrap1"><div class="wrap2"><span class="contents"><button id="toggle">Toggle</button></span></div></div></div></header></div></body>`,
    { url: "https://chatgpt.com/c/x" },
  );
  const doc = dom.window.document;
  Object.defineProperty(dom.window, "innerWidth", { value: 1600, configurable: true });
  doc.getElementById("h").getBoundingClientRect = () => box(0, 0, 1600, 52);
  for (const [id, left] of [["more", 1400], ["share", 1450], ["toggle", 1556]]) doc.getElementById(id).getBoundingClientRect = () => box(left, 8, 36, 36);
  assert.equal(chatgptAdapter.headerBottom(doc), 52, "found without an id");
  const spot = chatgptAdapter.headerActions(doc);
  assert.equal(spot.before, doc.querySelector(".wrap1"), "beside the wrapper, in the same row, not stacked inside it");
  assert.equal(spot.parent, doc.querySelector(".row"));
  assert.equal(spot.right, 1592);
  // A hidden page's own (zero-sized) header never counts.
  doc.getElementById("h").getBoundingClientRect = () => box(0, 0, 0, 0);
  assert.equal(chatgptAdapter.headerBottom(doc), 0);
  assert.equal(chatgptAdapter.headerActions(doc), null);
});

test("a fixed header spans the window whatever the column's padding: it is never given cancelling margins", () => {
  const dom = new JSDOM(
    `<!doctype html><body><div id="col"><header style="position:fixed"><button>x</button></header><div data-scroll-root><div data-turn-key="t"></div></div><form><div contenteditable="true" role="textbox"></div></form></div></body>`,
    { url: "https://chatgpt.com/c/x" },
  );
  const doc = dom.window.document;
  doc.querySelector("header").getBoundingClientRect = () => box(0, 0, 1600, 52);
  const cols = chatgptAdapter.columns(doc);
  assert.ok(cols.frame);
  assert.equal(cols.header, null);
});

test("a new chat (no scroller, no turns) still gets a column: the widest ancestor of the composer that is not the whole window", () => {
  const dom = new JSDOM(
    `<!doctype html><body><div id="root"><div id="layout"><main id="main"><div id="frame"><div id="wrap"><form id="form"><div contenteditable="true" role="textbox"></div></form></div></div></main></div></div></body>`,
    { url: "https://chatgpt.com/" },
  );
  const doc = dom.window.document;
  Object.defineProperty(dom.window, "innerWidth", { value: 1600, configurable: true });
  const widths = { root: 1600, layout: 1600, main: 1260, frame: 1259, wrap: 1239, form: 768 };
  for (const [id, w] of Object.entries(widths)) doc.getElementById(id).getBoundingClientRect = () => box(1600 - w, 0, w, 800);
  const cols = chatgptAdapter.columns(doc);
  assert.equal(cols.frame, doc.getElementById("main"));
  // An element with no box of its own (display: contents) cannot be padded: the next one down is used.
  doc.getElementById("main").getBoundingClientRect = () => box(0, 0, 0, 0);
  assert.equal(chatgptAdapter.columns(doc).frame, doc.getElementById("frame"));
});

test("any other pane on the right edge is found by what is painted there, not by its title", () => {
  const dom = new JSDOM(
    `<!doctype html><body><div id="page"><div id="conv"><div data-turn-key="t1"><p id="text">hi</p></div></div><aside id="subagents"><div id="inner"><p id="line">Subagents</p></div></aside></div><form><div contenteditable="true" role="textbox"></div></form></body>`,
    { url: "https://chatgpt.com/c/x" },
  );
  const doc = dom.window.document;
  Object.defineProperty(dom.window, "innerWidth", { value: 1600, configurable: true });
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  const rect = { page: box(0, 0, 1600, 800), conv: box(340, 0, 900, 800), subagents: box(1100, 0, 500, 800), inner: box(1110, 10, 480, 300), line: box(1120, 20, 100, 20), text: box(500, 20, 100, 20) };
  for (const [id, r] of Object.entries(rect)) doc.getElementById(id).getBoundingClientRect = () => r;
  doc.elementFromPoint = () => doc.getElementById("line");
  const found = chatgptAdapter.sidePane(doc);
  assert.equal(found.pane, doc.getElementById("subagents"), "the whole pane, not a card inside it");
  assert.equal(found.left, 1100);
  doc.elementFromPoint = () => doc.getElementById("text"); // the conversation itself is never a pane
  assert.equal(chatgptAdapter.sidePane(doc), null);
});

test("self-heal: whatever ChatGPT's re-render removes (the column, the button, the style) is put back, and the page shifts again", async () => {
  const fx = createFixture({ turns: 20, width: 1280, markup: "real", header: true });
  const { rail } = mount(fx);
  await fx.settle();
  const reserved = fx.reserve();
  assert.ok(reserved > 0);
  fx.doc.querySelector(".gs-rail").remove();
  fx.doc.querySelector(".gs-hbtns").remove();
  fx.doc.getElementById("gs-pane-style").remove();
  rail.heal();
  await fx.settle();
  assert.equal(fx.doc.querySelectorAll(".gs-rail").length, 1);
  assert.equal(fx.doc.querySelectorAll(".gs-hbtns").length, 1);
  assert.equal(fx.doc.querySelectorAll("#gs-pane-style").length, 1);
  assert.equal(fx.reserve(), reserved);
  assert.equal(fx.doc.querySelector(".gs-rail").hidden, false);
  assert.equal(fx.doc.querySelectorAll(".gs-panel").length, 2);
  // Nothing missing: nothing is done.
  const writes = [];
  const mo = new fx.win.MutationObserver((r) => writes.push(...r));
  mo.observe(fx.doc.documentElement, { childList: true, subtree: true, attributes: true });
  rail.heal();
  await fx.settle();
  assert.deepEqual(writes, []);
  mo.disconnect();
});

test("a pane that reaches into the header band covers the header button: it floats left of the pane instead", async () => {
  const fx = createFixture({ turns: 20, width: 1700, markup: "real", header: true, pane: { reserves: false } });
  mount(fx);
  await fx.settle();
  const acts = fx.doc.querySelector(".gs-hbtns");
  assert.equal(acts.hasAttribute("data-gs-float"), true, "not under the pane");
  assert.equal(acts.style.getPropertyValue("--gs-float-right"), `${fx.paneWidth() + 8}px`);
  assert.equal(fx.doc.querySelectorAll(".gs-hbtn").length, 1);
  assert.equal(fx.doc.querySelector(".gs-rail").hidden, true, "the pane has the room: our column steps aside");
});

test("a thread with only replies (a scheduled task's runs) lists each reply, so the list and the conversation view are never empty", async () => {
  const dom = new JSDOM(
    `<!doctype html><body><div data-thread-find-target="conversation">${[1, 2, 3]
      .map((n) => `<section data-turn-key="run-${n}"><div data-message-author-role="assistant"><h6>ChatGPT said:</h6><h2>Daily brief ${n}</h2><p>${"Details of the run. ".repeat(80)}</p></div></section>`)
      .join("")}</div></body>`,
    { url: "https://chatgpt.com/c/x" },
  );
  const { buildPromptIndex } = await import("../src/core/prompt-index.js");
  const index = buildPromptIndex(dom.window.document, chatgptAdapter);
  assert.deepEqual(index.map((p) => p.id), ["run-1", "run-2", "run-3"]);
  assert.deepEqual(index.map((p) => p.turnIndex), [0, 1, 2]);
  assert.match(index[0].text, /^Daily brief 1 Details of the run\./);
  assert.ok(index[0].text.length <= 240, "bounded: a long reply is not copied whole");
  assert.ok(index.every((p) => p.automated));
  // As soon as anyone wrote in the thread, only the prompts are listed.
  dom.window.document.querySelector("section").insertAdjacentHTML("afterbegin", '<div data-message-author-role="user">hello</div>');
  assert.deepEqual(buildPromptIndex(dom.window.document, chatgptAdapter).map((p) => p.id), ["run-1"]);
});
