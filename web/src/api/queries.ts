import { useQuery, type QueryKey, type UseQueryResult } from "@tanstack/react-query";
import type {
  ActivityResponse,
  AzureChangesRange,
  AzureChangesResponse,
  AzureChangesWho,
  AzureMetricsResource,
  AzureMetricsResponse,
  AzureServiceHealthRange,
  AzureServiceHealthResponse,
  AzureSummaryResponse,
  BootLogResponse,
  CapacityCheck,
  PriceInfo,
  LabCoverageResponse,
  LabDetail,
  LabSession,
  LabSessionsResponse,
  LabsResponse,
  ClientDetailResponse,
  ClientHistoryResponse,
  ClientsResponse,
  CostResponse,
  FirewallResponse,
  OverviewResponse,
  PushStatusResponse,
  RunDetailResponse,
  RuleHistoryResponse,
  RunLogResponse,
  SessionResponse,
  SettingsResponse,
  VmHistoryResponse,
} from "@shared/api";
import { apiGet } from "./client";

// One hook per read endpoint. A new endpoint is one line with `endpoint(...)`:
//   export const useThing = endpoint<ThingResponse, [id: number]>((id) => ({ key: ["thing", id], path: `/thing/${id}`, every: 30_000 }));

/** Refresh intervals in ms (spec section 10). */
export const INTERVALS = {
  overview: 15_000,
  /** The overview while a deploy, tear-down or power operation is in progress. */
  busy: 5_000,
  clients: 15_000,
  firewall: 15_000,
  activity: 30_000,
  cost: 60_000,
  settings: 60_000,
  history: 60_000,
  session: 60_000,
  run: 5_000,
  /** The Azure summary (feeds, health, vitals, the Service Health pill), on Overview and in the shell. */
  azure: 30_000,
  /** Azure metrics, the change log and Service Health: collected every 5 to 15 minutes, so a minute is plenty. */
  azureData: 60_000,
  /** The Labs tab (GET /labs, /labs/:id); `busy` while a lab deploys, tears down or runs a peer, unpeer or test. */
  labs: 15_000,
  /** Lab history and coverage. */
  labsHistory: 60_000,
} as const;

export interface QueryOpts {
  /** Set false to hold the request (for example until a menu opens). */
  enabled?: boolean;
}

interface Spec {
  key: QueryKey;
  path: string;
  /** A fixed interval, or a function of the data so far (false stops polling). */
  every?: number | false | ((data: never) => number | false);
  enabled?: boolean;
}

/** Build a typed hook for a read endpoint. Polling pauses while the tab is hidden (client default). */
export function endpoint<T, A extends unknown[] = []>(spec: (...args: A) => Spec) {
  return (...args: [...A, QueryOpts?]): UseQueryResult<T> => {
    const maybeOpts = args[args.length - 1];
    const hasOpts = args.length > 0 && typeof maybeOpts === "object" && maybeOpts !== null && !Array.isArray(maybeOpts) && "enabled" in (maybeOpts as object);
    const opts = (hasOpts ? maybeOpts : undefined) as QueryOpts | undefined;
    const specArgs = (hasOpts ? args.slice(0, -1) : args) as unknown as A;
    const s = spec(...specArgs);
    const every = s.every;
    return useQuery<T>({
      queryKey: s.key,
      queryFn: () => apiGet<T>(s.path),
      enabled: (s.enabled ?? true) && (opts?.enabled ?? true),
      refetchInterval: typeof every === "function" ? (q) => every(q.state.data as never) : every,
    });
  };
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? "?" + s : "";
};

// ── Overview and the polling rule ──

const BUSY_STATES = new Set(["deploying", "destroying", "hibernating", "resuming"]);

/** True while a deploy, tear-down, hibernate or resume is in progress. */
export const isBusyState = (state: string | undefined): boolean => !!state && BUSY_STATES.has(state);

/** 5 s while a run or power operation is in progress, else 15 s. */
export function overviewInterval(data: OverviewResponse | undefined): number {
  return isBusyState(data?.snapshot?.state) ? INTERVALS.busy : INTERVALS.overview;
}
export const activityInterval = () => INTERVALS.activity;

export const useSession = endpoint<SessionResponse>(() => ({ key: ["session"], path: "/session", every: INTERVALS.session }));
export const useOverview = endpoint<OverviewResponse>(() => ({ key: ["overview"], path: "/overview", every: overviewInterval }));

