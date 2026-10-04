// insights/feeds/activity.ts
//
// Plain English: the resource group's Activity Log: who changed what in
// Azure, including changes made in the portal. Every 5 minutes while the
// resource group exists or a run ended less than 2 hours ago, otherwise
// hourly. At most 2 pages per run.
//
//   - Events are grouped by correlation id (one operation logs Started,
//     Accepted, then Succeeded or Failed); the final status wins, and a
//     later "Started" never replaces one already stored.
//   - The caller is "wgadmin" (wg-admin's own service principal: its client
//     id, or its object id read from the sign-in token), "person" (an email
//     address) or "azure" (the platform).
//   - The resource becomes a plain name (Virtual machine, Network security
//     group, ...), from AZURE_RESOURCE_KINDS.
//   - Rows with category ResourceHealth are Azure's own notes on the VM
//     (annotations, shown by overview.azureHealth).
//   - A change by anyone but wg-admin to the VM, NSG, public IP or NIC
//     writes one watchman note ("Changed in Azure outside wg-admin: ..."),
//     once per correlation id.

import type { FeedModule } from "../runner";
import type { FeedCtx } from "../types";
import type { Env } from "../../env";
import type { Snapshot } from "../../state";
import { addAlert } from "../../db";
import { AZURE_RESOURCE_KINDS } from "../../../../shared/azureMetrics";
import { HOUR, MIN, armRefusal, iso, paths, rgExists, str, time, valueOf, type FeedRow } from "../common";

const ACTIVITY_API = "2015-04-01";
const SELECT = "eventDataId,eventTimestamp,operationName,status,caller,resourceId,category,correlationId,level,subStatus";
const MAX_PAGES = 2;
/** How far before the last success each query reaches, for events Azure logs late. */
const OVERLAP_MS = 10 * MIN;
/** The furthest back the first run reaches. */
const BACKFILL_MS = 24 * HOUR;
const FINAL = new Set(["Succeeded", "Failed", "Canceled", "Cancelled", "Resolved"]);
/** Resource kinds whose outside changes write a watchman note. */
const WATCHED = new Set(["vm", "nsg", "pip", "nic"]);

export interface ActivityRow {
  id: string;
  at: string;
  correlation_id: string | null;
  operation: string;
  status: string;
  caller: string | null;
  caller_kind: "wgadmin" | "person" | "azure";
  resource_type: string;
  resource_name: string | null;
  category: string | null;
  level: string | null;
  /** Not stored: the resource kind's value (vm, nsg, ...), for the outside-change note. */
  kind: string;
}

/** Minutes until the next read: 5 while the resource group exists or within 2 h of a run ending, else 60. */
export function activityCadence(snap: Snapshot, lastRunEnd: string | null, now: number): number {
  if (rgExists(snap) || snap.state === "deploying" || snap.state === "destroying") return 5;
  const end = Date.parse(lastRunEnd ?? "");
  return Number.isFinite(end) && now - end < 2 * HOUR ? 5 : 60;
}

/** When the last run ended (or was asked for, if it has not ended). */
export async function lastRunEnd(db: D1Database): Promise<string | null> {
  const r = await db.prepare("SELECT MAX(COALESCE(finished_at, requested_at)) AS at FROM runs").first<{ at: string | null }>();
  return r?.at ?? null;
}

/** wg-admin's own identities: the client id, and the object id in the cached sign-in token (the Activity Log may name either). */
export async function wgadminIds(env: Env): Promise<string[]> {
  const ids = [env.AZURE_CLIENT_ID ?? ""];
  try {
    const cached = await env.STATUS.get<{ token: string }>("azure:token", "json");
    const payload = cached?.token?.split(".")[1];
    if (payload) {
      const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { oid?: unknown; appid?: unknown };
      for (const c of [claims.oid, claims.appid]) if (typeof c === "string") ids.push(c);
    }
  } catch {
    /* no token, or not a JWT: the client id alone */
  }
  return ids.filter(Boolean).map((s) => s.toLowerCase());
}

export function callerKind(caller: string | null, ids: string[]): ActivityRow["caller_kind"] {
  if (!caller) return "azure";
  const c = caller.toLowerCase();
  if (ids.some((id) => id.toLowerCase() === c)) return "wgadmin";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(caller) ? "person" : "azure";
}

