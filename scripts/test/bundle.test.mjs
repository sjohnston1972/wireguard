import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeBundle, entryFiles, LIMITS } from "../lib/bundle.mjs";

const script = fileURLToPath(new URL("../bundle-size.mjs", import.meta.url));
const f = (name, gzip, extra = {}) => ({ name, bytes: gzip * 3, gzip, ...extra });

test("the budget: the page's entry JS 320 kB gzip (ruling 8), all JS 400 kB, CSS 50 kB", () => {
  assert.deepEqual(LIMITS, { entryJsGzip: 320_000, jsGzip: 400_000, cssGzip: 50_000 });
});

test("the entry is index.html's module script and its modulepreloads; lazy chunks and sw.js are not", () => {
  const html = '<script type="module" crossorigin src="/assets/index-a.js"></script><link rel="modulepreload" crossorigin href="/assets/vendor-b.js"><link rel="stylesheet" href="/assets/index-c.css">';
  assert.deepEqual(entryFiles(html), ["assets/index-a.js", "assets/vendor-b.js"]);
  assert.deepEqual(entryFiles("<p>no scripts</p>"), []);
});

test("lazy chunks count toward the JS total but not the entry", () => {
  const r = judgeBundle([f("assets/index-a.js", 300_000, { entry: true }), f("assets/Insights-b.js", 60_000), f("sw.js", 3_000)], LIMITS);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^Entry JS/.test(l) && /300\.0 kB/.test(l) && /320\.0 kB/.test(l)), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^JS total/.test(l) && /363\.0 kB/.test(l) && /400\.0 kB/.test(l)), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.includes("assets/Insights-b.js") && /lazy/.test(l)), "the table marks lazy chunks");
});

test("over the entry budget fails and names only the entry files", () => {
  const r = judgeBundle([f("assets/index-a.js", 321_000, { entry: true }), f("assets/Insights-b.js", 20_000)], LIMITS);
  assert.equal(r.ok, false);
  const fail = r.lines.filter((l) => /^FAIL/.test(l)).join("\n");
  assert.match(fail, /entry JS/);
  assert.match(fail, /assets\/index-a\.js/);
  assert.doesNotMatch(fail, /Insights-b/);
});

test("bundle-size.mjs reads the entry from the built index.html", () => {
  const dir = fakeDist({
    "index.html": '<!doctype html><script type="module" src="/assets/index-a.js"></script>',
    "assets/index-a.js": "import('./Insights-b.js')",
    "assets/Insights-b.js": "export const x = 1",
  });
  try {
    const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /assets\/Insights-b\.js.*lazy/);
    assert.doesNotMatch(r.stdout, /assets\/index-a\.js.*lazy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("under budget passes", () => {
  const r = judgeBundle([f("assets/index-a.js", 279_470, { entry: true }), f("assets/index-b.css", 38_040), f("assets/inter.woff2", 48_000), f("index.html", 400)], LIMITS);
  assert.equal(r.ok, true);
  assert.ok(r.lines.some((l) => /Entry JS/.test(l) && /279\.5 kB/.test(l) && /320\.0 kB/.test(l)), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.includes("assets/index-a.js")), "the table lists each file");
});

test("over the JS total fails and names the files", () => {
  const r = judgeBundle([f("assets/index-a.js", 200_000, { entry: true }), f("assets/vendor-b.js", 210_000), f("assets/index-c.css", 30_000)], LIMITS);
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
