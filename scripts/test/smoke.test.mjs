import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKS, judge, scriptFromIndex, parseSmokeArgs, requestHeaders } from "../lib/smoke.mjs";

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";
const INDEX = '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-AbC123.js"></script></head><body><div id="root"></div></body></html>';
const r = (status, headers = {}, body = "") => ({ status, headers, body });
const html = (extra = {}) => r(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "public, max-age=0, must-revalidate", ...extra }, INDEX);
const json = (status, body) => r(status, { "content-type": "application/json" }, JSON.stringify(body));

// For every check: a response it must pass and one (or more) it must fail.
const CANNED = {
  "deep link is index.html with CSP and no long cache": {
    pass: html(),
    fail: [html({ "content-security-policy": undefined }), html({ "cache-control": "public, max-age=31536000, immutable" }), r(404, { "content-type": "text/plain" }, "Not found"), r(200, { "content-type": "text/html", "content-security-policy": CSP }, "<p>old page</p>")],
  },
  "a hashed asset is JavaScript and immutable": {
    pass: r(200, { "content-type": "text/javascript", "cache-control": "public, max-age=31536000, immutable" }, "export{}"),
    fail: [r(200, { "content-type": "text/javascript", "cache-control": "public, max-age=0, must-revalidate" }), html({ "cache-control": "public, max-age=31536000, immutable" })],
  },
  "a missing asset is not index.html": {
    pass: r(404, { "content-type": "text/plain" }, "Not found"),
    fail: [html(), r(200, { "content-type": "text/javascript" }, "")],
  },
  "sw.js is JavaScript and revalidated every load": {
    pass: r(200, { "content-type": "application/javascript", "cache-control": "no-cache" }, "self.addEventListener"),
    fail: [r(200, { "content-type": "application/javascript", "cache-control": "public, max-age=14400" }), html({ "cache-control": "no-cache" })],
  },
  "the manifest is JSON": {
    pass: r(200, { "content-type": "application/manifest+json" }, '{"id":"/","scope":"/"}'),
    fail: [html(), r(302, { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" })],
  },
  "the app icon is an image": {
    pass: r(200, { "content-type": "image/png" }, "png"),
    fail: [html(), r(404, {})],
  },
  "the session API answers JSON": {
    pass: json(200, { email: "dev@localhost" }),
    fail: [html(), json(401, { error: { code: "unauthorized" } })],
  },
  "an unknown API path is a JSON 404": {
    pass: json(404, { error: { code: "not_found", message: "No such API route." } }),
    fail: [r(404, { "content-type": "text/plain" }, "Not found"), html()],
  },
  "the old push API is gone": {
    pass: r(404, { "content-type": "text/plain" }, "Not found"),
    fail: [json(200, { registered: false }), html()],
  },
  "the VM heartbeat route reaches the Worker": {
    pass: json(401, { error: "unauthorized" }),
    fail: [html(), r(302, { location: "https://team.cloudflareaccess.com/" }), r(405, {})],
  },
  "a used alert button link is gone": {
    pass: r(410, { "content-type": "text/plain" }, "That button has expired."),
    fail: [html(), r(302, { location: "https://team.cloudflareaccess.com/" })],
  },
  "an old page's htmx request is told to reload": {
    pass: r(200, { "hx-refresh": "true" }, ""),
    fail: [html(), r(405, {}), r(404, { "content-type": "text/plain" }, "Not found"), r(200, { "content-type": "text/html" }, "<p>fragment</p>")],
  },
  "an old page's form post is refused": {
    pass: r(405, {}),
    fail: [html(), r(200, { "hx-refresh": "true" }, ""), r(500, {}), r(404, { "content-type": "text/plain" }, "Not found")],
  },
  "an old page's htmx GET of a page gets the app": {
    pass: html(),
    fail: [r(500, { "content-type": "text/plain" }, "error"), r(200, { "hx-refresh": "true" }, ""), r(200, { "content-type": "text/html", "content-security-policy": CSP }, "<p>fragment</p>"), r(404, { "content-type": "text/plain" }, "Not found")],
  },
  "deep link without a session goes to Access": {
    pass: r(302, { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/wg-admin.example?redirect_url=%2Fclients%2F3" }),
    fail: [html(), r(302, { location: "https://evil.example/cloudflareaccess.com" }), r(200, {})],
  },
};

const all = [...CHECKS.local, ...CHECKS.live];

test("every check has a canned passing and failing response", () => {
  for (const c of all) assert.ok(CANNED[c.name], `no canned responses for "${c.name}"`);
});

for (const [name, { pass, fail }] of Object.entries(CANNED)) {
  test(`judge: ${name}`, () => {
    const checks = all.filter((c) => c.name === name);
    assert.ok(checks.length > 0, "the check exists");
    for (const c of checks) {
      const ok = judge(c, pass);
      assert.equal(ok.ok, true, `${c.path ?? c.pathFrom}: ${ok.problems.join("; ")}`);
      for (const f of fail) {
        const bad = judge(c, f);
        assert.equal(bad.ok, false, `${c.path ?? c.pathFrom} should fail ${JSON.stringify(f)}`);
        assert.ok(bad.problems.length > 0);
      }
    }
  });
}

test("local checks cover the deep links, assets, sw.js, manifest and the APIs", () => {
  const paths = CHECKS.local.map((c) => `${c.method ?? "GET"} ${c.path ?? c.pathFrom}`);
  for (const p of ["GET /clients/3", "GET /firewall/rules/1", "GET /settings/mobile", "GET indexScript", "GET /assets/nope.js", "GET /sw.js", "GET /manifest.webmanifest", "GET /api/v1/session", "GET /api/v1/nope", "GET /api/push/status", "GET /partials/live", "POST /actions/deploy", "POST /peers/1/delete", "GET /firewall"]) {
    assert.ok(paths.includes(p), p);
  }
});

test("live checks need no session: Access for pages, bypass and token routes answer", () => {
  const paths = CHECKS.live.map((c) => `${c.method ?? "GET"} ${c.path}`);
  assert.deepEqual(paths, ["GET /clients/3", "GET /manifest.webmanifest", "GET /icons/icon-192.png", "POST /api/agent", "POST /api/act/nope"]);
  const agent = CHECKS.live.find((c) => c.path === "/api/agent");
  assert.match(agent.headers.Authorization, /^Bearer /);
});

test("the old-page checks that send POSTs or HX requests are local-only; live stays GET/HEAD plus its token routes", () => {
  for (const name of ["an old page's form post is refused", "an old page's htmx GET of a page gets the app"]) {
    assert.ok(CHECKS.local.some((c) => c.name === name), name);
    assert.ok(!CHECKS.live.some((c) => c.name === name), `${name} must not run live`);
  }
});

test("deep links are requested as browser navigations; everything else is not", () => {
  // The assets layer only answers index.html for a navigation (Sec-Fetch-Mode: navigate).
  const deep = CHECKS.local.find((c) => c.path === "/clients/3");
  assert.equal(requestHeaders(deep)["Sec-Fetch-Mode"], "navigate");
  assert.equal(requestHeaders(deep)["Sec-Fetch-Dest"], "document");
  const missing = CHECKS.local.find((c) => c.path === "/assets/nope.js");
  assert.equal(requestHeaders(missing)["Sec-Fetch-Dest"], "script");
  assert.notEqual(requestHeaders(missing)["Sec-Fetch-Mode"], "navigate");
});

test("scriptFromIndex finds the app's hashed script in index.html", () => {
  assert.equal(scriptFromIndex(INDEX), "/assets/index-AbC123.js");
  assert.equal(scriptFromIndex("<p>old dashboard</p>"), null);
});

test("parseSmokeArgs takes --local or --live and a base URL", () => {
  assert.deepEqual(parseSmokeArgs(["--local", "http://localhost:8787/"]), { mode: "local", base: "http://localhost:8787" });
  assert.deepEqual(parseSmokeArgs(["--live", "https://wg-admin.example"]), { mode: "live", base: "https://wg-admin.example" });
  assert.throws(() => parseSmokeArgs([]), /--local/);
  assert.throws(() => parseSmokeArgs(["--live"]), /base/);
  assert.throws(() => parseSmokeArgs(["--live", "wg-admin.example"]), /base/);
});
