// Shared pieces of the dry-run acceptance gate (`npm run gate`).
// Everything here is local: jsdom fixtures, fake IndexedDB, a manual clock.
// The page guards turn any attempt at real ChatGPT traffic into a recorded
// violation that fails the gate.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { DryRunDispatcher } from "../../src/chatgpt/queue/dispatch.js";
import { World } from "../queue-helpers.js";
import { createFixture } from "../virtualization-fixture.js";

export const BUNDLE_PATH = new URL("../../dist/ghostship-chatgpt.user.js", import.meta.url);
export const SEND = '[data-testid="send-button"]';
export const STOP = '[data-testid="stop-button"]';

const NETWORK_APIS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"];

/**
 * Adds native Send/Stop buttons to the fixture composer and traps everything
 * that could leave the page: clicks on them, form submission, and every
 * network API. `report()` is the evidence the gate asserts is empty.
 */
export function installPageGuards(fx) {
  const { win, doc } = fx;
  const form = doc.getElementById("composer");
  form.insertAdjacentHTML("beforeend", `<button type="submit" data-testid="send-button">Send</button><button type="button" data-testid="stop-button">Stop</button>`);
  const events = { nativeClicks: [], formSubmits: 0, network: [] };

  win.addEventListener(
    "click",
    (event) => {
      const hit = event.target?.closest?.(`${SEND}, ${STOP}`);
      if (hit) events.nativeClicks.push(hit.getAttribute("data-testid"));
    },
    true,
  );
  win.addEventListener("submit", (event) => {
    events.formSubmits++;
    event.preventDefault();
  }, true);
  for (const name of ["submit", "requestSubmit"]) {
    win.HTMLFormElement.prototype[name] = function () {
      events.formSubmits++;
    };
  }

  const trap = (name) =>
    function () {
      events.network.push(name);
      throw new Error(`gate: blocked ${name}`);
    };
  for (const name of NETWORK_APIS) win[name] = trap(name);
  win.navigator.sendBeacon = trap("sendBeacon");

  return {
    /** The recorded evidence; every list must be empty for a passing gate. */
    report: () => ({ nativeClicks: [...events.nativeClicks], formSubmits: events.formSubmits, network: [...events.network] }),
    isClean: () => events.nativeClicks.length === 0 && events.formSubmits === 0 && events.network.length === 0,
    send: () => doc.querySelector(SEND),
    stop: () => doc.querySelector(STOP),
  };
}

/** Runs the built userscript, exactly as a userscript manager would, in the fixture window. */
export function runBundle(fx) {
  const code = readFileSync(BUNDLE_PATH, "utf8");
  new vm.Script(code, { filename: "ghostship-chatgpt.user.js" }).runInContext(fx.dom.getInternalVMContext());
  return fx.win.__ghostshipUserscripts;
}

export const bundleSource = () => readFileSync(BUNDLE_PATH, "utf8");

/**
 * DryRunDispatcher that also records protocol violations as they happen: a
 * submit while the conversation is not idle (the queue must wait, or stop first
 * and only send once the stop took effect).
 */
export class GuardedDispatcher extends DryRunDispatcher {
  violations = [];
  async submit(request) {
    if (this.state !== "idle") this.violations.push(`submit:${request.itemId} while ${this.state}`);
    return super.submit(request);
  }
  submits(itemId) {
    return this.log.filter((e) => e.type === "submit" && (itemId === undefined || e.request.itemId === itemId)).length;
  }
  stops() {
    return this.log.filter((e) => e.type === "stop").length;
  }
}

export function guardedWorld() {
  const world = new World();
  world.dispatcher = new GuardedDispatcher();
  return world;
}

export { createFixture };
