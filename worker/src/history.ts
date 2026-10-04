// history.ts
//
// Plain English: the dashboard's own history, like an SNMP poller keeping
// readings instead of only showing the current one. Every VM heartbeat
// adds to a one-minute sample for the VM and one per client (history in
// D1, tables in migrations/0012_history.sql). The watchman fills in the
// minutes when no heartbeat came, so availability is honest, and folds
// samples older than 48 hours into 5-minute summaries kept for 30 days.
// Nothing is recorded while the VM is destroyed or in Standby.

import type { Env } from "./env";
import type { AgentReport, FirewallStatus, Snapshot, Traffic } from "./state";
import { peerOnline } from "./state";
import { listPeers } from "./db";
import { vitalsSample } from "./vitals";

/** Seconds per raw sample. A minute, not 30 s: heartbeats drift, and a 30 s
 *  slot could miss one and read as downtime while the VM was fine. */
export const RAW_RES = 60;
/** Seconds per summary row. */
export const SUMMARY_RES = 300;
/** Raw samples are folded into summaries after 48 hours. */
export const RAW_KEEP_MS = 48 * 3600_000;
/** Summaries and drops are deleted after 30 days. */
export const SUMMARY_KEEP_MS = 30 * 86_400_000;
/** The last 2 minutes are left alone: a heartbeat may be on its way. */
export const LATE_GRACE_MS = 2 * 60_000;
/** How far back the watchman looks for missed minutes (it runs every 5). */
export const LOOKBACK_MS = 15 * 60_000;

/** The start of the slot holding `ms`, as "YYYY-MM-DDTHH:MM:SSZ". */
export function bucket(ms: number, res: number): string {
  const start = Math.floor(ms / (res * 1000)) * res * 1000;
  return new Date(start).toISOString().replace(".000Z", "Z");
}

export interface VmSample {
  load1: number | null;
  rx_rate: number;
  tx_rate: number;
  peers_online: number;
  dns_up: 0 | 1 | null;
}

/** One heartbeat's VM reading: load, traffic rate, clients online, tunnel DNS. */
export function vmSample(report: AgentReport, traffic: Traffic): VmSample {
  const load = Number.parseFloat((report.load ?? "").split(" ")[0]);
  return {
    load1: Number.isFinite(load) ? load : null,
    rx_rate: traffic.rx_rate,
    tx_rate: traffic.tx_rate,
    peers_online: traffic.peers_online,
    dns_up: report.dns ? (report.dns.up ? 1 : 0) : null,
  };
}

export interface ClientSample {
  peer_id: number;
  online: 0 | 1;
  handshake_age: number | null;
  latency: number | null;
  rx: number;
  tx: number;
}

/**
 * One heartbeat's reading for each known client. Bytes are what moved since
 * the previous heartbeat; a counter that went down (the VM rebooted or was
 * rebuilt) counts from zero, and the first heartbeat of a session counts
 * the whole counter. Keys that are not a client in the table are skipped,
 * and so is a client that is offline, moved nothing and answered no ping:
 * no row means idle and offline, which keeps the write count down.
 */
export function clientSamples(o: {
  report: AgentReport;
  prev: AgentReport | null;
  rtt: Record<string, number> | null | undefined;
  peers: { id: number; public_key: string }[];
  nowMs: number;
}): ClientSample[] {
  const ids = new Map(o.peers.map((p) => [p.public_key, p.id]));
  const before = new Map((o.prev?.peers ?? []).map((p) => [p.public_key, p]));
  const delta = (now: number, prev: number | undefined) => (prev !== undefined && now >= prev ? now - prev : now);
  const out: ClientSample[] = [];
  for (const p of o.report.peers) {
    const id = ids.get(p.public_key);
    if (id === undefined) continue;
    const was = before.get(p.public_key);
    const ms = o.rtt?.[p.public_key];
    const sample: ClientSample = {
      peer_id: id,
      online: peerOnline(p, o.nowMs) ? 1 : 0,
      handshake_age: p.latest_handshake > 0 ? Math.max(0, Math.round(o.nowMs / 1000 - p.latest_handshake)) : null,
      latency: typeof ms === "number" && Number.isFinite(ms) ? Math.round(ms * 10) / 10 : null,
      rx: delta(p.rx, was?.rx),
      tx: delta(p.tx, was?.tx),
    };
    if (!sample.online && !sample.rx && !sample.tx && sample.latency === null) continue;
    out.push(sample);
  }
  return out;
}

