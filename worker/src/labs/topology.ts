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
// Cache: this isolate's memory, 30 s per lab and session, with requests in
// flight shared; nothing is written to KV (a diagram open for an hour would
// spend 120 of KV's daily writes). The answer is always a status:
//   ok            the live graph
//   not_running   no live session (the app never asks then)
//   no_azure      Azure is not configured (under `wrangler dev` with
//                 AUTH_DEV_BYPASS, the seeded rows in KV labs:topology:dev
//                 stand in, so the screens show a live diagram)
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

/** How long one lab's live graph is reused (per session, per isolate). */
export const TOPOLOGY_CACHE_MS = 30_000;

const cache = new Map<string, { at: number; response: LabTopologyResponse }>();
const inflight = new Map<string, Promise<LabTopologyResponse>>();

/** Tests: forget every cached graph. */
export function resetTopologyCache(): void {
  cache.clear();
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
    });
  } catch {
    return answer("failed", "Azure did not answer the diagram's read. Showing the planned diagram.");
  }
  if (r.status === 429) {
    const last = cache.get(`${s.lab_id}:${s.id}`)?.response;
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
  const live = liveGraph(rows, ctxOf(s, at));
  return answer("ok", truncated ? TRUNCATED : null, { live, fetchedAt: at, truncated });
}

/**
 * The live diagram of `labId` (a catalogue id: the route checks) for its live
 * session, from this isolate's cache when it is under 30 s old.
 */
export async function labTopology(env: Env, labId: string, now: number = Date.now()): Promise<LabTopologyResponse> {
  const s = await liveSessionOf(env, labId);
  if (!s) return answer("not_running", "The lab is not running, so there is no live diagram.");
  if (!canAzure(env)) {
    const rows = env.AUTH_DEV_BYPASS === "1" ? await devRows(env, labId) : null;
    if (!rows) return answer("no_azure", "Azure is not connected, so the diagram shows the plan.");
    const at = new Date(now).toISOString();
    return answer("ok", null, { live: liveGraph(rows, ctxOf(s, at)), fetchedAt: at });
  }
  const key = `${labId}:${s.id}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TOPOLOGY_CACHE_MS) return hit.response;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = fetchLive(env, s, now)
    .then((response) => {
      if (response.status === "ok") {
        // Ended sessions' graphs are let go (kept a while for a 429's fallback).
        for (const [k, v] of cache) if (now - v.at > 20 * TOPOLOGY_CACHE_MS) cache.delete(k);
        cache.set(key, { at: now, response });
      }
      return response;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
