// clients.ts
//
// Plain English: one client as the Clients screen sees it: what the table
// says, what the VM reports (online is a handshake in the last 3 minutes;
// WireGuard has no session, only handshakes), the exact routes its config
// sends through the tunnel, and the stale and expiry flags; plus the counts
// across the top of the screen. Shared by the data API.

import type { Env } from "./env";
import type { Peer } from "./db";
import * as db from "./db";
import { effectiveConfig } from "./settings";
import { no, type Done, type Refusal } from "./result";
export type { Done, Refusal };
import type { AgentPeer, Roam, Snapshot } from "./state";
import { peerOnline } from "./state";
import { clientAllowedIps, peerExpired, peerStale, peerIp6, validPeerName, isWgKey, serverPublicKey, nextFreeIp, clientConfigTemplate, expiryFrom, EXPIRY_DAYS } from "./peers";

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
  /** Its config predates the lab pool in AllowedIPs: "config out of date: get config" (peers.labs_config_due). */
  labsConfigDue: boolean;
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
    labsConfigDue: !!p.labs_config_due,
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

const NAME_RULE = "Name: letters, digits, spaces, dashes; up to 32 characters.";
const KEY_RULE = "That is not a valid WireGuard public key.";

/** A switch from the API: absent, or a real true/false (not "yes", not 1). */
function flag(v: unknown): boolean | undefined | "bad" {
  if (v === undefined) return undefined;
  return typeof v === "boolean" ? v : "bad";
}

/** Expiry days from the API: absent, or one of 0 (never), 1, 7, 30. */
function days(v: unknown): number | undefined | "bad" {
  if (v === undefined) return undefined;
  return typeof v === "number" && EXPIRY_DAYS.includes(v) ? v : "bad";
}

/**
 * Add a client. The browser made the keypair and sends only the public
 * half; the answer carries the config with a placeholder where the
 * browser puts the private key.
 */
export async function addClient(
  env: Env,
  user: string,
  input: { name?: unknown; public_key?: unknown; full_tunnel?: unknown; azure_vnet?: unknown; tunnel_dns?: unknown; home_lan?: unknown; expires_days?: unknown },
): Promise<Done<{ peer: Peer; template: string }>> {
  const name = String(input.name ?? "").trim();
  if (!validPeerName(name)) return no(400, "bad_input", NAME_RULE, "name");
  if (!isWgKey(String(input.public_key ?? ""))) return no(400, "bad_input", KEY_RULE, "public_key");
  const f = { full_tunnel: flag(input.full_tunnel), azure_vnet: flag(input.azure_vnet), tunnel_dns: flag(input.tunnel_dns), home_lan: flag(input.home_lan) };
  for (const [k, v] of Object.entries(f)) if (v === "bad") return no(400, "bad_input", `${k} must be true or false.`, k);
  const d = days(input.expires_days);
  if (d === "bad") return no(400, "bad_input", "Expiry is 0 (never), 1, 7 or 30 days.", "expires_days");
  const serverPub = await serverPublicKey(env);
  if (!serverPub) return no(503, "not_configured", "Server key not configured.");
  const cfg = await effectiveConfig(env);
  const ip = nextFreeIp(cfg.subnet, (await db.listPeers(env)).map((p) => p.ip));
  if (!ip) return no(409, "refused", "No free tunnel addresses left.");
  let peer: Peer;
  try {
    peer = await db.addPeer(env, { name, public_key: String(input.public_key), ip, full_tunnel: f.full_tunnel === true, azure_vnet: f.azure_vnet === true, tunnel_dns: f.tunnel_dns === true, expires_at: expiryFrom(d) });
    if (f.home_lan === true && f.full_tunnel !== true) {
      await db.setPeerHomeLan(env, peer.id, true);
      peer = (await db.getPeer(env, peer.id))!;
    }
  } catch (e) {
    return no(409, "refused", /UNIQUE/.test(String(e)) ? "That key is already registered." : (e as Error).message);
  }
  await db.audit(env, user, "client.add", peer.name, null, peer);
  return { ok: true, value: { peer, template: clientConfigTemplate(env, peer, serverPub) } };
}

/** New keys for an existing client: the browser sends the new public half. */
export async function rekeyClient(env: Env, user: string, id: number, publicKey: unknown): Promise<Done<{ peer: Peer; template: string }>> {
  if (!isWgKey(String(publicKey ?? ""))) return no(400, "bad_input", KEY_RULE, "public_key");
  const peer = await db.getPeer(env, id);
  if (!peer) return no(404, "not_found", "No such client.");
  const serverPub = await serverPublicKey(env);
  if (!serverPub) return no(503, "not_configured", "Server key not configured.");
  try {
    await db.setPeerKey(env, id, String(publicKey));
  } catch (e) {
    return no(409, "refused", /UNIQUE/.test(String(e)) ? "That key is already registered." : (e as Error).message);
  }
  const updated = (await db.getPeer(env, id))!;
  await db.audit(env, user, "client.rekey", peer.name, peer, updated);
  return { ok: true, value: { peer: updated, template: clientConfigTemplate(env, updated, serverPub) } };
}

/**
 * Change a client's switches and expiry, all checked before anything is
 * written, then one change-log entry. The home site never expires: losing
 * it would cut the home network off.
 */
export async function editClient(
  env: Env,
  user: string,
  id: number,
  change: { home_lan?: unknown; azure_vnet?: unknown; tunnel_dns?: unknown; enabled?: unknown; expires_days?: unknown },
): Promise<Done<Peer>> {
  const f = { home_lan: flag(change.home_lan), azure_vnet: flag(change.azure_vnet), tunnel_dns: flag(change.tunnel_dns), enabled: flag(change.enabled) };
  for (const [k, v] of Object.entries(f)) if (v === "bad") return no(400, "bad_input", `${k} must be true or false.`, k);
  const d = days(change.expires_days);
  if (d === "bad") return no(400, "bad_input", "Expiry is 0 (never), 1, 7 or 30 days.", "expires_days");
  const p = await db.getPeer(env, id);
  if (!p) return no(404, "not_found", "No such client.");
  if (d && p.routes) return no(400, "bad_input", "The home site does not expire.", "expires_days");
  if (f.home_lan !== undefined) await db.setPeerHomeLan(env, id, f.home_lan as boolean);
  if (f.azure_vnet !== undefined) await db.setPeerAzureVnet(env, id, f.azure_vnet as boolean);
  if (f.tunnel_dns !== undefined) await db.setPeerTunnelDns(env, id, f.tunnel_dns as boolean);
  if (f.enabled !== undefined) await db.setPeerEnabled(env, id, f.enabled as boolean);
  if (d !== undefined) await db.setPeerExpiry(env, id, expiryFrom(d));
  const after = (await db.getPeer(env, id))!;
  const onlySwitch = f.enabled !== undefined && f.home_lan === undefined && f.azure_vnet === undefined && f.tunnel_dns === undefined;
  const action = onlySwitch || (f.enabled !== undefined && !!p.enabled !== !!after.enabled) ? (after.enabled ? "client.enable" : "client.disable") : "client.edit";
  await db.audit(env, user, action, p.name, p, after);
  return { ok: true, value: after };
}

/** Delete a client. Its config stops working at the next heartbeat. */
export async function deleteClient(env: Env, user: string, id: number): Promise<Done<null>> {
  const gone = await db.getPeer(env, id);
  if (!gone) return no(404, "not_found", "No such client.");
  await db.deletePeer(env, id);
  await db.audit(env, user, "client.delete", gone.name, gone, null);
  return { ok: true, value: null };
}
