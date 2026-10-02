// clients.ts
//
// Plain English: one client as the Clients screen sees it: what the table
// says, what the VM reports (online is a handshake in the last 3 minutes;
// WireGuard has no session, only handshakes), the exact routes its config
// sends through the tunnel, and the stale and expiry flags; plus the counts
// across the top of the screen. Shared by the data API.

import type { Peer } from "./db";
import type { AgentPeer, Roam, Snapshot } from "./state";
import { peerOnline } from "./state";
import { clientAllowedIps, peerExpired, peerStale, peerIp6 } from "./peers";

export type ClientStatus = "disabled" | "expired" | "removing" | "headend_down" | "loading" | "online" | "offline";

/** "Expiring soon" means within a week. */
export const EXPIRING_SOON_MS = 7 * 86_400_000;

/**
 * What is true of this client right now. "removing" is switched off (or
 * expired) but still on the VM until the next heartbeat; "loading" is
 * switched on but not yet on the VM.
 */
export function clientStatus(p: Peer, live: AgentPeer | undefined, running: boolean, now = Date.now()): ClientStatus {
  const expired = peerExpired(p, now);
  if (!p.enabled || expired) return running && live ? "removing" : expired ? "expired" : "disabled";
  if (!running) return "headend_down";
  if (!live) return "loading";
  return peerOnline(live, now) ? "online" : "offline";
}

export interface ClientView extends Peer {
  status: ClientStatus;
  live: AgentPeer | null;
  /** Recent round-trip times in ms, oldest first (about the last 12 minutes). */
  latency: number[];
  lastLatencyMs: number | null;
  /** What its config sends through the tunnel; empty for the home site (its routes are below). */
  allowedIps: string[];
  /** Networks reached through it (the home site), else empty. */
  siteRoutes: string[];
  ip6: string | null;
  expired: boolean;
  stale: boolean;
  expiresSoon: boolean;
  isSite: boolean;
  roam: Roam | null;
}

export interface ClientKpis {
  total: number;
  online: number;
  avgLatencyMs: number | null;
  fullTunnel: number;
  stale: number;
  expiringSoon: number;
}

export function clientView(p: Peer, snap: Snapshot, cfg: { subnet: string; subnet6: string; loopbackIp: string; vnetCidr: string; homeLanCidr: string }, now = Date.now()): ClientView {
  const running = snap.state === "running";
  const live = running ? snap.agent?.peers.find((x) => x.public_key === p.public_key) : undefined;
  const status = clientStatus(p, live, running, now);
  const latency = snap.latency?.[p.public_key] ?? [];
  const expired = peerExpired(p, now);
  return {
    ...p,
    status,
    live: live ?? null,
    latency,
    lastLatencyMs: status === "online" ? latency.at(-1) ?? null : null,
    allowedIps: p.routes ? [] : clientAllowedIps(cfg, p),
    siteRoutes: p.routes ? p.routes.split(",").map((r) => r.trim()).filter(Boolean) : [],
    ip6: cfg.subnet6 ? peerIp6(cfg.subnet6, p.ip) : null,
    expired,
    stale: !!p.enabled && peerStale(p, now),
    expiresSoon: !!p.expires_at && !expired && Date.parse(p.expires_at) - now <= EXPIRING_SOON_MS,
    isSite: !!p.routes,
    roam: snap.roams?.[p.public_key] ?? null,
  };
}

export function clientKpis(views: ClientView[]): ClientKpis {
  const lat = views.map((v) => v.lastLatencyMs).filter((x): x is number => x !== null);
  return {
    total: views.length,
    online: views.filter((v) => v.status === "online").length,
    avgLatencyMs: lat.length ? Math.round((lat.reduce((a, b) => a + b, 0) / lat.length) * 10) / 10 : null,
    fullTunnel: views.filter((v) => v.full_tunnel).length,
    stale: views.filter((v) => v.stale).length,
    expiringSoon: views.filter((v) => v.expiresSoon).length,
  };
}