export interface FwDelta {
  rule: string;
  packets: number;
  bytes: number;
}

/** A counter reading as a pair of whole, non-negative numbers, or null when it is not one. */
function counterPair(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const p = Math.floor(Number(v[0]));
  const b = Math.floor(Number(v[1]));
  if (!Number.isFinite(p) || p < 0) return null;
  return [p, Number.isFinite(b) && b >= 0 ? b : 0];
}

/**
 * What each firewall counter gained since the previous report. The VM's
 * counters restart when a rule set is loaded or the VM reboots, and this
 * uses the same rule as the carried-over totals (runs.ts nextBase): on a
 * different rule set, for a counter that is new, or for one whose packet
 * count went down, the whole reading counts (it started from zero). Bytes
 * that went down while packets did not are counted whole too, never as a
 * negative. Only counters that gained packets are returned.
 */
export function fwDeltas(prev: FirewallStatus | null, rep: { hash?: string; counters?: Record<string, [number, number]> } | null | undefined): FwDelta[] {
  const counters = rep?.counters;
  if (!counters || typeof counters !== "object") return [];
  const sameSet = !!prev && prev.applied_hash === (rep?.hash || null);
  const out: FwDelta[] = [];
  for (const [rule, v] of Object.entries(counters)) {
    const now = counterPair(v);
    if (!now) continue;
    const was = sameSet ? counterPair(prev?.counters[rule]) : null;
    if (!was || now[0] < was[0]) {
      if (now[0] > 0) out.push({ rule, packets: now[0], bytes: now[1] });
    } else if (now[0] > was[0]) {
      out.push({ rule, packets: now[0] - was[0], bytes: now[1] >= was[1] ? now[1] - was[1] : now[1] });
    }
  }
  return out;
}

/**
 * Add one heartbeat to this minute's samples: the VM, each known client,
 * the firewall drops it reported, and the packets each firewall rule
 * matched since the last report (`fwHits`, from fwDeltas; only counters
 * that went up have a row). One transaction. A second heartbeat in the
 * same minute keeps "received" at 1, adds the bytes, keeps the latest rate
 * and the highest rate and latency seen.
 */
