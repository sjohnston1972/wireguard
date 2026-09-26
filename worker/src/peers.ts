// peers.ts
//
// Plain English: everything about clients (phones, laptops) except their
// private keys, which the Worker never sees. The browser makes the keypair,
// sends only the public half, and gets back a config with a placeholder
// where the private key goes. It fills that in locally and shows the QR.
//
// The server's public key comes from wrangler.toml; the Worker never holds
// the private key.

import type { Env } from "./env";
import { config } from "./env";
import type { Peer } from "./db";

export const PRIVATE_KEY_PLACEHOLDER = "__CLIENT_PRIVATE_KEY__";

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * The server's WireGuard public key. The Worker only ever holds the public
 * half (a plain var in wrangler.toml); the private key lives in GitHub
 * secrets and on the VM, so a compromised dashboard cannot impersonate the
 * headend. Async only so callers did not have to change.
 */
export async function serverPublicKey(env: Env): Promise<string | null> {
  const pub = env.WG_SERVER_PUBLIC_KEY ?? "";
  return isWgKey(pub) ? pub : null;
}

export function isWgKey(s: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(s)) return false;
  try {
    return b64ToBytes(s).length === 32;
  } catch {
    return false;
  }
}

/** Host addresses in a /24-style subnet, from .2 upwards (.1 is the server). */
export function nextFreeIp(subnet: string, used: string[]): string | null {
  const [base, prefixStr] = subnet.split("/");
  const prefix = Number(prefixStr);
  const parts = base.split(".").map(Number);
  const baseInt = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const size = 2 ** (32 - prefix);
  const usedSet = new Set(used);
  for (let i = 2; i < size - 1; i++) {
    const n = (baseInt + i) >>> 0;
    const ip = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    if (!usedSet.has(ip)) return ip;
  }
  return null;
}

export function serverTunnelIp(subnet: string): string {
  const [base] = subnet.split("/");
  const p = base.split(".").map(Number);
  return `${p[0]}.${p[1]}.${p[2]}.${p[3] + 1}`;
}

/**
 * A client's IPv6 tunnel address, mirroring its IPv4 one: 10.13.13.7 is
 * fd13:13::7 and 10.13.13.13 is fd13:13::d (Terraform's cidrhost does the
 * same, so the VM and the dashboard always agree). Empty when IPv6 is off.
 */
export function peerIp6(subnet6: string, ip4: string): string {
  if (!subnet6) return "";
  const host = Number(ip4.split(".")[3]);
  const prefix = subnet6.split("/")[0].replace(/::$/, "");
  return `${prefix}::${host.toString(16)}`;
}

