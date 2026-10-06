// scripts/bundle-size.mjs   (npm run bundle-size [-- <dist dir>])
//
// Plain English: after "npm run build:web", checks the built app is within its
// size budget, gzipped: 320 kB for the JS every page load fetches (index.html's
// module script plus the chunks it preloads), 450 kB for all JS including the
// chunks loaded only when needed (the Azure insights widgets, the lab diagram
// with @xyflow/react), 50 kB of CSS, 16 kB per planned lab diagram (the
// assets/*.json files) and 60 kB for the Azure icon sprite (see
// scripts/lib/bundle.mjs). Also that no entry file mentions @xyflow or
// react-flow__ (the diagram stays lazy), that it carries no source maps,
// does not include the dev-only component gallery and has no font inlined as
// a data: URI (the CSP only allows fonts from the site itself). Prints a table; exits 1 on
// any problem, so "npm run deploy-worker" stops before publishing.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { entryFiles, FORBIDDEN_IN_ENTRY, judgeBundle, LIMITS } from "./lib/bundle.mjs";

const dist = process.argv[2] ?? "web/dist";
if (!existsSync(join(dist, "index.html"))) {
  console.error(`No build in ${dist}. Run "npm run build:web" first.`);
  process.exit(1);
}

const entry = new Set(entryFiles(readFileSync(join(dist, "index.html"), "utf8")));
const files = [];
for (const e of readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!e.isFile()) continue;
  const full = join(e.parentPath ?? e.path, e.name);
  const buf = readFileSync(full);
  const name = relative(dist, full).split("\\").join("/");
  files.push({
    name,
    entry: entry.has(name),
    bytes: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    gallery: buf.includes("__gallery"),
    inlineFont: e.name.endsWith(".css") && /data:(font\/|application\/(x-)?font)/.test(buf.toString("utf8")),
    forbidden: e.name.endsWith(".js") ? FORBIDDEN_IN_ENTRY.filter((s) => buf.includes(s)) : [],
  });
}

const { ok, lines } = judgeBundle(files, LIMITS);
console.log(lines.join("\n"));
if (!ok) process.exit(1);
console.log("Bundle within budget.");
