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
//
// Behind the login, sameOriginOnly also refuses any change that did not come
// from the dashboard's own pages (see below).

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
    // The login switch-off is for "npm run dev" on this PC only. If it ever
    // leaks into the live settings it is ignored, and the normal check runs.
    if (isLocalhost(c.req.url)) {
      if (!warnedBypass) {
        warnedBypass = true;
        console.warn("AUTH_DEV_BYPASS is on: login is switched off for localhost.");
      }
      c.set("user", "dev@localhost");
      return next();
    }
    console.error("AUTH_DEV_BYPASS is set but this request is not on localhost. Ignoring it; remove it from the live settings.");
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
    // The exact reason goes to the Worker's log, not to whoever sent the token.
    console.error("Access token rejected:", (e as Error).message);
    return c.text("Access token rejected. Sign in again through wg-admin.clydeford.net.", 401);
  }
}

let warnedBypass = false;

/** True when the address is this PC (localhost, 127.0.0.1 or ::1). */
export function isLocalhost(url: string): boolean {
  const h = new URL(url).hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

/**
 * Hono middleware, after requireAccess: a change (anything but reading a
 * page) must come from the dashboard's own pages. Browsers label every
 * request with where it came from (Sec-Fetch-Site, and Origin on a POST), and
 * a web page cannot fake those labels. Without this, another site open in the
 * same browser could submit a hidden form here while you are logged in
 * ("cross-site request forgery"). Like an ACL that only accepts management
 * traffic sourced from the management VLAN.
 */
export async function sameOriginOnly(c: Context<{ Bindings: Env; Variables: AuthedVars }>, next: Next) {
  const m = c.req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  if (!cameFromOurPages(c.req.header("Sec-Fetch-Site"), c.req.header("Origin"), c.req.url, c.env.PUBLIC_URL)) {
    return c.text("Refused: that request did not come from the wg-admin pages.", 403);
  }
  return next();
}

/** The decision behind sameOriginOnly, on its own so it can be tested. */
export function cameFromOurPages(fetchSite: string | undefined, origin: string | undefined, url: string, publicUrl: string | undefined): boolean {
  // Modern browsers: "same-origin" means one of our own pages sent it.
  if (fetchSite) return fetchSite === "same-origin";
  // Older browsers: fall back to the Origin label. No label at all is refused.
  if (!origin || origin === "null") return false;
  const ours = new Set([new URL(url).origin]);
  try {
    if (publicUrl) ours.add(new URL(publicUrl).origin);
  } catch {
    /* a malformed PUBLIC_URL is simply not trusted */
  }
  return ours.has(origin);
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
