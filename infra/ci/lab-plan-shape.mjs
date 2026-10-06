// infra/ci/lab-plan-shape.mjs
//
// Plain English: a lab's real plan, with every value taken out (labs spec
// §17, ruling 35). lab.yml step 6 runs it on `terraform show -json` and
// prints one line,
//
//   LAB_PLAN_SHAPE <base64 of the gzipped shape JSON>
//
// which scripts/lab-release-test.mjs reads from the run's log and saves as
// scripts/test/fixtures/labs/plans/shapes/<id>.json. The hand-written plan
// fixtures are then checked against it, so a fixture can never again be
// tidier than what Terraform really prints (lab 16's references, lab 6's
// unknown mail nickname).
//
//   node infra/ci/lab-plan-shape.mjs plan.json
//
// The shape: { resources: { "<address>": { type, refs, unknown, sensitive } } }
//   address    every planned resource (instance keys kept) and every data source read
//   refs       { "<attribute path>": [references] }, from the configuration, as
//              Terraform lists them (a nested block's under "block.0.attr")
//   unknown    attribute paths known only after apply (after_unknown), sorted
//   sensitive  attribute paths Terraform marks sensitive, sorted
// Never a value: no names, addresses, tags, passwords or keys. Exit 0 with the
// line; exit 2 (no line) when the plan cannot be read. Plain Node, no packages
// (the runner has Node; npm ci is not run), as lab-scope.mjs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const stripIndex = (address) => address.replace(/\[[^\]]*\]$/, "");

/** Every "references" list under a configuration expression, by path: { "a": [...], "b.0.c": [...] }. */
function refPaths(expr, path, out) {
  if (Array.isArray(expr)) {
    expr.forEach((e, i) => refPaths(e, [...path, i], out));
    return out;
  }
  if (!expr || typeof expr !== "object") return out;
  if (Array.isArray(expr.references) && path.length) out[path.join(".")] = [...expr.references];
  for (const [k, v] of Object.entries(expr)) if (k !== "references" && k !== "constant_value") refPaths(v, [...path, k], out);
  return out;
}

/** The paths whose leaf is `true` in an after_unknown or after_sensitive tree, sorted. */
function truePaths(tree) {
  const out = [];
  const walk = (v, path) => {
    if (v === true) {
      if (path.length) out.push(path.join("."));
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
  };
  walk(tree, []);
  return out.sort();
}

function moduleResources(mod, out = []) {
  for (const r of mod?.resources ?? []) out.push(r);
  for (const c of mod?.child_modules ?? []) moduleResources(c, out);
  return out;
}

/** A `terraform show -json` plan's shape (above): addresses, references, unknown and sensitive paths, no values. */
export function planShape(plan) {
  const config = new Map((plan?.configuration?.root_module?.resources ?? []).map((r) => [r.address, r]));
  const refsOf = (address) => refPaths(config.get(stripIndex(address))?.expressions ?? {}, [], {});
  const resources = {};
  for (const c of plan?.resource_changes ?? []) {
    if (!c?.address) continue;
    resources[c.address] = { type: c.type, refs: refsOf(c.address), unknown: truePaths(c.change?.after_unknown), sensitive: truePaths(c.change?.after_sensitive) };
  }
  // Data sources read at plan live in prior_state, not resource_changes.
  for (const r of moduleResources(plan?.prior_state?.values?.root_module)) {
    if (r?.mode !== "data" || !r.address || resources[r.address]) continue;
    resources[r.address] = { type: r.type, refs: refsOf(r.address), unknown: [], sensitive: truePaths(r.sensitive_values) };
  }
  const sorted = Object.fromEntries(Object.keys(resources).sort().map((a) => [a, resources[a]]));
  return { resources: sorted };
}

/** The line lab.yml prints: LAB_PLAN_SHAPE <base64 of the gzipped shape JSON>. */
export const shapeLine = (plan) => `LAB_PLAN_SHAPE ${gzipSync(JSON.stringify(planShape(plan))).toString("base64")}`;

function main(argv) {
  const file = argv[0];
  if (!file) {
    console.error("Usage: node infra/ci/lab-plan-shape.mjs <terraform show -json file>");
    return 2;
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    // Never the file's text: it holds sensitive values in the clear.
    console.error(`lab-plan-shape: cannot read ${file} as JSON (${e.name})`);
    return 2;
  }
  console.log(shapeLine(plan));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
