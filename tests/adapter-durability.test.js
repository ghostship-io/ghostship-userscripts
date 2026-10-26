// Hook durability: the adapter's hooks must survive routine changes to parts of the site they do not hook (class
// names, test ids, ids, wrapper divs, extra buttons, banners and forms, sibling order, the turn marker), and must
// not lean on position. Every hook is listed in HOOKS with its anchor and fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { chatgptAdapter, HOOKS } from "../src/chatgpt/adapter.js";

const PAGE = (turns, streaming) => `
<nav aria-label="Chat history" class="side"><a class="row" href="/c/aaa-111"><span class="t" data-thread-title>One</span></a><a class="row" href="/c/bbb-222"><span class="t" data-thread-title>Two</span></a></nav>
<div class="page" data-app-shell-active-page="true">
  <button class="profile" data-testid="accounts-profile-button">Jane Doe</button>
  <header class="hdr" data-box="0,0,1200,56"><div class="tt">Title</div><div class="acts"><button class="b" aria-label="More" data-probe="more" data-box="1060,8,40,40">M</button><button class="b" aria-label="Share" data-probe="share" data-box="1110,8,80,40">Share</button></div></header>
  <div class="scroll" data-scroll-root data-probe="scroller" style="overflow-y:auto" data-client="600" data-scroll="2000">
    <div class="thread" data-thread-find-target="conversation" data-probe="root">
      <div class="w">${turns("t1", "user", "turn1", "")}</div>
      <div class="w">${turns("t2", "assistant", "turn2", '<button aria-expanded="false" data-probe="think">Thought for 5s</button><button aria-expanded="false" data-probe="not-think">Model: Thinking effort</button>')}</div>
    </div>
  </div>
  <div class="composer-wrap" data-map-composer-conversation="conv-1">
    <form class="cf" data-chatgpt-composer data-probe="form">
      <div class="ed" id="prompt-textarea" contenteditable="true" role="textbox" data-probe="input"></div>
      <button class="send" type="submit" aria-label="Send prompt" data-testid="send-button" data-probe="send"></button>
      ${streaming ? '<button class="stop" type="button" aria-label="Stop streaming" data-testid="stop-button" data-probe="stop"></button>' : ""}
    </form>
  </div>
</div>`;
const turnEl = (key, role, probe, extra) => `<section class="turn" data-turn-key="${key}" data-probe="${probe}"><div class="m" data-message-author-role="${role}">text</div>${extra}</section>`;

function build(streaming = false) {
  const dom = new JSDOM(`<!doctype html><body>${PAGE(turnEl, streaming)}</body>`, { url: "https://chatgpt.com/c/aaa-111", pretendToBeVisual: false });
  const { window } = dom;
  window.innerWidth = 1600;
  window.innerHeight = 800;
  window.Element.prototype.getBoundingClientRect = function () {
    const [left, top, width, height] = (this.getAttribute?.("data-box") ?? "0,0,0,0").split(",").map(Number);
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  };
  for (const [prop, attr] of [["clientHeight", "data-client"], ["scrollHeight", "data-scroll"]]) Object.defineProperty(window.Element.prototype, prop, { configurable: true, get() { return Number(this.getAttribute?.(attr) ?? 0); } });
  return window;
}

const probe = (el) => el?.closest?.("[data-probe]")?.getAttribute("data-probe") ?? (el ? "?" : null);
/** What every hook finds, in terms of the probe names baked into the page (so the result is comparable across changes). */
function observe(win) {
  const doc = win.document;
  const a = chatgptAdapter;
  const turns = a.turns(doc);
  const actions = a.headerActions(doc);
  return {
    composerInput: probe(a.composerInput(doc)),
    composer: probe(a.composer(doc)),
    send: probe(a.sendButton(doc)),
    stop: probe(a.stopButton(doc)),
    steer: probe(a.steerButton(doc)),
    generating: a.generating(doc),
    turns: turns.map((t) => probe(t)),
    roles: turns.map((t) => a.role(t)),
    userTurns: a.userTurnCount(doc),
    user: probe(a.userMessage(turns[0])),
    turnRoot: probe(a.turnRoot(doc)),
    scroller: probe(a.scroller(doc)),
    links: a.sidebarLinks(doc).map((l) => l.id).sort(),
    conversation: a.pageConversationId(doc),
    route: a.conversationId(win),
    thinking: a.thinkingToggles(doc).map((t) => probe(t.button)),
    headerButton: actions && { right: actions.right, wraps: !!actions.before.querySelector?.('[data-probe="share"]') || probe(actions.before) === "share" },
    loadError: a.loadError(doc),
    self: a.selfCheck(doc),
    account: a.accountId(doc),
  };
}

