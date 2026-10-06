// shared/topology/armTemplate.ts
//
// Plain English: Bicep labs' resources for the planned diagram (lab topology
// spec ruling 24). Filled in by T0.4; until then a template deployment's
// resources are not expanded.

import type { TfInst } from "./rules/planned";

export interface ArmResource {
  type: string;
  name: string;
  dependsOn: string[];
  properties: Record<string, unknown>;
}

export function expandDeployment(_inst: TfInst): ArmResource[] {
  return [];
}
