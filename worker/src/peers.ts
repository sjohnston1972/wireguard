// peers.ts
//
// Plain English: everything about clients (phones, laptops) except their
// private keys, which the Worker never sees. The browser makes the keypair,
// sends only the public half, and gets back a config with a placeholder
// where the private key goes. It fills that in locally and shows the QR.
//
// The server's public key is derived here from the fixed private key, the
// same way "wg pubkey" does it, using the Worker's built-in WebCrypto.

import type { Env } from "./env";
import { config } from "./env";
import type { Peer } from "./db";

export const PRIVATE_KEY_PLACEHOLDER = "__CLIENT_PRIVATE_KEY__";

const PKCS8_X25519_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function b64urlToB64(s: string): string {
  return s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
}

/** Derive the WireGuard public key from the server's private key. Cached per isolate. */
let cachedPub: { priv: string; pub: string } | null = null;
export async function serverPublicKey(env: Env): Promise<string | null> {
  const priv = env.WG_SERVER_PRIVATE_KEY;
  if (!priv || !isWgKey(priv)) return null;
  if (cachedPub && cachedPub.priv === priv) return cachedPub.pub;
  const raw = b64ToBytes(priv);
  const der = new Uint8Array(PKCS8_X25519_PREFIX.length + raw.length);
  der.set(PKCS8_X25519_PREFIX);
  der.set(raw, PKCS8_X25519_PREFIX.length);
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "X25519" }, true, ["deriveBits"]);
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  const pub = b64urlToB64(jwk.x ?? "");
  cachedPub = { priv, pub };
  return pub;
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
 * Client config with a placeholder for the private key. Endpoint is always
 * the DNS name so a rebuilt VM needs no client change.
 */
export function clientConfigTemplate(env: Env, peer: { ip: string; full_tunnel: number }, serverPub: string): string {
  const cfg = config(env);
  const allowed = peer.full_tunnel ? ["0.0.0.0/0", "::/0"] : [cfg.subnet, `${cfg.loopbackIp}/32`];
  return [
    "[Interface]",
    `PrivateKey = ${PRIVATE_KEY_PLACEHOLDER}`,
    `Address = ${peer.ip}/32`,
    ...(peer.full_tunnel ? ["DNS = 1.1.1.1"] : []),
    "",
    "[Peer]",
    `PublicKey = ${serverPub}`,
    `Endpoint = ${cfg.dnsName}:${cfg.port}`,
    `AllowedIPs = ${allowed.join(", ")}`,
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

/** What the VM's agent needs: enabled peers as {name, public_key, allowed_ips}. */
export function agentPeerList(peers: Peer[]): { name: string; public_key: string; allowed_ips: string }[] {
  return peers.filter((p) => p.enabled).map((p) => ({ name: p.name, public_key: p.public_key, allowed_ips: `${p.ip}/32` }));
}

/** What Terraform's peers_json needs at deploy time. */
export function terraformPeerList(peers: Peer[]): { name: string; public_key: string; ip: string }[] {
  return peers.filter((p) => p.enabled).map((p) => ({ name: p.name, public_key: p.public_key, ip: p.ip }));
}

export function validPeerName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(name);
}
