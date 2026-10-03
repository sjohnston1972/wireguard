// fwview.ts
//
// Plain English: what the Firewall screen reads off the stored state: where
// the rule set stands on the VM (applied, pending, refused...), a rule's
// running hit total, and how many drops the default rule made lately. The
// old page and the data API both use these, so they always agree.

import type { Env } from "./env";
import type { Snapshot } from "./state";
import { STARTER_RULES, type FwRule } from "./firewall";
import { bucket, RAW_RES, SUMMARY_RES } from "./history";

export type PolicyState = "not_running" | "no_firewall" | "refused" | "applied" | "pending";

/** Where the rule set stands on the VM, with the sentence the screen shows. */
export function policyState(snap: Snapshot, hash: string): { state: PolicyState; text: string } {
  const fw = snap.firewall;
  if (snap.state !== "running") return { state: "not_running", text: "Not running: this rule set is loaded at the next deploy or resume." };
  if (!fw) return { state: "no_firewall", text: "This VM was built before the firewall existed: redeploy to use it." };
  if (fw.error) return { state: "refused", text: `The VM refused the last rule set and kept the previous one: ${fw.error}` };
  if (fw.applied_hash === hash) return { state: "applied", text: `Applied on the VM (rule set ${hash.slice(0, 8)}).` };
  return { state: "pending", text: "Changed: the VM picks it up within 30 seconds." };
}

/** A rule's running total: carried-over hits plus the VM's current counter. */
export function totalHits(snap: Snapshot, key: string): [number, number] | null {
  const c = snap.firewall?.counters[key];
  const b = snap.fw_base?.[key];
  if (!c && !b) return null;
  return [Math.max(0, (c?.[0] ?? 0) + (b?.[0] ?? 0)), Math.max(0, (c?.[1] ?? 0) + (b?.[1] ?? 0))];
}

const HOUR_S = 3600;
const DAY_MS = 86_400_000;

/**
 * Packets each counter matched over the last 24 hours, in total and as 24
 * hourly counts (oldest first, the last hour ending now), from hist_fw
 * (an index range on the time). Counters with no row get no entry, and the
 * whole answer is null when nothing at all was recorded in the window, so
 * "no history" is never shown as "no hits".
 */
export async function fwHitsLast24h(env: Env, nowMs: number): Promise<Record<string, { packets: number; trend: number[] }> | null> {
  const fromMs = Math.floor((nowMs - DAY_MS) / 60_000) * 60_000;
  const rows = (
    await env.DB.prepare(
      `SELECT rule, (CAST(strftime('%s', t) AS INTEGER) - CAST(?3 AS INTEGER)) / ${HOUR_S} AS h, SUM(packets) AS n
       FROM hist_fw WHERE res IN (${RAW_RES}, ${SUMMARY_RES}) AND t >= ?1 AND t <= ?2 GROUP BY rule, h`,
    )
      .bind(bucket(fromMs, RAW_RES), bucket(nowMs, 1), fromMs / 1000)
      .all<{ rule: string; h: number; n: number }>()
  ).results;
  if (!rows.length) return null;
  const out: Record<string, { packets: number; trend: number[] }> = {};
  for (const r of rows) {
    const e = (out[r.rule] ??= { packets: 0, trend: Array(24).fill(0) });
    e.trend[Math.max(0, Math.min(23, r.h))] += r.n;
    e.packets += r.n;
  }
  return out;
}

/**
 * The drop statistics for the Firewall screen, from hist_drops (index
 * ranges on the time): drops per hour over the last 24 hours (oldest first),
 * how many different source addresses made them, and the total for the 24
 * hours before that, for the "vs the day before" figure.
 */
export async function dropStats24h(env: Env, nowMs: number): Promise<{ hourly: number[]; uniqueSources: number; previous: number }> {
  const fromMs = Math.floor((nowMs - DAY_MS) / 60_000) * 60_000;
  const from = bucket(fromMs, RAW_RES);
  const now = bucket(nowMs, 1);
  const [hours, uniq, prev] = await Promise.all([
    env.DB.prepare(
      `SELECT (CAST(strftime('%s', t) AS INTEGER) - CAST(?3 AS INTEGER)) / ${HOUR_S} AS h, SUM(n) AS n FROM hist_drops WHERE t >= ?1 AND t <= ?2 GROUP BY h`,
    )
      .bind(from, now, fromMs / 1000)
      .all<{ h: number; n: number }>(),
    env.DB.prepare("SELECT COUNT(DISTINCT src) AS n FROM hist_drops WHERE t >= ?1 AND t <= ?2").bind(from, now).first<{ n: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM hist_drops WHERE t >= ?1 AND t < ?2").bind(bucket(fromMs - DAY_MS, RAW_RES), from).first<{ n: number }>(),
  ]);
  const hourly: number[] = Array(24).fill(0);
  for (const r of hours.results) hourly[Math.max(0, Math.min(23, r.h))] += r.n;
  return { hourly, uniqueSources: Number(uniq?.n ?? 0), previous: Number(prev?.n ?? 0) };
}

/**
 * Which of the last 24 hours (oldest first, bucketed as the trends are) the
 * VM was up in: any minute with a heartbeat received, from hist_vm (an index
 * range on the time).
 */
export async function vmUpHours24h(env: Env, nowMs: number): Promise<boolean[]> {
  const fromMs = Math.floor((nowMs - DAY_MS) / 60_000) * 60_000;
  const rows = (
    await env.DB.prepare(
      `SELECT (CAST(strftime('%s', t) AS INTEGER) - CAST(?3 AS INTEGER)) / ${HOUR_S} AS h, SUM(received) AS n
       FROM hist_vm WHERE res IN (${RAW_RES}, ${SUMMARY_RES}) AND t >= ?1 AND t <= ?2 GROUP BY h`,
    )
      .bind(bucket(fromMs, RAW_RES), bucket(nowMs, 1), fromMs / 1000)
      .all<{ h: number; n: number }>()
  ).results;
  const up: boolean[] = Array(24).fill(false);
  for (const r of rows) if (r.n > 0) up[Math.max(0, Math.min(23, r.h))] = true;
  return up;
}

/** Hourly counts with the hours the VM was not up as null ("no data", not 0). A count recorded anyway is kept. */
export function onlyWhenUp(counts: number[], up: boolean[]): (number | null)[] {
  return counts.map((n, i) => (n > 0 || up[i] ? n : null));
}

/** True when a rule is one of the starter rules a fresh install comes with (same name and same ends), for the "Custom / Default" filter. */
export function isStarterRule(r: Pick<FwRule, "name" | "src_kind" | "src_value" | "dst_kind" | "dst_value">): boolean {
  return STARTER_RULES.some((s) => s.name === r.name && s.src_kind === r.src_kind && s.src_value === r.src_value && s.dst_kind === r.dst_kind && s.dst_value === r.dst_value);
}

/** Drops the default rule made since a time (from the history table; an index search on the time). */
export async function dropsSince(env: Env, sinceIso: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM hist_drops WHERE t >= ?1").bind(sinceIso).first<{ n: number }>();
  return Number(r?.n ?? 0);
}
