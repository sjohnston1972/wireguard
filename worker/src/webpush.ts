// webpush.ts
//
// Plain English: sending a notification straight to the wg-admin app on the
// phone, the standard Web Push way, with nothing but the Worker's built-in
// crypto. When the phone turned alerts on, its browser gave us an address at
// its push service (Google's, on Android) plus two keys. For each alert we:
//   1. encrypt the message so only that phone can read it (RFC 8291:
//      a one-off ECDH key exchange, HKDF, then AES-128-GCM), and
//   2. sign a short note proving it comes from this dashboard (RFC 8292,
//      "VAPID": an ES256 JWT), so nobody else can push to the phone.
// The push service only ever sees ciphertext. Networking picture: IPsec to
// each phone, with the push service as an untrusted transit provider.

import type { Env } from "./env";
import { config } from "./env";

export interface PushSubscription {
  endpoint: string;
  p256dh: string; // the phone's public key, base64url, 65 bytes uncompressed
  auth: string; // 16-byte shared secret, base64url
}

export interface PushMessage {
  title: string;
  body: string;
  /** Opens when the notification itself is tapped. */
  url?: string;
  /** Up to two buttons on the notification; each POSTs its URL (a single-use action link). */
  actions?: { title: string; url: string }[];
  /** Same tag replaces an older notification instead of stacking. */
  tag?: string;
  urgent?: boolean;
}

const enc = new TextEncoder();

export function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** RFC 8291 "aes128gcm" body for one subscription. `salt` and `ephemeral` are injectable for tests. */
export async function encryptPayload(sub: PushSubscription, plaintext: Uint8Array, opts: { salt?: Uint8Array; ephemeral?: CryptoKeyPair } = {}): Promise<Uint8Array> {
  const uaPublic = unb64u(sub.p256dh);
  const authSecret = unb64u(sub.auth);
  const eph = opts.ephemeral ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, eph.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));

  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096, one record
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/** RFC 8292 VAPID Authorization header value for a push service origin. */
export async function vapidAuth(env: Env, endpoint: string, now = Date.now()): Promise<string> {
  const pub = unb64u(env.VAPID_PUBLIC_KEY ?? "");
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE_KEY, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: config(env).publicUrl })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

/**
 * Is this address at one of the real push services? Google (Chrome and
 * Android), Apple (Safari, iPhone), Mozilla (Firefox) and Microsoft (Edge on
 * Windows). Alerts carry one-tap Tear down / Hibernate links, so they are only
 * ever sent to these, never to any other web address someone registers.
 */
export function isPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return h === "fcm.googleapis.com" || h === "updates.push.services.mozilla.com" || h.endsWith(".push.apple.com") || h.endsWith(".notify.windows.com");
}

export function canPush(env: Env): boolean {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/**
 * Send one message to one phone. Returns "ok", "gone" (the phone unsubscribed
 * or the app was removed: forget it) or an error string.
 */
export async function sendPush(env: Env, sub: PushSubscription, msg: PushMessage): Promise<"ok" | "gone" | string> {
  if (!isPushEndpoint(sub.endpoint)) return "not a known push service; turn alerts off and on again on that phone";
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(msg)));
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(env, sub.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: msg.urgent ? "high" : "normal",
      ...(msg.tag ? { Topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}),
    },
    body,
  });
  if (r.status === 404 || r.status === 410) return "gone";
  if (!r.ok) return `${r.status} ${(await r.text()).slice(0, 160)}`;
  return "ok";
}
