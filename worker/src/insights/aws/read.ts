// insights/aws/read.ts
//
// Plain English: what the /api/v1/azure routes answer while the server is in
// AWS (AWS insights spec section 6), read from the aws_* tables only, never
// AWS. The answers have the same shapes as Azure's, so the panels draw them
// unchanged: each Azure feed id is answered by the AWS feed standing in for
// it (AWS_STANDS_IN) with its source for the footer (AWS_SOURCES); hist_aws_vm
// serves Azure's VM columns (the ones AWS has no figure for are null) and the
// Public IP panel's packets and bytes; CloudTrail's rows serve the change log;
// AWS's status feed the service health. read.ts picks these by the
// snapshot's cloud. "No data" is null, never 0.

import type { Env } from "../../env";
import type { Snapshot } from "../../state";
import type { AzureChangeRow, AzureChangesRange, AzureChangesWho, AzureHealth, BootLogResponse, FeedId, FeedState, FeedStatus, ScheduledEvent, ServiceEvent } from "../../../../shared/api";
import { AWS_METRICS, FEEDS, PIP_COLUMNS, VM_COLUMNS } from "../../../../shared/azureMetrics";
import { RANGE_MS, RANGE_STEP, type HistoryRange } from "../../history";
import { slotOf, vmExists, type FeedRow } from "../common";
import type { CapacityDoc, MetricDefsDoc } from "../types";
import type { PriceRow } from "../price";
import { toServiceEvent } from "../feeds/serviceHealth";
import { NO_VM } from "../feeds/bootLog";
import { DEVSEED_KV, devSeeded } from "../../devmarks";
import { getAwsLatest, readAwsFeedRows } from "./common";
import { AWS_FEED_MODULES } from "./feeds/index";
import { AWS_SOURCES, AWS_STANDS_IN, awsConfigured, type AwsBootLogDoc, type AwsFeedId, type AwsHealthDoc } from "./types";

/** The boot log's reasons on AWS (spec 4.7 and 7). */
export const AWS_NOT_CONNECTED = "AWS isn't connected. Add the Worker's AWS keys.";
export const AWS_NO_CONSOLE = "AWS has no console output for this server yet.";
/** metricDefs has no AWS feed: AWS/EC2's metric names are fixed (AWS_METRICS). */
const AWS_CATALOGUE_SOURCE = "AWS CloudWatch";

const STATES: readonly FeedState[] = ["ok", "error", "not_configured", "skipped", "idle"];

/**
 * Whether the screens show AWS's stored data as connected: the Worker's AWS
 * keys set and AWS switched on (awsConfigured), or on a developer's PC a dev
 * seed (npm run seed -- insights-aws) left AWS feeds that worked, under the
 * same two locks as Azure's insightsShown (read.ts). Nothing is ever fetched
 * on the strength of this.
 */
export async function awsInsightsShown(env: Env, feeds: Map<string, FeedRow>): Promise<boolean> {
  if (awsConfigured(env)) return true;
  return [...feeds.values()].some((r) => r.status === "ok") && (await devSeeded(env, DEVSEED_KV.insights));
}

type StandInId = Exclude<AwsFeedId, "aws.housekeeping">;

/** The AWS feed answering for an Azure feed id; null for metricDefs (AWS has none). */
export function awsFeedFor(id: FeedId): StandInId | null {
  for (const [aws, ids] of Object.entries(AWS_STANDS_IN) as [StandInId, FeedId[]][]) if (ids.includes(id)) return aws;
  return null;
}

/** Every Azure feed id, in FEEDS order, answered by the AWS feed standing in for it, with its source and timing. */
export async function awsFeedStatuses(env: Env, rows?: Map<string, FeedRow>): Promise<(FeedStatus & { lastTryAt: string | null; nextDueAt: string | null })[]> {
  const have = rows ?? (await readAwsFeedRows(env.DB));
  const configured = await awsInsightsShown(env, have);
  return FEEDS.map((f) => {
    const aws = awsFeedFor(f.id);
    if (!aws) {
      // Metric names: AWS's are a fixed list, so there is nothing to read and nothing to fail.
      return { id: f.id, title: f.title, status: configured ? "ok" : "not_configured", lastOkAt: null, error: null, cadenceMin: null, source: AWS_CATALOGUE_SOURCE, lastTryAt: null, nextDueAt: null };
    }
    const mod = AWS_FEED_MODULES.find((m) => m.id === aws);
    const r = have.get(aws);
    const stored = STATES.includes(r?.status as FeedState) ? (r!.status as FeedState) : "idle";
    return {
      id: f.id,
      title: mod?.title ?? f.title,
      status: configured ? stored : "not_configured",
      lastOkAt: r?.last_ok_at ?? null,
      error: configured ? r?.error ?? null : null,
      cadenceMin: mod ? mod.cadenceMin : f.cadenceMin,
      source: AWS_SOURCES[aws],
      lastTryAt: r?.last_try_at ?? null,
      nextDueAt: r?.next_due_at ?? null,
    };
  });
}

