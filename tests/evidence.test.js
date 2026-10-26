// The evidence-image policy (scripts/check-evidence.mjs): a PNG without a sanitization manifest, a region that is
// not a solid fill, a stale hash, a missing avatar/labels field or metadata fails. Images are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { checkEvidence } from "../scripts/check-evidence.mjs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, body) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
};
/** An RGB PNG whose pixels come from `pixel(x, y) -> [r, g, b]`; `filter` is the PNG row filter type to use. */
function png(width, height, pixel, { text = false, filter = 0 } = {}) {
  const rows = [];
  let previous = Buffer.alloc(width * 3);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * 3);
    for (let x = 0; x < width; x++) row.set(pixel(x, y), x * 3);
    const out = Buffer.alloc(width * 3 + 1);
    out[0] = filter;
    for (let i = 0; i < row.length; i++) {
      const a = i >= 3 ? row[i - 3] : 0;
      const b = previous[i];
      out[i + 1] = (filter === 1 ? row[i] - a : filter === 2 ? row[i] - b : row[i]) & 255;
    }
    rows.push(out);
    previous = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...(text ? [chunk("tEXt", Buffer.from("a\0b"))] : []), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
const GRAY = [0x5a, 0x5a, 0x5a];
const noise = (x, y) => [(x * 37 + y * 11) & 255, (x * 5 + y * 91) & 255, (x ^ y) & 255];
const sha = (b) => createHash("sha256").update(b).digest("hex");
const AVATAR = { x: 2, y: 2, w: 6, h: 6 };
const LABEL = { x: 10, y: 10, w: 8, h: 4 };
const inside = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const filled = (...regions) => (x, y) => (regions.some((r) => inside(r, x, y)) ? GRAY : noise(x, y));

function evidence(files, manifest) {
  const dir = mkdtempSync(join(tmpdir(), "gs-evidence-"));
  for (const [name, buf] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), buf);
  }
  if (manifest !== undefined) writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}
const entry = (buf, extra = {}) => ({ sha256: sha(buf), avatar: AVATAR, labels: [LABEL], fill: "5a5a5a", ...extra });
const good = () => png(24, 20, filled(AVATAR, LABEL));
const run = (files, manifest) => {
  const dir = evidence(files, manifest);
  try {
    return checkEvidence(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a PNG with solid avatar and label regions and a matching manifest entry passes (including filtered rows)", () => {
  const a = good();
  const b = png(24, 20, filled(AVATAR, LABEL), { filter: 1 });
  const c = png(24, 20, filled(AVATAR, LABEL), { filter: 2 });
  assert.deepEqual(run({ "a.png": a, "d/b.png": b, "d/c.png": c }, { images: { "a.png": entry(a), "d/b.png": entry(b), "d/c.png": entry(c) } }), []);
  const bare = png(24, 20, noise);
  assert.deepEqual(run({ "x.png": bare }, { images: { "x.png": entry(bare, { avatar: "absent", labels: [] }) } }), []);
});

test("a PNG added without a manifest, or missing from it, fails", () => {
  assert.match(run({ "a.png": good() })[0], /no sanitization manifest/);
  const a = good();
  assert.match(run({ "a.png": a, "b.png": good() }, { images: { "a.png": entry(a) } }).join("\n"), /b\.png: not in the sanitization manifest/);
});

test("a manifest entry without an avatar field or labels list fails", () => {
  const a = good();
  const { avatar, ...noAvatar } = entry(a);
  assert.match(run({ "a.png": a }, { images: { "a.png": noAvatar } }).join("\n"), /no avatar region/);
  const { labels, ...noLabels } = entry(a);
  assert.match(run({ "a.png": a }, { images: { "a.png": noLabels } }).join("\n"), /no labels list/);
});

test("a declared region that is not a solid fill (a blur, a missed spot) fails, and so does one outside the image", () => {
  const blurred = png(24, 20, (x, y) => (inside(AVATAR, x, y) ? GRAY : inside(LABEL, x, y) && x === LABEL.x ? [0x5b, 0x5a, 0x5a] : noise(x, y)));
  assert.match(run({ "a.png": blurred }, { images: { "a.png": entry(blurred) } }).join("\n"), /label 1 is not a solid #5a5a5a fill/);
  const unfilled = png(24, 20, noise);
  assert.match(run({ "a.png": unfilled }, { images: { "a.png": entry(unfilled) } }).join("\n"), /avatar is not a solid/);
  const a = good();
  assert.match(run({ "a.png": a }, { images: { "a.png": entry(a, { labels: [{ x: 20, y: 18, w: 8, h: 8 }] }) } }).join("\n"), /outside the image/);
});

test("an image changed after its manifest entry, a stale entry, other formats and metadata chunks fail", () => {
  const a = good();
  const edited = png(24, 20, filled(AVATAR, LABEL, { x: 0, y: 0, w: 1, h: 1 }));
  assert.match(run({ "a.png": edited }, { images: { "a.png": entry(a) } }).join("\n"), /sha256 differs/);
  assert.match(run({ "a.png": a }, { images: { "a.png": entry(a), "gone.png": entry(a) } }).join("\n"), /gone\.png: in the manifest but not on disk/);
  assert.match(run({ "shot.jpg": Buffer.from("x") }).join("\n"), /only PNG evidence/);
  const withText = png(24, 20, filled(AVATAR, LABEL), { text: true });
  assert.match(run({ "a.png": withText }, { images: { "a.png": entry(withText) } }).join("\n"), /metadata chunks/);
});

test("the repository itself carries no unmanifested image", () => {
  assert.doesNotThrow(() => execFileSync("node", ["scripts/check-evidence.mjs"], { stdio: "pipe" }));
});
