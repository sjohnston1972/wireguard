// scripts/bundle-size.mjs   (npm run bundle-size [-- <dist dir>])
//
// Plain English: after "npm run build:web", checks the built app is within its
// size budget (JS 320 kB and CSS 50 kB, gzipped), carries no source maps,
// does not include the dev-only component gallery and has no font inlined as
// a data: URI (the CSP only allows fonts from the site itself). Prints a table; exits 1 on
// any problem, so "npm run deploy-worker" stops before publishing.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { judgeBundle, LIMITS } from "./lib/bundle.mjs";

const dist = process.argv[2] ?? "web/dist";
if (!existsSync(join(dist, "index.html"))) {
  console.error(`No build in ${dist}. Run "npm run build:web" first.`);
  process.exit(1);
}

const files = [];
for (const e of readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!e.isFile()) continue;
  const full = join(e.parentPath ?? e.path, e.name);
  const buf = readFileSync(full);
  files.push({
    name: relative(dist, full).split("\\").join("/"),
    bytes: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    gallery: buf.includes("__gallery"),
    inlineFont: e.name.endsWith(".css") && /data:(font\/|application\/(x-)?font)/.test(buf.toString("utf8")),
  });
}

const { ok, lines } = judgeBundle(files, LIMITS);
console.log(lines.join("\n"));
if (!ok) process.exit(1);
console.log("Bundle within budget.");
