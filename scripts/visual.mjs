// Screenshots of the built script on a synthetic ChatGPT-like page (tests/visual/mock-chatgpt.html: lorem text only),
// at wide, medium, narrow and mobile widths, with and without a side pane, in both themes. Opt-in (needs the
// `playwright` CLI); writes build/visual/*.png. Nothing here touches chatgpt.com.
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build", "visual");
const run = promisify(execFile);
const files = {
  "/c/mock": ["tests/visual/mock-chatgpt.html", "text/html"],
  "/ghostship-chatgpt.user.js": ["dist/ghostship-chatgpt.user.js", "text/javascript"],
};
const server = createServer(async (req, res) => {
  const hit = files[new URL(req.url, "http://x").pathname];
  if (!hit) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": hit[1] }).end(await readFile(path.join(root, hit[0])));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/c/mock`;

const sizes = { wide: [1700, 900], medium: [1200, 820], narrow: [820, 900], mobile: [390, 800] };
const cases = [];
for (const [size, [w, h]] of Object.entries(sizes)) {
  for (const pane of [false, true]) cases.push({ name: `${size}-${pane ? "side-pane" : "no-pane"}`, w, h, query: pane ? "pane=1" : "" });
}
cases.push({ name: "wide-light-no-pane", w: 1700, h: 900, query: "theme=light" });
cases.push({ name: "wide-sidebar-open-side-pane", w: 1700, h: 900, query: "pane=1&nav=open" });
cases.push({ name: "wide-prompts-collapsed", w: 1700, h: 900, query: "press=prompts" });
cases.push({ name: "wide-both-collapsed", w: 1700, h: 900, query: "press=prompts,minimap" });
cases.push({ name: "narrow-prompts-drawer", w: 820, h: 900, query: "press=prompts" });
cases.push({ name: "mobile-minimap-drawer", w: 390, h: 800, query: "press=minimap" });

await mkdir(out, { recursive: true });
for (const c of cases) {
  const file = path.join(out, `${c.name}.png`);
  await run("playwright", ["screenshot", "--channel", "chromium", "--viewport-size", `${c.w},${c.h}`, "--wait-for-timeout", "3200", `${base}?${c.query}`, file]);
  console.log(file);
}
server.close();
