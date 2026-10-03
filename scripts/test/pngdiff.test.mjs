import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodePng, diffPng, diffDirs } from "../lib/pngdiff.mjs";

const script = fileURLToPath(new URL("../shots-diff.mjs", import.meta.url));

// ── A small PNG writer for the tests (8-bit, no interlace) ────────────────

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
/**
 * Encode `px` (rows of [r,g,b] or [r,g,b,a]) as a PNG. `filters` gives the
 * filter type for each row (cycles), so every one of the five is exercised.
 */
function encodePng(px, { alpha = true, filters = [0] } = {}) {
  const h = px.length;
  const w = px[0].length;
  const bpp = alpha ? 4 : 3;
  const raw = [];
  let prev = new Uint8Array(w * bpp);
  for (let y = 0; y < h; y++) {
    const line = new Uint8Array(w * bpp);
    px[y].forEach((p, x) => line.set(p.slice(0, bpp), x * bpp));
    const f = filters[y % filters.length];
    const out = new Uint8Array(line.length);
    for (let i = 0; i < line.length; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      out[i] = (line[i] - pred) & 0xff;
    }
    raw.push(Buffer.from([f]), Buffer.from(out));
    prev = line;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  const idat = deflateSync(Buffer.concat(raw));
  // Split the image data over two IDAT chunks, as real encoders may.
  const mid = idat.length >> 1;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat.subarray(0, mid)), chunk("IDAT", idat.subarray(mid)), chunk("IEND", Buffer.alloc(0))]);
}
/** A w x h image with a different colour per pixel, so any decoding slip shows. */
function picture(w, h, alpha = true) {
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => [(x * 37 + y * 11) & 0xff, (x * 5 + y * 71) & 0xff, (x * y * 3 + 9) & 0xff, alpha ? (200 + x + y) & 0xff : 255]));
}

test("pngdiff: identical images pass, one changed pixel fails with its box", () => {
  const px = picture(9, 7);
  const a = encodePng(px);
  assert.deepEqual(diffPng(a, encodePng(px)), { same: true, count: 0, box: null, reason: null });
  const changed = px.map((r) => r.map((p) => [...p]));
  changed[4][6] = [1, 2, 3, 255];
  const d = diffPng(a, encodePng(changed));
  assert.equal(d.same, false);
  assert.equal(d.count, 1);
  assert.deepEqual(d.box, { x: 6, y: 4, width: 1, height: 1 });
  const two = changed.map((r) => r.map((p) => [...p]));
  two[1][2] = [0, 0, 0, 0];
  assert.deepEqual(diffPng(a, encodePng(two)).box, { x: 2, y: 1, width: 5, height: 4 });
});

test("pngdiff: different sizes fail", () => {
  const d = diffPng(encodePng(picture(4, 4)), encodePng(picture(5, 4)));
  assert.equal(d.same, false);
  assert.match(d.reason, /4x4.*5x4/);
});

test("pngdiff: reads RGB and RGBA 8-bit PNGs", () => {
  const px = picture(6, 10, false);
  // Every row filter: None, Sub, Up, Average, Paeth.
  const rgb = decodePng(encodePng(px, { alpha: false, filters: [0, 1, 2, 3, 4] }));
  assert.equal(rgb.width, 6);
  assert.equal(rgb.height, 10);
  assert.equal(rgb.data.length, 6 * 10 * 4);
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 6; x++) {
      const i = (y * 6 + x) * 4;
      assert.deepEqual([...rgb.data.subarray(i, i + 4)], [px[y][x][0], px[y][x][1], px[y][x][2], 255], `rgb pixel ${x},${y}`);
    }
  const pxa = picture(6, 10, true);
  const rgba = decodePng(encodePng(pxa, { alpha: true, filters: [4, 3, 2, 1, 0] }));
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 6; x++) {
      const i = (y * 6 + x) * 4;
      assert.deepEqual([...rgba.data.subarray(i, i + 4)], pxa[y][x], `rgba pixel ${x},${y}`);
    }
  // The same picture written two ways compares equal.
  assert.equal(diffPng(encodePng(pxa, { filters: [0] }), encodePng(pxa, { filters: [4, 1] })).same, true);
});

test("pngdiff: refuses what it cannot read, by name", () => {
  assert.throws(() => decodePng(Buffer.from("not a png")), /not a PNG/);
  const png = encodePng(picture(2, 2));
  png[24] = 16; // bit depth 16
  assert.throws(() => decodePng(png), /bit depth 16/);
});

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "wg-pngdiff-"));
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a);
  mkdirSync(b);
  return { root, a, b };
}

test("diffDirs pairs shots by name: same, different and missing on either side", () => {
  const { root, a, b } = dirs();
  try {
    const px = picture(5, 5);
    const other = px.map((r) => r.map((p) => [...p]));
    other[0][0] = [9, 9, 9, 9];
    writeFileSync(join(a, "same.png"), encodePng(px));
    writeFileSync(join(b, "same.png"), encodePng(px));
    writeFileSync(join(a, "diff.png"), encodePng(px));
    writeFileSync(join(b, "diff.png"), encodePng(other));
    writeFileSync(join(a, "only-a.png"), encodePng(px));
    writeFileSync(join(b, "only-b.png"), encodePng(px));
    writeFileSync(join(b, "report.json"), "{}");
    const r = diffDirs(a, b);
    assert.equal(r.ok, false);
    const by = Object.fromEntries(r.files.map((f) => [f.file, f]));
    assert.deepEqual(Object.keys(by).sort(), ["diff.png", "only-a.png", "only-b.png", "same.png"]);
    assert.equal(by["same.png"].same, true);
    assert.equal(by["diff.png"].count, 1);
    assert.match(by["only-a.png"].reason, /missing/);
    assert.match(by["only-b.png"].reason, /missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm run shots:diff exits 0 for identical folders and 1 on any difference, naming the file and box", () => {
  const { root, a, b } = dirs();
  try {
    const px = picture(5, 5);
    writeFileSync(join(a, "x.png"), encodePng(px));
    writeFileSync(join(b, "x.png"), encodePng(px));
    const ok = spawnSync(process.execPath, [script, a, b], { encoding: "utf8", timeout: 20_000 });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /1\/1 identical/);
    const other = px.map((r) => r.map((p) => [...p]));
    other[3][2] = [0, 0, 0, 0];
    writeFileSync(join(b, "x.png"), encodePng(other));
    const bad = spawnSync(process.execPath, [script, a, b], { encoding: "utf8", timeout: 20_000 });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /x\.png.*1 pixel.*2,3 1x1/);
    const usage = spawnSync(process.execPath, [script, a], { encoding: "utf8", timeout: 20_000 });
    assert.equal(usage.status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
