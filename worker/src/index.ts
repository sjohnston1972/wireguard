// index.ts
//
// Plain English: the front desk. Every request that reaches the Worker lands
// here. The pages themselves are the React app (served as static files, see
// wrangler.toml); this file only answers what the app cannot: the routes that
// prove themselves with a token instead of the login (the VM's heartbeat and
// packet captures, GitHub's result callback, run secrets and live log, the one-tap
// buttons on phone notifications), the phone-install manifest, the data API
// for the app (/api/v1, behind the login), capture downloads and the health
// check. The cron entry point at the bottom is the night watchman, and (on its
// own cron) the Azure insights collector.

import { Hono, type Context } from "hono";
import type { Env } from "./env";
import { config } from "./env";
import { requireAccess, sameOriginOnly, bearer, type AuthedVars } from "./auth";
import { getSnapshot } from "./state";
import { startDestroy, extendAutoDestroy, handleCallback, handleAgent, issueRunSecrets, RunError } from "./runs";
import { verifyGithubOidc } from "./oidc";
import { startHibernate } from "./standby";
import { consumeAction } from "./actions";
import { notify } from "./notify";
import { runScheduled } from "./monitor";
import { runInsights } from "./insights/runner";
import { INSIGHTS_CRON } from "./insights/types";
import { receiveCapture, MAX_CAPTURE_BYTES } from "./capture";
import { buildApi } from "./api";
import { devSeed } from "./devseed";
import { serveHashedAsset } from "./assetguard";
import { receiveLiveLog, LIVE_LOG_MAX_BODY } from "./livelog";

export { RunLock } from "./lock";

type App = { Bindings: Env; Variables: AuthedVars };
const app = new Hono<App>();

// ── Browser safety rules on every page ─────────────────────────────────────
// Content-Security-Policy tells the browser what a wg-admin page may load:
// scripts, styles and fonts only from this site (never a CDN; the fonts are
// files in the app's build), and it may not be shown inside another site's
// frame (so nobody can overlay invisible buttons on it, "clickjacking").
// Inline styles are allowed because the app's dialogs inject one; inline
// scripts are not. Like an outbound ACL for the page. The app's own files get
// the same policy from web/public/_headers; keep the two identical.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("Content-Security-Policy", CSP);
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "same-origin");
});

// ── Token-authenticated API (no Cloudflare Access) ─────────────────────────

// Brake on guessing: each caller's address gets a few WRONG tokens a minute
// per route, then is told to slow down. Only failures count, and they count
// against that one address, so junk from elsewhere can never lock out the
// real VM, GitHub or the phone. (The tokens are far too long to guess anyway;
// this just stops the noise.) Kept in this Worker copy's memory.
const FAILS_PER_MINUTE = 10;
const failBuckets = new Map<string, { n: number; reset: number }>();

function failKey(c: Context<App>, route: string): string {
  return `${route}:${c.req.header("CF-Connecting-IP") ?? "unknown"}`;
}

/** Has this caller already had its share of failures on this route? */
function tooManyFailures(key: string): boolean {
  const b = failBuckets.get(key);
  return !!b && b.reset > Date.now() && b.n >= FAILS_PER_MINUTE;
}

/** Count one failed attempt against this caller. */
function noteFailure(key: string): void {
  const now = Date.now();
  if (failBuckets.size > 5000) for (const [k, b] of failBuckets) if (b.reset < now) failBuckets.delete(k);
  const b = failBuckets.get(key);
  if (!b || b.reset < now) failBuckets.set(key, { n: 1, reset: now + 60_000 });
  else b.n++;
}

app.post("/api/callback", async (c) => {
  const key = failKey(c, "callback");
  if (tooManyFailures(key)) return c.json({ error: "slow down" }, 429);
  const body = await c.req.json().catch(() => null);
  const r = await handleCallback(c.env, bearer(c), body);
  if (r.status >= 400) noteFailure(key);
  return c.json({ message: r.message }, r.status as 200);
});

