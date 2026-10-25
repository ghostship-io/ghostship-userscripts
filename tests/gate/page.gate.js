// Gate (a), page level: the built userscript, run against fixtures, must not
// click native Send/Stop, submit, touch the network or move the viewport on its own.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bundleSource, createFixture, installPageGuards, runBundle } from "./harness.js";

const boot = async (options = {}) => {
  const fx = createFixture({ turns: 40, ...options });
  const guards = installPageGuards(fx);
  const health = runBundle(fx);
  await fx.settle();
  return { fx, guards, health };
};

test("canary: the page guards really detect a native Send click, a stop click and every network API", () => {
  const fx = createFixture({ turns: 4 });
  const guards = installPageGuards(fx);
  guards.send().click();
  guards.stop().click();
  fx.doc.getElementById("composer").requestSubmit();
  assert.throws(() => fx.win.fetch("/backend-api/conversation"), /blocked fetch/);
  assert.throws(() => new fx.win.XMLHttpRequest(), /blocked XMLHttpRequest/);
  assert.throws(() => new fx.win.WebSocket("wss://example.invalid"), /blocked WebSocket/);
  assert.throws(() => fx.win.navigator.sendBeacon("/x"), /blocked sendBeacon/);
  assert.deepEqual(guards.report(), {
    nativeClicks: ["send-button", "stop-button"],
    formSubmits: 2, // the Send click submits the form, then requestSubmit()
    network: ["fetch", "XMLHttpRequest", "WebSocket", "sendBeacon"],
  });
  assert.equal(guards.isClean(), false);
});

test("bundle: no network, form-submit or synthetic-event primitive; the only clicks are the live dispatcher's Send and Stop, the recovery's Try again and a thinking trace's own disclosure button", () => {
  const code = bundleSource().replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|GM_xmlhttpRequest|requestSubmit)\b|dispatchEvent\(\s*new (Mouse|Pointer)Event|\.submit\(\)/);
  assert.equal(code.match(/\.click\(\)/g)?.length, 4, "exactly four click sites: Send and Stop in the live dispatcher, Try again in the recovery, the disclosure button in the thinking expander");
});

test("boot: activates on a long thread without any traffic, click or scroll", async () => {
  const { fx, guards, health } = await boot();
  assert.equal(health.mode, "active");
  assert.equal(health.version, JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8")).scripts[0].version, "the running build reports the manifest version");
  assert.deepEqual(guards.report(), { nativeClicks: [], formSubmits: 0, network: [] });
  assert.equal(fx.scrollEvents.length, 0);
});

test("streaming while reading the bottom and an older turn: no scroll movement, no traffic", async () => {
  const { fx, guards } = await boot();
  const bottom = fx.rawTop();
  const eventsAtStart = fx.scrollEvents.length;
  for (let i = 0; i < 30; i++) {
    fx.stream(fx.thread.lastElementChild, 20);
    fx.pageAutoscroll();
    if (i % 10 === 9) fx.addTurn();
    await fx.settle();
  }
  assert.equal(fx.rawTop(), bottom, "page autoscroll at the bottom is blocked");
  assert.equal(fx.scrollEvents.length, eventsAtStart);

  fx.wheel(-4000);
  await fx.settle();
  const anchor = fx.anchor();
  const events = fx.scrollEvents.length;
  for (let i = 0; i < 20; i++) {
    fx.stream(fx.thread.lastElementChild, 25);
    fx.pageAutoscroll();
    await fx.settle();
  }
  assert.deepEqual(fx.anchor(), anchor, "the reading position keeps its exact pixel offset");
  assert.equal(fx.scrollEvents.length, events);
  assert.equal(guards.isClean(), true, JSON.stringify(guards.report()));
});

test("React remount of every turn, new turns and composer typing: still no scroll, click or traffic", async () => {
  const { fx, guards } = await boot();
  fx.wheel(-2500);
  await fx.settle();
  const anchor = fx.anchor();
  const events = fx.scrollEvents.length;
  fx.remount();
  await fx.settle();
  fx.addTurn();
  fx.doc.getElementById("prompt-textarea").value = "draft that must stay a draft";
  fx.doc.getElementById("prompt-textarea").dispatchEvent(new fx.win.Event("input", { bubbles: true }));
  await fx.settle();
  assert.deepEqual(fx.anchor(), anchor);
  assert.equal(fx.scrollEvents.length, events);
  assert.equal(fx.doc.getElementById("prompt-textarea").value, "draft that must stay a draft");
  assert.equal(guards.isClean(), true, JSON.stringify(guards.report()));
});

test("broken ChatGPT markup (turns without roles): the script fails closed (safe mode), leaves the page untouched and sends nothing", async () => {
  const fx = createFixture({ turns: 12 });
  fx.elements().forEach((e) => (e.innerHTML = "<div>unrecognised</div>"));
  const guards = installPageGuards(fx);
  const before = fx.doc.documentElement.outerHTML;
  const health = runBundle(fx);
  await fx.settle();
  assert.equal(health.mode, "safe");
  assert.equal(fx.doc.documentElement.outerHTML, before);
  fx.scroller.scrollTop = 100;
  assert.equal(fx.rawTop(), 100, "native scrolling is not intercepted");
  assert.equal(guards.isClean(), true, JSON.stringify(guards.report()));
});

test("no recognisable turns (a new chat or changed turn markup): composer-only, conversation and scrolling untouched, nothing sent", async () => {
  const fx = createFixture({ turns: 12, markup: "no-role" });
  const guards = installPageGuards(fx);
  const turnsBefore = fx.thread.outerHTML;
  const health = runBundle(fx);
  await fx.settle();
  assert.equal(health.mode, "composer-only");
  assert.equal(JSON.stringify(health.missing), JSON.stringify(["turns"]));
  assert.equal(fx.thread.outerHTML, turnsBefore, "the conversation is not modified");
  fx.scroller.scrollTop = 100;
  assert.equal(fx.rawTop(), 100, "native scrolling is not intercepted");
  assert.equal(guards.isClean(), true, JSON.stringify(guards.report()));
});

test("thinking traces: the built script opens a collapsed trace that is in view, once, and presses nothing else", async () => {
  const fx = createFixture({ turns: 40, markup: "real" });
  const guards = installPageGuards(fx);
  const turn = fx.elements().at(-1).firstElementChild;
  turn.insertAdjacentHTML("afterbegin", '<div><button type="button" aria-expanded="false" id="trace">Worked for 12s</button></div>');
  const trace = fx.doc.getElementById("trace");
  trace.getBoundingClientRect = () => ({ top: 100, bottom: 124, left: 0, right: 200, width: 200, height: 24, x: 0, y: 100 });
  let presses = 0;
  trace.addEventListener("click", () => {
    presses++;
    trace.setAttribute("aria-expanded", "true");
  });
  const picker = fx.doc.getElementById("composer").appendChild(Object.assign(fx.doc.createElement("button"), { id: "picker", type: "button", textContent: "Thinking effort" }));
  picker.setAttribute("aria-expanded", "false");
  let pickerPresses = 0;
  picker.addEventListener("click", () => pickerPresses++);
  runBundle(fx);
  await fx.settle();
  await new Promise((resolve) => setTimeout(resolve, 400));
  await fx.settle();
  assert.equal(presses, 1, "the trace in view is opened once");
  assert.equal(trace.getAttribute("aria-expanded"), "true");
  assert.equal(pickerPresses, 0, "nothing in the composer is pressed");
  assert.equal(guards.isClean(), true, JSON.stringify(guards.report()));
});
