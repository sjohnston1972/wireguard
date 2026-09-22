// auth.ts
//
// Plain English: the door. Cloudflare Access already made Steven log in
// before the request reached this Worker, and it attached a signed note (a
// JWT) saying who he is. We check that note's signature against Cloudflare's
// published keys, that it was issued for THIS app, and that the email is the
// one allowed. Like checking a visitor badge was issued by our own reception
// and not just printed at home.
//
// Two routes skip this and use bearer tokens instead: /api/agent (the VM) and
// /api/callback (GitHub Actions). Those tokens are minted per deploy and per
// run and only their SHA-256 hashes are stored.

import type { Context, Next } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./env";

const jwksCache = new Map<string, JWTVerifyGetKey>();

function jwks(teamDomain: string): JWTVerifyGetKey {
  let k = jwksCache.get(teamDomain);
  if (!k) {
    k = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, k);
  }
  return k;
}

export type AuthedVars = { user: string };

/** Hono middleware: require a valid Cloudflare Access identity. */
export async function requireAccess(c: Context<{ Bindings: Env; Variables: AuthedVars }>, next: Next) {
  const env = c.env;
  if (env.AUTH_DEV_BYPASS === "1") {
    c.set("user", "dev@localhost");
    return next();
  }
  const team = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  const allowed = env.CF_ACCESS_ALLOWED_EMAIL;
  if (!team || !aud || !allowed) {
    return c.text("wg-admin is not configured for login yet (CF_ACCESS_* secrets missing). Refusing to serve.", 503);
  }
  const token = c.req.header("Cf-Access-Jwt-Assertion") ?? "";
  if (!token) return c.text("No Cloudflare Access token. Open this page through wg-admin.clydeford.net.", 401);
  try {
    const { payload } = await jwtVerify(token, jwks(team), { issuer: `https://${team}`, audience: aud });
    const email = String(payload.email ?? "").toLowerCase();
    if (email !== allowed.toLowerCase()) return c.text(`Signed in as ${email}, which is not allowed here.`, 403);
    c.set("user", email);
    return next();
  } catch (e) {
    return c.text(`Access token rejected: ${(e as Error).message}`, 401);
  }
}

/** 32 random bytes as hex. Used for the per-run callback and agent tokens. */
export function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare, so a token check does not leak by timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Pull "Bearer xyz" out of an Authorization header. */
export function bearer(c: Context): string {
  const h = c.req.header("Authorization") ?? "";
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : "";
}
