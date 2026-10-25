// node scripts/bump.mjs <script-id> <patch|minor|major>
// Managers only update to a strictly higher @version, so a rollback is a
// revert plus a bump, never a lower number.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "manifest.json");
const [id, level] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(file, "utf8"));
const script = manifest.scripts.find((s) => s.id === id);
if (!script || !["patch", "minor", "major"].includes(level)) {
  console.error("usage: node scripts/bump.mjs <script-id> <patch|minor|major>");
  process.exit(2);
}
const [major, minor, patch] = script.version.split(".").map(Number);
script.version = level === "major" ? `${major + 1}.0.0` : level === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
console.log(`${id} -> ${script.version}`);
