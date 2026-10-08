// labs/topology.ts
//
// Plain English: a running lab's live diagram (lab topology spec §6). One
// Azure Resource Graph query (shared/topology/query.ts) lists what is in the
// lab's own groups, rg-lab-<id> and rg-lab-<id>-*, in the configured
// subscription only; liveGraph (shared/topology/live.ts) re-checks every
// row's group with ownsName, derives the graph and scrubs it, so no raw
// properties ever leave. At most two outside calls per refresh (a sign-in
// when the token has expired, and the query), through directNet like the
// dashboard's other reads.
//
// Cache: this isolate's memory, 30 s per lab and session (failures too), with requests in
// flight shared, keyed by the data source first ("real:" / "demo:", topologyCacheKey) so a
// demo answer and a real one can never share an entry; nothing is written to KV (a diagram open for an hour would
// spend 120 of KV's daily writes). The answer is always a status:
//   ok            the live graph
//   not_running   no live session (the app never asks then)
//   no_azure      Azure is not configured (under `wrangler dev` with
//                 AUTH_DEV_BYPASS, or in demo mode's store, the seeded rows in
//                 KV labs:topology:dev stand in, so the screens show a live
//                 diagram; devmarks.ts standInsAllowed)
//   failed        ARM refused or did not answer (a plain message, no body)
//   throttled     429: the last graph this isolate had, if any
// Anything but ok means the app shows the planned graph with a banner.

import type { Env } from "../env";
import { canAzure } from "../env";
import type { LabTopologyResponse } from "../../../shared/api";
import { ARG_API, ARG_TOP, topologyRequest } from "../../../shared/topology/query";
import { liveGraph, type ArgRow, type LiveCtx } from "../../../shared/topology/live";
import { catalogue } from "./catalogue";
import { arm, directNet } from "./net";
import { liveSessionOf, type LabSessionRow } from "./store";
import { LABS_KV } from "../devseed-labs";
import { standInsAllowed } from "../devmarks";
import { isDemoEnv } from "../demo/env";

/** How long one lab's live graph is reused (per session, per isolate). */
export const TOPOLOGY_CACHE_MS = 30_000;

/** How long the Resource Graph read may take before the diagram falls back to the plan. */
export const TOPOLOGY_TIMEOUT_MS = 10_000;

/** The last answer (ok or failed), reused for 30 s. */
const cache = new Map<string, { at: number; response: LabTopologyResponse }>();
/** The last ok answer, for a 429's fallback (a cached failure must not lose it). */
const lastGood = new Map<string, { at: number; response: LabTopologyResponse }>();
const inflight = new Map<string, Promise<LabTopologyResponse>>();

/** The cache key: the data source first (demo mode spec §9.10), then the lab and its session. */
export function topologyCacheKey(env: Env, labId: string, sessionId: string): string {
  return `${isDemoEnv(env) ? "demo" : "real"}:${labId}:${sessionId}`;
}

/** Tests: forget every cached graph. */
export function resetTopologyCache(): void {
  cache.clear();
  lastGood.clear();
  inflight.clear();
}

const answer = (status: LabTopologyResponse["status"], message: string | null, extra: Partial<LabTopologyResponse> = {}): LabTopologyResponse => ({ status, message, live: null, fetchedAt: null, truncated: false, ...extra });

const TRUNCATED = `Showing the first ${ARG_TOP} resources: the lab has more.`;

function ctxOf(s: LabSessionRow, at: string): LiveCtx {
  return {
    labId: s.lab_id,
    version: Number(s.lab_version),
    namePrefix: s.name_prefix,
    region: s.region,
    secondaryRegion: s.secondary_region ?? null,
    catalogueIds: catalogue().labs.map((l) => l.id),
    gatewayVnetId: null,
    at,
  };
}

/** The seeded rows for `wrangler dev` (scenario labs), or null. */
async function devRows(env: Env, labId: string): Promise<ArgRow[] | null> {
  try {
    const all = await env.STATUS.get<Record<string, ArgRow[]>>(LABS_KV.topologyDev, "json");
    return all?.[labId] ?? null;
  } catch {
    return null;
  }
}

