// state.ts
//
// Plain English: the one-line answer to "is it up?". A small JSON snapshot
// holds the current state (Destroyed, Deploying, Running, Destroying,
// Failed), the public IP, whether DNS matches, the last heartbeat from the
// VM, the auto-destroy deadline and what Azure says exists. Every page load
// reads it; every event (a click, a callback, a heartbeat, a cron check)
// patches it. It lives in the Durable Object so patches merge atomically; a
// KV mirror is kept only for cheap reads.
//
// The snapshot is a cache of the truth, never the truth: the cron re-derives
// it from GitHub, Azure and the VM, so a stale entry heals within 5 minutes.

import type { Env } from "./env";

export type State = "destroyed" | "deploying" | "running" | "destroying" | "failed";

/** One row in the "what exists in Azure" inventory. */
export interface AzureResource {
  kind: string; // "Resource group", "Virtual network", "Public IP", ...
  name: string;
  detail: string; // the one line that matters: address space, IP, size, rules
}

export interface AzureInventory {
  checked_at: string;
  resource_group: string;
  exists: boolean;
  resources: AzureResource[];
  error?: string;
}

export interface AgentPeer {
  public_key: string;
  endpoint: string | null;
  allowed_ips: string;
  latest_handshake: number; // epoch seconds, 0 = never
  rx: number;
  tx: number;
}

export interface AgentReport {
  at: string;
  hostname: string;
  uptime_seconds: number;
  load: string;
  listen_port: number | null;
  server_public_key: string | null;
  loopback: string | null; // address the VM reports on its lo1 dummy interface, null if absent
  peers: AgentPeer[];
}

/** Totals across all peers, plus the rate since the previous heartbeat. */
export interface Traffic {
  at: string;
  rx: number; // bytes received by the VM from clients (client -> Azure)
  tx: number; // bytes sent by the VM to clients (Azure -> client)
  rx_rate: number; // bytes per second over the last heartbeat interval
  tx_rate: number;
  peers_online: number;
}

/** Fold a new heartbeat into the traffic summary. Counters reset on a rebuild, so negative deltas are treated as zero. */
export function nextTraffic(prev: Traffic | null, report: AgentReport, now = Date.now()): Traffic {
  const rx = report.peers.reduce((a, p) => a + p.rx, 0);
  const tx = report.peers.reduce((a, p) => a + p.tx, 0);
  const peers_online = report.peers.filter((p) => peerOnline(p, now)).length;
  let rx_rate = 0, tx_rate = 0;
  if (prev) {
    const secs = (now - Date.parse(prev.at)) / 1000;
    if (secs > 0 && secs < 600) {
      rx_rate = Math.max(0, (rx - prev.rx) / secs);
      tx_rate = Math.max(0, (tx - prev.tx) / secs);
    }
  }
  return { at: new Date(now).toISOString(), rx, tx, rx_rate, tx_rate, peers_online };
}

/** "Packets are passing" = bytes moved in the last interval and the report is fresh. */
export function trafficFlowing(t: Traffic | null, now = Date.now()): boolean {
  return !!t && now - Date.parse(t.at) < 90_000 && t.rx_rate + t.tx_rate > 0;
}

export interface Step {
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | skipped | cancelled
}

export interface Snapshot {
  state: State;
  run_id: string | null;
  action: "apply" | "destroy" | null;
  since: string | null; // when the current state began
  running_since: string | null; // when the VM came up (for cost)
  public_ip: string | null;
  dns_ip: string | null;
  dns_live: boolean;
  auto_destroy_at: string | null;
  last_agent_at: string | null;
  agent: AgentReport | null;
  drift: string | null;
  github_run_url: string | null;
  steps: Step[];
  log_tail: string | null;
  error: string | null;
  azure: AzureInventory | null; // what Azure itself says exists, refreshed every 5 min while not Destroyed
  traffic: Traffic | null; // totals and rate from the last two heartbeats
  updated_at: string;
}

export const EMPTY: Snapshot = {
  state: "destroyed",
  run_id: null,
  action: null,
  since: null,
  running_since: null,
  public_ip: null,
  dns_ip: null,
  dns_live: false,
  auto_destroy_at: null,
  last_agent_at: null,
  agent: null,
  drift: null,
  github_run_url: null,
  steps: [],
  log_tail: null,
  error: null,
  azure: null,
  traffic: null,
  updated_at: new Date(0).toISOString(),
};