/** A DNS-safe name for the tunnel DNS: "Steven's Phone" -> "steven-s-phone" (so steven-s-phone.wg). */
export function hostLabel(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

/**
 * Client config with a placeholder for the private key. Endpoint is always
 * the DNS name so a rebuilt VM needs no client change.
 *
 * DNS: full-tunnel clients always use the tunnel DNS on the VM loopback
 * (ad-blocking, .wg names), since all their traffic depends on the VM anyway.
 * Split-tunnel clients use it only when asked, because while the VM is
 * destroyed a client left connected would lose DNS altogether.
 */
export function clientConfigTemplate(env: Env, peer: { ip: string; full_tunnel: number; azure_vnet?: number; tunnel_dns?: number; home_lan?: number }, serverPub: string): string {
  const cfg = config(env);
  const ip6 = peerIp6(cfg.subnet6, peer.ip);
  const allowed = peer.full_tunnel
    ? ["0.0.0.0/0", "::/0"]
    : [cfg.subnet, `${cfg.loopbackIp}/32`]
        .concat(cfg.subnet6 ? [cfg.subnet6] : [])
        .concat(peer.azure_vnet ? [cfg.vnetCidr] : [])
        .concat(peer.home_lan && cfg.homeLanCidr ? [cfg.homeLanCidr] : []);
  const dns = peer.full_tunnel || peer.tunnel_dns ? [`DNS = ${cfg.loopbackIp}, wg`] : [];
  return [
    "[Interface]",
    `PrivateKey = ${PRIVATE_KEY_PLACEHOLDER}`,
    `Address = ${peer.ip}/32${ip6 ? `, ${ip6}/128` : ""}`,
    ...dns,
    "",
    "[Peer]",
    `PublicKey = ${serverPub}`,
    `Endpoint = ${cfg.dnsName}:${cfg.port}`,
    `AllowedIPs = ${allowed.join(", ")}`,
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

/** An IPv4 network as [first address, prefix length], or null if it is not one. */
function v4Net(cidr: string): [number, number] | null {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m || m.slice(1, 5).some((x) => Number(x) > 255) || Number(m[5]) > 32) return null;
  const bits = Number(m[5]);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const n = ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
  return [(n & mask) >>> 0, bits];
}

/** Do two IPv4 networks share any address? (One always contains the other if so.) */
export function v4Overlap(a: string, b: string): boolean {
  const x = v4Net(a), y = v4Net(b);
  if (!x || !y) return false;
  const bits = Math.min(x[1], y[1]);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((x[0] & mask) >>> 0) === ((y[0] & mask) >>> 0);
}

/**
 * Networks a site route may never cover: the tunnel itself, the VM's
 * loopback and the Azure VNet. Sending any of those into the tunnel would
 * cut the VM off from its own clients or its own LAN.
 */
export function protectedNets(cfg: { subnet: string; loopbackIp: string; vnetCidr: string }): string[] {
  return [cfg.subnet, `${cfg.loopbackIp}/32`, cfg.vnetCidr].filter(Boolean);
}

/**
 * Why a site route is refused, or null if it is fine. Shorter than /8
 * (0.0.0.0/0, 128.0.0.0/1 and so on) would swallow the VM's default route,
 * so it could never reach the dashboard again to be fixed.
 */
export function routeProblem(cidr: string, avoid: string[] = []): string | null {
  const n = v4Net(cidr);
  if (!n) return "not an IPv4 network";
  if (n[1] < 8) return "wider than /8 would take over the VM's own internet route";
  const hit = avoid.find((a) => v4Overlap(cidr, a));
  return hit ? `overlaps ${hit}, which the VM needs for itself` : null;
}

/**
 * The extra networks a site peer carries, cleaned: "192.168.1.0/24, 10.9.0.0/16"
 * -> ["192.168.1.0/24", "10.9.0.0/16"]. Anything routeProblem refuses is left
 * out (pass protectedNets(cfg) as avoid to check for overlaps too).
 */
export function peerRoutes(p: { routes?: string | null }, avoid: string[] = []): string[] {
  return String(p.routes ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x && routeProblem(x, avoid) === null);
}

/** The expiry choices on the Clients page, in days; 0 = never. */
export const EXPIRY_DAYS = [0, 1, 7, 30];

/** When a client picked "Expires: N days" stops working, or null for never (or anything not on the list). */
export function expiryFrom(days: unknown, now = new Date()): string | null {
  const d = Number(days);
  if (!d || !EXPIRY_DAYS.includes(d)) return null;
  return new Date(now.getTime() + d * 86400_000).toISOString();
}

/** Has this client's time run out? */
export function peerExpired(p: { expires_at?: string | null }, now = Date.now()): boolean {
  return !!p.expires_at && Date.parse(p.expires_at) <= now;
}

/**
 * A client nobody seems to use: no handshake in 30 days (or never, and it
 * was added more than 30 days ago). Uses the remembered handshake time, so
 * it still works while the VM is torn down.
 */
export const STALE_DAYS = 30;
export function peerStale(p: { last_handshake_at?: string | null; created_at: string }, now = Date.now()): boolean {
  const last = Date.parse(p.last_handshake_at || p.created_at);
  return Number.isFinite(last) && now - last > STALE_DAYS * 86400_000;
}

/**
 * What the VM's agent needs: enabled, unexpired peers as {name, host, public_key, allowed_ips}.
 * A site peer (the home container) also carries its LAN, so the VM routes
 * 192.168.1.0/24 to it: WireGuard's cryptokey routing is the routing table.
 */
export function agentPeerList(peers: Peer[], subnet6 = "", avoid: string[] = [], now = Date.now()): { name: string; host: string; public_key: string; allowed_ips: string }[] {
  return peers
    .filter((p) => p.enabled && !peerExpired(p, now))
    .map((p) => {
      const ip6 = peerIp6(subnet6, p.ip);
      const allowed = [`${p.ip}/32`].concat(ip6 ? [`${ip6}/128`] : []).concat(peerRoutes(p, avoid));
      return { name: p.name, host: hostLabel(p.name), public_key: p.public_key, allowed_ips: allowed.join(",") };
    });
}

/** What Terraform's peers_json needs at deploy time. Expired clients are left out, like on the VM. */
export function terraformPeerList(peers: Peer[], avoid: string[] = [], now = Date.now()): { name: string; public_key: string; ip: string; routes?: string }[] {
  return peers.filter((p) => p.enabled && !peerExpired(p, now)).map((p) => ({ name: p.name, public_key: p.public_key, ip: p.ip, ...(peerRoutes(p, avoid).length ? { routes: peerRoutes(p, avoid).join(",") } : {}) }));
}

export function validPeerName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(name);
}
