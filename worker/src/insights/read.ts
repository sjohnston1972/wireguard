// insights/read.ts
//
// Plain English: what the /api/v1/azure routes answer, read from D1 and the
// snapshot only (never Azure). "No data" is null, never 0.

import type { Env, Config } from "../env";
import type { Snapshot } from "../state";
import type { AgentVitals, AzureChangeRow, AzureChangesRange, AzureChangesWho, AzureHealth, AzureMetricsResource, AzureSummaryResponse, FeedId, FeedState, FeedStatus, ScheduledEvent } from "../../../shared/api";
import { AZURE_METRICS, FEEDS, PIP_COLUMNS, VITALS_COLUMNS, VM_COLUMNS } from "../../../shared/azureMetrics";
import { RANGE_MS, RANGE_STEP, RAW_RES, SUMMARY_RES, type HistoryRange } from "../history";
import { azureRegionName } from "../region";
import { insightsConfigured, type HealthDoc, type MetricDefsDoc } from "./types";
import { MIN, getLatest, readFeedRows, slotOf, type FeedRow } from "./common";
import { activityCadence, healthAnnotations, lastRunEnd } from "./feeds/activity";
import { activeRegionalIssues } from "./feeds/serviceHealth";
import { DEVSEED_KV, devSeeded } from "../devmarks";

const STATES: readonly FeedState[] = ["ok", "error", "not_configured", "skipped", "idle"];
/** How old the newest metric slot may be to count as "latest". */
const LATEST_MS = 30 * MIN;
const ANNOTATIONS = 5;
/** Agents from this version send vitals. */
export const VITALS_AGENT_VERSION = 7;

/**
 * Whether the screens show Azure's stored data as connected. Yes with the four
 * service principal values (insightsConfigured). On a developer's PC only
 * also when a dev seed left feeds that worked (npm run seed -- insights or
 * everything), so the Azure widgets can be seen filled on a dev server run
 * from .env.example: that needs the login bypass AND the marker only the
 * locked seed route writes (devmarks.ts), so the bypass set on the live Worker
 * by mistake, with stale ok rows, still reads as not connected. Nothing is
 * ever fetched on the strength of this: every fetch asks insightsConfigured.
 */
export async function insightsShown(env: Env, feeds: Map<string, FeedRow>): Promise<boolean> {
  if (insightsConfigured(env)) return true;
  return [...feeds.values()].some((r) => r.status === "ok") && (await devSeeded(env, DEVSEED_KV.insights));
}

/** Every feed's status, in priority order, with the activity feed's current cadence. */
export async function feedStatuses(env: Env, snap: Snapshot, now: Date, rows?: Map<string, FeedRow>): Promise<(FeedStatus & { lastTryAt: string | null; nextDueAt: string | null })[]> {
  const have = rows ?? (await readFeedRows(env.DB));
  const configured = await insightsShown(env, have);
  const activity = activityCadence(snap, await lastRunEnd(env.DB), now.getTime());
  return FEEDS.map((f) => {
    const r = have.get(f.id);
    const stored = STATES.includes(r?.status as FeedState) ? (r!.status as FeedState) : "idle";
    return {
      id: f.id,
      title: f.title,
      status: configured ? stored : "not_configured",
      lastOkAt: r?.last_ok_at ?? null,
      error: configured ? r?.error ?? null : null,
      cadenceMin: f.id === "activity" ? activity : f.cadenceMin,
      lastTryAt: r?.last_try_at ?? null,
      nextDueAt: r?.next_due_at ?? null,
    };
  });
}

