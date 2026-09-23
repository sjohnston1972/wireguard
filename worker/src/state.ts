// state.ts
//
// Plain English: the one-line answer to "is it up?". A small JSON snapshot
// holds the current state (Destroyed, Deploying, Running, Destroying,
// Failed, and the standby trio Hibernating, Standby, Resuming), the public IP, whether DNS matches, the last heartbeat from the
// VM, the auto-destroy deadline and what Azure says exists. Every page load
// reads it; every event (a click, a callback, a heartbeat, a cron check)
// patches it. It lives in the Durable Object so patches merge atomically; a
// KV mirror is kept only for cheap reads.
//
// The snapshot is a cache of the truth, never the truth: the cron re-derives
// it from GitHub, Azure and the VM, so a stale entry heals within 5 minutes.

import type { Env } from "./env";

export type State = "destroyed" | "deploying" | "running" | "destroying" | "failed" | "hibernating" | "standby" | "resuming";

/** The VM's boot self-test (wg-selftest.sh): true/false per check, null = not tried on this build. */
export interface SelfTest {
  at: string;
  ms: number;
  handshake: boolean | null;
  tunnel: boolean | null;
  loopback: boolean | null;
  dns: boolean | null;
  internet: boolean | null;
  internet6: boolean | null;
  error?: string;
}

/** Which checks failed, in words; empty when everything that ran passed. */
export function selfTestFailures(t: SelfTest | null): string[] {
  if (!t) return [];
  const names: [keyof SelfTest, string][] = [["handshake", "handshake"], ["tunnel", "ping the tunnel end"], ["loopback", "ping the loopback"], ["dns", "tunnel DNS"], ["internet", "internet (IPv4)"], ["internet6", "internet (IPv6)"]];
  const out = names.filter(([k]) => t[k] === false).map(([, n]) => n);
  if (t.error) out.unshift(t.error);
  return out;
}

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
  wan6?: string | null; // the VM's public-side IPv6 address, when Azure gave it one
  dns?: { up: boolean; blocked: number } | null; // tunnel DNS: running, and how many names it blocks
  peers: AgentPeer[];
}

/** A client that changed the address it dials in from (Wi-Fi to 4G, say). */
export interface Roam {
  at: string;
  from: string;
  to: string;
}

/** What this Running stretch has done, for the summary sent when it ends. */
export interface Session {
  started: string;
  rx: number; // bytes, summed across heartbeats so a reboot's counter reset is not lost
  tx: number;
  seen: string[]; // public keys of clients that shook hands during the session
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
  selftest: SelfTest | null; // the VM's boot self-test, from the heartbeat
  latency: Record<string, number[]>; // per client public key: recent round-trip times in ms, oldest first
  roams: Record<string, Roam>; // per client public key: the last time it changed networks
  session: Session | null;
  standby_since: string | null; // when the VM was deallocated into Standby
  power_op_at: string | null; // when a hibernate or resume was asked for
  pending_summary: string | null; // the session summary, held while a tear-down runs
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
  selftest: null,
  latency: {},
  roams: {},
  session: null,
  standby_since: null,
  power_op_at: null,
  pending_summary: null,
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

/** How many round-trip samples to keep per client: 40 heartbeats is 20 minutes. */
export const LATENCY_SAMPLES = 40;

/** Fold one heartbeat's ping results into the per-client history. */
export function nextLatency(prev: Record<string, number[]>, rtt: Record<string, number> | null | undefined, known: string[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const k of known) {
    const hist = prev[k] ?? [];
    const v = rtt?.[k];
    out[k] = typeof v === "number" && Number.isFinite(v) ? hist.concat(Math.round(v * 10) / 10).slice(-LATENCY_SAMPLES) : hist;
  }
  return out;
}

/** The host part of "1.2.3.4:5678" or "[2a00::1]:5678". */
export function endpointHost(ep: string | null): string | null {
  if (!ep) return null;
  const m = ep.match(/^\[(.+)\]:\d+$/) ?? ep.match(/^(.+):\d+$/);
  return m ? m[1] : ep;
}

/** Clients whose dial-in address changed since the last heartbeat. */
export function detectRoams(prev: AgentReport | null, next: AgentReport, at: string): Record<string, Roam> {
  const out: Record<string, Roam> = {};
  const before = new Map((prev?.peers ?? []).map((p) => [p.public_key, endpointHost(p.endpoint)]));
  for (const p of next.peers) {
    const was = before.get(p.public_key);
    const now = endpointHost(p.endpoint);
    if (was && now && was !== now) out[p.public_key] = { at, from: was, to: now };
  }
  return out;
}

/** Add one heartbeat to the running session's totals. Counters that went down (a reboot) count from zero. */
export function nextSession(prev: Session | null, prevReport: AgentReport | null, report: AgentReport, now = Date.now()): Session {
  const s: Session = prev ? { ...prev, seen: [...prev.seen] } : { started: new Date(now).toISOString(), rx: 0, tx: 0, seen: [] };
  const before = new Map((prevReport?.peers ?? []).map((p) => [p.public_key, p]));
  for (const p of report.peers) {
    const b = before.get(p.public_key);
    s.rx += b && p.rx >= b.rx ? p.rx - b.rx : p.rx;
    s.tx += b && p.tx >= b.tx ? p.tx - b.tx : p.tx;
    if (p.latest_handshake > 0 && now / 1000 - p.latest_handshake < 180 && !s.seen.includes(p.public_key)) s.seen.push(p.public_key);
  }
  return s;
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
  hibernating: "Hibernating",
  standby: "Standby",
  resuming: "Resuming",
};

export function isBusy(s: State): boolean {
  return s === "deploying" || s === "destroying" || s === "hibernating" || s === "resuming";
}

/** Busy with a VM power change (the Worker talks to Azure itself; no GitHub run). */
export function isPowerOp(s: State): boolean {
  return s === "hibernating" || s === "resuming";
}
