import test from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./virtualization-fixture.js";
import { createRuntime } from "../src/core/runtime.js";
import { DEFAULTS } from "../src/core/config.js";
import { chatgptAdapter } from "../src/chatgpt/adapter.js";
import { createTurnBackend } from "../src/chatgpt/virtualization/backend.js";
import { createRail } from "../src/chatgpt/rail/rail.js";
import { silhouette } from "../src/chatgpt/rail/minimap-model.js";

const box = (kind, top, bottom, left = 0, right = 100) => ({ kind, top, bottom, left, right });

test("silhouette: items are the real boxes as fractions of the turn, nothing invented", () => {
  const items = silhouette(
    [box("prompt", 0, 100, 60, 100), box("text", 120, 220, 0, 100), box("code", 240, 540, 0, 100), box("table", 560, 760, 10, 90), box("image", 780, 980, 20, 60)],
    { top: 0, bottom: 1000 },
  );
  assert.deepEqual(items.map((i) => i.kind), ["prompt", "text", "code", "table", "image"]);
  assert.deepEqual(items.map((i) => [i.top, i.height]), [[0, 0.1], [0.12, 0.1], [0.24, 0.3], [0.56, 0.2], [0.78, 0.2]]);
  assert.deepEqual([items[0].left, items[0].width], [0.6, 0.4], "the prompt bubble keeps its place on the right");
  assert.deepEqual([items[3].left, items[3].width], [0.1, 0.8]);
  assert.deepEqual([items[4].left, items[4].width], [0.2, 0.4]);
  assert.deepEqual(silhouette([], { top: 0, bottom: 10 }), []);
  assert.deepEqual(silhouette([box("text", 5, 5)], { top: 0, bottom: 10 }), [], "boxes without area are not drawn");
});

test("silhouette: bounded, keeps structure when neighbours merge, stays ordered and inside the turn", () => {
  const many = Array.from({ length: 1000 }, (_, i) => box(i === 500 ? "code" : "text", i * 10, i * 10 + 8));
  const items = silhouette(many, { top: 0, bottom: 10000 }, 120);
  assert.ok(items.length <= 120);
  assert.ok(items.some((i) => i.kind === "code"), "a code block survives merging");
  assert.ok(items.every((i, n) => i.top >= 0 && i.top + i.height <= 1 + 1e-9 && (n === 0 || i.top >= items[n - 1].top)));
});

function mount(fx) {
  const runtime = createRuntime({ win: fx.win, adapter: chatgptAdapter, backend: createTurnBackend(), config: { ...DEFAULTS } });
  const rail = createRail({ win: fx.win, adapter: chatgptAdapter, runtime });
  return { runtime, rail };
}

/** Give turn `index` real block geometry: the prompt bubble on the right, then the reply's blocks stacked. */
function lay(fx, index) {
  const turn = chatgptAdapter.turns(fx.doc)[index];
  turn.querySelector("[data-conversation-role]").insertAdjacentHTML("beforeend", '<img alt="chart" src="x.png">');
  const plan = [];
  let y = 90;
  const place = (el, kind, h, left = 0, width = 1) => {
    plan.push({ kind, y, h, left, width });
    const rel = { y, h, left, width };
    el.getBoundingClientRect = () => {
      const t = turn.getBoundingClientRect();
      const w = t.width;
      return { top: t.top + rel.y, bottom: t.top + rel.y + rel.h, height: rel.h, left: t.left + rel.left * w, right: t.left + (rel.left + rel.width) * w, width: rel.width * w };
    };
    y += h + 10;
  };
  const bubble = turn.querySelector("[data-user-message-bubble]");
  const bubbleRel = { y: 0, h: 60, left: 0.6, width: 0.4 };
  bubble.getBoundingClientRect = () => {
    const t = turn.getBoundingClientRect();
    return { top: t.top, bottom: t.top + 60, height: 60, left: t.left + 0.6 * t.width, right: t.right, width: 0.4 * t.width };
  };
  const reply = turn.querySelector("[data-conversation-role]");
  place(reply.querySelector("p"), "text", 120);
  place(reply.querySelector("h2"), "heading", 30, 0, 0.5);
  place(reply.querySelector("pre"), "code", 400);
  place(reply.querySelector("table"), "table", 300, 0.1, 0.8);
  place(reply.querySelector("img"), "image", 200, 0.2, 0.4);
  return { turn, plan, bubbleRel };
}

