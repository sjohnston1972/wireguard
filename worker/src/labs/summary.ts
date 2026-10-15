// labs/summary.ts
//
// Plain English: what the existing pages show about labs. GET /overview
// carries `labs` (the banner's "· 2 labs running (£0.12/h)", the topology's
// lab boxes, the runningLabs widget, "Re-peer N labs") and GET /cost carries
// `labs` (the Labs panel: this month per lab). api/overview.ts and api/cost.ts
// only call these two functions. D1 only: never Azure or GitHub. "Re-peer N"
// counts only labs in the server's cloud, the only ones that can peer to it.

import type { Env } from "../env";
import type { LabCostRow, LabsSummary } from "../../../shared/api";
import { activeRuns, liveSessions } from "./store";
import { labSession } from "./view";
import { labCostRows as costRows } from "./cost";
import { headendCloud } from "./engine";
import { cloudOfId } from "../../../shared/labs";

/** OverviewResponse.labs: live sessions oldest first, their £/h, and how many wait to be peered again. */
export async function labsSummary(env: Env, now: Date): Promise<LabsSummary> {
  const [live, runs, hc] = await Promise.all([liveSessions(env), activeRuns(env), headendCloud(env)]);
  const running = live.map((s) => labSession(s, runs.find((r) => r.session_id === s.id) ?? null, now.getTime()));
  return {
    running,
    gbpH: Math.round(live.reduce((n, s) => n + s.est_gbp_h, 0) * 1e6) / 1e6,
    rePeer: live.filter((s) => s.state === "running" && (s.peering === "waiting" || s.peering === "disconnected") && (hc === null || cloudOfId(s.lab_id) === hc)).length,
  };
}

/** CostResponse.labs: this calendar month (UTC) per lab, largest first. */
export async function labCostRows(env: Env, now: Date): Promise<LabCostRow[]> {
  return costRows(env, now);
}