export async function recordHeartbeat(
  env: Env,
  o: { report: AgentReport; prev: AgentReport | null; rtt: Record<string, number> | null | undefined; traffic: Traffic; drops: FirewallStatus["drops"]; fwHits?: FwDelta[] },
): Promise<void> {
  const nowMs = Date.parse(o.report.at);
  const t = bucket(nowMs, RAW_RES);
  const vm = vmSample(o.report, o.traffic);
  // The VM's own vitals (agent version 7; all null from an older agent).
  const vit = vitalsSample(o.report.vitals, nowMs);
  const clients = clientSamples({ report: o.report, prev: o.prev, rtt: o.rtt, peers: await listPeers(env), nowMs });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO hist_vm (res, t, expected, received, load1, rx_rate, tx_rate, rx_rate_max, tx_rate_max, peers_online, dns_up,
                           mem_used_pct, disk_used_pct, steal_pct, conntrack_pct, net_rtt_ms, net_loss_pct)
       VALUES (?1, ?2, 1, 1, ?3, ?4, ?5, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT (res, t) DO UPDATE SET
         received = 1, load1 = excluded.load1, rx_rate = excluded.rx_rate, tx_rate = excluded.tx_rate,
         rx_rate_max = MAX(COALESCE(rx_rate_max, 0), excluded.rx_rate_max),
         tx_rate_max = MAX(COALESCE(tx_rate_max, 0), excluded.tx_rate_max),
         peers_online = excluded.peers_online, dns_up = excluded.dns_up,
         mem_used_pct = COALESCE(excluded.mem_used_pct, mem_used_pct),
         disk_used_pct = COALESCE(excluded.disk_used_pct, disk_used_pct),
         steal_pct = MAX(COALESCE(steal_pct, excluded.steal_pct), COALESCE(excluded.steal_pct, steal_pct)),
         conntrack_pct = COALESCE(excluded.conntrack_pct, conntrack_pct),
         net_rtt_ms = COALESCE(excluded.net_rtt_ms, net_rtt_ms),
         net_loss_pct = MAX(COALESCE(net_loss_pct, excluded.net_loss_pct), COALESCE(excluded.net_loss_pct, net_loss_pct))`,
    ).bind(RAW_RES, t, vm.load1, vm.rx_rate, vm.tx_rate, vm.peers_online, vm.dns_up, vit.mem_used_pct, vit.disk_used_pct, vit.steal_pct, vit.conntrack_pct, vit.net_rtt_ms, vit.net_loss_pct),
    ...clients.map((c) =>
      env.DB.prepare(
        `INSERT INTO hist_client (res, t, peer_id, online, handshake_age, latency_avg, latency_max, rx, tx)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)
         ON CONFLICT (res, t, peer_id) DO UPDATE SET
           online = MAX(online, excluded.online), handshake_age = excluded.handshake_age,
           latency_avg = COALESCE((latency_avg + excluded.latency_avg) / 2, excluded.latency_avg, latency_avg),
           latency_max = MAX(COALESCE(latency_max, excluded.latency_max), COALESCE(excluded.latency_max, latency_max)),
           rx = rx + excluded.rx, tx = tx + excluded.tx`,
      ).bind(RAW_RES, t, c.peer_id, c.online, c.handshake_age, c.latency, c.rx, c.tx),
    ),
    ...o.drops.map((d) =>
      env.DB.prepare(
        `INSERT INTO hist_drops (t, src, dst, proto, dport, in_if, out_if, n) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
         ON CONFLICT (t, src, dst, proto, dport, in_if, out_if) DO UPDATE SET n = n + 1`,
      ).bind(bucket(Date.parse(d.at), RAW_RES), d.src, d.dst, d.proto, d.dport ?? 0, d.in, d.out),
    ),
    ...(o.fwHits ?? []).map((h) =>
      env.DB.prepare(
        `INSERT INTO hist_fw (res, t, rule, packets, bytes) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (res, t, rule) DO UPDATE SET packets = packets + excluded.packets, bytes = bytes + excluded.bytes`,
      ).bind(RAW_RES, t, h.rule, h.packets, h.bytes),
    ),
  ]);
}

/**
 * The watchman's half of availability: every fully elapsed minute in the
 * last 15 with no heartbeat, while the VM is meant to be up, gets a row
 * saying so. Counting starts at the session's first heartbeat: boot and
 * the self-test can take several minutes after GitHub reports the VM built,
 * and that is not downtime. The last 2 minutes are left alone (a heartbeat
 * may be on its way).
 */
export async function recordMissedHeartbeats(env: Env, snap: Snapshot, now: Date): Promise<number> {
  if (snap.state !== "running" || !snap.running_since) return 0;
  const first = await env.DB.prepare("SELECT MIN(t) AS t FROM hist_vm WHERE res = ?1 AND t >= ?2 AND received = 1")
    .bind(RAW_RES, bucket(Date.parse(snap.running_since), RAW_RES))
    .first<{ t: string | null }>();
  if (!first?.t) return 0;
  const step = RAW_RES * 1000;
  const from = Math.ceil(Math.max(Date.parse(first.t), now.getTime() - LOOKBACK_MS) / step) * step;
  const until = now.getTime() - LATE_GRACE_MS;
  const stmts: D1PreparedStatement[] = [];
  for (let ms = from; ms + step <= until; ms += step) {
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO hist_vm (res, t, expected, received) VALUES (?1, ?2, 1, 0)").bind(RAW_RES, bucket(ms, RAW_RES)));
  }
  if (!stmts.length) return 0;
  const results = await env.DB.batch(stmts);
  return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

/** The 5-minute slot of a stored time, in SQL. */
const SUMMARY_SLOT = `strftime('%Y-%m-%dT%H:%M:%SZ', (CAST(strftime('%s', t) AS INTEGER) / ${SUMMARY_RES}) * ${SUMMARY_RES}, 'unixepoch')`;

/**
 * Housekeeping, every 5 minutes: raw samples older than 48 hours become
 * 5-minute summaries (counts and bytes summed, rates and latency averaged,
 * the peaks kept, DNS down if it was down at any point, a client online if
 * it was online at any point), then are deleted. Summaries and drops older
 * than 30 days are deleted. One transaction.
 */
export async function rollUp(env: Env, now: Date): Promise<void> {
  const cutoff = bucket(now.getTime() - RAW_KEEP_MS, SUMMARY_RES);
  const expiry = bucket(now.getTime() - SUMMARY_KEEP_MS, SUMMARY_RES);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO hist_vm (res, t, expected, received, load1, rx_rate, tx_rate, rx_rate_max, tx_rate_max, peers_online, dns_up,
                           mem_used_pct, disk_used_pct, steal_pct, conntrack_pct, net_rtt_ms, net_loss_pct)
       SELECT ${SUMMARY_RES}, ${SUMMARY_SLOT} AS slot, SUM(expected), SUM(received), AVG(load1), AVG(rx_rate), AVG(tx_rate),
              MAX(rx_rate_max), MAX(tx_rate_max), MAX(peers_online), MIN(dns_up),
              AVG(mem_used_pct), AVG(disk_used_pct), MAX(steal_pct), AVG(conntrack_pct), AVG(net_rtt_ms), MAX(net_loss_pct)
       FROM hist_vm WHERE res = ${RAW_RES} AND t < ?1 GROUP BY slot
       ON CONFLICT (res, t) DO UPDATE SET expected = expected + excluded.expected, received = received + excluded.received`,
    ).bind(cutoff),
    env.DB.prepare(
      `INSERT INTO hist_client (res, t, peer_id, online, handshake_age, latency_avg, latency_max, rx, tx)
       SELECT ${SUMMARY_RES}, ${SUMMARY_SLOT} AS slot, peer_id, MAX(online), MIN(handshake_age), AVG(latency_avg), MAX(latency_max), SUM(rx), SUM(tx)
       FROM hist_client WHERE res = ${RAW_RES} AND t < ?1 GROUP BY peer_id, slot
       ON CONFLICT (res, t, peer_id) DO UPDATE SET rx = rx + excluded.rx, tx = tx + excluded.tx`,
    ).bind(cutoff),
    env.DB.prepare(
      `INSERT INTO hist_fw (res, t, rule, packets, bytes)
       SELECT ${SUMMARY_RES}, ${SUMMARY_SLOT} AS slot, rule, SUM(packets), SUM(bytes)
       FROM hist_fw WHERE res = ${RAW_RES} AND t < ?1 GROUP BY rule, slot
       ON CONFLICT (res, t, rule) DO UPDATE SET packets = packets + excluded.packets, bytes = bytes + excluded.bytes`,
    ).bind(cutoff),
    env.DB.prepare(`DELETE FROM hist_vm WHERE res = ${RAW_RES} AND t < ?1`).bind(cutoff),
    env.DB.prepare(`DELETE FROM hist_client WHERE res = ${RAW_RES} AND t < ?1`).bind(cutoff),
    env.DB.prepare(`DELETE FROM hist_fw WHERE res = ${RAW_RES} AND t < ?1`).bind(cutoff),
    // Raw rows never live 30 days (they are folded at 48 hours), so only summaries expire here.
    env.DB.prepare(`DELETE FROM hist_vm WHERE res = ${SUMMARY_RES} AND t < ?1`).bind(expiry),
    env.DB.prepare(`DELETE FROM hist_client WHERE res = ${SUMMARY_RES} AND t < ?1`).bind(expiry),
    env.DB.prepare(`DELETE FROM hist_fw WHERE res = ${SUMMARY_RES} AND t < ?1`).bind(expiry),
    env.DB.prepare("DELETE FROM hist_drops WHERE t < ?1").bind(expiry),
  ]);
}