// ── Health ───────────────────────────────────────────────────────────────

/** AWS's status checks and scheduled events for the headend (aws_latest['health']); none once the server is destroyed. */
export async function awsHealth(db: D1Database, snap: Snapshot): Promise<{ health: AzureHealth | null; maintenance: ScheduledEvent[] }> {
  if (snap.state === "destroyed") return { health: null, maintenance: [] };
  const d = await getAwsLatest<AwsHealthDoc>(db, "health");
  const doc = d?.doc;
  if (!doc || typeof doc !== "object" || !doc.health || typeof doc.health !== "object") return { health: null, maintenance: [] };
  const maintenance = Array.isArray(doc.maintenance) ? [...doc.maintenance].sort((a, b) => (a.notBefore ?? "9999").localeCompare(b.notBefore ?? "9999")) : [];
  return { health: { ...doc.health, annotations: [] }, maintenance };
}

// ── Metrics ──────────────────────────────────────────────────────────────

/** The newest stored slot since `since` (the summary's headline figures). */
export async function awsNewestSlot(db: D1Database, since: string): Promise<{ t: string; cpu_avg: number | null; credits_min: number | null } | null> {
  return db.prepare("SELECT t, cpu_avg, credits_min FROM hist_aws_vm WHERE res = 300 AND t >= ?1 ORDER BY t DESC LIMIT 1").bind(since).first<{ t: string; cpu_avg: number | null; credits_min: number | null }>();
}

/** The SQL aggregate for a hist_aws_vm column, by its CloudWatch stat: peaks the max, minimums the min, the rest (averages and per-slot sums) average. */
function awsAggregate(column: string): string {
  const m = AWS_METRICS.find((x) => x.column === column);
  if (!m) return `NULL AS ${column}`;
  const fn = m.stat === "Maximum" ? "MAX" : m.stat === "Minimum" ? "MIN" : "AVG";
  return `${fn}(${column}) AS ${column}`;
}

/**
 * The Public IP panel's figures on AWS (spec 4.1), from the instance's own
 * counters: packets = in + out in the slot, bytes = (in + out bytes per
 * second) × 300. A slot missing either half is null, never a half count.
 * AWS has no DDoS, SYN or availability figures: null.
 */
const AWS_PIP: Record<string, string> = {
  packets: "AVG(pkts_in + pkts_out) AS packets",
  bytes: "AVG((net_in + net_out) * 300) AS bytes",
};

const POINT = `strftime('%Y-%m-%dT%H:%M:%SZ', (CAST(strftime('%s', t) AS INTEGER) / CAST(?3 AS INTEGER)) * CAST(?3 AS INTEGER), 'unixepoch')`;

/** vm or pip points from hist_aws_vm, in Azure's columns (VM_COLUMNS, PIP_COLUMNS), 5-minute slots or wider. */
export async function readAwsMetrics(db: D1Database, resource: "vm" | "pip", range: HistoryRange, now: Date): Promise<{ step: number; columns: string[]; points: Record<string, number | string | null>[] }> {
  const cols: readonly string[] = resource === "vm" ? VM_COLUMNS : PIP_COLUMNS;
  const step = Math.max(300, RANGE_STEP[range]);
  const from = slotOf(now.getTime() - RANGE_MS[range], step);
  const to = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const select = cols.map((c) => (resource === "vm" ? awsAggregate(c) : AWS_PIP[c] ?? `NULL AS ${c}`)).join(", ");
  const sql = `SELECT ${POINT} AS t, ${select} FROM hist_aws_vm WHERE res = 300 AND t >= ?1 AND t <= ?2 GROUP BY 1 ORDER BY 1`;
  const points = (await db.prepare(sql).bind(from, to, step).all<Record<string, number | string | null>>()).results;
  return { step, columns: ["t", ...cols], points };
}

/** AWS/EC2's metric names, as the diagnostics list them (the vm figures, and the counters the Public IP panel reads). */
export function awsMetricNames(): MetricDefsDoc {
  const vm = [...new Set(AWS_METRICS.map((m) => m.name))];
  return { vm, pip: ["NetworkPacketsIn", "NetworkPacketsOut", "NetworkIn", "NetworkOut"] };
}

