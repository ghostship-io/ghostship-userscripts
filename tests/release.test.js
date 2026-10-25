// Release policy: agents edit CHANGELOG.md only; the check refuses version edits and a missing entry, and the
// release step derives the version from the changelog. Everything runs on strings or a temporary git repository.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PolicyError, bumpVersion, checkPolicy, parseChangelog, releaseChangelog, releaseLevel, unreleasedEntries, versionFields } from "../scripts/release-lib.mjs";
import { prNumber, release } from "../scripts/release.mjs";

const CHANGELOG = (unreleased, released = "") => `# Changelog\n\nPreamble.\n\n## Unreleased\n\n${unreleased}\n${released}`;
const MANIFEST = (version) => JSON.stringify({ schema: 1, scripts: [{ id: "s", version }] });
const META = (version) => `// ==UserScript==\n// @name        S\n// @version     ${version}\n// ==/UserScript==\n`;
const files = (v, changelog) => ({ "CHANGELOG.md": changelog, "manifest.json": MANIFEST(v), "dist/manifest.json": MANIFEST(v), "dist/s.meta.js": META(v), "dist/s.user.js": `${META(v)}\ncode` });

test("bumpVersion: patch, minor and major reset the lower parts, and bad input is refused", () => {
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.throws(() => bumpVersion("1.2", "patch"), PolicyError);
  assert.throws(() => bumpVersion("1.2.3", "huge"), PolicyError);
});

test("the level is patch unless a standalone marker says otherwise; code examples, comments, bad and conflicting markers are handled", () => {
  // Defect: a version bump chosen by a marker that is only an example, or by two contradictory markers.
  assert.equal(releaseLevel(CHANGELOG("- a")), "patch");
  assert.equal(releaseLevel(CHANGELOG("- a\nRelease: minor")), "minor");
  assert.equal(releaseLevel(CHANGELOG("- a\n\nrelease: MAJOR\n")), "major");
  assert.equal(releaseLevel(CHANGELOG("- a\n```\nRelease: major\n```\n<!--\nRelease: major\n-->")), "patch");
  assert.equal(releaseLevel(CHANGELOG("- a (Release: major in prose)")), "patch");
  assert.throws(() => releaseLevel(CHANGELOG("- a\nRelease: minor\nRelease: major")), /Conflicting/);
  assert.throws(() => releaseLevel(CHANGELOG("- a\nRelease: huge")), /Unknown release level/);
  assert.equal(releaseLevel(CHANGELOG("- a\nRelease: minor\nRelease: minor")), "minor");
});

test("entries: only the Unreleased section counts, continuation lines stay with their entry", () => {
  const text = CHANGELOG("- first\n  continued\n- second (#4)\n", "\n## [1.0.0] - 2026-01-01\n\n- old\n");
  assert.deepEqual(unreleasedEntries(text), ["- first\n  continued", "- second (#4)"]);
  assert.deepEqual(unreleasedEntries("# Changelog\n"), []);
  assert.equal(parseChangelog(text).start > 0, true);
});

test("releaseChangelog: entries move under the new heading with their PR number, Unreleased is left empty, history is kept", () => {
  const text = CHANGELOG("- first\n  continued\n- second (#4)\nRelease: minor\n", "\n## [1.0.0] - 2026-01-01\n\n- old\n");
  const out = releaseChangelog(text, { version: "1.1.0", date: "2026-10-25", pr: "9" });
  assert.equal(out, "# Changelog\n\nPreamble.\n\n## Unreleased\n\n## [1.1.0] - 2026-10-25\n\n- first (#9)\n  continued\n- second (#4)\n\n## [1.0.0] - 2026-01-01\n\n- old\n");
  assert.deepEqual(unreleasedEntries(out), []);
  assert.throws(() => releaseChangelog(CHANGELOG(""), { version: "1.0.1", date: "d" }), /no entries/);
  assert.throws(() => releaseChangelog("# Changelog\n", { version: "1.0.1", date: "d" }), /no Unreleased/);
  assert.match(releaseChangelog(CHANGELOG("- a"), { version: "1.0.1", date: "d" }), /- a\n/, "without a PR number nothing is appended");
});

test("versionFields reads manifest.json, dist/manifest.json and the @version of every dist script and header", () => {
  const fields = versionFields(files("1.2.3", ""));
  assert.equal(fields["manifest.json:s"], "1.2.3");
  assert.equal(fields["dist/manifest.json:s"], "1.2.3");
  assert.equal(fields["dist/s.meta.js"], "1.2.3");
  assert.equal(fields["dist/s.user.js"], "1.2.3");
});

