// history.ts
//
// Plain English: the dashboard's own history, like an SNMP poller keeping
// readings instead of only showing the current one. Every VM heartbeat
// adds to a one-minute sample for the VM and one per client (history in
// D1, tables in migrations/0012_history.sql). The watchman fills in the
// minutes when no heartbeat came, so availability is honest, and folds
// samples older than 48 hours into 5-minute summaries kept for 30 days.
// Nothing is recorded while the VM is destroyed or in Standby.

import type { AgentReport, Traffic } from "./state";
import { peerOnline } from "./state";

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
