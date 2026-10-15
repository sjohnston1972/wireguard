// insights/aws/feeds/activity.ts
//
// Plain English: AWS's change log for cloudlabs: CloudTrail's write events
// (LookupEvents, ReadOnly=false) in the region, every 5 minutes while AWS is
// configured, stored in aws_activity. Spec 2026-10-15-aws-insights-design.md,
// section 4.3.
//
//   - Each run reaches back from the newest stored event (or the last
//     success, if later) less 20 minutes, as CloudTrail shows events 5 to 15
//     minutes late; the first run reaches back 7 days. At most 3 pages of 50
//     per run, about 600 ms apart (AWS allows LookupEvents 2 a second).
//   - Nothing is lost when the account is busier than that: whatever a run
//     leaves unread (from its StartTime to the oldest event it read) is kept
//     as a backlog in aws_latest['activity-backlog'], and later runs spend
//     the pages their own window leaves over on it, newest first, until it
//     is empty. AWS throttling a page after the first ends the run's paging
//     the same way (what was read is kept; the feed is ok); only a throttled
//     first page skips the feed. Backlog older than 7 days is dropped with a
//     line in the run's log, and a run that leaves a backlog says so there.
//   - The account may hold other projects, so an event is kept only when
//     cloudlabs made it (the Worker's IAM user wg-admin-worker, or a session
//     of the GitHub deploy role wg-admin-deploy) or it touches a resource
//     tagged wg-admin=vpn. The tagged list costs one call, so it is only
//     asked for when a new event is not obviously cloudlabs' own, or when
//     cloudlabs' own events arrive and the remembered ids are over an hour
//     old. Every tagged id seen is remembered (the latest 500, in
//     aws_latest['known-ids']), so a person deleting a cloudlabs resource,
//     no longer tagged once it is gone, still shows.
//   - The caller is "wgadmin" (as above), "aws" (an AWS service) or
//     "person"; the resource becomes a plain name (EC2 instance, Security
//     group, ...) from AWS_RESOURCE_KINDS.
//   - CloudTrail's events never change, so an event already stored is not
//     written again.
//   - A person's successful change to the instance, its security group,
//     Elastic IP or network interface writes one watchman note ("Changed in
//     AWS outside cloudlabs: ..."), once per event id, as Azure's activity
//     feed does.

import type { Env } from "../../../env";
import { addAlert } from "../../../db";
import { AWS_RESOURCE_KINDS } from "../../../../../shared/azureMetrics";
import { DAY, HOUR, MIN, iso, str } from "../../common";
import { BudgetExceeded } from "../../types";
import { getAwsLatest, putAwsLatestStmt } from "../common";
import { AwsOutOfTime } from "../ctx";
import { AwsThrottled, type AwsFeed, type AwsFeedCtx } from "../types";

export const LOOKUP_TARGET = "com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.LookupEvents";
const MAX_PAGES = 3;
const PAGE_SIZE = 50;
/** The pause between pages: AWS allows LookupEvents 2 a second per account and region. */
const PAGE_PAUSE_MS = 600;
/** aws_latest key: the windows (ISO from/to) a run left unread, newest first. */
export const ACTIVITY_BACKLOG_KEY = "activity-backlog";
/** aws_latest key: every tagged resource id seen (the latest KNOWN_IDS_KEEP, newest last). */
export const KNOWN_IDS_KEY = "known-ids";
const KNOWN_IDS_KEEP = 500;
/** How old the remembered ids may be before cloudlabs' own new events refresh them. */
const KNOWN_IDS_REFRESH_MS = HOUR;
/** At most this many backlog windows; beyond it the oldest are merged (re-reading costs pages, never events). */
const BACKLOG_WINDOWS = 20;

/** The pause between pages; tests replace it. */
export const activityTiming = {
  pause: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};
/** How far before the newest stored event each query reaches, for events CloudTrail shows late. */
const OVERLAP_MS = 20 * MIN;
/** The first run's reach. */
const BACKFILL_MS = 7 * DAY;
/** The Worker's IAM user and the GitHub deploy role (infra/aws-bootstrap/main.tf). */
const WORKER_USER = "wg-admin-worker";
const DEPLOY_ROLE = "wg-admin-deploy";
/** Resource kinds whose outside changes write a watchman note (as Azure's: VM, NSG, public IP, NIC). */
const WATCHED = new Set(["vm", "nsg", "pip", "nic"]);