// ── History (fetched on range change, then every 60 s) ──

export type HistoryRange = "1h" | "24h" | "7d" | "30d";
export type HistoryParams = { scope: "vm"; range: HistoryRange } | { scope: "client"; id: number; range: HistoryRange };

export function useHistory(p: Extract<HistoryParams, { scope: "vm" }>, o?: QueryOpts): UseQueryResult<VmHistoryResponse>;
export function useHistory(p: Extract<HistoryParams, { scope: "client" }>, o?: QueryOpts): UseQueryResult<ClientHistoryResponse>;
export function useHistory(p: HistoryParams, o?: QueryOpts): UseQueryResult<VmHistoryResponse | ClientHistoryResponse> {
  const path = "/history" + (p.scope === "client" ? qs({ scope: "client", id: p.id, range: p.range }) : qs({ scope: "vm", range: p.range }));
  return useHist(p, path, o);
}
/**
 * One firewall counter's hits for a range: `key` is "r<rule id>", "f<published
 * port id>" or "default". Fetched on range change, then every 60 s.
 */
export function useRuleHistory(key: string, range: HistoryRange, o?: QueryOpts): UseQueryResult<RuleHistoryResponse> {
  return useQuery({
    queryKey: ["history", { scope: "rule", id: key, range }],
    queryFn: () => apiGet<RuleHistoryResponse>("/history" + qs({ scope: "rule", id: key, range })),
    refetchInterval: INTERVALS.history,
    enabled: o?.enabled ?? true,
  });
}

const useHist = (p: HistoryParams, path: string, o?: QueryOpts) =>
  useQuery({
    queryKey: ["history", p],
    queryFn: () => apiGet<VmHistoryResponse | ClientHistoryResponse>(path),
    refetchInterval: INTERVALS.history,
    enabled: o?.enabled ?? true,
  });

// ── Clients, firewall, activity, runs, cost, settings, push ──

export const useClients = endpoint<ClientsResponse>(() => ({ key: ["clients"], path: "/clients", every: INTERVALS.clients }));
export const useClient = endpoint<ClientDetailResponse, [id: number]>((id) => ({ key: ["clients", id], path: `/clients/${id}`, every: INTERVALS.clients }));
export const useFirewall = endpoint<FirewallResponse>(() => ({ key: ["firewall"], path: "/firewall", every: INTERVALS.firewall }));

export interface ActivityParams {
  range: "1h" | "6h" | "24h" | "7d" | "30d";
  kind?: string;
  q?: string;
  page?: number;
}
export const useActivity = endpoint<ActivityResponse, [p: ActivityParams]>((p) => ({
  key: ["activity", p],
  path: "/activity" + qs({ range: p.range, kind: p.kind, q: p.q, page: p.page }),
  every: INTERVALS.activity,
}));

/** A run's detail; polls every 5 s while it is the run in progress. */
export const useRun = endpoint<RunDetailResponse, [id: string]>((id) => ({
  key: ["runs", id],
  path: `/runs/${encodeURIComponent(id)}`,
  every: (d: RunDetailResponse | undefined) => (d?.active ? INTERVALS.run : false),
}));
/** A run's log, fetched on demand from GitHub; set `live` while the run is active to refresh every 5 s. */
export const useRunLog = endpoint<RunLogResponse, [id: string, live?: boolean]>((id, live) => ({
  key: ["runs", id, "log"],
  path: `/runs/${encodeURIComponent(id)}/log`,
  every: live ? INTERVALS.run : false,
}));

export type CostRange = "month" | "7d" | "30d";
export const useCost = endpoint<CostResponse, [range: CostRange]>((range) => ({ key: ["cost", range], path: "/cost" + qs({ range }), every: INTERVALS.cost }));
export const useSettings = endpoint<SettingsResponse>(() => ({ key: ["settings"], path: "/settings", every: INTERVALS.settings }));
export const usePushStatus = endpoint<PushStatusResponse, [endpoint: string]>((ep) => ({ key: ["push", ep], path: "/push/status" + qs({ endpoint: ep }), every: false }));

// ── Azure insights (spec 2026-10-04-azure-insights-design.md, section 8) ──
// Every query key starts with "azure". The routes read D1 only, so polling never reaches Azure.