const all = (doc, sel) => [...doc.querySelectorAll(sel)];
const wrap = (el, times, doc) => {
  for (let i = 0; i < times; i++) {
    const w = doc.createElement("div");
    el.replaceWith(w);
    w.append(el);
  }
};
/** Routine changes to parts of the page the hooks do not anchor on. Each returns what must differ from the baseline. */
const CHANGES = {
  "every class renamed": { run: (d) => all(d, "[class]").forEach((e, i) => e.setAttribute("class", `x${i} css-${i * 7}`)) },
  "every id removed": { run: (d) => all(d, "[id]").forEach((e) => e.removeAttribute("id")) },
  "every test id removed (profile hash then falls back to unknown)": {
    run: (d) => all(d, "[data-testid]").forEach((e) => e.removeAttribute("data-testid")),
    differs: { account: "unknown" },
  },
  "extra wrapper divs around the composer, header, thread and nav": {
    run: (d) => {
      for (const sel of ["form", "header", ".thread", "nav", ".acts", ".composer-wrap"]) all(d, sel).forEach((e) => wrap(e, 3, d));
    },
  },
  "unrelated banner, buttons, forms and links added around the hooks": {
    run: (d) => {
      const page = d.querySelector(".page");
      page.insertAdjacentHTML("afterbegin", '<div role="alert"><button aria-label="Stop sharing">x</button><button type="submit" aria-label="Send feedback">f</button><a href="/c/zzz-999">promo</a></div>');
      page.insertAdjacentHTML("afterbegin", '<form><textarea aria-label="Feedback"></textarea><button type="submit" aria-label="Send">s</button><button type="button" aria-label="Stop recording">r</button></form>');
      d.querySelector("header").insertAdjacentHTML("afterbegin", '<button aria-label="Upgrade" data-box="400,8,80,40">u</button>');
      d.querySelector(".acts").insertAdjacentHTML("afterbegin", '<button aria-label="Notifications" data-box="1000,8,40,40">n</button>');
      d.querySelector(".composer-wrap").insertAdjacentHTML("afterbegin", '<div><button aria-label="Attach">+</button><button aria-label="Voice">v</button></div>');
      d.querySelector("form").insertAdjacentHTML("afterbegin", '<button type="button" aria-label="Dictate">d</button>');
    },
    differs: { links: ["aaa-111", "bbb-222"] }, // the promo link is outside the navigation landmark and must not count
  },
  "siblings reordered": {
    run: (d) => {
      const nav = d.querySelector("nav");
      [...nav.children].reverse().forEach((c) => nav.append(c));
      const form = d.querySelector("form");
      [...form.children].reverse().forEach((c) => form.append(c));
      const acts = d.querySelector(".acts");
      [...acts.children].reverse().forEach((c) => acts.append(c));
    },
  },
  "turn marker, scroll-root marker and composer markers all gone (semantic fallbacks)": {
    run: (d) => {
      all(d, "[data-turn-key]").forEach((t) => {
        const article = d.createElement("article");
        article.setAttribute("data-probe", t.getAttribute("data-probe"));
        article.append(...t.childNodes);
        t.replaceWith(article);
      });
      all(d, "[data-scroll-root], [data-thread-find-target], [data-chatgpt-composer], [data-testid], [id]").forEach((e) => {
        for (const attr of ["data-scroll-root", "data-thread-find-target", "data-chatgpt-composer", "data-testid", "id"]) e.removeAttribute(attr);
      });
    },
    differs: { account: "unknown" },
  },
};

