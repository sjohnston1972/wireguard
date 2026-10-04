// insights/feeds/serviceHealth.ts
//
// Plain English: Azure Service Health: Azure's own outages ("service
// issues") and planned maintenance, for the whole subscription, every 15
// minutes. Kept only when they touch VMs or networking
// (SERVICE_HEALTH_SERVICES) in a region wg-admin uses (the configured one
// and any profile's), by Azure's plain region name ("UK South", from
// REGIONS). Other event types (advisories, security) are dropped. Events
// stay after they drop out of Azure's 7-day reply; housekeeping removes them
// 90 days after their last update. The top-bar pill reads the active
// service issues in the configured region (activeRegionalIssues).

import type { FeedModule } from "../runner";
import type { ServiceEvent } from "../../../../shared/api";
import { SERVICE_HEALTH_SERVICES } from "../../../../shared/azureMetrics";
import { azureRegionName } from "../../region";
import { listProfiles } from "../../db";
import { DAY, armRefusal, paths, str, time } from "../common";

const HEALTH_API = "2022-10-01";
const TYPES = new Set(["ServiceIssue", "PlannedMaintenance"]);

export interface ServiceEventRow {
  tracking_id: string;
  type: "ServiceIssue" | "PlannedMaintenance";
  status: "Active" | "Resolved";
  level: string | null;
  title: string;
  summary: string | null;
  services: string[];
  regions: string[];
  starts_at: string | null;
  ends_at: string | null;
  updated_at: string;
}

/** Azure's HTML summary as plain text, capped. */
function plainText(html: unknown, max = 1000): string | null {
  if (typeof html !== "string") return null;
  const t = html
    .slice(0, 20_000)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.slice(0, max) : null;
}

/** The query: events updated in the last 7 days (Azure's documented M/D/YYYY date). */
export function serviceHealthQuery(now: Date): string {
  const d = new Date(now.getTime() - 7 * DAY);
  return `api-version=${HEALTH_API}&queryStartTime=${encodeURIComponent(`${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`)}`;
}

/** The events worth keeping: the right type, a watched service, and a region in `regionNames`. */
export function normaliseServiceEvents(reply: unknown, regionNames: string[], now: Date): ServiceEventRow[] {
  const list = (reply as { value?: unknown })?.value;
  if (!Array.isArray(list)) return [];
  const inUse = new Set(regionNames);
  const out: ServiceEventRow[] = [];
  for (const e of list.slice(0, 500)) {
    const p = (e as { properties?: Record<string, unknown> })?.properties;
    const id = str((e as { name?: unknown })?.name, 60);
    if (!p || !id || typeof p.eventType !== "string" || !TYPES.has(p.eventType)) continue;
    const services: string[] = [];
    const regions: string[] = [];
    let touches = false;
    for (const imp of Array.isArray(p.impact) ? p.impact.slice(0, 50) : []) {
      const svc = str((imp as { impactedService?: unknown })?.impactedService, 80);
      if (!svc || !SERVICE_HEALTH_SERVICES.includes(svc)) continue;
      const rs = (imp as { impactedRegions?: unknown }).impactedRegions;
      const names = (Array.isArray(rs) ? rs.slice(0, 100) : []).map((r) => str((r as { impactedRegion?: unknown })?.impactedRegion, 60)).filter((n): n is string => !!n);
      if (!names.length) continue;
      if (!services.includes(svc)) services.push(svc);
      for (const n of names) if (!regions.includes(n)) regions.push(n);
      if (names.some((n) => inUse.has(n))) touches = true;
    }
    const title = str(p.title, 200);
    if (!touches || !title) continue;
    out.push({
      tracking_id: id,
      type: p.eventType as ServiceEventRow["type"],
      status: p.status === "Resolved" ? "Resolved" : "Active",
      level: str(p.level, 40),
      title,
      summary: plainText(p.summary),
      services: services.slice(0, 10),
      regions: regions.slice(0, 20),
      starts_at: time(p.impactStartTime),
      ends_at: time(p.impactMitigationTime),
      updated_at: time(p.lastUpdateTime) ?? now.toISOString(),
    });
  }
  return out;
}

export async function storeServiceEvents(db: D1Database, rows: ServiceEventRow[]): Promise<void> {
  if (!rows.length) return;
  await db.batch(
    rows.map((r) =>
      db
        .prepare(
          `INSERT INTO az_service_events (tracking_id, type, status, level, title, summary, services, regions, starts_at, ends_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
           ON CONFLICT (tracking_id) DO UPDATE SET type = excluded.type, status = excluded.status, level = excluded.level, title = excluded.title, summary = excluded.summary,
             services = excluded.services, regions = excluded.regions, starts_at = excluded.starts_at, ends_at = excluded.ends_at, updated_at = excluded.updated_at`,
        )
        .bind(r.tracking_id, r.type, r.status, r.level, r.title, r.summary, JSON.stringify(r.services), JSON.stringify(r.regions), r.starts_at, r.ends_at, r.updated_at),
    ),
  );
}

interface StoredEvent {
  tracking_id: string;
  type: string;
  status: string;
  level: string | null;
  title: string;
  summary: string | null;
  services: string;
  regions: string;
  starts_at: string | null;
  ends_at: string | null;
  updated_at: string;
}

const parseList = (s: string): string[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

export function toServiceEvent(r: StoredEvent): ServiceEvent {
  return {
    trackingId: r.tracking_id,
    type: r.type === "PlannedMaintenance" ? "PlannedMaintenance" : "ServiceIssue",
    status: r.status === "Resolved" ? "Resolved" : "Active",
    level: r.level,
    title: r.title,
    summary: r.summary,
    services: parseList(r.services),
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    updatedAt: r.updated_at,
  };
}

/** This region's events (by Azure's plain name) updated since `fromIso`, plus every active one; active first, then newest. */
export async function regionalEvents(db: D1Database, regionName: string, fromIso: string): Promise<ServiceEvent[]> {
  const rows = (await db.prepare("SELECT * FROM az_service_events WHERE updated_at >= ?1 OR status = 'Active' ORDER BY (status = 'Active') DESC, updated_at DESC LIMIT 200").bind(fromIso).all<StoredEvent>()).results;
  return rows.filter((r) => parseList(r.regions).includes(regionName)).map(toServiceEvent);
}

/** Active service issues touching VMs or networking in this region: the top-bar pill. Planned maintenance never counts. */
export async function activeRegionalIssues(db: D1Database, regionName: string): Promise<ServiceEvent[]> {
  const rows = (await db.prepare("SELECT * FROM az_service_events WHERE type = 'ServiceIssue' AND status = 'Active' ORDER BY updated_at DESC LIMIT 50").all<StoredEvent>()).results;
  return rows.filter((r) => parseList(r.regions).includes(regionName)).map(toServiceEvent);
}

const serviceHealth: FeedModule = {
  id: "serviceHealth",
  title: "Service health",
  cadenceMin: 15,
  when: "always",
  calls: 1,
  arm: true,
  async run(ctx) {
    const r = await ctx.arm(`${paths(ctx.env, ctx.cfg).sub}/providers/Microsoft.ResourceHealth/events?${serviceHealthQuery(ctx.now)}`);
    if (!r.ok) throw await armRefusal("the Service Health events", r);
    const profiles = await listProfiles(ctx.env);
    const regionNames = [...new Set([ctx.cfg.region, ...profiles.map((p) => p.region)].map(azureRegionName))];
    await storeServiceEvents(ctx.db, normaliseServiceEvents(await r.json(), regionNames, ctx.now));
    return { status: "ok", error: null };
  },
};

export default serviceHealth;