test("the minimap is a silhouette of the turn's real layout: prompt, lines, code band, table and image boxes at their measured places", async () => {
  const fx = createFixture({ turns: 20, width: 1600, markup: "real" });
  const { rail } = mount(fx);
  await fx.settle();
  const geo = lay(fx, 3);
  fx.doc.querySelectorAll(".gs-prompt")[3].click();
  await fx.settle();
  const bars = [...fx.doc.querySelectorAll(".gs-bar")];
  assert.deepEqual(bars.map((b) => b.dataset.kind), ["prompt", "text", "heading", "code", "table", "image"]);
  const height = geo.turn.getBoundingClientRect().height;
  const pct = (v) => +(v * 100).toFixed(2);
  const spec = (b) => Object.fromEntries(b.getAttribute("style").split(";").filter(Boolean).map((d) => d.split(":")).map(([k, v]) => [k.trim(), parseFloat(v)]));
  geo.plan.forEach((p, n) => {
    const s = spec(bars[n + 1]);
    assert.ok(Math.abs(s.top - pct(p.y / height)) < 0.02, `${p.kind} top ${s.top}`);
    assert.ok(Math.abs(s.height - pct(p.h / height)) < 0.02, `${p.kind} height ${s.height}`);
  });
  // The bubble keeps its place on the right; the table and image keep their real width and indent.
  const bubble = spec(bars[0]);
  const reply = spec(bars[1]);
  assert.ok(bubble.left > reply.left && bubble.width < reply.width, "prompt and response are told apart by where and how they are laid out");
  assert.ok(spec(bars[4]).width < spec(bars[3]).width, "the table is narrower than the code band, as rendered");
  assert.ok(fx.doc.querySelectorAll(".gs-bar").length <= 120);
  rail.dispose();
});

test("a turn the virtualizer skipped is estimated instead, and turns real once it renders", async () => {
  const fx = createFixture({ turns: 40, width: 1600, markup: "real" });
  const { runtime, rail } = mount(fx);
  await fx.settle();
  const turn = chatgptAdapter.turns(fx.doc)[3];
  assert.equal(runtime.isTurnActive(turn), false);
  rail.select(chatgptAdapter.turnId(turn, 3));
  assert.equal(runtime.isTurnActive(turn), true, "selecting wakes it");
  await fx.settle();
  const kinds = new Set([...fx.doc.querySelectorAll(".gs-bar")].map((b) => b.dataset.kind));
  for (const k of ["heading", "code", "table"]) assert.ok(kinds.has(k), k);
  rail.dispose();
});

test("minimap styling: no category colors, native tokens only, viewport box in the native accent", async () => {
  const fx = createFixture({ turns: 5, width: 1600, markup: "real" });
  const { rail } = mount(fx);
  const css = fx.doc.getElementById("gs-pane-style").textContent;
  const rules = css.match(/\.gs-(bar|view|minimap|bars)[^{]*\{[^}]*\}/g).join("\n");
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(red|green|blue|orange|gray|grey)\b/i);
  assert.doesNotMatch(css, /opacity:\.\d+\}\n\.gs-bar/, "kinds differ by structure, not by tint");
  assert.match(css, /\.gs-view\{[^}]*border:1px solid var\(--interactive-bg-accent-default,AccentColor\)/);
  assert.match(css, /\.gs-bar\[data-kind="code"\]\{[^}]*var\(--bg-elevated-secondary/);
  assert.match(css, /\.gs-bar\[data-kind="prompt"\]\{[^}]*var\(--message-surface/);
  assert.match(css, /\.gs-bar\[data-kind="text"\]\{[^}]*background-size:100% var\(--gs-lh\)/, "text is drawn as lines");
  rail.dispose();
});

test("the minimap keeps the conversation's real aspect ratio inside a clear frame, and the viewport box sits in it", async () => {
  for (const [turn, label] of [[3, "a tall turn"], [1, "a short turn"]]) {
    const fx = createFixture({ turns: 20, width: 1600, markup: "real" });
    const { rail } = mount(fx);
    await fx.settle();
    const minimap = fx.doc.querySelector(".gs-minimap");
    minimap.getBoundingClientRect = () => ({ top: 0, bottom: 240, height: 240, left: 0, right: 288, width: 288, x: 0, y: 0 });
    fx.doc.querySelectorAll(".gs-prompt")[turn].click();
    await fx.settle();
    const frame = fx.doc.querySelector(".gs-frame");
    assert.ok(frame.contains(fx.doc.querySelector(".gs-bars")) && frame.contains(fx.doc.querySelector(".gs-view")), "bars and the viewport box are inside the frame");
    const w = parseFloat(frame.style.width);
    const h = parseFloat(frame.style.height);
    const el = chatgptAdapter.turns(fx.doc)[turn].getBoundingClientRect();
    assert.ok(Math.abs(w / h - el.width / el.height) < 0.02 * (w / h) + 0.05, `${label}: ${w}x${h} vs the turn's ${el.width}x${el.height}`);
    assert.ok(w <= 288 - 18 && h <= 360, `${label}: inside the track width, and the panel grows no taller than its cap`);
    assert.ok(w > 0 && h > 0);
    rail.dispose();
  }
  // Styling: the frame is bordered and sits on a recessed track, so it reads as a page in a view.
  const fx = createFixture({ turns: 3, width: 1600, markup: "real" });
  const { rail } = mount(fx);
  const css = fx.doc.getElementById("gs-pane-style").textContent;
  assert.match(css, /\.gs-frame\{[^}]*border:1px solid[^}]*background:var\(--main-surface-primary/);
  assert.match(css, /\.gs-minimap\{[^}]*padding:8px[^}]*background:var\(--bg-elevated-secondary/);
  assert.doesNotMatch(css, /\.gs-minimap\{(?:[^}]*;)?height:/, "the track grows with the conversation view instead of a fixed height");
  assert.equal(fx.doc.querySelector('[data-gs-panel="minimap"] .gs-panel-title').textContent, "Conversation view");
  rail.dispose();
});
