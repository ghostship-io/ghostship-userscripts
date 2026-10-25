// Bundles each manifest script into dist/ with a userscript metadata header and
// writes dist/manifest.json (version + sha256) for the update channel.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const raw = `https://raw.githubusercontent.com/${manifest.repo}/${manifest.channel}/dist`;

export function header(script) {
  const lines = [
    ["name", script.name],
    ["namespace", `https://github.com/${manifest.repo}`],
    ["version", script.version],
    ["description", script.description],
    ...script.match.map((m) => ["match", m]),
    ...script.grant.map((g) => ["grant", g]),
    ["run-at", script.runAt],
    ["updateURL", `${raw}/${script.id}.meta.js`],
    ["downloadURL", `${raw}/${script.id}.user.js`],
  ];
  const pad = Math.max(...lines.map(([k]) => k.length)) + 1;
  return ["// ==UserScript==", ...lines.map(([k, v]) => `// @${k.padEnd(pad)} ${v}`), "// ==/UserScript=="].join("\n") + "\n";
}

await mkdir(path.join(root, "dist"), { recursive: true });
const out = { schema: manifest.schema, scripts: [] };
for (const script of manifest.scripts) {
  const bundled = await build({
    entryPoints: [path.join(root, script.entry)],
    bundle: true,
    format: "iife",
    target: "chrome110",
    write: false,
    legalComments: "none",
    logLevel: "warning",
  });
  const head = header(script);
  const body = `${head}\n${bundled.outputFiles[0].text}`;
  await writeFile(path.join(root, "dist", `${script.id}.user.js`), body);
  await writeFile(path.join(root, "dist", `${script.id}.meta.js`), head);
  out.scripts.push({ id: script.id, version: script.version, file: `${script.id}.user.js`, sha256: createHash("sha256").update(body).digest("hex") });
}
await writeFile(path.join(root, "dist", "manifest.json"), JSON.stringify(out, null, 2) + "\n");