// ── Changes ──────────────────────────────────────────────────────────────

const RANGE_DAYS: Record<AzureChangesRange, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };

/**
 * CloudTrail's write events on cloudlabs' resources, newest first. AWS's own
 * calls (caller_kind aws) are the platform's, which the response type calls
 * "azure"; the response's `cloud` says which platform that is.
 */
export async function readAwsChanges(db: D1Database, range: AzureChangesRange, who: AzureChangesWho, now: Date): Promise<AzureChangeRow[]> {
  const from = new Date(now.getTime() - RANGE_DAYS[range] * 86_400_000).toISOString();
  const whoSql = who === "others" ? "AND caller_kind <> 'wgadmin'" : who === "wgadmin" ? "AND caller_kind = 'wgadmin'" : "";
  const rows = (
    await db
      .prepare(`SELECT id, at, operation, status, caller, caller_kind, resource_type, resource_name FROM aws_activity WHERE at >= ?1 ${whoSql} ORDER BY at DESC LIMIT 500`)
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

// ── Service health ───────────────────────────────────────────────────────

type StoredEvent = Parameters<typeof toServiceEvent>[0];

const regionsOf = (s: string): string[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** This region's AWS status events (by its plain name, "London") updated since `fromIso`, plus every active one; active first, then newest. */
export async function awsRegionalEvents(db: D1Database, regionName: string, fromIso: string): Promise<ServiceEvent[]> {
  const rows = (await db.prepare("SELECT * FROM aws_service_events WHERE updated_at >= ?1 OR status = 'Active' ORDER BY (status = 'Active') DESC, updated_at DESC LIMIT 200").bind(fromIso).all<StoredEvent>()).results;
  return rows.filter((r) => regionsOf(r.regions).includes(regionName)).map(toServiceEvent);
}

/** Active AWS issues in this region: the top-bar pill. Planned maintenance never counts. */
export async function activeAwsRegionalIssues(db: D1Database, regionName: string): Promise<ServiceEvent[]> {
  const rows = (await db.prepare("SELECT * FROM aws_service_events WHERE type = 'ServiceIssue' AND status = 'Active' ORDER BY updated_at DESC LIMIT 50").all<StoredEvent>()).results;
  return rows.filter((r) => regionsOf(r.regions).includes(regionName)).map(toServiceEvent);
}

// ── Capacity and prices ──────────────────────────────────────────────────

/** A region's stored AWS capacity reading, or null. */
export async function readAwsCapacity(db: D1Database, region: string): Promise<{ doc: CapacityDoc; fetchedAt: string } | null> {
  const r = await db.prepare("SELECT json, fetched_at FROM aws_capacity WHERE region = ?1").bind(region).first<{ json: string; fetched_at: string }>();
  if (!r) return null;
  try {
    const doc = JSON.parse(r.json) as CapacityDoc;
    return doc && Array.isArray(doc.sizes) ? { doc, fetchedAt: r.fetched_at } : null;
  } catch {
    return null;
  }
}

/** A region's stored AWS list prices, in the same row shape readPrices answers for Azure. */
export async function readAwsPrices(db: D1Database, region: string): Promise<PriceRow[]> {
  return (await db.prepare("SELECT region, item, gbp, unit, fetched_at FROM aws_prices WHERE region = ?1").bind(region).all<PriceRow>()).results;
}

// ── Boot log ─────────────────────────────────────────────────────────────

/** A boot log as the route answers it: the response's fields only (the stored doc's launch time stays inside). */
export function asBootLogResponse(d: BootLogResponse | AwsBootLogDoc): BootLogResponse {
  return { fetchedAt: d.fetchedAt ?? null, bytes: d.bytes ?? 0, truncated: !!d.truncated, redactions: d.redactions ?? 0, text: d.text ?? null, reason: d.reason ?? null };
}

/** GET boot log on AWS: the stored console output, or why there is none. */
export async function storedAwsBootLog(env: Env, snap: Snapshot): Promise<BootLogResponse> {
  const have = await getAwsLatest<AwsBootLogDoc>(env.DB, "bootlog");
  if (have?.doc && typeof have.doc === "object") return asBootLogResponse(have.doc);
  const none = (reason: string): BootLogResponse => ({ fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason });
  if (!awsConfigured(env)) return none(AWS_NOT_CONNECTED);
  if (!vmExists(snap)) return none(NO_VM);
  return none(AWS_NO_CONSOLE);
}
