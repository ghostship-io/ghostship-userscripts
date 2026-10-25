// CI policy check for pull requests: node scripts/check-pr.mjs [base-ref] (default origin/main).
// Refuses edits to version fields (manifest.json, dist metadata and bundle headers) and a shipping change
// without a CHANGELOG.md entry. Reads git only; changes nothing.
import { execFileSync } from "node:child_process";
import { checkPolicy } from "./release-lib.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const show = (rev, path) => {
  try {
    return git("show", `${rev}:${path}`);
  } catch {
    return null;
  }
};

const base = process.argv[2] ?? "origin/main";
const head = process.argv[3] ?? "HEAD";
const changed = git("diff", "--name-only", `${base}...${head}`).split("\n").filter(Boolean);
const watched = ["CHANGELOG.md", "manifest.json", ...new Set([...git("ls-tree", "-r", "--name-only", base, "dist").split("\n"), ...git("ls-tree", "-r", "--name-only", head, "dist").split("\n")])].filter(Boolean);
const contents = (rev) => Object.fromEntries(watched.map((path) => [path, show(rev, path)]));
const { ok, violations } = checkPolicy({ base: contents(base), head: contents(head), changed });
if (ok) {
  console.log(`release policy: ok (${changed.length} changed file${changed.length === 1 ? "" : "s"})`);
} else {
  for (const violation of violations) console.error(`release policy: ${violation}`);
  process.exit(1);
}
