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
export function clientConfigTemplate(env: Env, peer: { ip: string; full_tunnel: number; azure_vnet?: number; tunnel_dns?: number }, serverPub: string): string {
  const cfg = config(env);
  const ip6 = peerIp6(cfg.subnet6, peer.ip);
  const allowed = peer.full_tunnel
    ? ["0.0.0.0/0", "::/0"]
    : [cfg.subnet, `${cfg.loopbackIp}/32`].concat(cfg.subnet6 ? [cfg.subnet6] : []).concat(peer.azure_vnet ? [cfg.vnetCidr] : []);
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

/** What the VM's agent needs: enabled peers as {name, host, public_key, allowed_ips}. */
export function agentPeerList(peers: Peer[], subnet6 = ""): { name: string; host: string; public_key: string; allowed_ips: string }[] {
  return peers
    .filter((p) => p.enabled)
    .map((p) => {
      const ip6 = peerIp6(subnet6, p.ip);
      return { name: p.name, host: hostLabel(p.name), public_key: p.public_key, allowed_ips: `${p.ip}/32${ip6 ? `,${ip6}/128` : ""}` };
    });
}

/** What Terraform's peers_json needs at deploy time. */
export function terraformPeerList(peers: Peer[]): { name: string; public_key: string; ip: string }[] {
  return peers.filter((p) => p.enabled).map((p) => ({ name: p.name, public_key: p.public_key, ip: p.ip }));
}

export function validPeerName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(name);
}
