// activity.ts
//
// Plain English: what the Activity screen is made of, apart from how it looks:
// what a session cost, how the change log is filtered and worded, and (for the
// data API) the logbook turned into one list of events, a timeline and the
// figures across the top. The old page and the API both use it.

import type { Run, Alert, AuditEntry } from "./db";
import type { Config } from "./env";

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

