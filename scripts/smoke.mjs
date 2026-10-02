// scripts/smoke.mjs   (node scripts/smoke.mjs --local http://localhost:8787 | --live https://wg-admin.clydeford.net)
//
// Plain English: after a deploy (or against "npm run dev:api"), asks the site
// a handful of questions a browser, the VM and a phone would ask, and checks
// each answer: deep links get the app with its security headers, hashed files
// are cached for good, sw.js is not, a missing file is never the app's page,
// the API answers JSON, and (live, with no session) Access guards the pages
// while the VM heartbeat and alert buttons still reach the Worker.
// Prints PASS/FAIL per check; exits 1 if any fail. Reads nothing from .env.
//
// Requests go through node:http(s), not fetch: fetch always says
// "Sec-Fetch-Mode: cors", so the assets layer would never treat a deep link
// as a page load. Redirects are not followed (the Access redirect is a check).

import http from "node:http";
import https from "node:https";
import { CHECKS, judge, parseSmokeArgs, requestHeaders, scriptFromIndex } from "./lib/smoke.mjs";

function request(url, check) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method: check.method ?? "GET", headers: requestHeaders(check), timeout: 20_000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const headers = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
        resolve({ status: res.statusCode, headers, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("timeout", () => req.destroy(new Error("no answer in 20 s")));
    req.on("error", reject);
    if (check.body) req.write(check.body);
    req.end();
  });
}

let args;
try {
  args = parseSmokeArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

let indexHtml = null;
let failed = 0;
for (const check of CHECKS[args.mode]) {
  let path = check.path;
  if (check.pathFrom === "indexScript") {
    path = indexHtml ? scriptFromIndex(indexHtml) : null;
    if (!path) {
      console.log(`FAIL ${check.name}: no /assets/*.js script found in / (did the / check pass?)`);
      failed++;
      continue;
    }
  }
  const label = `${check.method ?? "GET"} ${path}`;
  let res;
  try {
    res = await request(args.base + path, check);
  } catch (e) {
    console.log(`FAIL ${check.name} (${label}): ${e.message}`);
    failed++;
    continue;
  }
  if (path === "/" && res.status === 200) indexHtml = res.body;
  const { ok, problems } = judge(check, res);
  if (ok) console.log(`PASS ${check.name} (${label})`);
  else {
    failed++;
    console.log(`FAIL ${check.name} (${label}): ${problems.join("; ")}`);
  }
}

const total = CHECKS[args.mode].length;
console.log(`\n${total - failed}/${total} ${args.mode} checks passed against ${args.base}.`);
process.exit(failed ? 1 : 0);
