// scripts/lib/smoke.mjs
//
// Plain English: the quick "is the site serving the right thing" checks, as
// data, and the pure judge that marks a response pass or fail. scripts/smoke.mjs
// makes the requests. Two sets:
//   local: against "npm run dev:api" (login bypassed): pages, files, the API.
//   live:  against wg-admin.clydeford.net with no session: Access must guard
//          the pages, and the paths with Access bypass apps (manifest, icons,
//          VM heartbeat, alert buttons) must still reach Cloudflare and the Worker.

const DEEP = "deep link is index.html with CSP and no long cache";

/** What a check expects (every field optional):
 *  status, type (RegExp on Content-Type), notType (RegExp it must not match),
 *  csp (a strict CSP header), cache ("immutable" | "no-cache" | "not-long"),
 *  app (the body is the React app's index.html), json (the body parses),
 *  errorCode (the body is { error: { code } }), redirect (RegExp on Location). */
const deepLink = (path) => ({
  name: DEEP,
  path,
  navigate: true,
  expect: { status: 200, type: /^text\/html/, csp: true, cache: "not-long", app: true },
});

export const CHECKS = {
  local: [
    deepLink("/"),
    deepLink("/clients/3"),
    deepLink("/firewall/rules/1"),
    deepLink("/settings/mobile"),
    { name: "a hashed asset is JavaScript and immutable", pathFrom: "indexScript", dest: "script", expect: { status: 200, type: /javascript/, cache: "immutable" } },
    { name: "a missing asset is not index.html", path: "/assets/nope.js", dest: "script", expect: { status: 404, notType: /^text\/html/ } },
    { name: "sw.js is JavaScript and revalidated every load", path: "/sw.js", dest: "serviceworker", expect: { status: 200, type: /javascript/, cache: "no-cache" } },
    { name: "the manifest is JSON", path: "/manifest.webmanifest", dest: "manifest", expect: { status: 200, type: /json/, json: true } },
    { name: "the app icon is an image", path: "/icons/icon-192.png", dest: "image", expect: { status: 200, type: /^image\// } },
    { name: "the session API answers JSON", path: "/api/v1/session", expect: { status: 200, type: /json/, json: true } },
    { name: "an unknown API path is a JSON 404", path: "/api/v1/nope", expect: { status: 404, type: /json/, errorCode: "not_found" } },
    { name: "the old push API is gone", path: "/api/push/status", expect: { status: 404, notType: /^text\/html/ } },
    { name: "the VM heartbeat route reaches the Worker", method: "POST", path: "/api/agent", headers: { Authorization: "Bearer smoke-test-not-a-token", "Content-Type": "application/json" }, body: "{}", expect: { status: 401, type: /json/, json: true } },
    { name: "a used alert button link is gone", method: "POST", path: "/api/act/nope", expect: { status: 410 } },
  ],
  live: [
    { name: "deep link without a session goes to Access", path: "/clients/3", navigate: true, expect: { status: 302, redirect: /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\// } },
    { name: "the manifest is JSON", path: "/manifest.webmanifest", dest: "manifest", expect: { status: 200, type: /json/, json: true } },
    { name: "the app icon is an image", path: "/icons/icon-192.png", dest: "image", expect: { status: 200, type: /^image\// } },
    { name: "the VM heartbeat route reaches the Worker", method: "POST", path: "/api/agent", headers: { Authorization: "Bearer smoke-test-not-a-token", "Content-Type": "application/json" }, body: "{}", expect: { status: 401, type: /json/, json: true } },
    { name: "a used alert button link is gone", method: "POST", path: "/api/act/nope", expect: { status: 410 } },
  ],
};

/**
 * The headers a browser would send. The assets layer serves index.html for an
 * unknown path only to a navigation (Sec-Fetch-Mode: navigate); Node's fetch
 * always sends "cors" there, which is why smoke.mjs uses node:http instead.
 */
export function requestHeaders(check) {
  const h = { "User-Agent": "wg-admin-smoke", ...(check.headers ?? {}) };
  if (check.navigate) Object.assign(h, { Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "none" });
  else Object.assign(h, { "Sec-Fetch-Mode": check.dest === "image" ? "no-cors" : "cors", "Sec-Fetch-Dest": check.dest ?? "empty", "Sec-Fetch-Site": "same-origin" });
  return h;
}

/** The app's hashed entry script named in index.html, or null. */
export function scriptFromIndex(html) {
  const m = /<script\b[^>]*\bsrc="(\/assets\/[^"]+\.js)"/.exec(html);
  return m ? m[1] : null;
}

/** response: { status, headers: { lower-case name: value }, body: text }. Returns { ok, problems }. */
export function judge(check, response) {
  const e = check.expect;
  const h = response.headers ?? {};
  const type = h["content-type"] ?? "";
  const cache = h["cache-control"] ?? "";
  const problems = [];
  if (e.status !== undefined && response.status !== e.status) problems.push(`status ${response.status}, expected ${e.status}`);
  if (e.type && !e.type.test(type)) problems.push(`Content-Type "${type}" does not match ${e.type}`);
  if (e.notType && e.notType.test(type)) problems.push(`Content-Type "${type}" must not match ${e.notType}`);
  if (e.csp) {
    const csp = h["content-security-policy"] ?? "";
    if (!/script-src 'self'(;|$)/.test(csp) || !/frame-ancestors 'none'/.test(csp)) problems.push(`no strict Content-Security-Policy (got "${csp}")`);
  }
  if (e.cache === "immutable" && !/immutable/.test(cache)) problems.push(`Cache-Control "${cache}" is not immutable`);
  if (e.cache === "no-cache" && !/(^|,\s*)no-cache\b/.test(cache)) problems.push(`Cache-Control "${cache}" is not no-cache`);
  if (e.cache === "not-long" && (/immutable/.test(cache) || /max-age=[1-9]/.test(cache))) problems.push(`Cache-Control "${cache}" caches the page`);
  if (e.app && !/<div id="root">/.test(response.body ?? "")) problems.push("the body is not the app's index.html");
  let parsed;
  if (e.json || e.errorCode) {
    try {
      parsed = JSON.parse(response.body ?? "");
    } catch {
      problems.push("the body is not JSON");
    }
  }
  if (e.errorCode && parsed && parsed.error?.code !== e.errorCode) problems.push(`error code ${JSON.stringify(parsed.error?.code)}, expected "${e.errorCode}"`);
  if (e.redirect && !e.redirect.test(h.location ?? "")) problems.push(`Location "${h.location ?? ""}" does not match ${e.redirect}`);
  return { ok: problems.length === 0, problems };
}

/** `--local <base>` or `--live <base>` (an http(s) URL; a trailing slash is dropped). */
export function parseSmokeArgs(argv) {
  const i = argv.findIndex((a) => a === "--local" || a === "--live");
  if (i === -1) throw new Error("Usage: node scripts/smoke.mjs --local http://localhost:8787 | --live https://wg-admin.clydeford.net");
  const base = argv[i + 1];
  if (!base || !/^https?:\/\/[^/]+/.test(base)) throw new Error(`${argv[i]} needs a base URL such as http://localhost:8787`);
  return { mode: argv[i].slice(2), base: base.replace(/\/+$/, "") };
}