for (const streaming of [false, true]) {
  const base = observe(build(streaming));
  test(`baseline page (${streaming ? "streaming" : "idle"}): every hook finds what it hooks`, () => {
    assert.deepEqual({ ...base, loadError: undefined, headerButton: undefined, account: undefined }, {
      composerInput: "input", composer: "form", send: "send", stop: streaming ? "stop" : null, steer: null, generating: streaming,
      turns: ["turn1", "turn2"], roles: ["user", "assistant"], userTurns: 1, user: "turn1", turnRoot: "root", scroller: "scroller",
      links: ["aaa-111", "bbb-222"], conversation: "conv-1", route: "aaa-111", thinking: ["think"], loadError: undefined, headerButton: undefined,
      self: { ok: true, hasTurns: true, missing: [] }, account: undefined,
    });
    assert.match(base.account, /^acct-/);
    assert.equal(base.headerButton.wraps, true, "the header buttons go beside the right-most native header button");
  });
  for (const [name, change] of Object.entries(CHANGES)) {
    test(`unrelated change keeps every hook working (${streaming ? "streaming" : "idle"}): ${name}`, () => {
      const win = build(streaming);
      change.run(win.document);
      assert.deepEqual(observe(win), { ...base, ...(change.differs ?? {}) });
    });
  }
}

test("the harness has teeth: a hook anchored on position or a class is caught by the same changes", () => {
  const fragile = (doc) => doc.querySelector(".page > .composer-wrap > form > .ed") ?? null;
  const classy = (doc) => doc.querySelector(".send");
  const caught = [];
  for (const [name, change] of Object.entries(CHANGES)) {
    const win = build(false);
    const before = [probe(fragile(win.document)), probe(classy(win.document))];
    change.run(win.document);
    const after = [probe(fragile(win.document)), probe(classy(win.document))];
    if (before.join() !== after.join()) caught.push(name);
  }
  assert.ok(caught.includes("every class renamed") && caught.includes("extra wrapper divs around the composer, header, thread and nav"), `the class and position hooks should break, broke under: ${caught.join("; ")}`);
});

test("the adapter lists every hook with an anchor and a fallback, and nothing else", () => {
  const methods = Object.keys(chatgptAdapter).sort();
  assert.deepEqual(Object.keys(HOOKS).sort(), methods);
  for (const [name, hook] of Object.entries(HOOKS)) {
    assert.ok(hook.anchor && hook.fallback, `${name} needs an anchor and a fallback`);
  }
});

test("no selector in the adapter leans on position, depth or a class name", () => {
  const source = readFileSync(new URL("../src/chatgpt/adapter.js", import.meta.url), "utf8");
  const selectors = [...source.matchAll(/^const [A-Z_]+ = (['"`])(.+)\1;/gm)].map((m) => m[2]);
  selectors.push(...[...source.matchAll(/(?:querySelector(?:All)?|closest|matches)\((['"`])([^'"`$]+)\1\)/g)].map((m) => m[2]));
  const listed = [...source.matchAll(/^const COMPOSERS = \[(.+)\];/gm)].flatMap((m) => [...m[1].matchAll(/(['"])(.+?)\1(?:, |$)/g)].map((x) => x[2]));
  selectors.push(...listed);
  assert.ok(selectors.length > 25, `found ${selectors.length} selectors`);
  // The one class-based signal is a streaming marker, only ever one of several (STOP / STEER / this).
  const CLASS_ALLOWED = new Set([".result-streaming"]);
  for (const sel of selectors) {
    assert.doesNotMatch(sel, /:(nth|first|last|only)-(child|of-type)/, `positional selector: ${sel}`);
    assert.doesNotMatch(sel, /[\])\w"'*]\s*>\s*[\[.#\w*]/, `child combinator (depth) in: ${sel}`);
    for (const cls of sel.match(/(?<![\w\]="'-])\.[a-zA-Z_][\w-]*/g) ?? []) assert.ok(CLASS_ALLOWED.has(cls), `class selector ${cls} in: ${sel}`);
    assert.doesNotMatch(sel, /\.(css|_|sc-|jsx-)[\w-]*\d|\.[a-z]+-[0-9a-f]{5,}/i, `generated class name in: ${sel}`);
  }
});
