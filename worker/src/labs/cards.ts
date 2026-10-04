// labs/cards.ts
//
// Plain English: what each catalogue card says beyond lab.yaml (labs spec
// §10, §11.2): its newest release test and whether the current version has
// passed one ("Untested v2" until it has).

import type { Env } from "../env";
import type { LabCard, LabReleaseTest } from "../../../shared/api";
import type { LabDef } from "../../../shared/labs";

interface TestRow {
  lab_id: string;
  version: number;
  at: string;
  run_id: string;
  result: string;
  deploy_seconds: number | null;
  destroy_seconds: number | null;
  est_gbp: number | null;
  leftovers_json: string | null;
}

function testOf(r: TestRow): LabReleaseTest {
  let leftovers: string[] = [];
  try {
    const v = JSON.parse(r.leftovers_json ?? "[]");
    if (Array.isArray(v)) leftovers = v.filter((x): x is string => typeof x === "string");
  } catch {
    leftovers = [];
  }
  return {
    labId: r.lab_id,
    version: r.version,
    at: r.at,
    runId: r.run_id,
    result: r.result === "pass" ? "pass" : "fail",
    clean: leftovers.length === 0 && r.result === "pass",
    deploySeconds: r.deploy_seconds,
    destroySeconds: r.destroy_seconds,
    estGbp: r.est_gbp,
    leftovers,
  };
}

/** Every lab's release tests, newest first. */
export async function releaseTests(env: Env): Promise<LabReleaseTest[]> {
  return (await env.DB.prepare("SELECT * FROM lab_release_tests ORDER BY at DESC").all<TestRow>()).results.map(testOf);
}

/** The card's release-test fields: the newest test, and whether the current version's newest test passed. */
export function releaseFields(def: LabDef, tests: LabReleaseTest[]): Pick<LabCard, "lastReleaseTest" | "released"> {
  const mine = tests.filter((t) => t.labId === def.id);
  const current = mine.find((t) => t.version === def.version);
  return { lastReleaseTest: mine[0] ?? null, released: current?.result === "pass" };
}
