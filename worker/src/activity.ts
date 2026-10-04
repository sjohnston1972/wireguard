// activity.ts
//
// Plain English: what the Activity screen is made of, apart from how it looks:
// what a session cost, how the change log is filtered and worded, and (for the
// data API) the logbook turned into one list of events, a timeline and the
// figures across the top. The old page and the API both use it.

import type { Run, Alert, AuditEntry } from "./db";
import type { Config } from "./env";
import type { LabAction } from "../../shared/api";

export function sessionCost(run: Run, runs: Run[], cfg: Config, now = Date.now()): number | null {
  if (run.action !== "apply" || run.status !== "success" || !run.finished_at) return null;
  // Session ends at the next successful destroy after this apply, or now.
  const end = runs
    .filter((r) => r.action === "destroy" && r.status === "success" && r.finished_at && Date.parse(r.finished_at) > Date.parse(run.finished_at!))
    .map((r) => Date.parse(r.finished_at!))
    .sort((a, b) => a - b)[0];
  const ms = (end ?? now) - Date.parse(run.finished_at);
  return (ms / 3_600_000) * cfg.hourlyRateGbp;
}

/** Change-log rows per page. */
export const AUDIT_PAGE = 50;

/** The change log's "Show" filter: the first word of each change's action. */
export const AUDIT_KINDS: { value: string; label: string }[] = [
  { value: "", label: "All changes" },
  { value: "client", label: "Clients" },
  { value: "firewall", label: "Firewall and published ports" },
  { value: "settings", label: "Settings" },
  { value: "profile", label: "Profiles" },
  { value: "schedule", label: "Schedules" },
  { value: "push", label: "Phone alerts" },
  { value: "capture", label: "Packet captures" },
  { value: "lock", label: "Run lock" },
  { value: "config", label: "Backup and restore" },
];

/** One value, short enough for a table cell. */
export function shortValue(v: unknown): string {
  const s = v === null || v === undefined ? "none" : typeof v === "string" ? (v === "" ? "blank" : v) : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/**
 * A change's before and after as plain lines: "enabled: 1 → 0" for an
 * edit, "name = Phone" for something added, "removed; it was:" and the old
 * values for a delete.
 */
export function describeChange(beforeJson: string | null, afterJson: string | null): string[] {
  const parse = (j: string | null): unknown => {
    try {
      return j === null ? null : JSON.parse(j);
    } catch {
      return j;
    }
  };
  const b = parse(beforeJson), a = parse(afterJson);
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (obj(b) && obj(a)) return [...new Set([...Object.keys(b), ...Object.keys(a)])].map((k) => `${k}: ${shortValue(b[k])} → ${shortValue(a[k])}`);
  if (obj(a)) return Object.entries(a).map(([k, v]) => `${k} = ${shortValue(v)}`);
  if (obj(b)) return ["removed; it was:", ...Object.entries(b).map(([k, v]) => `${k} = ${shortValue(v)}`)];
  if (b !== null || a !== null) return [`${shortValue(b)} → ${shortValue(a)}`];
  return [];
}


// ── For the data API ──────────────────────────────────────────────────────

/** How far back the Activity screen looks. */
export type ActivityRange = "1h" | "6h" | "24h" | "7d" | "30d";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const ACTIVITY_RANGE_MS: Record<ActivityRange, number> = { "1h": HOUR, "6h": 6 * HOUR, "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };

/** How wide one timeline bucket is, per range. */
export const ACTIVITY_BUCKET_MS: Record<ActivityRange, number> = { "1h": 5 * MIN, "6h": 30 * MIN, "24h": HOUR, "7d": 6 * HOUR, "30d": DAY };

/** The range named in an address, or null when it is not one we know. */
export function parseRange(v: string | undefined): ActivityRange | null {
  return v !== undefined && Object.prototype.hasOwnProperty.call(ACTIVITY_RANGE_MS, v) ? (v as ActivityRange) : null;
}

/** A run as the API shows it: the facts of the run, and none of its secrets. */
export interface RunRow {
  id: string;
  action: Run["action"];
  status: Run["status"];
  requested_at: string;
  requested_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  github_run_url: string | null;
  public_ip: string | null;
  reason: string | null;
  error: string | null;
  durationSeconds: number | null;
  sessionCostGbp: number | null;
  /**
   * Set for a lab run (lab_runs, id "lab-..."): the lab and its own action. Such a
   * row's `action` is "apply" for deploy, peer and test and "destroy" for destroy
   * and unpeer, so a gateway-only view still reads it. Absent or null: a gateway run.
   */
  lab?: { id: string; title: string; action: LabAction } | null;
  /** Why it ran: the stated reason, else "watchman" for the watchman's own runs, else "dashboard". */
  source: string;
}

/** One run without its secrets (SSH password, token hashes, payload). */
export function runRow(run: Run, runs: Run[], cfg: Config, now = Date.now()): RunRow {
  const took = run.finished_at ? Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at ?? run.requested_at)) / 1000) : null;
  return {
    id: run.id,
    action: run.action,
    status: run.status,
    requested_at: run.requested_at,
    requested_by: run.requested_by,
    started_at: run.started_at,
    finished_at: run.finished_at,
    github_run_url: run.github_run_url,
    public_ip: run.public_ip,
    reason: run.reason,
    error: run.error,
    durationSeconds: took !== null && Number.isFinite(took) && took >= 0 ? took : null,
    sessionCostGbp: sessionCost(run, runs, cfg, now),
    source: run.reason || (run.requested_by === "watchman" ? "watchman" : "dashboard"),
  };
}

