// Web Push: encrypt as the Worker does, decrypt as a phone would (with Node's
// own crypto, an independent implementation), and check the VAPID signature.
import { describe, it, expect } from "vitest";
import * as nodeCrypto from "node:crypto";
import { encryptPayload, vapidAuth, b64u, isPushEndpoint, sendPush } from "../src/webpush";
import type { Env } from "../src/env";

// Node's crypto, typed loosely: the Worker's type definitions only describe
// the parts of it that the Workers runtime provides.
const { createECDH, hkdfSync, createDecipheriv, createPublicKey, verify, randomBytes, generateKeyPairSync } = nodeCrypto as any;

/** RFC 8291 decryption, the phone's side. */
function decrypt(body: any, uaPrivate: any, auth: any): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  const uaPublic = uaPrivate.getPublicKey();
  const ecdh = uaPrivate.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync("sha256", ecdh, auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

describe("Web Push", () => {
  it("a phone can decrypt what the Worker encrypts (RFC 8291)", async () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = randomBytes(16);
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) };
    const msg = JSON.stringify({ title: "ready", body: "Tunnel proven end to end", actions: [{ title: "Extend 1h", url: "https://x/api/act/1" }] });
    const body = Buffer.from(await encryptPayload(sub, new TextEncoder().encode(msg)));
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(decrypt(body, ua, auth)).toBe(msg);
  });

  it("signs a VAPID token the push service can verify (RFC 8292)", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = privateKey.export({ format: "jwk" });
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
    const env = { VAPID_PUBLIC_KEY: pub.toString("base64url"), VAPID_PRIVATE_KEY: jwk.d, PUBLIC_URL: "https://wg-admin.example" } as unknown as Env;
    const h = await vapidAuth(env, "https://fcm.googleapis.com/fcm/send/abc", 1_800_000_000_000);
    const m = h.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)!;
    expect(m[4]).toBe(env.VAPID_PUBLIC_KEY);
    const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
    expect(claims).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_800_000_000 + 12 * 3600, sub: "https://wg-admin.example" });
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url"))).toBe(true);
  });
});

describe("where alerts may be sent (issue #16)", () => {
  it("only the real push services", () => {
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc123")).toBe(true);
    expect(isPushEndpoint("https://web.push.apple.com/QGx")).toBe(true);
    expect(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isPushEndpoint("https://evil.example/collect")).toBe(false);
    expect(isPushEndpoint("https://fcm.googleapis.com.evil.example/x")).toBe(false);
    expect(isPushEndpoint("https://evilpush.apple.com/x")).toBe(false);
    expect(isPushEndpoint("http://fcm.googleapis.com/fcm/send/x")).toBe(false);
    expect(isPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(isPushEndpoint("not a url")).toBe(false);
  });

  it("a stored subscription elsewhere is never sent to", async () => {
    const env = { VAPID_PUBLIC_KEY: "x", VAPID_PRIVATE_KEY: "y", PUBLIC_URL: "https://wg-admin.example" } as unknown as Env;
    const r = await sendPush(env, { endpoint: "https://evil.example/collect", p256dh: "x", auth: "y" }, { title: "t", body: "b" });
    expect(r).toMatch(/not a known push service/);
  });
});
