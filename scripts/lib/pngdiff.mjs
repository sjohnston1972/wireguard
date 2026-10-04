// scripts/lib/pngdiff.mjs
//
// Plain English: compares two screenshots pixel by pixel. It reads PNG files
// itself (Node's built-in zlib does the unpacking; nothing to install) and
// answers how many pixels differ and the smallest box around them. Used by
// "npm run shots:diff" to prove a change left every screen exactly as it was.
//
// Reads what the screenshot tool writes: 8-bit RGB or RGBA (also 8-bit grey
// and grey+alpha), not interlaced. Anything else is refused by name.

import { inflateSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Channels per pixel for each colour type we read. */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** A PNG file's pixels as RGBA bytes, row by row. */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") ihdr = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!ihdr) throw new Error("not a PNG file (no IHDR)");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colour = ihdr[9];
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not supported (8 only)`);
  if (!(colour in CHANNELS)) throw new Error(`PNG colour type ${colour} is not supported (grey, RGB, grey+alpha, RGBA)`);
  if (ihdr[12] !== 0) throw new Error("interlaced PNGs are not supported");
  const bpp = CHANNELS[colour];
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is cut short");

  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const f = raw[at];
    for (let i = 0; i < stride; i++) {
      const x = raw[at + 1 + i];
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) v = x + paeth(a, b, c);
      else throw new Error(`PNG row ${y} has unknown filter ${f}`);
      line[i] = v & 0xff;
    }
    for (let px = 0; px < width; px++) {
      const s = px * bpp;
      const d = (y * width + px) * 4;
      if (bpp === 4 || bpp === 3) {
        out[d] = line[s];
        out[d + 1] = line[s + 1];
        out[d + 2] = line[s + 2];
        out[d + 3] = bpp === 4 ? line[s + 3] : 255;
      } else {
        out[d] = out[d + 1] = out[d + 2] = line[s];
        out[d + 3] = bpp === 2 ? line[s + 1] : 255;
      }
    }
    [prev, line] = [line, prev];
  }
  return { width, height, data: out };
}

/**
 * Two PNG files compared. `count` is how many pixels differ, `box` the
 * smallest rectangle holding them all ({x, y, width, height}), `reason` why
 * they could not be compared pixel for pixel (different sizes).
 */
export function diffPng(bufA, bufB) {
  const a = decodePng(bufA);
  const b = decodePng(bufB);
  if (a.width !== b.width || a.height !== b.height) {
    return { same: false, count: null, box: null, reason: `sizes differ: ${a.width}x${a.height} and ${b.width}x${b.height}` };
  }
  let count = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < da.length; i += 4) {
    if (da[i] === db[i] && da[i + 1] === db[i + 1] && da[i + 2] === db[i + 2] && da[i + 3] === db[i + 3]) continue;
    count++;
    const p = i >> 2;
    const x = p % a.width;
    const y = (p - x) / a.width;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (count === 0) return { same: true, count: 0, box: null, reason: null };
  return { same: false, count, box: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }, reason: null };
}

/** Every .png in two folders, paired by file name. A file on one side only is a difference. */
export function diffDirs(dirA, dirB) {
  for (const d of [dirA, dirB]) if (!existsSync(d)) throw new Error(`No such folder: ${d}`);
  const pngs = (d) => new Set(readdirSync(d).filter((f) => f.toLowerCase().endsWith(".png")));
  const a = pngs(dirA);
  const b = pngs(dirB);
  const files = [];
  for (const file of [...new Set([...a, ...b])].sort()) {
    if (!a.has(file)) files.push({ file, same: false, count: null, box: null, reason: `missing from ${dirA}` });
    else if (!b.has(file)) files.push({ file, same: false, count: null, box: null, reason: `missing from ${dirB}` });
    else {
      try {
        files.push({ file, ...diffPng(readFileSync(join(dirA, file)), readFileSync(join(dirB, file))) });
      } catch (e) {
        files.push({ file, same: false, count: null, box: null, reason: e.message });
      }
    }
  }
  return { ok: files.length > 0 && files.every((f) => f.same), files };
}