test("check: a change that ships and adds an entry passes; the same change with no entry is refused", () => {
  // Defect: a shipping change that never reaches the release notes (and so never reaches a version).
  const base = files("1.0.0", CHANGELOG("- earlier"));
  const ok = checkPolicy({ base, head: { ...base, "CHANGELOG.md": CHANGELOG("- earlier\n- new thing") }, changed: ["src/a.js", "dist/s.user.js", "CHANGELOG.md"] });
  assert.deepEqual(ok, { ok: true, violations: [] });
  const none = checkPolicy({ base, head: base, changed: ["src/a.js"] });
  assert.equal(none.ok, false);
  assert.match(none.violations[0], /adds no entry/);
  const reworded = checkPolicy({ base, head: { ...base, "CHANGELOG.md": CHANGELOG("") }, changed: ["src/a.js"] });
  assert.equal(reworded.ok, false, "deleting an entry is not adding one");
});

test("check: docs, tests and workflow changes need no entry", () => {
  const base = files("1.0.0", CHANGELOG(""));
  assert.equal(checkPolicy({ base, head: base, changed: ["README.md", "tests/x.test.js", ".github/workflows/test.yml", "AGENTS.md", "scripts/release.mjs"] }).ok, true);
});

test("check: every kind of version edit is refused", () => {
  // Defect: an agent bumping the version by hand (manifest, bundle header, metadata or the dist index).
  const changelog = CHANGELOG("- new");
  const base = files("1.0.0", CHANGELOG(""));
  const edits = {
    "manifest.json": files("1.0.1", changelog),
    "dist/s.meta.js": { ...files("1.0.0", changelog), "dist/s.meta.js": META("1.0.1") },
    "dist/s.user.js": { ...files("1.0.0", changelog), "dist/s.user.js": `${META("1.0.1")}\ncode` },
    "dist/manifest.json": { ...files("1.0.0", changelog), "dist/manifest.json": MANIFEST("1.0.1") },
  };
  for (const [name, head] of Object.entries(edits)) {
    const result = checkPolicy({ base, head, changed: ["src/a.js", name] });
    assert.equal(result.ok, false, name);
    assert.ok(result.violations.some((v) => /agents do not edit versions/.test(v)), name);
  }
});

test("check: a bundle change that keeps the version passes, and a hand-written release section is refused", () => {
  const base = files("1.0.0", CHANGELOG("", "\n## [1.0.0] - 2026-01-01\n\n- old\n"));
  const head = { ...files("1.0.0", CHANGELOG("- new", "\n## [1.0.0] - 2026-01-01\n\n- old\n")), "dist/s.user.js": `${META("1.0.0")}\nother code` };
  assert.equal(checkPolicy({ base, head, changed: ["src/a.js", "dist/s.user.js"] }).ok, true);
  const forged = { ...head, "CHANGELOG.md": CHANGELOG("- new", "\n## [1.0.1] - 2026-10-25\n\n- new\n\n## [1.0.0] - 2026-01-01\n\n- old\n") };
  const result = checkPolicy({ base, head: forged, changed: ["src/a.js"] });
  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /added a release section for 1\.0\.1/);
});

test("prNumber reads the merge subject written by agent pr land, GitHub and squash merges", () => {
  assert.equal(prNumber("Merge PR #14: Recover from it (#796)"), "14");
  assert.equal(prNumber("Merge pull request #12 from x/y"), "12");
  assert.equal(prNumber("Add a thing (#33)"), "33");
  assert.equal(prNumber("No number here"), null);
});

// ---- the release step on a real (temporary) git repository ----

// Temporary repositories must not run the host's global commit hooks.
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
process.env.GIT_CONFIG_VALUE_0 = "/dev/null";

const NOREPLY = "1+owner@users.noreply.github.com";
const PERSONAL = ["someone", "example.test"].join("@");
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

function repo({ version = "0.7.0", unreleased = "- Ship the thing", subject = "Merge PR #20: ship (#5)", email = NOREPLY } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), "release-"));
  sh(cwd, "init", "-q", "-b", "main");
  mkdirSync(path.join(cwd, "dist"));
  writeFileSync(path.join(cwd, "CHANGELOG.md"), CHANGELOG(unreleased));
  writeFileSync(path.join(cwd, "manifest.json"), MANIFEST(version) + "\n");
  writeFileSync(path.join(cwd, "dist/built.txt"), `built ${version}\n`);
  writeFileSync(path.join(cwd, "src.js"), "code\n");
  sh(cwd, "add", "-A");
  sh(cwd, "-c", "user.name=Owner", "-c", `user.email=${email}`, "commit", "-q", "-m", subject);
  // The build rewrites dist from the manifest, like scripts/build.mjs.
  const build = (dir) => writeFileSync(path.join(dir, "dist/built.txt"), `built ${JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")).scripts[0].version}\n`);
  return { cwd, build, run: (opts = {}) => release({ cwd, repo: "o/r", date: "2026-10-25", build, ...opts }) };
}

