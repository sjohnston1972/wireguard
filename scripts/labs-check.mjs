// scripts/labs-check.mjs   (npm run labs-check [-- --base origin/main])
//
// Plain English: the static checks for every lab (spec §11.1), with no cloud
// calls: each lab.yaml against the schema, readmes, the address pool, each
// lab's Terraform text (no literal CIDRs, provisioners, forbidden providers
// or gateway names; only §3.4 variables) and, with --base, that a lab whose
// folder changed against that git ref bumped its version. Terraform fmt and
// validate live in npm run labs-tf (plan area L1).
//
//   node scripts/labs-check.mjs [--base origin/main]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogue, checkPool, labFolders, lintTfText, variablesProblems, versionProblems } from "./lib/labs.mjs";

const root = fileURLToPath(new URL("../labs/", import.meta.url));
const args = process.argv.slice(2);
const bi = args.indexOf("--base");
const base = bi >= 0 ? args[bi + 1] : null;
if (bi >= 0 && !base) {
  console.error("Usage: node scripts/labs-check.mjs [--base <git ref>]");
  process.exit(2);
}

const lines = [];
const notes = [];
const { catalogue, problems } = buildCatalogue(root);
for (const p of problems) lines.push(`${p.lab ?? "labs"}/${p.file}${p.field ? ` (${p.field})` : ""}: ${p.message}`);
for (const p of checkPool()) lines.push(`pool: ${p}`);

for (const folder of ["_template", ...labFolders(root)]) {
  const tf = join(root, folder, folder === "_template" ? "" : "terraform");
  if (!existsSync(tf)) {
    notes.push(`${folder}: no terraform/ folder yet (the lab cannot deploy until it has one)`);
    continue;
  }
  const files = Object.fromEntries(readdirSync(tf).filter((f) => f.endsWith(".tf")).map((f) => [f, readFileSync(join(tf, f), "utf8")]));
  for (const p of lintTfText(files)) lines.push(`${folder}/${folder === "_template" ? "" : "terraform/"}${p.file}:${p.line} (${p.rule}): ${p.message}`);
  if (files["variables.tf"]) for (const p of variablesProblems(files["variables.tf"])) lines.push(`${folder}/variables.tf: ${p}`);
}

if (base) {
  try {
    for (const p of versionProblems(root, base)) lines.push(`${p.lab}/${p.file} (${p.field}): ${p.message}`);
  } catch (e) {
    lines.push(`--base ${base}: ${e.message}`);
  }
}

for (const n of notes) console.log(`note: ${n}`);
if (lines.length) {
  console.error(`labs-check: ${lines.length} problem(s)`);
  for (const l of lines) console.error(`  ${l}`);
  process.exit(1);
}
console.log(`labs-check: ${catalogue.labs.length} labs, the pool and the template are fine${base ? `; versions checked against ${base}` : ""}.`);