type CallerKind = "wgadmin" | "person" | "aws";

/** One CloudTrail event, read but not yet judged. */
export interface AwsTrailEvent {
  id: string;
  at: string;
  operation: string;
  status: "Succeeded" | "Failed";
  caller: string | null;
  caller_kind: CallerKind;
  /** Every resource the event names: its id (the last ARN segment), kind value and plain label. */
  resources: { id: string; kind: string; label: string }[];
}

/** One aws_activity row. */
export interface AwsActivityRow {
  id: string;
  at: string;
  operation: string;
  status: "Succeeded" | "Failed";
  caller: string | null;
  caller_kind: CallerKind;
  resource_type: string;
  resource_name: string | null;
  /** Not stored: the resource kind's value (vm, nsg, ...), for the outside-change note. */
  kind: string;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The last segment of an ARN or path ("arn:aws:ec2:...:instance/i-0abc" -> "i-0abc"); an id stays as it is. */
const lastSegment = (s: string): string => s.split(/[:/]/).pop() || s;

/**
 * Who made a call: LookupEvents' Username and the event's own JSON
 * (userIdentity, invokedBy). cloudlabs is the Worker's IAM user or a session
 * of the deploy role, matched by ARN; an AWS service (userIdentity type
 * AWSService, or invokedBy ending amazonaws.com) is "aws"; anyone else is a
 * person.
 */
export function awsCallerOf(username: string | null, trail: Record<string, unknown> | null): { caller: string | null; kind: CallerKind } {
  const ui = obj(trail?.userIdentity);
  const type = str(ui?.type, 40);
  const arn = str(ui?.arn, 400) ?? "";
  const issuer = str(obj(obj(ui?.sessionContext)?.sessionIssuer)?.arn, 400) ?? "";
  const invokedBy = str(ui?.invokedBy, 120) ?? str(trail?.invokedBy, 120);
  const session = /:assumed-role\//.test(arn) ? lastSegment(arn) : null;
  const name = str(username, 120) ?? session ?? str(ui?.userName, 120) ?? (type === "Root" ? "root" : null);
  const ours =
    arn.endsWith(`:user/${WORKER_USER}`) ||
    arn.includes(`:assumed-role/${DEPLOY_ROLE}/`) ||
    issuer.endsWith(`:role/${DEPLOY_ROLE}`) ||
    (!arn && type === null && username === WORKER_USER);
  if (ours) return { caller: name, kind: "wgadmin" };
  if (type === "AWSService" || (invokedBy && /amazonaws\.com$/i.test(invokedBy))) return { caller: invokedBy ?? name, kind: "aws" };
  return { caller: name, kind: "person" };
}

/** CloudTrail's EventTime: epoch seconds (JSON 1.1), or an ISO string. */
function eventTime(v: unknown): string | null {
  const ms = typeof v === "number" ? v * 1000 : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function resourceOf(type: unknown, name: unknown): AwsTrailEvent["resources"][number] | null {
  const n = str(name, 400);
  if (!n) return null;
  const t = str(type, 80) ?? "";
  const k = AWS_RESOURCE_KINDS.find((x) => x.awsTypes.includes(t)) ?? AWS_RESOURCE_KINDS.find((x) => x.value === "other")!;
  return { id: lastSegment(n).slice(0, 120), kind: k.value, label: k.label };
}

/** LookupEvents' events as AwsTrailEvents; anything without an id, a name and a time is dropped. */
export function normaliseAwsActivity(events: unknown[]): AwsTrailEvent[] {
  const out: AwsTrailEvent[] = [];
  for (const e of events.slice(0, 1000)) {
    const ev = obj(e);
    const id = str(ev?.EventId, 100);
    const operation = str(ev?.EventName, 160);
    const at = eventTime(ev?.EventTime);
    if (!ev || !id || !operation || !at) continue;
    let trail: Record<string, unknown> | null = null;
    try {
      trail = typeof ev.CloudTrailEvent === "string" ? obj(JSON.parse(ev.CloudTrailEvent)) : null;
    } catch {
      /* unreadable: judged by Username alone */
    }
    const who = awsCallerOf(str(ev.Username, 120), trail);
    const resources = (Array.isArray(ev.Resources) ? ev.Resources.slice(0, 50) : []).map((r) => resourceOf(obj(r)?.ResourceType, obj(r)?.ResourceName)).filter((r): r is NonNullable<typeof r> => !!r);
    out.push({ id, at, operation, status: trail?.errorCode ? "Failed" : "Succeeded", caller: who.caller, caller_kind: who.kind, resources });
  }
  return out;
}

const KIND_RANK = new Map<string, number>(AWS_RESOURCE_KINDS.map((k, i) => [k.value, k.value === "other" ? 99 : i]));

/**
 * The events that are cloudlabs': made by cloudlabs, or touching a tagged
 * resource (`tagged`: ids of resources tagged wg-admin=vpn; null when not
 * looked up, so only cloudlabs' own are kept). The row names one resource:
 * a tagged one first, then the most telling kind (instance, security group,
 * Elastic IP, ...).
 */
export function keepAwsActivity(events: AwsTrailEvent[], tagged: Set<string> | null): AwsActivityRow[] {
  const rows: AwsActivityRow[] = [];
  for (const e of events) {
    const touches = !!tagged && e.resources.some((r) => tagged.has(r.id));
    if (e.caller_kind !== "wgadmin" && !touches) continue;
    const pick = [...e.resources].sort((a, b) => Number(!!tagged?.has(b.id)) - Number(!!tagged?.has(a.id)) || (KIND_RANK.get(a.kind) ?? 99) - (KIND_RANK.get(b.kind) ?? 99))[0];
    const other = AWS_RESOURCE_KINDS.find((k) => k.value === "other")!;
    rows.push({
      id: e.id,
      at: e.at,
      operation: e.operation,
      status: e.status,
      caller: e.caller,
      caller_kind: e.caller_kind,
      resource_type: pick?.label ?? other.label,
      resource_name: pick?.id ?? null,
      kind: pick?.kind ?? "other",
    });
  }
  return rows;
}

/**
 * Where a run's query starts (ms): the newest stored event or the last
 * success, whichever is later, less 20 minutes; 7 days back when there is
 * neither (and never further). Never later than 20 minutes ago.
 */
export function lookupStart(nowMs: number, newestStored: string | null, lastOk: string | null): number {
  const floor = nowMs - BACKFILL_MS;
  const known = [Date.parse(newestStored ?? ""), Date.parse(lastOk ?? "")].filter(Number.isFinite);
  if (!known.length) return floor;
  return Math.min(nowMs - OVERLAP_MS, Math.max(floor, Math.max(...known) - OVERLAP_MS));
}

/** A stretch of CloudTrail not yet read (ISO times; `to` is the oldest event read so far, or the window's end). */
export interface AwsActivityWindow {
  from: string;
  to: string;
}

/**
 * The stored backlog, less any window wholly older than 7 days (the first
 * run reaches no further back either). `dropped`: those windows.
 */
export function trimBacklog(raw: unknown, nowMs: number): { windows: AwsActivityWindow[]; dropped: AwsActivityWindow[] } {
  const floor = nowMs - BACKFILL_MS;
  const windows: AwsActivityWindow[] = [];
  const dropped: AwsActivityWindow[] = [];
  for (const w of Array.isArray(raw) ? raw.slice(0, BACKLOG_WINDOWS * 2) : []) {
    const from = Date.parse(obj(w)?.from as string);
    const to = Date.parse(obj(w)?.to as string);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    if (to < floor) dropped.push({ from: iso(from), to: iso(to) });
    else windows.push({ from: iso(from), to: iso(to) });
  }
  return { windows, dropped };
}

/** Newest first, overlaps merged, at most BACKLOG_WINDOWS (the oldest merged into one). */
function tidyBacklog(windows: { from: number; to: number }[]): AwsActivityWindow[] {
  const sorted = [...windows].sort((a, b) => b.to - a.to);
  const out: { from: number; to: number }[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.to >= last.from) last.from = Math.min(last.from, w.from);
    else out.push({ ...w });
  }
  if (out.length > BACKLOG_WINDOWS) {
    const rest = out.splice(BACKLOG_WINDOWS - 1);
    out.push({ from: Math.min(...rest.map((w) => w.from)), to: Math.max(...rest.map((w) => w.to)) });
  }
  return out.map((w) => ({ from: iso(w.from), to: iso(w.to) }));
}

/** One window's query within a run. */
interface Query {
  from: number;
  to: number;
  token: string | null;
  /** The oldest EventTime read from it (ms), or null. */
  oldest: number | null;
  done: boolean;
}

/**
 * Up to 3 pages of write events (1 call each, about 600 ms apart): the new
 * window since lookupStart first, then the backlog, newest first. Answers
 * the events read and the backlog left (empty when everything was read). A
 * throttle, the run's deadline or its budget on a page after the first ends
 * the paging and keeps what was read; on the first page it is thrown.
 */
export async function fetchAwsActivity(ctx: AwsFeedCtx, lastOk: string | null, backlog: AwsActivityWindow[] = []): Promise<{ events: unknown[]; backlog: AwsActivityWindow[] }> {
  const newest = await ctx.db.prepare("SELECT MAX(at) AS at FROM aws_activity").first<{ at: string | null }>();
  const now = ctx.now.getTime();
  const start = lookupStart(now, newest?.at ?? null, lastOk);
  // The new window covers everything since `start` (read now, or left as backlog): the old backlog ends there.
  const queries: Query[] = [
    { from: start, to: now, token: null, oldest: null, done: false },
    ...backlog.map((w) => ({ from: Date.parse(w.from), to: Math.min(Date.parse(w.to), start), token: null, oldest: null, done: false })).filter((q) => q.to > q.from),
  ];
  const out: unknown[] = [];
  let pages = 0;
  paging: for (const q of queries) {
    while (!q.done) {
      if (pages >= MAX_PAGES) break paging;
      if (pages > 0) await activityTiming.pause(PAGE_PAUSE_MS);
      let r: { Events?: unknown; NextToken?: unknown };
      try {
        r = await ctx.json({
          service: "cloudtrail",
          region: ctx.region,
          host: `cloudtrail.${ctx.region}.amazonaws.com`,
          target: LOOKUP_TARGET,
          body: {
            LookupAttributes: [{ AttributeKey: "ReadOnly", AttributeValue: "false" }],
            StartTime: Math.floor(q.from / 1000),
            EndTime: Math.floor(q.to / 1000),
            MaxResults: PAGE_SIZE,
            ...(q.token ? { NextToken: q.token } : {}),
          },
        });
      } catch (e) {
        // A page after the first: keep what was read, and the rest stays unread for later runs.
        if (pages > 0 && (e instanceof AwsThrottled || e instanceof AwsOutOfTime || e instanceof BudgetExceeded)) break paging;
        throw e;
      }
      pages++;
      const events = Array.isArray(r?.Events) ? r.Events.slice(0, PAGE_SIZE * 2) : [];
      out.push(...events);
      for (const e of events) {
        const t = Date.parse(eventTime(obj(e)?.EventTime) ?? "");
        if (Number.isFinite(t)) q.oldest = Math.min(q.oldest ?? t, t);
      }
      q.token = typeof r?.NextToken === "string" && r.NextToken ? r.NextToken : null;
      if (!q.token) q.done = true;
    }
  }
  // What is left: each unfinished window, from its start to the oldest event read from it.
  const left = queries.filter((q) => !q.done).map((q) => ({ from: q.from, to: Math.min(q.to, q.oldest ?? q.to) }));
  return { events: out, backlog: tidyBacklog(left.filter((w) => w.to > w.from)) };
}

/**
 * The remembered tagged ids with a fresh lookup added: no repeats, the
 * newest lookup last, at most the latest 500.
 */
export function mergeKnownIds(known: unknown, tagged: Set<string>): string[] {
  const old = Array.isArray(known) ? known.filter((x): x is string => typeof x === "string" && !tagged.has(x)) : [];
  return [...new Set([...old, ...tagged])].slice(-KNOWN_IDS_KEEP);
}

/** Which of these event ids aws_activity already holds. */
export async function storedAwsActivityIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = (await db.prepare(`SELECT id FROM aws_activity WHERE id IN (${chunk.map((_, j) => `?${j + 1}`).join(", ")})`).bind(...chunk).all<{ id: string }>()).results;
    for (const r of rows) found.add(r.id);
  }
  return found;
}