/** The plain resource kind and name from a resource id. */
function resourceOf(resourceId: string | null): { kind: string; label: string; name: string | null } {
  const other = AZURE_RESOURCE_KINDS.find((k) => k.value === "other")!;
  if (!resourceId) return { kind: "other", label: other.label, name: null };
  const m = resourceId.match(/\/providers\/([^/]+)\/([^/]+)\/([^/]+)/i);
  if (m) {
    const type = `${m[1]}/${m[2]}`.toLowerCase();
    const k = AZURE_RESOURCE_KINDS.find((x) => x.armType === type) ?? other;
    return { kind: k.value, label: k.label, name: str(m[3], 80) };
  }
  const rg = resourceId.match(/\/resourceGroups\/([^/]+)\/?$/i);
  if (rg) {
    const k = AZURE_RESOURCE_KINDS.find((x) => x.value === "rg")!;
    return { kind: k.value, label: k.label, name: str(rg[1], 80) };
  }
  return { kind: "other", label: other.label, name: null };
}

/** Events grouped into one row per operation, newest event of the final status kept. */
export function normaliseActivity(events: unknown[], ids: string[]): ActivityRow[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const e of events.slice(0, 2000)) {
    if (!e || typeof e !== "object") continue;
    const ev = e as Record<string, unknown>;
    const id = str(ev.eventDataId, 100);
    if (!id || !time(ev.eventTimestamp) || !valueOf(ev.operationName)) continue;
    const key = str(ev.correlationId, 100) ?? id;
    const g = groups.get(key) ?? [];
    g.push(ev);
    groups.set(key, g);
  }
  const rows: ActivityRow[] = [];
  for (const g of groups.values()) {
    const rank = (ev: Record<string, unknown>) => (FINAL.has(valueOf(ev.status) ?? "") ? 1 : 0);
    const kept = [...g].sort((a, b) => rank(b) - rank(a) || String(time(b.eventTimestamp)).localeCompare(String(time(a.eventTimestamp))))[0]!;
    const caller = str(kept.caller, 120) ?? g.map((ev) => str(ev.caller, 120)).find((c) => c) ?? null;
    const res = resourceOf(str(kept.resourceId, 400));
    rows.push({
      id: str(kept.eventDataId, 100)!,
      at: time(kept.eventTimestamp)!,
      correlation_id: str(kept.correlationId, 100),
      operation: valueOf(kept.operationName, 160)!,
      status: valueOf(kept.status, 40) ?? "Unknown",
      caller,
      caller_kind: callerKind(caller, ids),
      resource_type: res.label,
      resource_name: res.name,
      category: valueOf(kept.category, 40),
      level: str(kept.level, 40),
      kind: res.kind,
    });
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

/** The query string: the resource group, from `fromMs` to `toMs`, only the fields used. Spaces as %20. */
export function activityQuery(rg: string, fromMs: number, toMs: number): string {
  const filter = `eventTimestamp ge '${iso(fromMs)}' and eventTimestamp le '${iso(toMs)}' and resourceGroupName eq '${rg}'`;
  return `api-version=${ACTIVITY_API}&$filter=${encodeURIComponent(filter)}&$select=${encodeURIComponent(SELECT)}`;
}

/** Up to two pages of events since 10 minutes before the last success (24 h on the first run). */
export async function fetchActivity(ctx: FeedCtx, row: FeedRow | null): Promise<unknown[]> {
  const now = ctx.now.getTime();
  const lastOk = Date.parse(row?.last_ok_at ?? "");
  const from = Math.max(now - BACKFILL_MS, Math.min(now - OVERLAP_MS, Number.isFinite(lastOk) ? lastOk - OVERLAP_MS : -Infinity));
  let next: string | null = `${paths(ctx.env, ctx.cfg).sub}/providers/Microsoft.Insights/eventtypes/management/values?${activityQuery(ctx.cfg.resourceGroup, from, now)}`;
  const out: unknown[] = [];
  for (let page = 0; page < MAX_PAGES && next; page++) {
    const r = await ctx.arm(next);
    if (!r.ok) throw await armRefusal("the Activity Log", r);
    const j = (await r.json()) as { value?: unknown; nextLink?: unknown };
    if (Array.isArray(j.value)) out.push(...j.value);
    next = typeof j.nextLink === "string" && j.nextLink ? j.nextLink : null;
  }
  return out;
}

function outsideChange(r: ActivityRow): boolean {
  return r.caller_kind !== "wgadmin" && r.category === "Administrative" && WATCHED.has(r.kind) && /\/(write|delete|action)$/i.test(r.operation);
}

/** Store the rows (a final status is never replaced), and note each new outside change once. */
export async function storeActivity(env: Env, rows: ActivityRow[]): Promise<number> {
  if (!rows.length) return 0;
  const db = env.DB;
  const corr = rows.map((r) => r.correlation_id ?? r.id);
  const existing = new Map<string, string>();
  for (let i = 0; i < corr.length; i += 50) {
    const chunk = corr.slice(i, i + 50);
    const found = (await db.prepare(`SELECT COALESCE(correlation_id, id) AS k, status FROM az_activity WHERE COALESCE(correlation_id, id) IN (${chunk.map((_, j) => `?${j + 1}`).join(", ")})`).bind(...chunk).all<{ k: string; status: string }>()).results;
    for (const f of found) if (!existing.has(f.k) || FINAL.has(f.status)) existing.set(f.k, f.status);
  }
  const stmts: D1PreparedStatement[] = [];
  const fresh: ActivityRow[] = [];
  for (const r of rows) {
    const k = r.correlation_id ?? r.id;
    const had = existing.get(k);
    if (had === undefined) fresh.push(r);
    else if (FINAL.has(had) && !FINAL.has(r.status)) continue; // never step back from a final status
    stmts.push(db.prepare("DELETE FROM az_activity WHERE COALESCE(correlation_id, id) = ?1 AND id <> ?2").bind(k, r.id));
    stmts.push(
      db
        .prepare(
          `INSERT INTO az_activity (id, at, correlation_id, operation, status, caller, caller_kind, resource_type, resource_name, category, level) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
           ON CONFLICT (id) DO UPDATE SET at = excluded.at, status = excluded.status, caller = excluded.caller, caller_kind = excluded.caller_kind, level = excluded.level`,
        )
        .bind(r.id, r.at, r.correlation_id, r.operation, r.status, r.caller, r.caller_kind, r.resource_type, r.resource_name, r.category, r.level),
    );
  }
  if (stmts.length) await db.batch(stmts);
  let noted = 0;
  for (const r of fresh.filter(outsideChange)) {
    await addAlert(env, "drift", `Changed in Azure outside wg-admin: ${r.caller ?? "someone"}, ${r.operation} on ${r.resource_type} ${r.resource_name ?? ""} (${r.status}).`.replace(/\s+\(/, " ("));
    noted++;
  }
  return noted;
}

/** Plain words for Azure's own health notes on the VM. */
function annotationTitle(operation: string, status: string): string {
  if (/\/Activated\//i.test(operation)) return "Azure reported a problem with the VM";
  if (/\/Resolved\//i.test(operation)) return "Azure resolved a problem with the VM";
  if (/\/InProgress\//i.test(operation)) return "Azure is working on a problem with the VM";
  if (/\/Updated\//i.test(operation)) return "Azure updated a problem report for the VM";
  return `Azure health event: ${status}`;
}

/** Azure's own notes on the VM (category ResourceHealth), newest first. */
export async function healthAnnotations(db: D1Database, limit: number): Promise<{ at: string; title: string }[]> {
  const rows = (await db.prepare("SELECT at, operation, status FROM az_activity WHERE category = 'ResourceHealth' ORDER BY at DESC LIMIT ?1").bind(Math.max(0, Math.floor(limit))).all<{ at: string; operation: string; status: string }>()).results;
  return rows.map((r) => ({ at: r.at, title: annotationTitle(r.operation, r.status) }));
}

const activity: FeedModule = {
  id: "activity",
  title: "Activity log",
  cadenceMin: 5,
  when: "always",
  calls: MAX_PAGES,
  arm: true,
  async run(ctx) {
    const row = await ctx.db.prepare("SELECT feed, last_try_at, last_ok_at, status, error, next_due_at FROM az_feed WHERE feed = 'activity'").first<FeedRow>();
    const events = await fetchActivity(ctx, row);
    await storeActivity(ctx.env, normaliseActivity(events, await wgadminIds(ctx.env)));
    const cadence = activityCadence(ctx.snap, await lastRunEnd(ctx.db), ctx.now.getTime());
    return { status: "ok", error: null, nextDueAt: iso(ctx.now.getTime() + cadence * MIN) };
  },
};

export default activity;