// The workflow's live log: its output, a piece every few seconds while the run
// is going (livelog.ts), proven with the same callback token. Its own brake,
// so a late piece can never use up the result callback's share; and a late
// piece (409, the run just finished) or a too-big one (413) is not a "wrong
// token", so neither counts. The size is checked before the body is read.
app.post("/api/callback/log", async (c) => {
  const key = failKey(c, "callback-log");
  if (tooManyFailures(key)) return c.json({ error: "slow down" }, 429);
  if (Number(c.req.header("Content-Length") ?? 0) > LIVE_LOG_MAX_BODY) return c.json({ error: "too big" }, 413);
  const body = await c.req.json().catch(() => null);
  const r = await receiveLiveLog(c.env, bearer(c), body);
  if (r.status === 400 || r.status === 401 || r.status === 404) noteFailure(key);
  return c.json(r.body, r.status as 200);
});

// GitHub Actions collects the run's secrets here, proving itself with an OIDC
// token. Lives under /api/callback so it shares that path's Access bypass.
app.post("/api/callback/secrets", async (c) => {
  const key = failKey(c, "secrets");
  if (tooManyFailures(key)) return c.json({ error: "slow down" }, 429);
  let claims;
  try {
    claims = await verifyGithubOidc(c.env, bearer(c));
  } catch (e) {
    noteFailure(key);
    return c.json({ error: `not a trusted workflow: ${(e as Error).message}` }, 401);
  }
  const body = (await c.req.json().catch(() => null)) as { run_id?: string } | null;
  if (!body?.run_id) return c.json({ error: "missing run_id" }, 400);
  const r = await issueRunSecrets(c.env, String(body.run_id), Number(claims.run_id));
  if (r.status === 403 || r.status === 404) noteFailure(key);
  return c.json(r.body, r.status as 200);
});

// The VM's packet-capture upload. The token is checked BEFORE the file is
// read, and the file is read with a hard size cap, so a stranger cannot make
// the Worker swallow a huge upload (see capture.ts).
app.post("/api/agent/capture/:id", async (c) => {
  const key = failKey(c, "capture");
  if (tooManyFailures(key)) return c.text("slow down", 429);
  if (Number(c.req.header("Content-Length") ?? 0) > MAX_CAPTURE_BYTES) return c.text("too big", 413);
  const r = await receiveCapture(c.env, bearer(c), c.req.param("id"), c.req.raw.body, c.req.header("X-Capture-Error") ?? null);
  if (r.status === 401) noteFailure(key);
  return c.text(r.text, r.status as 200);
});

app.post("/api/agent", async (c) => {
  const key = failKey(c, "agent");
  if (tooManyFailures(key)) return c.json({ error: "slow down" }, 429);
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "bad json" }, 400);
  const r = await handleAgent(c.env, bearer(c), body);
  if (r.status === 401) noteFailure(key);
  return c.json(r.body as object, r.status as 200);
});

// One-tap buttons on phone notifications (actions.ts). POST only, so a link
// preview or a crawler fetching the URL cannot trigger anything.
app.post("/api/act/:token", async (c) => {
  const key = failKey(c, "act");
  if (tooManyFailures(key)) return c.text("slow down", 429);
  const action = await consumeAction(c.env, c.req.param("token"));
  if (!action) {
    noteFailure(key);
    return c.text("This button has expired or was already used.", 410);
  }
  let msg: string;
  try {
    if (action === "extend") {
      const snap = await getSnapshot(c.env);
      if (snap.state !== "running") throw new RunError("Nothing is running.");
      const from = Math.max(Date.now(), snap.auto_destroy_at ? Date.parse(snap.auto_destroy_at) : 0);
      const at = await extendAutoDestroy(c.env, (from - Date.now()) / 3_600_000 + 1);
      msg = `Extended. Now ends at ${new Date(at!).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" })}.`;
    } else if (action === "hibernate") {
      msg = await startHibernate(c.env, "phone notification", "button on the phone");
    } else {
      const run = await startDestroy(c.env, "phone notification", "button on the phone");
      msg = `Tear-down started (${run.id}).`;
    }
  } catch (e) {
    msg = `Could not do that: ${(e as Error).message}`;
  }
  await notify(c.env, "wg-admin", msg, { tags: ["ok_hand"], skipPush: true });
  return c.text(msg);
});

