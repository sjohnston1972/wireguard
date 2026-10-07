// scripts/labs-build.mjs   (npm run labs-build)
//
// Plain English: turns every labs/<id>/lab.yaml and readme.md, each lab's
// learning content (labs/_learning/<id>.yaml) and its planned diagram's
// resource counts into one file, shared/labs.generated.json (gitignored),
// which the Worker bundles as its lab catalogue. A lab with no learning file
// yet builds with none (labs-check refuses it). A lab with a problem stops the build, so a broken lab can
// never reach the dashboard. npm test, typecheck, build:web, dev, dev:api and
// deploy-worker run this first.
//
//   node scripts/labs-build.mjs

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCatalogue } from "./lib/labs.mjs";

const root = fileURLToPath(new URL("../labs/", import.meta.url));
const out = fileURLToPath(new URL("../shared/labs.generated.json", import.meta.url));

const { catalogue, problems } = buildCatalogue(root);
if (problems.length) {
  console.error(`labs-build: ${problems.length} problem(s); nothing written.`);
  for (const p of problems) console.error(`  ${p.lab ?? "labs"}/${p.file}${p.field ? ` (${p.field})` : ""}: ${p.message}`);
  process.exit(1);
}
writeFileSync(out, JSON.stringify(catalogue, null, 1) + "\n");
console.log(`labs-build: ${catalogue.labs.length} labs -> shared/labs.generated.json`);
