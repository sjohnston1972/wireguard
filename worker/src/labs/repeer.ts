// labs/repeer.ts
//
// Plain English: when the gateway reaches Running again (spec §6), labs that
// asked to peer but could not (waiting), or lost their peering in the last
// gateway tear-down (disconnected), can be peered now. One push says so,
// once per gateway run, with a link to the Labs tab where "Re-peer N labs"
// is one press. It never fails or slows the gateway: runs.ts calls it inside
// its own try/catch, and it only reads D1 and sends one notification.

import type { Env } from "../env";
import * as db from "../db";
import { notify } from "../notify";
import { dashboardButton } from "../actions";

/** Push "Re-peer N labs" once for this gateway run, if any lab is waiting. Returns how many wait. */
export async function rePeerPush(env: Env, gatewayRunId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM lab_sessions WHERE state = 'running' AND peering IN ('waiting', 'disconnected')").first<{ n: number }>();
  const n = Number(r?.n ?? 0);
  if (!n) return 0;
  const key = `labs:repeer-pushed:${gatewayRunId}`;
  if (await env.STATUS.get(key)) return n;
  await env.STATUS.put(key, "1", { expirationTtl: 7 * 86_400 });
  const msg = `The gateway is running again: ${n} lab${n === 1 ? " is" : "s are"} waiting to peer to it. Re-peer ${n} lab${n === 1 ? "" : "s"} from the Labs tab or the Overview.`;
  await db.addAlert(env, "info", msg, gatewayRunId);
  await notify(env, `wg-admin: re-peer ${n} lab${n === 1 ? "" : "s"}`, msg, { tags: ["link"], buttons: [dashboardButton(env, `Re-peer ${n} lab${n === 1 ? "" : "s"}`, "/labs")] });
  return n;
}