export type HistoryRange = "1h" | "24h" | "7d" | "30d";
export const RANGE_MS: Record<HistoryRange, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
/** Seconds per point for each range: about 60 to 360 points, enough for a chart. */
export const RANGE_STEP: Record<HistoryRange, number> = { "1h": 60, "24h": 300, "7d": 1800, "30d": 7200 };

export interface VmPoint {
  t: string;
  expected: number;
  received: number;
  load1: number | null;
  rx_rate: number | null;
  tx_rate: number | null;
  rx_rate_max: number | null;
  tx_rate_max: number | null;
  peers_online: number | null;
  dns_up: number | null;
}

export interface ClientPoint {
  t: string;
  online: number;
  latency_avg: number | null;
  latency_max: number | null;
  rx: number;
  tx: number;
}

export interface VmHistory {
  range: HistoryRange;
  step: number;
  from: string;
  to: string;
  points: VmPoint[];
  /** The newest point with a heartbeat in it, or null. */
  latest: string | null;
  /** Heartbeat minutes received out of those expected while running; pct null when there is nothing to judge. */
  availability: { expected: number; received: number; pct: number | null };
}

export interface ClientHistory {
  range: HistoryRange;
  step: number;
  from: string;
  to: string;
  points: ClientPoint[];
  latest: string | null;
}