function outsideChange(r: AwsActivityRow): boolean {
  return r.caller_kind === "person" && r.status === "Succeeded" && WATCHED.has(r.kind);
}

/**
 * Store the rows not already stored (`known`: the ids already in
 * aws_activity, read here when not given), and note each new outside change
 * once. Answers how many notes were written.
 */
export async function storeAwsActivity(env: Env, rows: AwsActivityRow[], known?: Set<string>): Promise<number> {
  if (!rows.length) return 0;
  const db = env.DB;
  const have = known ?? (await storedAwsActivityIds(db, rows.map((r) => r.id)));
  const fresh = rows.filter((r) => !have.has(r.id));
  if (!fresh.length) return 0;
  await db.batch(
    fresh.map((r) =>
      db
        .prepare("INSERT INTO aws_activity (id, at, operation, status, caller, caller_kind, resource_type, resource_name) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT (id) DO NOTHING")
        .bind(r.id, r.at, r.operation, r.status, r.caller, r.caller_kind, r.resource_type, r.resource_name),
    ),
  );
  let noted = 0;
  for (const r of fresh.filter(outsideChange)) {
    await addAlert(env, "drift", `Changed in AWS outside cloudlabs: ${r.operation} on ${r.resource_type} ${r.resource_name ?? ""}`.trim() + ` by ${r.caller ?? "someone"}`);
    noted++;
  }
  return noted;
}