async function fetchLive(env: Env, s: LabSessionRow, now: number): Promise<LabTopologyResponse> {
  const at = new Date(now).toISOString();
  let r: Response;
  try {
    r = await arm(env, directNet(), `/providers/Microsoft.ResourceGraph/resources?api-version=${ARG_API}`, {
      method: "POST",
      body: JSON.stringify(topologyRequest(env.AZURE_SUBSCRIPTION_ID ?? "", s.lab_id)),
      signal: AbortSignal.timeout(TOPOLOGY_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return answer("failed", `Azure did not answer the diagram's read within ${TOPOLOGY_TIMEOUT_MS / 1000} s. Showing the planned diagram.`);
    return answer("failed", "Azure did not answer the diagram's read. Showing the planned diagram.");
  }
  if (r.status === 429) {
    const last = lastGood.get(topologyCacheKey(env, s.lab_id, s.id))?.response;
    return answer("throttled", "Azure is busy (too many requests). Showing the last diagram it gave.", last?.live ? { live: last.live, fetchedAt: last.fetchedAt, truncated: last.truncated } : {});
  }
  if (!r.ok) {
    const why = r.status === 403 ? "Azure refused the diagram's read (403): the dashboard's identity cannot read Resource Graph." : `Azure answered ${r.status} to the diagram's read.`;
    return answer("failed", `${why} Showing the planned diagram.`);
  }
  let data: { data?: unknown; $skipToken?: unknown };
  try {
    data = (await r.json()) as { data?: unknown; $skipToken?: unknown };
  } catch {
    return answer("failed", "Azure's answer to the diagram's read was not readable. Showing the planned diagram.");
  }
  const rows = Array.isArray(data.data) ? (data.data as ArgRow[]) : [];
  const truncated = typeof data.$skipToken === "string" && data.$skipToken !== "";
  const built = build(rows, ctxOf(s, at));
  if ("failed" in built) return built.failed;
  return answer("ok", truncated ? TRUNCATED : null, { live: built.live, fetchedAt: at, truncated });
}

/** liveGraph, with a builder error answered as failed (its reason kept), never a 500. */
function build(rows: ArgRow[], ctx: LiveCtx): { live: ReturnType<typeof liveGraph> } | { failed: LabTopologyResponse } {
  try {
    return { live: liveGraph(rows, ctx) };
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160) || "unknown error";
    console.error(`labs topology: the live builder failed for ${ctx.labId}: ${reason}`);
    return { failed: answer("failed", `The live diagram could not be drawn from Azure's answer (${reason}). Showing the planned diagram.`) };
  }
}

/**
 * The live diagram of `labId` (a catalogue id: the route checks) for its live
 * session, from this isolate's cache when it is under 30 s old.
 */
export async function labTopology(env: Env, labId: string, now: number = Date.now()): Promise<LabTopologyResponse> {
  const s = await liveSessionOf(env, labId);
  if (!s) return answer("not_running", "The lab is not running, so there is no live diagram.");
  if (!canAzure(env)) {
    const rows = standInsAllowed(env) ? await devRows(env, labId) : null;
    if (!rows) return answer("no_azure", "Azure is not connected, so the diagram shows the plan.");
    const at = new Date(now).toISOString();
    const built = build(rows, ctxOf(s, at));
    return "failed" in built ? built.failed : answer("ok", null, { live: built.live, fetchedAt: at });
  }
  const key = topologyCacheKey(env, labId, s.id);
  const hit = cache.get(key);
  if (hit && now - hit.at < TOPOLOGY_CACHE_MS) return hit.response;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = fetchLive(env, s, now)
    .then((response) => {
      // A failure is cached too, so an open diagram does not hammer a failing Azure (it asks again after 30 s).
      if (response.status === "ok" || response.status === "failed") {
        // Ended sessions' graphs are let go (the last good one kept a while for a 429's fallback).
        for (const m of [cache, lastGood]) for (const [k, v] of m) if (now - v.at > 20 * TOPOLOGY_CACHE_MS) m.delete(k);
        cache.set(key, { at: now, response });
        if (response.status === "ok") lastGood.set(key, { at: now, response });
      }
      return response;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
