// labs/warnings.ts
//
// Plain English: the deploy modal's warnings (labs spec §9.2).

import type { Env } from "../env";
import type { LabDef } from "../../../shared/labs";
import type { LabWarning } from "../../../shared/api";

export async function labWarnings(_env: Env, _def: LabDef, _o: { hours: number; region: string }): Promise<LabWarning[]> {
  return [];
}
