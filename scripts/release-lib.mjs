// Release policy as pure functions: what a PR may change, and how the next version and the changelog are derived.
// Agents edit CHANGELOG.md only; the release step (scripts/release.mjs) sets the version on main after the merge.
// Conventions follow ghostship-agent's `agent pr land`: patch by default, a standalone `Release: minor|major`
// line selects a larger bump, every released entry carries its PR number, and the release commit changes only
// the release files.

export const RELEASE_FILES = ["CHANGELOG.md", "manifest.json", "dist"];

const LEVELS = ["patch", "minor", "major"];
const UNRELEASED = /^##\s+\[?unreleased\]?\s*$/i;
const HEADING = /^##\s+/;
const VERSION_HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?/;
const MARKER = /^Release:\s*(\S+)\s*$/i;

export class PolicyError extends Error {}

/** Splits the changelog at its `## Unreleased` section. Fenced code and HTML comments are not read for markers. */
export function parseChangelog(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => UNRELEASED.test(line));
  if (start < 0) return { lines, start: -1, end: -1, entries: [], marker: null };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  const entries = [];
  const markers = new Set();
  let fenced = false;
  let comment = false;
  for (const line of body) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) {
      if (entries.length && /^\s/.test(line)) entries[entries.length - 1] += `\n${line}`;
      continue;
    }
    if (line.includes("<!--")) comment = true;
    const inComment = comment;
    if (line.includes("-->")) comment = false;
    if (inComment) continue;
    const marker = MARKER.exec(line.trim());
    if (marker) {
      const level = marker[1].toLowerCase();
      if (!LEVELS.includes(level)) throw new PolicyError(`Unknown release level "${marker[1]}"; use patch, minor or major.`);
      markers.add(level);
    } else if (/^-\s+\S/.test(line)) {
      entries.push(line.trimEnd());
    } else if (entries.length && /^\s+\S/.test(line)) {
      entries[entries.length - 1] += `\n${line.trimEnd()}`;
    }
  }
  if (markers.size > 1) throw new PolicyError(`Conflicting release markers: ${[...markers].join(", ")}.`);
  return { lines, start, end, entries, marker: [...markers][0] ?? null };
}

export const unreleasedEntries = (text) => parseChangelog(text).entries;
export const releaseLevel = (text) => parseChangelog(text).marker ?? "patch";

export function bumpVersion(version, level) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || !LEVELS.includes(level)) throw new PolicyError(`Cannot bump "${version}" by "${level}".`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (level === "major") return `${major + 1}.0.0`;
  return level === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/**
 * Moves the Unreleased entries under a new version heading (marker line dropped, PR number added to entries
 * that lack one) and leaves an empty Unreleased section.
 */
export function releaseChangelog(text, { version, date, pr }) {
  const parsed = parseChangelog(text);
  if (parsed.start < 0) throw new PolicyError("CHANGELOG.md has no Unreleased section.");
  if (!parsed.entries.length) throw new PolicyError("The Unreleased section has no entries.");
  const entries = parsed.entries.map((entry) => {
    if (!pr || /\(#\d+\)|#\d+/.test(entry.split("\n")[0])) return entry;
    const [first, ...rest] = entry.split("\n");
    return [`${first} (#${pr})`, ...rest].join("\n");
  });
  const before = parsed.lines.slice(0, parsed.start + 1);
  const after = parsed.lines.slice(parsed.end);
  const out = [...before, "", `## [${version}] - ${date}`, "", ...entries, "", ...after];
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");
}

/** Version of every script as recorded in the files a PR must not touch the version of. */
export function versionFields(files) {
  const found = {};
  const manifest = (name, text) => {
    try {
      for (const script of JSON.parse(text).scripts ?? []) found[`${name}:${script.id}`] = script.version;
    } catch {
      found[`${name}:unreadable`] = text;
    }
  };
  for (const [name, text] of Object.entries(files)) {
    if (text == null) continue;
    if (name === "manifest.json" || name === "dist/manifest.json") manifest(name, text);
    else if (/^dist\/.+\.(meta|user)\.js$/.test(name)) found[name] = /^\/\/ @version\s+(\S+)/m.exec(text)?.[1] ?? null;
  }
  return found;
}

const releasedHeadings = (text) =>
  new Set((text ?? "").split("\n").map((line) => VERSION_HEADING.exec(line)?.[1]).filter(Boolean));

/** Paths whose change ships to the browser and so needs a changelog entry. */
export const shipsToBrowser = (path) => path.startsWith("src/") || path.startsWith("dist/") || path === "manifest.json";

/**
 * @param {{base: Record<string,string|null>, head: Record<string,string|null>, changed: string[]}} o
 *   base/head: contents of CHANGELOG.md, manifest.json and every dist file at the two revisions.
 * @returns {{ok: boolean, violations: string[]}}
 */
export function checkPolicy({ base, head, changed }) {
  const violations = [];
  const before = versionFields(base);
  const after = versionFields(head);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) violations.push(`${key}: version changed from ${before[key] ?? "(none)"} to ${after[key] ?? "(none)"}; agents do not edit versions, the release step does.`);
  }
  const baseHeadings = releasedHeadings(base["CHANGELOG.md"]);
  for (const version of releasedHeadings(head["CHANGELOG.md"])) {
    if (!baseHeadings.has(version)) violations.push(`CHANGELOG.md: added a release section for ${version}; add entries under Unreleased instead.`);
  }
  if (changed.some(shipsToBrowser)) {
    let added = [];
    try {
      const existing = new Set(unreleasedEntries(base["CHANGELOG.md"] ?? ""));
      added = unreleasedEntries(head["CHANGELOG.md"] ?? "").filter((entry) => !existing.has(entry));
      releaseLevel(head["CHANGELOG.md"] ?? "");
    } catch (error) {
      violations.push(`CHANGELOG.md: ${error.message}`);
    }
    if (!added.length) violations.push("CHANGELOG.md: this change ships to the browser (src/, dist/ or manifest.json) but adds no entry under Unreleased.");
  }
  return { ok: violations.length === 0, violations };
}