const activity: AwsFeed = {
  id: "aws.activity",
  title: "Change log",
  cadenceMin: 5,
  when: "always",
  calls: MAX_PAGES + 1, // the pages, and the tagged-resource lookup
  async run(ctx) {
    // The runner hands over the row it read for the whole run; a one-off reads it.
    const row = ctx.row !== undefined ? ctx.row : await ctx.db.prepare("SELECT last_try_at, last_ok_at, next_due_at FROM aws_feed WHERE feed = 'aws.activity'").first<{ last_try_at: string | null; last_ok_at: string | null; next_due_at: string | null }>();
    const now = ctx.now.getTime();
    const at = ctx.now.toISOString();
    const [had, remembered] = await Promise.all([getAwsLatest<unknown>(ctx.db, ACTIVITY_BACKLOG_KEY), getAwsLatest<unknown>(ctx.db, KNOWN_IDS_KEY)]);
    const trimmed = trimBacklog(had?.doc, now);
    const read = await fetchAwsActivity(ctx, row?.last_ok_at ?? null, trimmed.windows);
    const events = normaliseAwsActivity(read.events);
    const stored = await storedAwsActivityIds(ctx.db, events.map((e) => e.id));
    const fresh = events.filter((e) => !stored.has(e.id));
    const writes: D1PreparedStatement[] = [];
    // The tagged list when a new event might be ours without being by cloudlabs, or when cloudlabs
    // has been changing things (new resources) and the remembered ids are over an hour old.
    const mightBeOurs = fresh.some((e) => e.caller_kind !== "wgadmin" && e.resources.length);
    const rememberedAge = now - Date.parse(remembered?.updatedAt ?? "");
    const refresh = fresh.some((e) => e.caller_kind === "wgadmin") && !(rememberedAge < KNOWN_IDS_REFRESH_MS);
    let ours: Set<string> | null = null;
    if (mightBeOurs || refresh) {
      // A deleted resource is no longer tagged: the ids seen before still count as ours.
      const ids = mergeKnownIds(remembered?.doc, await ctx.taggedIds());
      writes.push(putAwsLatestStmt(ctx.db, KNOWN_IDS_KEY, ids, at));
      ours = new Set(ids);
    }
    await storeAwsActivity(ctx.env, keepAwsActivity(fresh, ours), stored);
    if (read.backlog.length) writes.push(putAwsLatestStmt(ctx.db, ACTIVITY_BACKLOG_KEY, read.backlog, at));
    else if (had) writes.push(ctx.db.prepare("DELETE FROM aws_latest WHERE key = ?1").bind(ACTIVITY_BACKLOG_KEY));
    if (writes.length) await ctx.db.batch(writes);
    const notes: string[] = [];
    if (trimmed.dropped.length) notes.push(`CloudTrail events from ${trimmed.dropped.map((w) => w.from).sort()[0]} to ${trimmed.dropped.map((w) => w.to).sort().pop()} were never read and are over 7 days old; they are dropped.`);
    if (read.backlog.length) {
      const from = read.backlog.map((w) => w.from).sort()[0];
      const to = read.backlog.map((w) => w.to).sort().pop();
      notes.push(`CloudTrail had more write events than one run reads; catching up on ${from} to ${to}.`);
    }
    return { status: "ok", error: null, ...(notes.length ? { note: notes.join(" ") } : {}) };
  },
};

export default activity;