export async function feedStatus(env: Env, snap: Snapshot, id: FeedId, now: Date): Promise<FeedStatus> {
  const { lastTryAt: _t, nextDueAt: _n, ...f } = (await feedStatuses(env, snap, now)).find((x) => x.id === id)!;
  return f;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The heartbeat's vitals as the app reads them; null for an old agent, no VM or no vitals. */
export function agentVitals(snap: Snapshot): AgentVitals | null {
  const a = snap.agent;
  const v = a?.vitals;
  if (snap.state !== "running" || !a || !v || (a.agent_version ?? 0) < VITALS_AGENT_VERSION) return null;
  const load = Number(String(a.load ?? "").trim().split(/\s+/)[0]);
  return {
    at: snap.last_agent_at ?? a.at,
    memUsedPct: v.mem && v.mem.total > 0 ? round1(((v.mem.total - v.mem.available) / v.mem.total) * 100) : null,
    diskUsedPct: v.disk && v.disk.total > 0 ? round1((v.disk.used / v.disk.total) * 100) : null,
    diskFreeBytes: v.disk ? v.disk.avail : null,
    load1: a.load !== undefined && a.load !== "" && Number.isFinite(load) ? load : null,
    ncpu: v.cpu?.ncpu ?? null,
    stealPct: v.cpu?.steal_pct ?? null,
    uptimeS: Number.isFinite(a.uptime_seconds) ? a.uptime_seconds : null,
    conntrack: v.conntrack ? { count: v.conntrack.count, max: v.conntrack.max } : null,
    updates: v.updates ? { pending: v.updates.pending, security: v.updates.security, at: v.updates.at } : null,
    net: v.net ? { at: v.net.at, method: v.net.method, targets: v.net.targets.map((t) => ({ ip: t.ip, rttMs: t.rtt_ms, lossPct: t.loss_pct })) } : null,
  };
}

/** Azure's scheduled events for this VM (from the heartbeat), soonest first. */
export function maintenance(snap: Snapshot): ScheduledEvent[] {
  if (snap.state !== "running") return [];
  const items = snap.agent?.vitals?.events?.items ?? [];
  return items
    .filter((e) => e.self)
    .map((e) => ({ id: e.id, type: e.type, status: e.status, notBefore: e.not_before, source: e.source, description: e.description, durationS: e.duration_s }))
    .sort((a, b) => (a.notBefore ?? "9999").localeCompare(b.notBefore ?? "9999"));
}

function agentState(snap: Snapshot): AzureSummaryResponse["agent"] {
  if (snap.state !== "running" || !snap.agent) return "none";
  return (snap.agent.agent_version ?? 0) >= VITALS_AGENT_VERSION ? "current" : "needsDeploy";
}

/** How far back the credit trend looks, the least time it needs between two readings, and the change that counts. */
const TREND_MS = 60 * MIN;
const TREND_SPAN_MS = 10 * MIN;
const TREND_CREDITS = 1;

/**
 * Where the CPU credits have gone in the hour up to the newest slot `t`: the
 * newest reading against the oldest one in that hour, if it is at least 10
 * minutes older. A B1s earns about 6 credits an hour at idle, so a move of
 * more than 1 credit is a direction; less is flat. Null with too few readings.
 */
async function creditsTrend(db: D1Database, t: string, newest: number): Promise<"falling" | "flat" | "rising" | null> {
  const at = Date.parse(t);
  const first = await db
    .prepare("SELECT t, credits_min FROM hist_az_vm WHERE res = 300 AND t >= ?1 AND t <= ?2 AND credits_min IS NOT NULL ORDER BY t LIMIT 1")
    .bind(slotOf(at - TREND_MS), slotOf(at - TREND_SPAN_MS))
    .first<{ t: string; credits_min: number }>();
  if (!first) return null;
  const change = newest - first.credits_min;
  return change < -TREND_CREDITS ? "falling" : change > TREND_CREDITS ? "rising" : "flat";
}

async function latest(db: D1Database, now: Date): Promise<AzureSummaryResponse["latest"]> {
  const since = slotOf(now.getTime() - LATEST_MS);
  const vm = await db.prepare("SELECT t, cpu_avg, credits_min, mem_free_min FROM hist_az_vm WHERE res = 300 AND t >= ?1 ORDER BY t DESC LIMIT 1").bind(since).first<{ t: string; cpu_avg: number | null; credits_min: number | null; mem_free_min: number | null }>();
  const pip = await db.prepare("SELECT t, vip_avail, ddos_max FROM hist_az_pip WHERE res = 300 AND t >= ?1 ORDER BY t DESC LIMIT 1").bind(since).first<{ t: string; vip_avail: number | null; ddos_max: number | null }>();
  return {
    cpuPct: vm?.cpu_avg ?? null,
    creditsLeft: vm?.credits_min ?? null,
    creditsTrend: vm && vm.credits_min !== null ? await creditsTrend(db, vm.t, vm.credits_min) : null,
    memFreeBytes: vm?.mem_free_min ?? null,
    vipAvailPct: pip?.vip_avail ?? null,
    underDdos: pip && pip.ddos_max !== null ? pip.ddos_max >= 1 : null,
    at: vm?.t ?? pip?.t ?? null,
  };
}

async function health(env: Env, snap: Snapshot): Promise<AzureHealth | null> {
  if (snap.state === "destroyed") return null;
  const doc = await getLatest<HealthDoc>(env.DB, "health");
  if (!doc?.doc || typeof doc.doc !== "object") return null;
  return { ...doc.doc, annotations: await healthAnnotations(env.DB, ANNOTATIONS) };
}

export async function readSummary(env: Env, cfg: Config, snap: Snapshot, now: Date): Promise<AzureSummaryResponse> {
  const name = azureRegionName(cfg.region);
  const rows = await readFeedRows(env.DB);
  return {
    configured: await insightsShown(env, rows),
    region: { id: cfg.region, name },
    feeds: (await feedStatuses(env, snap, now, rows)).map(({ lastTryAt: _t, nextDueAt: _n, ...f }) => f),
    health: await health(env, snap),
    maintenance: maintenance(snap),
    serviceIssues: await activeRegionalIssues(env.DB, name),
    vitals: agentVitals(snap),
    agent: agentState(snap),
    latest: await latest(env.DB, now),
  };
}

// ── Metrics ──────────────────────────────────────────────────────────────

/** The SQL aggregate per stored column: averages average, peaks take the max, minimums the min; totals and rates average, so they stay "per 5-minute slot" (or per second) at every range. */
function aggregateOf(column: string): string {
  const m = AZURE_METRICS.find((x) => x.column === column);
  const fn = m?.aggregation === "Maximum" ? "MAX" : m?.aggregation === "Minimum" ? "MIN" : "AVG";
  return `${fn}(${column}) AS ${column}`;
}
const VITALS_AGG: Record<string, string> = { steal_pct: "MAX", net_loss_pct: "MAX" };
const POINT = `strftime('%Y-%m-%dT%H:%M:%SZ', (CAST(strftime('%s', t) AS INTEGER) / CAST(?3 AS INTEGER)) * CAST(?3 AS INTEGER), 'unixepoch')`;

export async function readMetrics(db: D1Database, resource: AzureMetricsResource, range: HistoryRange, now: Date): Promise<{ step: number; columns: string[]; points: Record<string, number | string | null>[] }> {
  const cols: readonly string[] = resource === "vm" ? VM_COLUMNS : resource === "pip" ? PIP_COLUMNS : VITALS_COLUMNS;
  const step = resource === "vitals" ? RANGE_STEP[range] : Math.max(300, RANGE_STEP[range]);
  const from = slotOf(now.getTime() - RANGE_MS[range], step);
  const to = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  let sql: string;
  if (resource === "vitals") {
    sql = `SELECT ${POINT} AS t, ${cols.map((c) => `${VITALS_AGG[c] ?? "AVG"}(${c}) AS ${c}`).join(", ")} FROM hist_vm
      WHERE res IN (${RAW_RES}, ${SUMMARY_RES}) AND t >= ?1 AND t <= ?2 AND (${cols.map((c) => `${c} IS NOT NULL`).join(" OR ")}) GROUP BY 1 ORDER BY 1`;
  } else {
    sql = `SELECT ${POINT} AS t, ${cols.map(aggregateOf).join(", ")} FROM ${resource === "vm" ? "hist_az_vm" : "hist_az_pip"}
      WHERE res = 300 AND t >= ?1 AND t <= ?2 GROUP BY 1 ORDER BY 1`;
  }
  const points = (await db.prepare(sql).bind(from, to, step).all<Record<string, number | string | null>>()).results;
  return { step, columns: ["t", ...cols], points };
}

// ── Changes ──────────────────────────────────────────────────────────────

const RANGE_DAYS: Record<AzureChangesRange, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };

