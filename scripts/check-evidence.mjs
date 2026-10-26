// Evidence-image policy: node scripts/check-evidence.mjs [dir ...] (default: the repository root).
// Every PNG in a directory must be listed in that directory's `manifest.json` with its sha256, an `avatar` entry
// (the redacted region of the account avatar, or "absent" when the frame cannot show it), a `labels` list (the
// redacted regions of every user-named label: conversation, project, scheduled task, tab titles; empty when the frame
// shows none) and the `fill` colour. Each region is verified against the pixels: it must lie inside the image and be
// ONE solid colour equal to `fill`, so a blur, a missing region or a stale manifest fails. Other image formats and
// PNG text chunks (metadata) are refused. Reads files only.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP = new Set([".git", "node_modules"]);
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const TEXT_CHUNKS = new Set(["tEXt", "iTXt", "zTXt", "eXIf"]);

/** Decodes a non-interlaced 8-bit RGB/RGBA PNG to `{ width, height, channels, data }`; throws on anything else. */
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let header = null;
  const idat = [];
  const text = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    else if (type === "IDAT") idat.push(body);
    else if (TEXT_CHUNKS.has(type)) text.push(type);
    pos += 12 + len;
  }
  if (!header) throw new Error("no IHDR");
  if (header.depth !== 8 || header.interlace !== 0 || (header.color !== 2 && header.color !== 6)) throw new Error("unsupported PNG (need 8-bit RGB or RGBA, not interlaced)");
  const channels = header.color === 2 ? 3 : 4;
  const stride = header.width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const data = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= channels ? data[y * stride + i - channels] : 0;
      const b = y ? data[(y - 1) * stride + i] : 0;
      const c = y && i >= channels ? data[(y - 1) * stride + i - channels] : 0;
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error("bad PNG filter");
      data[y * stride + i] = v & 255;
    }
  }
  return { width: header.width, height: header.height, channels, data, text };
}

const isRegion = (r) => r && [r.x, r.y, r.w, r.h].every(Number.isInteger) && r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0;

/** Problems with one region: out of bounds, or not one solid colour equal to `fill` (hex, no `#`). */
function regionProblem(png, r, fill) {
  if (!isRegion(r)) return "is not a region {x,y,w,h}";
  if (r.x + r.w > png.width || r.y + r.h > png.height) return "lies outside the image";
  const want = [0, 2, 4].map((i) => parseInt(fill.slice(i, i + 2), 16));
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) {
      const o = (y * png.width + x) * png.channels;
      if (png.data[o] !== want[0] || png.data[o + 1] !== want[1] || png.data[o + 2] !== want[2]) return `is not a solid #${fill} fill (pixel ${x},${y})`;
    }
  return null;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Checks every image under `dir` against `dir/manifest.json`; returns the list of problems (empty = ok). */
export function checkEvidence(dir) {
  const problems = [];
  const files = walk(dir).filter((f) => IMAGE.test(f));
  const rel = (f) => relative(dir, f).split("\\").join("/");
  const pngs = files.filter((f) => /\.png$/i.test(f));
  for (const f of files) if (!/\.png$/i.test(f)) problems.push(`${rel(f)}: only PNG evidence is accepted`);
  if (!pngs.length) return problems;
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return [...problems, ...pngs.map((f) => `${rel(f)}: no sanitization manifest (manifest.json)`)];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return [...problems, "manifest.json is not valid JSON"];
  }
  const images = manifest?.images ?? {};
  for (const f of pngs) {
    const name = rel(f);
    const entry = images[name];
    if (!entry) {
      problems.push(`${name}: not in the sanitization manifest`);
      continue;
    }
    const buf = readFileSync(f);
    if (createHash("sha256").update(buf).digest("hex") !== entry.sha256) problems.push(`${name}: changed since its manifest entry (sha256 differs)`);
    if (!/^[0-9a-f]{6}$/i.test(entry.fill ?? "")) problems.push(`${name}: manifest has no fill colour`);
    if (!Array.isArray(entry.labels)) problems.push(`${name}: manifest has no labels list (empty when the frame shows none)`);
    if (entry.avatar !== "absent" && !isRegion(entry.avatar)) problems.push(`${name}: manifest has no avatar region (or "absent")`);
    let png;
    try {
      png = decodePng(buf);
    } catch (e) {
      problems.push(`${name}: ${e.message}`);
      continue;
    }
    if (png.text.length) problems.push(`${name}: carries metadata chunks (${png.text.join(", ")})`);
    if (!/^[0-9a-f]{6}$/i.test(entry.fill ?? "") || !Array.isArray(entry.labels)) continue;
    const regions = [...(entry.avatar === "absent" ? [] : [["avatar", entry.avatar]]), ...entry.labels.map((r, i) => [`label ${i + 1}`, r])];
    for (const [what, r] of regions) {
      const problem = isRegion(r) ? regionProblem(png, r, entry.fill) : "is not a region {x,y,w,h}";
      if (problem) problems.push(`${name}: ${what} ${problem}`);
    }
  }
  for (const name of Object.keys(images)) if (!pngs.some((f) => rel(f) === name)) problems.push(`${name}: in the manifest but not on disk`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.length > 2 ? process.argv.slice(2) : ["."];
  let bad = 0;
  for (const dir of dirs) {
    const problems = checkEvidence(dir);
    for (const p of problems) console.error(`evidence: ${dir}: ${p}`);
    bad += problems.length;
  }
  if (bad) process.exit(1);
  console.log(`evidence: ok (${dirs.join(", ")})`);
}