/** GET /azure/summary every 30 s. On an error the last answer stays (React Query keeps data). */
export const useAzureSummary = endpoint<AzureSummaryResponse>(() => ({ key: ["azure", "summary"], path: "/azure/summary", every: INTERVALS.azure }));
/** GET /azure/metrics for one resource and range, every 60 s. */
export const useAzureMetrics = endpoint<AzureMetricsResponse, [resource: AzureMetricsResource, range: HistoryRange]>((resource, range) => ({
  key: ["azure", "metrics", resource, range],
  path: "/azure/metrics" + qs({ resource, range }),
  every: INTERVALS.azureData,
}));
/** GET /azure/changes, every 60 s. */
export const useAzureChanges = endpoint<AzureChangesResponse, [range: AzureChangesRange, who: AzureChangesWho]>((range, who) => ({
  key: ["azure", "changes", range, who],
  path: "/azure/changes" + qs({ range, who }),
  every: INTERVALS.azureData,
}));
/** GET /azure/service-health, every 60 s. */
export const useAzureServiceHealth = endpoint<AzureServiceHealthResponse, [range: AzureServiceHealthRange]>((range) => ({
  key: ["azure", "serviceHealth", range],
  path: "/azure/service-health" + qs({ range }),
  every: INTERVALS.azureData,
}));
/** GET /azure/capacity for a deploy target; held until both a region and a size are given. Refetched with the settings (60 s). */
export const useCapacity = endpoint<CapacityCheck, [region: string | null | undefined, size: string | null | undefined]>((region, size) => ({
  key: ["azure", "capacity", region ?? "", size ?? ""],
  path: "/azure/capacity" + qs({ region: region ?? undefined, size: size ?? undefined }),
  every: INTERVALS.settings,
  enabled: !!region && !!size,
}));
/** GET /azure/price for a region and size; held until both are given. */
export const usePrice = endpoint<PriceInfo, [region: string | null | undefined, size: string | null | undefined]>((region, size) => ({
  key: ["azure", "price", region ?? "", size ?? ""],
  path: "/azure/price" + qs({ region: region ?? undefined, size: size ?? undefined }),
  every: INTERVALS.settings,
  enabled: !!region && !!size,
}));
/** GET /azure/bootlog: the last stored boot log, fetched when asked for (no polling). useFetchBootLog (mutations.ts) fetches a new one. */
export const BOOTLOG_KEY = ["azure", "bootlog"] as const;
export const useBootLog = endpoint<BootLogResponse>(() => ({ key: BOOTLOG_KEY, path: "/azure/bootlog", every: false }));

// ── Labs (labs spec §7.2, plan L0). Every key starts "labs", so one invalidation refreshes them all. ──

/** A session is busy while it deploys or tears down, or has a run going (peer, unpeer, test). */
const labBusy = (s: LabSession | null | undefined): boolean => !!s && (s.state === "deploying" || s.state === "tearing_down" || s.activeRun !== null);

/** GET /labs: every 5 s while any live session is busy, else 15 s. */
export function labsInterval(data: LabsResponse | undefined): number {
  return data?.running.some(labBusy) ? INTERVALS.busy : INTERVALS.labs;
}
/** GET /labs/:id: every 5 s while its session is busy, else 15 s. */
export function labDetailInterval(data: LabDetail | undefined): number {
  return labBusy(data?.session) ? INTERVALS.busy : INTERVALS.labs;
}

export const useLabs = endpoint<LabsResponse>(() => ({ key: ["labs"], path: "/labs", every: labsInterval }));
export const useLab = endpoint<LabDetail, [id: string]>((id) => ({ key: ["labs", id], path: `/labs/${encodeURIComponent(id)}`, every: labDetailInterval }));
/** GET /labs/sessions, newest first; `lab` narrows to one lab; `limit` 1 to 200 (default 50). Every 60 s. */
export const useLabSessions = endpoint<LabSessionsResponse, [lab?: string, limit?: number]>((lab, limit = 50) => ({
  key: ["labs", "sessions", lab ?? "", limit],
  path: "/labs/sessions" + qs({ lab, limit }),
  every: INTERVALS.labsHistory,
}));
/** GET /labs/coverage, every 60 s. */
export const useLabCoverage = endpoint<LabCoverageResponse>(() => ({ key: ["labs", "coverage"], path: "/labs/coverage", every: INTERVALS.labsHistory }));
