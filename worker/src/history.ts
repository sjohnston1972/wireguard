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
import type { AgentReport, FirewallStatus, Traffic } from "./state";
import { peerOnline } from "./state";
import { listPeers } from "./db";

/** Seconds per raw sample. A minute, not 30 s: heartbeats drift, and a 30 s
 *  slot could miss one and read as downtime while the VM was fine. */
export const RAW_RES = 60;
/** Seconds per summary row. */
export const SUMMARY_RES = 300;
/** Raw samples are folded into summaries after 48 hours. */
export const RAW_KEEP_MS = 48 * 3600_000;
/** Summaries and drops are deleted after 30 days. */
export const SUMMARY_KEEP_MS = 30 * 86_400_000;
/** No minute counts as missed until 3 minutes after the VM came up (boot and self-test). */
export const BOOT_GRACE_MS = 3 * 60_000;
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
 * the whole counter. Keys that are not a client in the table are skipped.
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
    out.push({
      peer_id: id,
      online: peerOnline(p, o.nowMs) ? 1 : 0,
      handshake_age: p.latest_handshake > 0 ? Math.max(0, Math.round(o.nowMs / 1000 - p.latest_handshake)) : null,
      latency: typeof ms === "number" && Number.isFinite(ms) ? Math.round(ms * 10) / 10 : null,
      rx: delta(p.rx, was?.rx),
      tx: delta(p.tx, was?.tx),
    });
  }
  return out;
}

/**
 * Add one heartbeat to this minute's samples: the VM, each known client,
 * and the firewall drops it reported. One transaction. A second heartbeat
 * in the same minute keeps "received" at 1, adds the bytes, keeps the
 * latest rate and the highest rate and latency seen.
 */
export async function recordHeartbeat(
  env: Env,
  o: { report: AgentReport; prev: AgentReport | null; rtt: Record<string, number> | null | undefined; traffic: Traffic; drops: FirewallStatus["drops"] },
): Promise<void> {
  const nowMs = Date.parse(o.report.at);
  const t = bucket(nowMs, RAW_RES);
  const vm = vmSample(o.report, o.traffic);
  const clients = clientSamples({ report: o.report, prev: o.prev, rtt: o.rtt, peers: await listPeers(env), nowMs });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO hist_vm (res, t, expected, received, load1, rx_rate, tx_rate, rx_rate_max, tx_rate_max, peers_online, dns_up)
       VALUES (?1, ?2, 1, 1, ?3, ?4, ?5, ?4, ?5, ?6, ?7)
       ON CONFLICT (res, t) DO UPDATE SET
         received = 1, load1 = excluded.load1, rx_rate = excluded.rx_rate, tx_rate = excluded.tx_rate,
         rx_rate_max = MAX(COALESCE(rx_rate_max, 0), excluded.rx_rate_max),
         tx_rate_max = MAX(COALESCE(tx_rate_max, 0), excluded.tx_rate_max),
         peers_online = excluded.peers_online, dns_up = excluded.dns_up`,
    ).bind(RAW_RES, t, vm.load1, vm.rx_rate, vm.tx_rate, vm.peers_online, vm.dns_up),
    ...clients.map((c) =>
      env.DB.prepare(
        `INSERT INTO hist_client (res, t, peer_id, online, handshake_age, latency_avg, latency_max, rx, tx)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)
         ON CONFLICT (res, peer_id, t) DO UPDATE SET
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
  ]);
}
