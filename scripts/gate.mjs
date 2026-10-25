// Dry-run acceptance gate: builds, then runs tests/gate/*.gate.js and records an
// aggregate report (no thread content, only test names and results).
import { run } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [path.join(root, "scripts/build.mjs")], { stdio: "inherit" });

const dir = path.join(root, "tests/gate");
const files = readdirSync(dir).filter((f) => f.endsWith(".gate.js")).map((f) => path.join(dir, f));
const results = [];
const stream = run({ files, concurrency: false });
stream.on("test:pass", (e) => {
  if (e.skip || e.todo) return;
  results.push({ name: e.name, status: "pass" });
  console.log(`  pass  ${e.name}`);
});
stream.on("test:fail", (e) => {
  results.push({ name: e.name, status: "fail", error: String(e.details?.error?.message ?? "").split("\n")[0] });
  console.log(`  FAIL  ${e.name}\n        ${e.details?.error?.message?.split("\n")[0] ?? ""}`);
});
await new Promise((resolve) => stream.on("end", resolve).resume());

const bundle = readFileSync(path.join(root, "dist/ghostship-chatgpt.user.js"));
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
const failed = results.filter((r) => r.status === "fail").length;
const report = {
  gate: "dry-run",
  passed: failed === 0 && results.length > 0,
  version: manifest.scripts.find((s) => s.id === "ghostship-chatgpt").version,
  bundleSha256: createHash("sha256").update(bundle).digest("hex"),
  node: process.version,
  liveTraffic: false,
  total: results.length,
  failed,
  results,
};
mkdirSync(path.join(root, "build"), { recursive: true });
writeFileSync(path.join(root, "build/gate-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`\ngate ${report.passed ? "PASSED" : "FAILED"}: ${results.length - failed}/${results.length} (report: build/gate-report.json)`);
process.exit(report.passed ? 0 : 1);
