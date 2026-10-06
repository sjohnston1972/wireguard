// scripts/test/fixtures/labs/plans/shape.mjs
//
// Plain English: a plan fixture checked against the lab's real plan (labs
// spec §17, ruling 35). Each release test records the real plan's shape
// (infra/ci/lab-plan-shape.mjs in lab.yml step 6, saved by
// scripts/lab-release-test.mjs as shapes/<id>.json): every address, the
// references each attribute makes, and which paths are unknown or sensitive,
// never a value. lab-plans.test.mjs compares that with planShape() of the
// fixture.
//
//   planShape(plan)              the shape of a `terraform show -json` plan
//   recordedShape(id, dir?)      shapes/<id>.json, or null when none is recorded yet
//   compareShapes(real, fixture) one line per difference ([] when they agree);
//                                references are compared as sets (Terraform's
//                                order is its own), everything else exactly

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { planShape } from "../../../../../infra/ci/lab-plan-shape.mjs";

export { planShape };

/** Where release tests save each lab's real plan shape. */
export const SHAPES = fileURLToPath(new URL("./shapes/", import.meta.url));

export function recordedShape(id, dir = SHAPES) {
  const file = join(dir, `${id}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

const sameSet = (a = [], b = []) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const missing = (from, to) => from.filter((x) => !to.includes(x));

export function compareShapes(real, fixture) {
  const out = [];
  const r = real?.resources ?? {};
  const f = fixture?.resources ?? {};
  for (const a of Object.keys(r)) if (!f[a]) out.push(`${a}: in the real plan, not in the fixture`);
  for (const a of Object.keys(f)) if (!r[a]) out.push(`${a}: in the fixture, not in the real plan`);
  for (const a of Object.keys(r).filter((x) => f[x]).sort()) {
    const x = r[a];
    const y = f[a];
    if (x.type !== y.type) out.push(`${a}: type ${x.type} in the real plan, ${y.type} in the fixture`);
    for (const attr of [...new Set([...Object.keys(x.refs ?? {}), ...Object.keys(y.refs ?? {})])].sort()) {
      const rx = x.refs?.[attr] ?? [];
      const ry = y.refs?.[attr] ?? [];
      if (!sameSet(rx, ry)) out.push(`${a}: ${attr} references ${JSON.stringify(rx)} in the real plan, ${JSON.stringify(ry)} in the fixture`);
    }
    for (const k of ["unknown", "sensitive"]) {
      const only = missing(x[k] ?? [], y[k] ?? []);
      const extra = missing(y[k] ?? [], x[k] ?? []);
      if (only.length || extra.length) out.push(`${a}: ${k} paths differ${only.length ? `; only the real plan has ${only.join(", ")}` : ""}${extra.length ? `; only the fixture has ${extra.join(", ")}` : ""}`);
    }
  }
  return out;
}
