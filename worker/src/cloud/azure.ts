// cloud/azure.ts
//
// Plain English: the Azure side of the cloud door. Everything real lives in
// ../azure.ts (insights and labs use it too); this only maps the door's words
// onto it: hibernate = deallocate, resume = start.

import { canAzure } from "../env";
import { azureView, azureInventory, vmPower, setSshAllowedCidr, setPublishedPorts } from "../azure";
import type { CloudOps } from "./index";

export { costMonthToDate, costBreakdownMonthToDate } from "../azure";

export const azureOps: CloudOps = {
  id: "azure",
  label: "Azure",
  configured: canAzure,
  view: azureView,
  inventory: azureInventory,
  power: (env, op) => vmPower(env, op === "hibernate" ? "deallocate" : "start"),
  setSshAllowedCidr,
  setPublishedPorts,
};
