// api/topology.ts
//
// Plain English: the lab diagram's data (lab topology spec §5, §6.3, §8.3).
// Kept out of queries.ts on purpose: only the lazy diagram chunk imports this
// module, so the entry never carries it (nor the planned files' URL map).
//
// - usePlannedTopology(id): the lab's planned graph, a hashed static asset
//   (shared/topology/planned/<id>.json, emitted by Vite as a file, never JS),
//   fetched once and cached for the visit.
// - useLabTopology(id, { enabled }): the live graph while a session runs,
//   every 30 s only while a diagram is mounted and the tab visible (the
//   query client never polls in the background).
// - useTopologyLayoutQuery(id) / putTopologyLayout(id, body): the person's
//   saved arrangement of the lab's diagram (ui_prefs page topology:<id>).

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { LabTopologyResponse } from "@shared/api";
import type { TopologyGraph } from "@shared/topology/model";
import type { TopologyLayoutPage, TopologyLayoutPutBody } from "@shared/topology/layout";
import { apiGet, apiSend, type SendOptions } from "./client";

/** The live diagram's refresh, and how long an answer stays fresh (the Worker caches 30 s too). */
export const TOPOLOGY_REFRESH_MS = 30_000;

// Eager, as URLs: one small map in this chunk; lazy globs would make one JS chunk per lab.
const files = import.meta.glob<string>("../../../shared/topology/planned/*.json", { query: "?url", import: "default", eager: true });

/** Lab id → the hashed URL of its planned graph. */
export const PLANNED_URLS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(files).map(([path, url]) => [path.split("/").at(-1)!.replace(/\.json$/, ""), url])),
);

/** The URL of a lab's planned graph, or null when there is none. */
export function plannedTopologyUrl(id: string, urls: Readonly<Record<string, string>> = PLANNED_URLS): string | null {
  return Object.hasOwn(urls, id) ? urls[id]! : null;
}

/** A lab's planned graph, fetched once per visit. `urls` is for tests and the dev gallery. */
export function usePlannedTopology(id: string, urls: Readonly<Record<string, string>> = PLANNED_URLS): UseQueryResult<TopologyGraph> {
  return useQuery<TopologyGraph>({
    queryKey: ["labs", id, "planned-topology"],
    queryFn: async () => {
      const url = plannedTopologyUrl(id, urls);
      if (!url) throw new Error(`No planned diagram for ${id}.`);
      const r = await fetch(url, { credentials: "same-origin" });
      if (!r.ok) throw new Error(`The planned diagram did not load (${r.status}).`);
      return (await r.json()) as TopologyGraph;
    },
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** The live graph of a running lab; `enabled: false` when there is no live session (nothing is asked). */
export function useLabTopology(id: string, opts: { enabled: boolean }): UseQueryResult<LabTopologyResponse> {
  return useQuery<LabTopologyResponse>({
    queryKey: ["labs", id, "topology"],
    queryFn: () => apiGet<LabTopologyResponse>(`/labs/${encodeURIComponent(id)}/topology`),
    enabled: opts.enabled,
    staleTime: TOPOLOGY_REFRESH_MS,
    refetchInterval: TOPOLOGY_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
}

/** The person's saved arrangement of a lab's diagram (version 0: never saved). */
export function useTopologyLayoutQuery(id: string, opts: { enabled?: boolean } = {}): UseQueryResult<TopologyLayoutPage> {
  return useQuery<TopologyLayoutPage>({
    queryKey: ["prefs", "topology", id],
    queryFn: () => apiGet<TopologyLayoutPage>(`/prefs/topology/${encodeURIComponent(id)}`),
    enabled: opts.enabled ?? true,
    staleTime: Infinity,
  });
}

/** Save a lab's arrangement made on `body.baseVersion`; answers the page as stored (409 stale: another device saved). */
export function putTopologyLayout(id: string, body: TopologyLayoutPutBody, opts?: SendOptions): Promise<TopologyLayoutPage> {
  return apiSend<TopologyLayoutPage>("PUT", `/prefs/topology/${encodeURIComponent(id)}`, body, opts);
}