export type EventType = "deploy" | "destroy" | "failure" | "config" | "firewall" | "watchman";

export interface ActivityEvent {
  at: string;
  type: EventType;
  title: string;
  detail: string | null;
  ref: { kind: "run" | "note" | "change"; id: string | number };
}

/** Notes that report how a run went; the runs themselves already cover these. */
const RUN_NOTES = ["deploy", "destroy", "session"];

/**
 * Runs, watchman notes and dashboard changes as one list, newest first. A
 * finished run is placed when it ended: a deploy, a tear-down or a failure
 * (any finished run that did not succeed). A run still going is left out.
 */
export function eventsOf(runs: Run[], alerts: Alert[], audit: AuditEntry[]): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const r of runs) {
    if (!r.finished_at || (r.status !== "success" && r.status !== "failure" && r.status !== "cancelled")) continue;
    if (r.status === "success") out.push({ at: r.finished_at, type: r.action === "apply" ? "deploy" : "destroy", title: r.action === "apply" ? "Deployed" : "Torn down", detail: r.reason, ref: { kind: "run", id: r.id } });
    else out.push({ at: r.finished_at, type: "failure", title: `${r.action === "apply" ? "Deploy" : "Tear-down"} ${r.status}`, detail: r.error ?? r.reason, ref: { kind: "run", id: r.id } });
  }
  for (const a of alerts) {
    if (RUN_NOTES.includes(a.kind)) continue;
    out.push({ at: a.at, type: "watchman", title: a.kind.replace(/_/g, " "), detail: a.message, ref: { kind: "note", id: a.id } });
  }
  for (const c of audit) {
    out.push({ at: c.at, type: c.action.startsWith("firewall.") ? "firewall" : "config", title: c.action, detail: c.target || null, ref: { kind: "change", id: c.id } });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * Events counted into equal buckets across the range, oldest first. Every
 * bucket is there, even an empty one, so a chart can draw the whole range.
 * Events outside the range are not counted.
 */
export function timeline(events: ActivityEvent[], range: ActivityRange, now = Date.now()): { start: string; counts: Record<EventType, number> }[] {
  const step = ACTIVITY_BUCKET_MS[range];
  const from = now - ACTIVITY_RANGE_MS[range];
  const n = ACTIVITY_RANGE_MS[range] / step;
  const empty = (): Record<EventType, number> => ({ deploy: 0, destroy: 0, failure: 0, config: 0, firewall: 0, watchman: 0 });
  const buckets = Array.from({ length: n }, (_, i) => ({ start: new Date(from + i * step).toISOString(), counts: empty() }));
  for (const e of events) {
    const t = Date.parse(e.at);
    if (!(t >= from && t <= now)) continue;
    buckets[Math.min(n - 1, Math.floor((t - from) / step))].counts[e.type]++;
  }
  return buckets;
}

export interface ActivityKpis {
  deploys: number;
  medianDeploySeconds: number | null;
  successRate: { success: number; finished: number; pct: number | null };
  failedRuns: number;
  configChanges: number;
  watchmanProblems: number;
}

/** Notes that mean something is wrong. */
export const PROBLEM_NOTES = ["failure", "drift", "cost_guard", "unreachable"];

/**
 * The figures across the top, over the range only. A deploy is a successful
 * apply requested in the range; the success rate counts runs requested in the
 * range that have finished (a cancelled one counts as not succeeding), and
 * has no percentage when none have.
 */
export function activityKpis(runs: Run[], alerts: Alert[], audit: AuditEntry[], range: ActivityRange, now = Date.now()): ActivityKpis {
  const from = now - ACTIVITY_RANGE_MS[range];
  const inRange = (iso: string) => {
    const t = Date.parse(iso);
    return t >= from && t <= now;
  };
  const mine = runs.filter((r) => inRange(r.requested_at));
  const finished = mine.filter((r) => r.status === "success" || r.status === "failure" || r.status === "cancelled");
  const success = finished.filter((r) => r.status === "success");
  const deploys = success.filter((r) => r.action === "apply" && r.finished_at);
  const secs = deploys.map((r) => (Date.parse(r.finished_at!) - Date.parse(r.started_at ?? r.requested_at)) / 1000).filter((s) => Number.isFinite(s) && s >= 0).sort((a, b) => a - b);
  const mid = Math.floor(secs.length / 2);
  return {
    deploys: deploys.length,
    medianDeploySeconds: secs.length ? Math.round(secs.length % 2 ? secs[mid] : (secs[mid - 1] + secs[mid]) / 2) : null,
    successRate: { success: success.length, finished: finished.length, pct: finished.length ? Math.round((success.length / finished.length) * 100) : null },
    failedRuns: finished.length - success.length,
    configChanges: audit.filter((c) => inRange(c.at)).length,
    watchmanProblems: alerts.filter((a) => inRange(a.at) && PROBLEM_NOTES.includes(a.kind)).length,
  };
}