// The app description a phone reads to install wg-admin to its home screen.
// It and /icons/ have their own Access bypass (they hold nothing private),
// because browsers fetch them without the login cookie.
app.get("/manifest.webmanifest", (c) =>
  c.json(
    {
      id: "/",
      name: "wg-admin",
      short_name: "wg-admin",
      description: "On-demand WireGuard headend: deploy, watch and tear down.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      background_color: "#08111c",
      theme_color: "#08111c",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    200,
    { "Content-Type": "application/manifest+json" }
  )
);

// Local scenario seeder (devseed.ts). Mounted before the login check, so it
// carries its own lock: a 404 unless AUTH_DEV_BYPASS=1 and the host is localhost.
app.all("/__dev/seed", devSeed);

// The app's hashed files (wrangler.toml sends /assets/* here first): served
// from the build, but a missing one is a 404, never the app's index.html
// (assetguard.ts). Before the login check like every other static file, which
// the assets layer serves without the Worker (Access guards them at the edge).
app.get("/assets/*", (c) => serveHashedAsset(c.req.raw, c.env.ASSETS));

// ── Everything below requires Cloudflare Access ───────────────────────────

app.use("*", requireAccess);
// Changes must come from the dashboard's own pages, not another site (auth.ts).
app.use("*", sameOriginOnly);

// An old dashboard page still open in a tab (htmx polling, boosted links, form
// buttons) is told to reload into the app instead of painting error text into
// itself. Its polling and buttons (/partials/*, /actions/*, /alerts/*) are
// routed here by run_worker_first in wrangler.toml; without that the assets
// layer would answer them. Remove this, and those three paths, one release
// after the switch-over.
app.use("*", async (c, next) => {
  if (c.req.header("HX-Request") === "true") return c.body(null, 200, { "HX-Refresh": "true" });
  await next();
});

// The data API for the new app (api/): JSON only, behind the same checks.
app.route("/api/v1", buildApi());

app.get("/captures/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{16}$/.test(id)) return c.text("Not found", 404);
  const obj = await c.env.STATE.get(`captures/${id}.pcap.gz`);
  if (!obj) return c.text("That capture is no longer kept.", 404);
  return new Response(obj.body, { headers: { "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="wg-admin-capture-${id.slice(0, 8)}.pcap.gz"` } });
});

app.get("/health", async (c) => {
  const snap = await getSnapshot(c.env);
  return c.json({ state: snap.state, public_ip: snap.public_ip, updated_at: snap.updated_at, config: config(c.env).dnsName });
});

app.notFound((c) => c.text("Not found", 404));
// A crash: the details go to the Worker's log under a short reference, and
// the caller only gets the reference. Some routes are open to the internet
// (token-checked), so error text must not leak how things work inside.
app.onError((err, c) => {
  const ref = crypto.randomUUID().slice(0, 8);
  console.error(`error ${ref} on ${c.req.method} ${new URL(c.req.url).pathname}:`, err);
  return c.text(`Something broke (reference ${ref}). The details are in the Worker's log.`, 500);
});

export default {
  fetch: app.fetch,
  // One cron (wrangler.toml): the watchman, then the Azure insights collector in the
  // same invocation. (A second trigger for the collector was registered but never fired
  // on Cloudflare, 2026-10-04.) Each is caught on its own, so neither can stop the
  // other; the collector keeps its own 25-call budget and soft time limit. A leftover
  // INSIGHTS_CRON trigger, if one ever fires, runs only the collector.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const insights = () =>
      runInsights(env, new Date(event.scheduledTime)).then(
        (lines) => {
          if (lines.length) console.log("insights:", lines.join(" | "));
        },
        (e) => console.error("insights run failed:", e),
      );
    if (event.cron === INSIGHTS_CRON) {
      ctx.waitUntil(insights());
      return;
    }
    ctx.waitUntil(
      runScheduled(env)
        .then(
          (notes) => {
            if (notes.length) console.log("watchman:", notes.join(" | "));
          },
          (e) => console.error("watchman run failed:", e),
        )
        .then(insights)
    );
  },
};