export async function readChanges(db: D1Database, range: AzureChangesRange, who: AzureChangesWho, now: Date): Promise<AzureChangeRow[]> {
  const from = new Date(now.getTime() - RANGE_DAYS[range] * 86_400_000).toISOString();
  const whoSql = who === "others" ? "AND caller_kind <> 'wgadmin'" : who === "wgadmin" ? "AND caller_kind = 'wgadmin'" : "";
  const rows = (
    await db
      .prepare(`SELECT id, at, operation, status, caller, caller_kind, resource_type, resource_name FROM az_activity WHERE at >= ?1 AND COALESCE(category, '') <> 'ResourceHealth' ${whoSql} ORDER BY at DESC LIMIT 500`)
      .bind(from)
      .all<{ id: string; at: string; operation: string; status: string; caller: string | null; caller_kind: string; resource_type: string; resource_name: string | null }>()
  ).results;
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    operation: r.operation,
    status: r.status,
    caller: r.caller,
    callerKind: r.caller_kind === "wgadmin" || r.caller_kind === "person" ? r.caller_kind : "azure",
    resourceType: r.resource_type,
    resourceName: r.resource_name,
  }));
}

export async function metricNames(db: D1Database): Promise<MetricDefsDoc> {
  const d = await getLatest<MetricDefsDoc>(db, "metricDefs");
  return { vm: Array.isArray(d?.doc?.vm) ? d!.doc.vm : null, pip: Array.isArray(d?.doc?.pip) ? d!.doc.pip : null };
}