/** The slot of a stored time at `?3` seconds per point, in SQL. The step is cast to a whole number: a JavaScript number binds as a decimal, and decimal division would not round down to the slot. */
const POINT = `strftime('%Y-%m-%dT%H:%M:%SZ', (CAST(strftime('%s', t) AS INTEGER) / CAST(?3 AS INTEGER)) * CAST(?3 AS INTEGER), 'unixepoch')`;

function window(range: HistoryRange, now: Date) {
  const step = RANGE_STEP[range];
  return { step, from: bucket(now.getTime() - RANGE_MS[range], step), to: bucket(now.getTime(), 1) };
}

/** The VM's history for a range: raw minutes and 5-minute summaries together, one point per step. */
export async function readVmHistory(env: Env, range: HistoryRange, now: Date): Promise<VmHistory> {
  const { step, from, to } = window(range, now);
  const rows = (
    await env.DB.prepare(
      `SELECT ${POINT} AS t, SUM(expected) AS expected, SUM(received) AS received, AVG(load1) AS load1,
              AVG(rx_rate) AS rx_rate, AVG(tx_rate) AS tx_rate, MAX(rx_rate_max) AS rx_rate_max, MAX(tx_rate_max) AS tx_rate_max,
              MAX(peers_online) AS peers_online, MIN(dns_up) AS dns_up
       FROM hist_vm WHERE res IN (${RAW_RES}, ${SUMMARY_RES}) AND t >= ?1 AND t <= ?2 GROUP BY 1 ORDER BY 1`,
    )
      .bind(from, to, step)
      .all<VmPoint>()
  ).results;
  const expected = rows.reduce((n, p) => n + p.expected, 0);
  const received = rows.reduce((n, p) => n + p.received, 0);
  return {
    range,
    step,
    from,
    to,
    points: rows,
    latest: [...rows].reverse().find((p) => p.received > 0)?.t ?? null,
    availability: { expected, received, pct: expected ? Math.round((received / expected) * 1000) / 10 : null },
  };
}

export interface RulePoint {
  t: string;
  packets: number;
  bytes: number;
}

export interface RuleHistory {
  range: HistoryRange;
  step: number;
  from: string;
  to: string;
  points: RulePoint[];
  latest: string | null;
}

/** A firewall counter key: "r<id>" for a rule, "default", or "f<id>" for a published port. */
export const RULE_KEY = /^(?:r[1-9]\d{0,9}|f[1-9]\d{0,9}|default)$/;

/** One firewall counter's hits for a range. No point in a step means it matched nothing then (no data is not zero). */
export async function readRuleHistory(env: Env, rule: string, range: HistoryRange, now: Date): Promise<RuleHistory> {
  const { step, from, to } = window(range, now);
  const rows = (
    await env.DB.prepare(
      `SELECT ${POINT} AS t, SUM(packets) AS packets, SUM(bytes) AS bytes
       FROM hist_fw WHERE res IN (${RAW_RES}, ${SUMMARY_RES}) AND t >= ?1 AND t <= ?2 AND rule = ?4 GROUP BY 1 ORDER BY 1`,
    )
      .bind(from, to, step, rule)
      .all<RulePoint>()
  ).results;
  return { range, step, from, to, points: rows, latest: rows.at(-1)?.t ?? null };
}

/** One client's history for a range. No point in a step means the client was idle and offline then. */
export async function readClientHistory(env: Env, peerId: number, range: HistoryRange, now: Date): Promise<ClientHistory> {
  const { step, from, to } = window(range, now);
  const rows = (
    await env.DB.prepare(
      `SELECT ${POINT} AS t, MAX(online) AS online, AVG(latency_avg) AS latency_avg, MAX(latency_max) AS latency_max, SUM(rx) AS rx, SUM(tx) AS tx
       FROM hist_client WHERE res IN (${RAW_RES}, ${SUMMARY_RES}) AND t >= ?1 AND t <= ?2 AND peer_id = ?4 GROUP BY 1 ORDER BY 1`,
    )
      .bind(from, to, step, peerId)
      .all<ClientPoint>()
  ).results;
  return { range, step, from, to, points: rows, latest: rows.at(-1)?.t ?? null };
}
