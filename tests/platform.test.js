import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const dist = JSON.parse(read("dist/manifest.json"));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

test("manifest: semver, https matches, least-privilege grants, unique ids", () => {
  const ids = new Set();
  for (const s of manifest.scripts) {
    assert.match(s.version, /^\d+\.\d+\.\d+$/);
    assert.ok(!ids.has(s.id));
    ids.add(s.id);
    for (const m of s.match) assert.match(m, /^https:\/\/[a-z.]+\/\*$/);
    for (const g of s.grant) assert.ok(g === "none", `${s.id}: grant ${g} needs justification in review`);
    assert.ok(read(s.entry));
  }
});

test("dist: header, version and sha256 agree with the manifest", () => {
  for (const s of manifest.scripts) {
    const entry = dist.scripts.find((d) => d.id === s.id);
    assert.equal(entry.version, s.version);
    const body = read(`dist/${entry.file}`);
    assert.equal(createHash("sha256").update(body).digest("hex"), entry.sha256);
    assert.match(body, new RegExp(`// @version\\s+${s.version.replaceAll(".", "\\.")}\\n`));
    assert.match(body, /\/ghostship-userscripts\/main\/dist\/.+\.meta\.js/);
    assert.equal(read(`dist/${s.id}.meta.js`).trim(), body.split("\n\n")[0].trim());
  }
});

test("dist matches a clean rebuild of src (CI fails if dist is stale)", { skip: !process.env.CI }, () => {
  execFileSync("git", ["diff", "--exit-code", "--", "dist"], { cwd: root });
});

test("no unsanctioned traffic: only the live dispatcher, the load-error recovery and the thinking-trace expander may click, and nothing may use the network or submit forms", () => {
  const banned = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|GM_xmlhttpRequest|GM\.xmlHttpRequest)\b|requestSubmit|dispatchEvent\(\s*new (Mouse|Pointer)Event/;
  const click = /\.click\(\)/;
  const liveDispatcher = path.join("src", "chatgpt", "queue", "live-dispatcher.js");
  const recovery = path.join("src", "chatgpt", "recovery.js");
  const thinking = path.join("src", "chatgpt", "thinking.js");
  for (const file of walk(path.join(root, "src")).filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
    const rel = path.relative(root, file);
    assert.doesNotMatch(text, banned, `${rel} uses a banned primitive`);
    if (rel !== liveDispatcher && rel !== recovery && rel !== thinking) assert.doesNotMatch(text, click, `${rel} clicks; native Send/Stop clicks belong only in ${liveDispatcher}`);
  }
  // The recovery's one click is the "Try again" control the adapter found inside the failure card, nothing else.
  const recoveryCode = readFileSync(path.join(root, recovery), "utf8").replace(/\/\/.*$/gm, "");
  assert.equal(recoveryCode.match(/\.click\(\)/g)?.length, 1);
  assert.match(recoveryCode, /found\.control\.click\(\)/);
  assert.doesNotMatch(recoveryCode, /sendButton|stopButton|steerButton/);
  // The expander's one click is the disclosure button the adapter found inside a conversation turn, nothing else.
  const thinkingCode = readFileSync(path.join(root, thinking), "utf8").replace(/\/\/.*$/gm, "");
  assert.equal(thinkingCode.match(/\.click\(\)/g)?.length, 1);
  assert.match(thinkingCode, /button\.click\(\)/);
  assert.doesNotMatch(thinkingCode, /sendButton|stopButton|steerButton|composer/i);
});

test("background timing: a Worker exists only in core/worker-timer.js, as a Blob of a few timer lines with no network and no page data", () => {
  const owner = path.join("src", "core", "worker-timer.js");
  for (const file of walk(path.join(root, "src")).filter((f) => f.endsWith(".js"))) {
    const rel = path.relative(root, file);
    const text = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
    if (rel !== owner) assert.doesNotMatch(text, /\bnew\s+(win\.|window\.)?(Shared)?Worker\b|\bServiceWorker\b|importScripts/, `${rel} starts a worker`);
  }
  const code = readFileSync(path.join(root, owner), "utf8");
  const source = code.match(/const SOURCE = `([\s\S]*?)`;/)?.[1] ?? "";
  assert.ok(source.length > 0 && source.length < 600, "the worker body is a few lines");
  assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|WebSocket|importScripts|self\.|document|location)\b/);
});

test("public repo hygiene: no emails, home paths or token-shaped strings in tracked files", () => {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" })
    .split("\n").filter((f) => f && f !== "package-lock.json" && f !== "tests/platform.test.js");
  const patterns = [
    [/[\w.+-]+@(?!users\.noreply\.github\.com)[\w-]+\.[a-z]{2,}/i, "email address"],
    [/\/home\/\w+|\/Users\/\w+|C:\\Users\\/, "home directory path"],
    [/\b(ghp_|github_pat_|sk-[A-Za-z0-9]{20}|xox[bp]-)/, "token"],
    [/chrome\/.*Default|User Data/, "browser profile path"],
  ];
  for (const f of files) {
    const text = readFileSync(path.join(root, f), "utf8");
    for (const [re, label] of patterns) assert.doesNotMatch(text, re, `${f}: ${label}`);
  }
});