/**
 * The snapshot is stored in the Durable Object (strongly consistent, atomic
 * merges). The first read after this change seeds it from the old KV copy so
 * a deployment that was already running is not forgotten.
 */
// Talk to the Durable Object directly (kept out of lock.ts so this module has
// no "cloudflare:workers" import and its pure helpers stay testable in Node).
function store(env: Env) {
  return env.RUN_LOCK.get(env.RUN_LOCK.idFromName("singleton"));
}
async function doGetSnapshot<T>(env: Env): Promise<T | null> {
  const r = await store(env).fetch("https://lock/snapshot");
  return ((await r.json()) as { snapshot: T | null }).snapshot;
}
async function doPatchSnapshot<T>(env: Env, patch: Partial<T>, seed?: T): Promise<T> {
  const r = await store(env).fetch("https://lock/snapshot", { method: "POST", body: JSON.stringify({ patch, seed }) });
  return ((await r.json()) as { snapshot: T }).snapshot;
}

async function legacyKv(env: Env): Promise<Snapshot | null> {
  return env.STATUS.get<Snapshot>("status", "json");
}

export async function getSnapshot(env: Env): Promise<Snapshot> {
  let s = await doGetSnapshot<Snapshot>(env);
  if (!s) {
    const seed = await legacyKv(env);
    if (seed) s = await doPatchSnapshot<Snapshot>(env, {}, { ...EMPTY, ...seed });
  }
  return s ? { ...EMPTY, ...s } : { ...EMPTY };
}

export async function saveSnapshot(env: Env, patch: Partial<Snapshot>): Promise<Snapshot> {
  const seed = (await legacyKv(env)) ?? EMPTY;
  const next = await doPatchSnapshot<Snapshot>(env, patch, { ...EMPTY, ...seed });
  // Keep a read-only mirror in KV for anything that still wants a cheap look.
  await env.STATUS.put("status", JSON.stringify(next));
  return { ...EMPTY, ...next };
}

/** Running cost so far, from a start time and an hourly rate. */
export function estimateCostGbp(since: string | null, hourlyRate: number, now = Date.now()): number {
  if (!since) return 0;
  const ms = now - Date.parse(since);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return (ms / 3_600_000) * hourlyRate;
}

/**
 * Parse "wg show wg0 dump". First line is the interface:
 *   <private-key> <public-key> <listen-port> <fwmark>
 * Then one line per peer:
 *   <public-key> <preshared-key> <endpoint> <allowed-ips> <latest-handshake> <rx> <tx> <keepalive>
 */
export function parseWgDump(dump: string): { listen_port: number | null; server_public_key: string | null; peers: AgentPeer[] } {
  const lines = dump.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { listen_port: null, server_public_key: null, peers: [] };
  const head = lines[0].split("\t");
  const listen_port = Number(head[2]) || null;
  const server_public_key = head[1] || null;
  const peers: AgentPeer[] = lines.slice(1).map((l) => {
    const f = l.split("\t");
    return {
      public_key: f[0],
      endpoint: f[2] && f[2] !== "(none)" ? f[2] : null,
      allowed_ips: f[3] ?? "",
      latest_handshake: Number(f[4]) || 0,
      rx: Number(f[5]) || 0,
      tx: Number(f[6]) || 0,
    };
  });
  return { listen_port, server_public_key, peers };
}

/** A peer is "online" if it shook hands within the last 3 minutes (WireGuard rekeys every 2). */
export function peerOnline(p: AgentPeer, now = Date.now()): boolean {
  return p.latest_handshake > 0 && now / 1000 - p.latest_handshake < 180;
}

/** True if any peer has shaken hands in the last `minutes`. */
export function anyHandshakeWithin(report: AgentReport | null, minutes: number, now = Date.now()): boolean {
  if (!report) return false;
  return report.peers.some((p) => p.latest_handshake > 0 && now / 1000 - p.latest_handshake < minutes * 60);
}

export const STATE_LABEL: Record<State, string> = {
  destroyed: "Destroyed",
  deploying: "Deploying",
  running: "Running",
  destroying: "Tearing down",
  failed: "Failed",
};

export function isBusy(s: State): boolean {
  return s === "deploying" || s === "destroying";
}
