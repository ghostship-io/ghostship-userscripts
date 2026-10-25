import test from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./virtualization-fixture.js";
import { createRuntime } from "../src/core/runtime.js";
import { DEFAULTS } from "../src/core/config.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createTurnBackend } from "../src/chatgpt/virtualization/backend.js";
import { createRail } from "../src/chatgpt/rail/rail.js";

// The structure of chatgpt.com as read from a live page (attributes only, no content): one
// [data-turn-key] element per complete turn, each in its own wrapper, a [data-user-message-bubble] and a
// [data-conversation-role] reply inside it, a contenteditable composer in a [data-chatgpt-composer] form,
// and [data-app-action-timeline-scroll] as the scroller.

test("the adapter recognises the current chatgpt.com structure", () => {
  const fx = createFixture({ turns: 6, markup: "real", width: 1600 });
  const check = chatgptAdapter.selfCheck(fx.doc);
  assert.deepEqual(check, { ok: true, hasTurns: true, missing: [] });
  assert.equal(chatgptAdapter.turns(fx.doc).length, 6);
  assert.equal(chatgptAdapter.scroller(fx.doc), fx.scroller);
  assert.equal(chatgptAdapter.turnRoot(fx.doc), fx.thread);
  assert.equal(chatgptAdapter.composer(fx.doc), fx.doc.getElementById("composer"));
  const turn = chatgptAdapter.turns(fx.doc)[0];
  assert.equal(chatgptAdapter.role(turn), "user");
  assert.match(chatgptAdapter.userMessage(turn).textContent, /^Prompt 0 about/);
  assert.match(chatgptAdapter.turnId(turn, 0), /^bbb2/);
});

test("virtualization, prompt list and navigation work on turns that live in separate wrappers", async () => {
  const fx = createFixture({ turns: 30, markup: "real", width: 1600 });
  const runtime = createRuntime({ win: fx.win, adapter: chatgptAdapter, backend: createTurnBackend(), config: { ...DEFAULTS } });
  createRail({ win: fx.win, adapter: chatgptAdapter, runtime });
  await fx.settle();
  assert.equal(runtime.mode, "active");
  const turns = chatgptAdapter.turns(fx.doc);
  const active = turns.filter((t) => t.getAttribute("data-gs-state") === "active").length;
  assert.equal(active, DEFAULTS.windowTurns, "latest 10 turns rendered");
  assert.equal(turns.filter((t) => t.getAttribute("data-gs-state") === "inactive").length, 20);
  assert.equal(fx.doc.querySelectorAll(".gs-prompt").length, 30);

  // Streaming into the newest turn leaves the viewport alone.
  const top = fx.rawTop();
  const events = fx.scrollEvents.length;
  for (let i = 0; i < 15; i++) {
    const last = fx.thread.lastElementChild.firstElementChild;
    last.lastElementChild.append(fx.doc.createTextNode("token "));
    last.__h += 20;
    fx.pageAutoscroll();
    await fx.settle();
  }
  assert.equal(fx.rawTop(), top);
  assert.equal(fx.scrollEvents.length, events);
  assert.equal(runtime.scroll.stats.unexpected, 0);

  // Selecting the oldest prompt wakes the skipped turn and scrolls to it.
  fx.doc.querySelector(".gs-prompt").click();
  await fx.settle();
  assert.equal(fx.rawTop(), 0);
  assert.equal(turns[0].getAttribute("data-gs-state"), "active");

  // A new turn appended in its own wrapper is picked up.
  fx.addTurn();
  await fx.settle();
  assert.equal(fx.doc.querySelectorAll(".gs-prompt").length, 31);
  assert.equal(runtime.mode, "active");
});