test("release: the plan changes nothing; applying writes the version, the changelog and dist in ONE commit with the trailer", () => {
  // Defect: a release that edits anything but the release files, or a version chosen by hand.
  const r = repo();
  const plan = r.run();
  assert.deepEqual([plan.released, plan.level, plan.version, plan.pr], [false, "patch", "0.7.1", "20"]);
  assert.equal(sh(r.cwd, "status", "--porcelain"), "");

  const done = r.run({ apply: true });
  assert.equal(done.released, true);
  assert.equal(JSON.parse(readFileSync(path.join(r.cwd, "manifest.json"), "utf8")).scripts[0].version, "0.7.1");
  assert.equal(readFileSync(path.join(r.cwd, "dist/built.txt"), "utf8"), "built 0.7.1\n");
  assert.match(readFileSync(path.join(r.cwd, "CHANGELOG.md"), "utf8"), /## \[0\.7\.1\] - 2026-10-25\n\n- Ship the thing \(#20\)\n/);
  assert.equal(sh(r.cwd, "rev-list", "--count", "HEAD"), "2\n");
  assert.deepEqual(sh(r.cwd, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort(), ["CHANGELOG.md", "dist/built.txt", "manifest.json"]);
  const message = sh(r.cwd, "log", "-1", "--format=%B");
  assert.match(message, /^Release 0\.7\.1\n\nGhostship-Release: o\/r#20/);
  assert.doesNotMatch(message, /Co-authored|Generated/i);
  assert.equal(sh(r.cwd, "log", "-1", "--format=%ae|%ce").trim(), `${NOREPLY}|${NOREPLY}`);
});

test("release: running again is a no-op (the release commit carries the trailer, and Unreleased is empty)", () => {
  const r = repo();
  r.run({ apply: true });
  const head = sh(r.cwd, "rev-parse", "HEAD");
  assert.deepEqual(r.run({ apply: true }), { released: false, reason: "HEAD is already a release commit" });
  sh(r.cwd, "-c", "user.name=O", "-c", `user.email=${NOREPLY}`, "commit", "-q", "--allow-empty", "-m", "Merge PR #21: docs");
  assert.deepEqual(r.run({ apply: true }), { released: false, reason: "no entries under Unreleased" });
  assert.equal(sh(r.cwd, "rev-list", "--count", "HEAD"), "3\n");
  assert.notEqual(head, "");
});

test("release: a Release: minor / major marker selects the bump", () => {
  assert.equal(repo({ unreleased: "- a\nRelease: minor" }).run().version, "0.8.0");
  assert.equal(repo({ unreleased: "- a\nRelease: major" }).run().version, "1.0.0");
  assert.throws(() => repo({ unreleased: "- a\nRelease: minor\nRelease: major" }).run(), /Conflicting/);
});

test("release: nothing under Unreleased means no version change", () => {
  const r = repo({ unreleased: "" });
  assert.equal(r.run({ apply: true }).released, false);
  assert.equal(sh(r.cwd, "rev-list", "--count", "HEAD"), "1\n");
});

test("release: refuses a merge that is not by the owner no-reply identity, and a build that touches anything else", () => {
  // Defect: a release commit under a personal or system identity, or one that smuggles in other files.
  const personal = repo({ email: PERSONAL });
  assert.throws(() => personal.run({ apply: true }), /no-reply identity/);
  assert.equal(sh(personal.cwd, "rev-list", "--count", "HEAD"), "1\n");

  const stray = repo();
  assert.throws(() => stray.run({ apply: true, build: (dir) => (writeFileSync(path.join(dir, "src.js"), "changed\n"), writeFileSync(path.join(dir, "dist/built.txt"), "x\n")) }), /outside the release set: src\.js/);
});

test("the workflows: only the release workflow may write contents, and it verifies before it pushes", () => {
  const read = (p) => readFileSync(new URL(`../.github/workflows/${p}`, import.meta.url), "utf8");
  assert.match(read("test.yml"), /permissions:\s*\n\s+contents: read/);
  assert.match(read("test.yml"), /scripts\/check-pr\.mjs/);
  const releaseYml = read("release.yml");
  assert.match(releaseYml, /contents: write/);
  assert.ok(releaseYml.indexOf("npm test") < releaseYml.indexOf("git push origin HEAD:main"), "tests run before the push");
  assert.doesNotMatch(releaseYml, /--force|--force-with-lease|push -f|\+HEAD/);
  assert.match(releaseYml, /git reset --hard origin\/main/, "a rejected push restarts from the new tip instead of failing");
});
