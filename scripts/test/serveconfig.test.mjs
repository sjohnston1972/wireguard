import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readAssetsConfig, parseHeaders, parseCsp } from "../lib/serveconfig.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");

const toml = read("wrangler.toml");
const headers = existsSync(root + "web/public/_headers") ? parseHeaders(read("web/public/_headers")) : {};

test("readAssetsConfig reads the [assets] table and stops at the next table", () => {
  const cfg = readAssetsConfig(
    'name = "x"\n[assets]\n# a comment\ndirectory = "d"\nnot_found_handling = "single-page-application"\nrun_worker_first = ["/a/*", "/b"]\n\n[triggers]\ndirectory = "nope"\n',
  );
  assert.deepEqual(cfg, { directory: "d", not_found_handling: "single-page-application", run_worker_first: ["/a/*", "/b"] });
  assert.equal(readAssetsConfig('name = "x"\n'), null);
});

test("parseHeaders turns _headers into {pattern: {name: value}}", () => {
  const h = parseHeaders("# comment\n/*\n  A: 1\n  B: two: three\n\n/x/*\n  C: 3\n");
  assert.deepEqual(h, { "/*": { A: "1", B: "two: three" }, "/x/*": { C: "3" } });
});

test("assets come from web/dist as a single-page app", () => {
  const cfg = readAssetsConfig(toml);
  assert.equal(cfg.directory, "web/dist");
  assert.equal(cfg.not_found_handling, "single-page-application");
});

test("the Worker can reach the built app through the ASSETS binding", () => {
  assert.equal(readAssetsConfig(toml).binding, "ASSETS");
  assert.match(read("worker/src/env.ts"), /^\s+ASSETS\?: Fetcher;/m);
});

test("run_worker_first covers /api/* and the other Worker paths", () => {
  const cfg = readAssetsConfig(toml);
  // /assets/* too: the Worker turns the SPA fallback for a missing hashed file
  // into a 404 (assetguard.ts) instead of index.html under an immutable header.
  assert.deepEqual(
    [...cfg.run_worker_first].sort(),
    ["/__dev/*", "/api/*", "/assets/*", "/captures/*", "/health", "/manifest.webmanifest"],
  );
});

test("CSP: scripts self only, no unsafe-eval, no outside hosts, frame-ancestors none", () => {
  const value = headers["/*"]["Content-Security-Policy"];
  assert.ok(value, "every asset response carries a CSP");
  const csp = parseCsp(value);
  assert.deepEqual(csp["script-src"], ["'self'"]);
  assert.deepEqual(csp["default-src"], ["'self'"]);
  assert.deepEqual(csp["frame-ancestors"], ["'none'"]);
  assert.deepEqual(csp["object-src"], ["'none'"]);
  assert.deepEqual(csp["worker-src"], ["'self'"]);
  assert.ok(!value.includes("unsafe-eval"));
  assert.ok(!/https?:|\*\.|googleapis|gstatic/.test(value), "no outside hosts");
  for (const [dir, sources] of Object.entries(csp)) {
    if (dir === "style-src") assert.deepEqual(sources, ["'self'", "'unsafe-inline'"]);
    else assert.ok(!sources.includes("'unsafe-inline'"), `${dir} allows no inline code`);
  }
  assert.equal(headers["/*"]["X-Frame-Options"], "DENY");
  assert.equal(headers["/*"]["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["/*"]["Referrer-Policy"], "same-origin");
});

test("hashed assets are immutable; index and sw.js are not long-cached", () => {
  assert.equal(headers["/*"]["Cache-Control"], undefined, "index.html keeps the default (revalidate every load)");
  assert.equal(headers["/assets/*"]["Cache-Control"], "public, max-age=31536000, immutable");
  assert.equal(headers["/sw.js"]["Cache-Control"], "no-cache");
  for (const [pattern, h] of Object.entries(headers)) {
    if (pattern !== "/assets/*") assert.ok(!/immutable|max-age=[1-9]/.test(h["Cache-Control"] ?? ""), `${pattern} is not long-cached`);
  }
});

test("the files the app needs at fixed URLs live in web/public; worker/public is gone", () => {
  for (const f of ["sw.js", "icon.svg", "_headers", "icons/icon-192.png", "icons/icon-512.png", "icons/badge-96.png", "icons/apple-touch-icon.png"]) {
    assert.ok(existsSync(root + "web/public/" + f), `web/public/${f}`);
  }
  assert.ok(!existsSync(root + "worker/public"), "worker/public is deleted");
  assert.match(read("web/public/icon.svg"), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test("index.html carries the manifest, icons and installed-app metas, and no inline script or style", () => {
  const html = read("web/index.html");
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials">/);
  assert.match(html, /<link rel="icon" href="\/icon\.svg" type="image\/svg\+xml">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png">/);
  assert.match(html, /<meta name="theme-color" content="#08111c">/);
  for (const m of ["apple-mobile-web-app-capable", "mobile-web-app-capable", "apple-mobile-web-app-title", "apple-mobile-web-app-status-bar-style"]) {
    assert.match(html, new RegExp(`<meta name="${m}" content="[^"]+">`), m);
  }
  assert.ok(!/<style/i.test(html), "no inline style element");
  assert.ok(!/\sstyle=/i.test(html), "no style attribute");
  assert.ok(!/\son[a-z]+=/i.test(html), "no inline event handler");
  for (const s of html.match(/<script\b[^>]*>/gi) ?? []) assert.match(s, /\ssrc="/, "every script is a file");
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(html), "fonts are self-hosted");
});
