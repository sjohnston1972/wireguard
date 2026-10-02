import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeBundle, LIMITS } from "../lib/bundle.mjs";

const script = fileURLToPath(new URL("../bundle-size.mjs", import.meta.url));
const f = (name, gzip, extra = {}) => ({ name, bytes: gzip * 3, gzip, ...extra });

test("the budget is ruling 8's: JS 320 kB gzip in total, CSS 50 kB gzip", () => {
  assert.deepEqual(LIMITS, { jsGzip: 320_000, cssGzip: 50_000 });
});

test("under budget passes", () => {
  const r = judgeBundle([f("assets/index-a.js", 279_470), f("assets/index-b.css", 38_040), f("assets/inter.woff2", 48_000), f("index.html", 400)], LIMITS);
  assert.equal(r.ok, true);
  assert.ok(r.lines.some((l) => /JS/.test(l) && /279\.5 kB/.test(l) && /320\.0 kB/.test(l)), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.includes("assets/index-a.js")), "the table lists each file");
});

test("over the JS budget fails and names the files", () => {
  const r = judgeBundle([f("assets/index-a.js", 200_000), f("assets/vendor-b.js", 130_000), f("assets/index-c.css", 30_000)], LIMITS);
  assert.equal(r.ok, false);
  const fail = r.lines.filter((l) => /^FAIL/.test(l)).join("\n");
  assert.match(fail, /JS/);
  assert.match(fail, /assets\/index-a\.js/);
  assert.match(fail, /assets\/vendor-b\.js/);
  assert.doesNotMatch(fail, /index-c\.css/);
});

test("over the CSS budget fails", () => {
  const r = judgeBundle([f("assets/index-a.js", 100_000), f("assets/index-c.css", 50_001)], LIMITS);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /^FAIL/.test(l) && /CSS/.test(l) && /index-c\.css/.test(l)));
});

test("a source map fails", () => {
  const r = judgeBundle([f("assets/index-a.js", 100_000), f("assets/index-a.js.map", 300_000)], LIMITS);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /^FAIL/.test(l) && /source map/.test(l) && /index-a\.js\.map/.test(l)));
});

test("the dev-only gallery in the build fails", () => {
  const r = judgeBundle([f("assets/index-a.js", 100_000, { gallery: true })], LIMITS);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /^FAIL/.test(l) && /__gallery/.test(l) && /index-a\.js/.test(l)));
});

test("a font inlined into the CSS as a data: URI fails (font-src 'self' blocks it)", () => {
  const r = judgeBundle([f("assets/index-a.js", 100_000), f("assets/index-c.css", 30_000, { inlineFont: true })], LIMITS);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /^FAIL/.test(l) && /data: URI/.test(l) && /index-c\.css/.test(l)));
});

test("bundle-size.mjs finds an inlined font in the built CSS", () => {
  const dir = fakeDist({ "index.html": "<!doctype html>", "assets/index-b.css": "@font-face{src:url(data:font/woff2;base64,d09GMg) format(\"woff2\")}" });
  try {
    const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /data: URI/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeDist(files) {
  const dir = mkdtempSync(join(tmpdir(), "bundle-"));
  mkdirSync(join(dir, "assets"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test("bundle-size.mjs exits 0 for a small build and 1 for one carrying the gallery", () => {
  const ok = fakeDist({ "index.html": "<!doctype html>", "assets/index-a.js": "console.log(1)", "assets/index-b.css": "a{}" });
  const bad = fakeDist({ "index.html": "<!doctype html>", "assets/index-a.js": 'route("__gallery")' });
  try {
    const good = spawnSync(process.execPath, [script, ok], { encoding: "utf8" });
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /assets\/index-a\.js/);
    const r = spawnSync(process.execPath, [script, bad], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /__gallery/);
  } finally {
    rmSync(ok, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

test("bundle-size.mjs exits 1 when there is no build", () => {
  const r = spawnSync(process.execPath, [script, join(tmpdir(), "no-such-dist-" + Date.now())], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm run build:web/);
});
