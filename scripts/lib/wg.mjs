// scripts/lib/wg.mjs
//
// Plain English: WireGuard keys without the "wg" tool (it is not installed on
// Windows). A WireGuard key is just an X25519 keypair, base64-encoded, 32
// bytes each. Node's crypto module can make and derive them natively.
//
// Networking analogy: the private key is the router's RSA key, the public key
// is what you paste into the far end's config. Only the public half ever
// travels.

import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";

// DER prefixes for wrapping raw 32-byte keys so Node can parse them.
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** Generate a fresh keypair. Returns { privateKey, publicKey } as base64. */
export function genKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const priv = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { privateKey: priv.toString("base64"), publicKey: pub.toString("base64") };
}

/** Derive the public key from a base64 private key, as "wg pubkey" does. */
export function publicKeyFrom(privateKeyB64) {
  const raw = Buffer.from(privateKeyB64, "base64");
  if (raw.length !== 32) throw new Error("WireGuard private key must be 32 bytes");
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
  return createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
}

/** True if the string looks like a WireGuard key (32 bytes, base64). */
export function isWgKey(s) {
  return typeof s === "string" && /^[A-Za-z0-9+/]{43}=$/.test(s) && Buffer.from(s, "base64").length === 32;
}

/** Sanity check that SPKI parsing works for a known raw public key. */
export function parsePublicKey(publicKeyB64) {
  const raw = Buffer.from(publicKeyB64, "base64");
  if (raw.length !== 32) throw new Error("WireGuard public key must be 32 bytes");
  createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, raw]), format: "der", type: "spki" });
  return true;
}

/**
 * Render a client .conf. The endpoint is always the DNS name, never an IP,
 * so a rebuilt VM needs no client change.
 *
 * @param {object} o
 * @param {string} o.clientPrivateKey  base64
 * @param {string} o.clientIp          e.g. 10.13.13.2
 * @param {string} o.serverPublicKey   base64
 * @param {string} o.endpoint          e.g. wg.clydeford.net:51820
 * @param {string} o.serverIp          e.g. 10.13.13.1
 * @param {string} [o.loopbackIp]      the VM loopback test address, added to split-tunnel AllowedIPs
 * @param {string} [o.vnetCidr]        the Azure VNet, added to split-tunnel AllowedIPs when wanted
 * @param {string} [o.homeLanCidr]     add to AllowedIPs for split-tunnel access to home via the VM
 * @param {boolean} [o.fullTunnel]     AllowedIPs 0.0.0.0/0 with DNS pushed
 */
export function renderClientConf(o) {
  const allowed = o.fullTunnel
    ? ["0.0.0.0/0", "::/0"]
    : [o.serverIp + "/32", o.tunnelCidr || "10.13.13.0/24"].concat(o.loopbackIp ? [o.loopbackIp + "/32"] : []).concat(o.vnetCidr ? [o.vnetCidr] : []).concat(o.homeLanCidr ? [o.homeLanCidr] : []);
  const uniq = [...new Set(allowed)];
  return [
    "[Interface]",
    `PrivateKey = ${o.clientPrivateKey}`,
    `Address = ${o.clientIp}/32`,
    ...(o.fullTunnel ? ["DNS = 1.1.1.1"] : []),
    "",
    "[Peer]",
    `PublicKey = ${o.serverPublicKey}`,
    `Endpoint = ${o.endpoint}`,
    `AllowedIPs = ${uniq.join(", ")}`,
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}
