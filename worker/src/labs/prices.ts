// labs/prices.ts
//
// Plain English: what a lab costs an hour (labs spec §9.1): the sum of its
// cost items (gbp_h × qty).

import type { Env } from "../env";
import { estimateGbpH, type LabDef } from "../../../shared/labs";

/** £/h for a lab in a region now. */
export async function labGbpH(_env: Env, def: LabDef, _region: string, _now: Date): Promise<number> {
  return estimateGbpH(def.cost.items);
}
