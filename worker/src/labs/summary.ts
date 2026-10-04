// labs/summary.ts
//
// Plain English: what the existing pages show about labs. GET /overview
// carries `labs` (the banner's "· 2 labs running (£0.12/h)", the topology's
// lab boxes, the runningLabs widget, "Re-peer N labs") and GET /cost carries
// `labs` (the Labs panel: this month per lab). api/overview.ts and api/cost.ts
// only call these two functions.
//
// Contract stubs (plan L0): nothing running, nothing spent. The engine (plan
// L2) fills them in from lab_sessions and lab_cost_days, keeping these names
// and signatures.

import type { Env } from "../env";
import type { LabCostRow, LabsSummary } from "../../../shared/api";

/** OverviewResponse.labs. */
export async function labsSummary(_env: Env, _now: Date): Promise<LabsSummary> {
  return { running: [], gbpH: 0, rePeer: 0 };
}

/** CostResponse.labs: this calendar month (UTC) per lab, largest first. */
export async function labCostRows(_env: Env, _now: Date): Promise<LabCostRow[]> {
  return [];
}
