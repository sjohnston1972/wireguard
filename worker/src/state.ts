// state.ts
//
// Plain English: the one-line answer to "is it up?". A small JSON snapshot in
// KV holds the current state (Destroyed, Deploying, Running, Destroying,
// Failed), the public IP, whether DNS matches, the last heartbeat from the
// VM and the auto-destroy deadline. Every page load reads it; every event
// (a click, a callback, a heartbeat, a cron check) updates it.
//
// KV is a cache of the truth, never the truth: the cron re-derives it from
// GitHub, Azure and the VM, so a stale entry heals itself within 5 minutes.

import type { Env } from "./env";

export type State = "destroyed" | "deploying" | "running" | "destroying" | "failed";

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
  peers: AgentPeer[];
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
  updated_at: new Date(0).toISOString(),
};

export async function getSnapshot(env: Env): Promise<Snapshot> {
  const s = await env.STATUS.get<Snapshot>("status", "json");
  return s ? { ...EMPTY, ...s } : { ...EMPTY };
}

export async function saveSnapshot(env: Env, patch: Partial<Snapshot>): Promise<Snapshot> {
  const cur = await getSnapshot(env);
  const next: Snapshot = { ...cur, ...patch, updated_at: new Date().toISOString() };
  await env.STATUS.put("status", JSON.stringify(next));
  return next;
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
