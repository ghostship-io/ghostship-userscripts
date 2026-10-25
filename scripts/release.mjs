// Release step, run on main after a merge (.github/workflows/release.yml): derives the next version from
// CHANGELOG.md, writes it to manifest.json, rebuilds dist/ and commits the release as ONE follow-up commit that
// changes only the release files. Patch by default; a standalone `Release: minor|major` line in the Unreleased
// section selects more. Idempotent: a commit carrying the Ghostship-Release trailer, or an empty Unreleased
// section, means there is nothing to do.
//   node scripts/release.mjs            plan only
//   node scripts/release.mjs --apply    write, build, commit (the caller pushes)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PolicyError, RELEASE_FILES, bumpVersion, releaseChangelog, releaseLevel, unreleasedEntries } from "./release-lib.mjs";

const TRAILER = "Ghostship-Release";
const NOREPLY = /@users\.noreply\.github\.com$/;

/** The PR a merge commit came from: "Merge PR #14: ..." (agent pr land) or "Merge pull request #14 ..." or "(#14)". */
export function prNumber(subject) {
  return /(?:Merge (?:PR|pull request) #|\(#)(\d+)/.exec(subject)?.[1] ?? null;
}

export function release({ cwd, repo, apply = false, date = new Date().toISOString().slice(0, 10), build = defaultBuild, git = defaultGit }) {
  const run = (...args) => git(cwd, ...args);
  const message = run("log", "-1", "--format=%B").trim();
  if (new RegExp(`^${TRAILER}:`, "m").test(message)) return { released: false, reason: "HEAD is already a release commit" };

  const changelogPath = path.join(cwd, "CHANGELOG.md");
  const manifestPath = path.join(cwd, "manifest.json");
  const changelog = readFileSync(changelogPath, "utf8");
  if (!unreleasedEntries(changelog).length) return { released: false, reason: "no entries under Unreleased" };

  const level = releaseLevel(changelog);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const versions = manifest.scripts.map((script) => [script.id, script.version, bumpVersion(script.version, level)]);
  const version = versions[0][2];
  const pr = prNumber(run("log", "-1", "--format=%s"));
  const plan = { released: false, level, version, versions, pr };
  if (!apply) return { ...plan, reason: "plan only" };

  const [name, email] = run("log", "-1", "--format=%an%n%ae").split("\n");
  if (!NOREPLY.test(email)) throw new PolicyError("The release commit must use the owner GitHub no-reply identity; the merge commit's author is not one.");
  if (run("status", "--porcelain").trim()) throw new PolicyError("The working tree is not clean.");

  writeFileSync(changelogPath, releaseChangelog(changelog, { version, date, pr }));
  for (const script of manifest.scripts) script.version = versions.find(([id]) => id === script.id)[2];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  build(cwd);

  const touched = run("status", "--porcelain").split("\n").filter(Boolean).map((line) => line.slice(3));
  const stray = touched.filter((file) => !RELEASE_FILES.some((allowed) => file === allowed || file.startsWith(`${allowed}/`)));
  if (stray.length) throw new PolicyError(`The release would change files outside the release set: ${stray.join(", ")}`);

  run("add", ...RELEASE_FILES);
  const trailer = `${TRAILER}: ${repo}#${pr ?? run("rev-parse", "--short", "HEAD").trim()}`;
  run("-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", `Release ${version}\n\n${trailer}`);
  return { ...plan, released: true, sha: run("rev-parse", "HEAD").trim() };
}

const defaultGit = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const defaultBuild = (cwd) => execFileSync(process.execPath, [path.join(cwd, "scripts/build.mjs")], { cwd, stdio: "inherit" });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes("--apply");
  const repo = process.env.GITHUB_REPOSITORY ?? "ghostship-io/ghostship-userscripts";
  try {
    const result = release({ cwd: process.cwd(), repo, apply });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`release: ${error.message}`);
    process.exit(1);
  }
}
