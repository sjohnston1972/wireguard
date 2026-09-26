// index.ts
//
// Plain English: the front desk. Every request lands here and is routed to
// a screen or an action. Screens are server-rendered HTML; htmx swaps them
// in place so the page never fully reloads. A few API routes skip the login
// and prove themselves another way: the VM's heartbeat and GitHub's result
// callback (bearer tokens), GitHub collecting its run secrets (an OIDC
// token), and the one-tap buttons on phone notifications (single-use links).
// The cron entry point at the bottom is the night watchman.

import { Hono, type Context } from "hono";
import { html } from "hono/html";
import type { Env } from "./env";
import { config, missingSecrets, canDispatch } from "./env";
import { requireAccess, sameOriginOnly, bearer, type AuthedVars } from "./auth";
import * as db from "./db";
import { getSnapshot } from "./state";
import { lockStatus, releaseLock } from "./lock";
import { serverPublicKey, nextFreeIp, clientConfigTemplate, validPeerName, isWgKey, expiryFrom } from "./peers";
import { effectiveConfig, saveOverrides } from "./settings";
import { startDeploy, startDestroy, cancelActive, reconcile, extendAutoDestroy, refreshActiveRun, refreshInventory, handleCallback, handleAgent, issueRunSecrets, RunError } from "./runs";
import { verifyGithubOidc } from "./oidc";
import { startHibernate, startResume, refreshPower } from "./standby";
import { consumeAction, dashboardButton } from "./actions";
import { notify, ntfyParts, lastNotifyError } from "./notify";
import { nearestRegion, REGIONS, regionName } from "./region";
import { startMove } from "./profiles";
import { startSpeedTest } from "./speedtest";
import { nextStart, validRule } from "./schedule-time";
import { setSshAllowedCidr } from "./azure";
import { runScheduled } from "./monitor";
import { page, type Tab } from "./views/layout";
import { liveSection } from "./views/dashboard";
import { peersBody, peersTable } from "./views/peers";
import { activityBody, AUDIT_KINDS, AUDIT_PAGE } from "./views/activity";
import { settingsBody } from "./views/settings";
import { rotationStatus } from "./keyrotation";
import { costBody } from "./views/cost";
import { budgetStatus, requireBudgetOk, OVER_BUDGET_FIELD } from "./budget";
import { firewallBody } from "./views/firewall";
import { parseCidr, parsePorts, compileFirewall, type EndKind, type Proto } from "./firewall";
import { clearFirewallCounters } from "./runs";
import { startCapture, receiveCapture, validFilter, MAX_CAPTURE_BYTES } from "./capture";
import { setPublishedPorts } from "./azure";
import { reservedPort, forwardTargetOk, publishedNsgRules } from "./firewall";
import { isPushEndpoint } from "./webpush";
import { buildExport, exportFileName, checkRestoreFile, applyRestore, currentCounts, backupStatus, MAX_RESTORE_BYTES, type RestorePlan } from "./backup";
import { restoreBody } from "./views/settings";
import { randomToken } from "./auth";

export { RunLock } from "./lock";

type App = { Bindings: Env; Variables: AuthedVars };
const app = new Hono<App>();

// ── Browser safety rules on every page ─────────────────────────────────────
// Content-Security-Policy tells the browser what a wg-admin page may load:
// scripts only from this site (htmx is kept in worker/public, not fetched
// from a CDN), styles from here plus Google Fonts, and it may not be shown
// inside another site's frame (so nobody can overlay invisible buttons on it,
// "clickjacking"). Inline style="..." attributes are allowed because the
// screens use them; inline scripts are not. Like an outbound ACL for the page.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
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
      background_color: "#0f1620",
      theme_color: "#2457f5",
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

// ── Everything below requires Cloudflare Access ───────────────────────────

app.use("*", requireAccess);
// Changes must come from the dashboard's own pages, not another site (auth.ts).
app.use("*", sameOriginOnly);

/**
 * The JSON body of a request from the dashboard's own script, or null. Only
 * accepted when labelled as JSON: a plain HTML form on another site cannot
 * send that label, so it is one more lock against forged requests.
 */
async function jsonBody<T>(c: Context<App>): Promise<T | null> {
  if (!/^application\/json\b/i.test(c.req.header("Content-Type") ?? "")) return null;
  return (await c.req.json().catch(() => null)) as T | null;
}

/**
 * "While you were away" should mean exactly that. Pressing any button on the
 * dashboard counts as having read the notes so far, and the routine notes
 * that follow in the next SEEN_WINDOW_MS (Deployed at..., Self-test passed,
 * Torn down, the session summary) are ones Steven watched happen.
 */
const LAST_ACTION_KEY = "ui:last_action_at";
const SEEN_WINDOW_MS = 15 * 60_000;

async function markActed(env: Env): Promise<void> {
  await db.acknowledgeAlerts(env);
  await env.STATUS.put(LAST_ACTION_KEY, new Date().toISOString(), { expirationTtl: 86_400 });
}

/** Mark the routine notes from just after the last button press as read. */
async function ackWatchedNotes(env: Env): Promise<void> {
  const last = await env.STATUS.get(LAST_ACTION_KEY);
  if (!last || Number.isNaN(Date.parse(last))) return;
  await db.acknowledgeRoutineBetween(env, last, new Date(Date.parse(last) + SEEN_WINDOW_MS).toISOString());
}

async function render(c: { env: Env; get: (k: "user") => string }, tab: Tab, title: string, body: Parameters<typeof page>[0]["body"], notice?: Parameters<typeof page>[0]["notice"]) {
  await ackWatchedNotes(c.env).catch((e) => console.error("ack watched notes:", e));
  const [snapshot, alerts] = await Promise.all([getSnapshot(c.env), db.unacknowledgedAlerts(c.env)]);
  return page({ title, tab, user: c.get("user"), snapshot, body, missing: missingSecrets(c.env), alerts, notice });
}

/** Cloudflare's idea of where the browser is: country code and the nearest Azure region. */
function where(c: Context<App>): { country: string | null; region: string | null } {
  const cf = (c.req.raw as unknown as { cf?: { country?: string; continent?: string; longitude?: string } }).cf;
  return { country: cf?.country ?? null, region: nearestRegion(cf) };
}

async function live(env: Env, notice?: { kind: "good" | "warn" | "bad" | "info"; text: string } | null, near?: { country: string | null; region: string | null }) {
  const [snap, cfg, peers, lock, deployment, serverPub, profiles, speedtests, schedules, backups] = await Promise.all([
    getSnapshot(env),
    effectiveConfig(env),
    db.listPeers(env),
    lockStatus(env),
    db.currentDeployment(env),
    serverPublicKey(env),
    db.listProfiles(env),
    db.listSpeedTests(env, 5),
    db.listSchedules(env),
    backupStatus(env).catch(() => null),
  ]);
  return liveSection({
    stateBackups: backups && !backups.error ? backups.state : null,
    snap,
    cfg,
    peerCount: peers.filter((p) => p.enabled).length,
    peers,
    canDispatch: canDispatch(env),
    notice,
    lockHolder: lock.held && !["deploying", "destroying"].includes(snap.state) ? lock.lock?.runId ?? null : null,
    deployment,
    serverPub,
    callerIp: null,
    near: near ?? null,
    profiles,
    speedtests,
    site: peers.find((p) => p.enabled && p.routes) ?? null,
    nextScheduled: nextStart(schedules, new Date()),
    budget: await budgetStatus(env, cfg, snap),
  });
}

app.get("/", async (c) => {
  await refreshActiveRun(c.env).catch(() => {});
  await refreshPower(c.env).catch(() => {});
  return c.html(await render(c, "dashboard", "Overview", await live(c.env, null, where(c))));
});

app.get("/partials/live", async (c) => {
  await refreshActiveRun(c.env).catch(() => {});
  await refreshPower(c.env).catch(() => {});
  return c.html(await live(c.env, null, where(c)));
});

function ip(c: { req: { header: (n: string) => string | undefined } }): string | null {
  return c.req.header("CF-Connecting-IP") ?? null;
}

async function action(c: Context<App>, fn: () => Promise<string>, kind: "good" | "warn" | "bad" | "info" = "good") {
  let notice: { kind: "good" | "warn" | "bad" | "info"; text: string };
  try {
    notice = { kind, text: await fn() };
  } catch (e) {
    notice = { kind: "bad", text: e instanceof RunError ? e.message : `Unexpected error: ${(e as Error).message}` };
  }
  // Steven is here and pressing buttons: the notes so far are read. The
  // banner sits outside #live, so it is removed with an out-of-band swap.
  await markActed(c.env).catch((e) => console.error("mark acted:", e));
  if (c.req.header("HX-Request")) return c.html(html`${await live(c.env, notice, where(c))}<div id="away" hx-swap-oob="delete"></div>`);
  return c.redirect("/");
}

app.post("/actions/deploy", async (c) => {
  const form = await c.req.parseBody();
  const hours = Number(form.hours);
  const choice = String(form.choice ?? (form.region ? `r:${form.region}` : ""));
  const user = c.get("user");
  return action(c, async () => {
    let region: string | undefined, vmSize: string | undefined, profile: string | null = null;
    if (choice.startsWith("p:")) {
      const p = await db.getProfile(c.env, Number(choice.slice(2)));
      if (!p) throw new RunError("No such profile.");
      ({ region, vm_size: vmSize } = p);
      profile = p.name;
    } else if (choice.startsWith("r:")) {
      region = choice.slice(2);
      // hasOwn, not "in": "in" would also accept built-in names like "constructor".
      if (!Object.hasOwn(REGIONS, region)) throw new RunError("Unknown region.");
    }
    await requireBudgetOk(c.env, form[OVER_BUDGET_FIELD] === "yes");
    const run = await startDeploy(c.env, { hours: hours > 0 ? hours : null, requesterIp: ip(c), requestedBy: user, region, vmSize, profile });
    return `Deploy started${profile ? `: ${profile}` : ""} in ${regionName(region ?? (await effectiveConfig(c.env)).region)} (${run.id}). About 4 minutes.`;
  });
});

app.post("/actions/move", async (c) => {
  const form = await c.req.parseBody();
  const user = c.get("user");
  return action(c, async () => {
    const cfg = await effectiveConfig(c.env);
    return startMove(c.env, { profileId: Number(form.profile), hours: cfg.autoDestroyDefaultHours > 0 ? cfg.autoDestroyDefaultHours : null, by: user, requesterIp: ip(c) });
  }, "info");
});

app.post("/actions/speedtest", async (c) => action(c, () => startSpeedTest(c.env), "info"));

app.post("/actions/hibernate", async (c) => {
  const user = c.get("user");
  return action(c, () => startHibernate(c.env, user, "dashboard"), "info");
});

app.post("/actions/resume", async (c) => {
  const form = await c.req.parseBody();
  const hours = Number(form.hours);
  const user = c.get("user");
  return action(c, () => startResume(c.env, user, hours > 0 ? hours : null));
});

app.post("/actions/destroy", async (c) => {
  const form = await c.req.parseBody();
  const user = c.get("user");
  return action(c, async () => {
    if (String(form.confirm ?? "").trim().toLowerCase() !== "destroy") throw new RunError('Type "destroy" to confirm.');
    const run = await startDestroy(c.env, user, "dashboard");
    return `Tear-down started (${run.id}).`;
  });
});

app.post("/actions/cleanup", async (c) => {
  const user = c.get("user");
  return action(c, async () => {
    const run = await startDestroy(c.env, user, "clean up after failure");
    return `Clean-up started (${run.id}).`;
  });
});

app.post("/actions/cancel", async (c) => action(c, () => cancelActive(c.env), "warn"));
app.post("/actions/reconcile", async (c) => {
  const user = c.get("user");
  return action(c, () => reconcile(c.env, user), "info");
});
app.post("/actions/extend", async (c) => {
  const form = await c.req.parseBody();
  const hours = Number(form.hours);
  return action(c, async () => {
    const at = await extendAutoDestroy(c.env, hours > 0 ? hours : null);
    return at ? `Auto-destroy set for ${new Date(at).toLocaleString("en-GB", { timeZone: "Europe/London" })}.` : "Auto-destroy cleared. It runs until you tear it down.";
  }, "info");
});

app.post("/actions/allow-ssh", async (c) => {
  const user = c.get("user");
  const addr = ip(c);
  return action(c, async () => {
    if (!addr || addr.includes(":")) throw new RunError("Could not read an IPv4 address for this browser.");
    const snap = await getSnapshot(c.env);
    if (snap.state !== "running") throw new RunError("Nothing is running.");
    await setSshAllowedCidr(c.env, `${addr}/32`);
    await db.addAlert(c.env, "info", `SSH allowed from ${addr} by ${user} (live NSG change).`);
    await refreshInventory(c.env);
    return `SSH now allowed from ${addr}. Takes effect within a few seconds.`;
  }, "info");
});

// The SSH password for what is running now, fetched only when Show or Copy
// is pressed (so it is not written into every page). Never cached.
app.get("/api/ssh-password", async (c) => {
  const [snap, dep] = await Promise.all([getSnapshot(c.env), db.currentDeployment(c.env)]);
  c.header("Cache-Control", "no-store");
  if (snap.state !== "running" || !dep?.ssh_password) return c.json({ error: "There is no SSH password for what is running now." }, 404);
  return c.json({ password: dep.ssh_password });
});

app.post("/alerts/ack", async (c) => {
  await db.acknowledgeAlerts(c.env);
  // From the page (htmx) the notes are simply removed where they are.
  if (c.req.header("HX-Request")) return c.html("");
  return c.redirect("/");
});

// ── Clients ────────────────────────────────────────────────────────────────

app.get("/peers", async (c) => {
  const [peers, snap, cfg, serverPub] = await Promise.all([db.listPeers(c.env), getSnapshot(c.env), effectiveConfig(c.env), serverPublicKey(c.env)]);
  const nextIp = nextFreeIp(cfg.subnet, peers.map((p) => p.ip));
  return c.html(await render(c, "peers", "Clients", peersBody({ peers, report: snap.agent, running: snap.state === "running", cfg, serverPub, nextIp, latency: snap.latency, talkers: Object.values(snap.talkers ?? {}), hist: snap.traffic_hist })));
});

app.get("/partials/peers-table", async (c) => {
  const [peers, snap] = await Promise.all([db.listPeers(c.env), getSnapshot(c.env)]);
  return c.html(peersTable(peers, snap.agent, snap.state === "running", snap.latency, Object.values(snap.talkers ?? {})));
});

app.post("/api/peers", async (c) => {
  const body = await jsonBody<{ name?: string; public_key?: string; full_tunnel?: boolean; azure_vnet?: boolean; tunnel_dns?: boolean; home_lan?: boolean; expires_days?: number }>(c);
  if (!body) return c.json({ error: "bad json" }, 400);
  const name = String(body.name ?? "").trim();
  if (!validPeerName(name)) return c.json({ error: "Name: letters, digits, spaces, dashes; up to 32 characters." }, 400);
  if (!isWgKey(String(body.public_key ?? ""))) return c.json({ error: "That is not a valid WireGuard public key." }, 400);
  const serverPub = await serverPublicKey(c.env);
  if (!serverPub) return c.json({ error: "Server key not configured." }, 503);
  const cfg = await effectiveConfig(c.env);
  const peers = await db.listPeers(c.env);
  const ipAddr = nextFreeIp(cfg.subnet, peers.map((p) => p.ip));
  if (!ipAddr) return c.json({ error: "No free tunnel addresses left." }, 409);
  let peer;
  try {
    peer = await db.addPeer(c.env, { name, public_key: String(body.public_key), ip: ipAddr, full_tunnel: !!body.full_tunnel, azure_vnet: !!body.azure_vnet, tunnel_dns: !!body.tunnel_dns, expires_at: expiryFrom(body.expires_days) });
    if (body.home_lan && !body.full_tunnel) {
      await db.setPeerHomeLan(c.env, peer.id, true);
      peer = (await db.getPeer(c.env, peer.id))!;
    }
  } catch (e) {
    return c.json({ error: /UNIQUE/.test(String(e)) ? "That key is already registered." : (e as Error).message }, 409);
  }
  await db.audit(c.env, c.get("user"), "client.add", peer.name, null, peer);
  return c.json({ peer, template: clientConfigTemplate(c.env, peer, serverPub) });
});

// Re-key: the browser made a new keypair for an existing client and sends
// the public half. Returns the config template for the new key.
app.post("/api/peers/:id/rekey", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await jsonBody<{ public_key?: string }>(c);
  if (!body || !isWgKey(String(body.public_key ?? ""))) return c.json({ error: "That is not a valid WireGuard public key." }, 400);
  const peer = await db.getPeer(c.env, id);
  if (!peer) return c.json({ error: "No such client." }, 404);
  const serverPub = await serverPublicKey(c.env);
  if (!serverPub) return c.json({ error: "Server key not configured." }, 503);
  try {
    await db.setPeerKey(c.env, id, String(body.public_key));
  } catch (e) {
    return c.json({ error: /UNIQUE/.test(String(e)) ? "That key is already registered." : (e as Error).message }, 409);
  }
  const updated = (await db.getPeer(c.env, id))!;
  await db.audit(c.env, c.get("user"), "client.rekey", peer.name, peer, updated);
  return c.json({ peer: updated, template: clientConfigTemplate(c.env, updated, serverPub) });
});

// Change or remove when a client stops working: {days: 0 (never), 1, 7 or 30}, counted from now.
// The home site never expires: losing it would cut the home network off.
app.post("/api/peers/:id/expiry", async (c) => {
  const body = await jsonBody<{ days?: number }>(c);
  if (!body) return c.json({ error: "bad json" }, 400);
  const peer = await db.getPeer(c.env, Number(c.req.param("id")));
  if (!peer) return c.json({ error: "No such client." }, 404);
  const at = expiryFrom(body.days);
  if (at && peer.routes) return c.json({ error: "The home site does not expire." }, 400);
  await db.setPeerExpiry(c.env, peer.id, at);
  await db.audit(c.env, c.get("user"), "client.edit", peer.name, { expires_at: peer.expires_at ?? null }, { expires_at: at });
  return c.json({ ok: true, expires_at: at });
});

app.post("/peers/:id/azure", async (c) => {
  const id = Number(c.req.param("id"));
  const p = await db.getPeer(c.env, id);
  if (p) await db.setPeerAzureVnet(c.env, id, !p.azure_vnet);
  if (p) await db.audit(c.env, c.get("user"), "client.edit", p.name, p, { ...p, azure_vnet: p.azure_vnet ? 0 : 1 });
  const [peers, snap] = await Promise.all([db.listPeers(c.env), getSnapshot(c.env)]);
  return c.req.header("HX-Request") ? c.html(peersTable(peers, snap.agent, snap.state === "running", snap.latency, Object.values(snap.talkers ?? {}))) : c.redirect("/peers");
});

app.post("/peers/:id/dns", async (c) => {
  const id = Number(c.req.param("id"));
  const p = await db.getPeer(c.env, id);
  if (p) await db.setPeerTunnelDns(c.env, id, !p.tunnel_dns);
  if (p) await db.audit(c.env, c.get("user"), "client.edit", p.name, p, { ...p, tunnel_dns: p.tunnel_dns ? 0 : 1 });
  const [peers, snap] = await Promise.all([db.listPeers(c.env), getSnapshot(c.env)]);
  return c.req.header("HX-Request") ? c.html(peersTable(peers, snap.agent, snap.state === "running", snap.latency, Object.values(snap.talkers ?? {}))) : c.redirect("/peers");
});

// ── Phone alerts (Web Push) ───────────────────────────────────────────────
// The app on the phone subscribes with its push service and hands us where
// to send and the keys to encrypt to (see webpush.ts). Behind the login.

app.post("/api/push/subscribe", async (c) => {
  const b = await jsonBody<{ endpoint?: string; keys?: { p256dh?: string; auth?: string }; label?: string }>(c);
  const endpoint = String(b?.endpoint ?? "");
  const p256dh = String(b?.keys?.p256dh ?? ""), auth = String(b?.keys?.auth ?? "");
  if (!/^https:\/\/[^\s]{10,}$/.test(endpoint) || !isPushEndpoint(endpoint) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) return c.json({ error: "That does not look like a push subscription." }, 400);
  await db.savePushSub(c.env, { endpoint, p256dh, auth, label: String(b?.label ?? "").slice(0, 40) || null });
  await db.addAlert(c.env, "info", `Phone alerts turned on for ${b?.label || "a device"} by ${c.get("user")}.`);
  await db.audit(c.env, c.get("user"), "push.add", b?.label || "a device", null, { label: b?.label || null });
  return c.json({ ok: true });
});

app.post("/api/push/unsubscribe", async (c) => {
  const b = await jsonBody<{ endpoint?: string }>(c);
  if (b?.endpoint) await db.deletePushSub(c.env, { endpoint: String(b.endpoint) });
  if (b?.endpoint) await db.audit(c.env, c.get("user"), "push.remove", "this device", null, null);
  return c.json({ ok: true });
});

// Is this device's subscription still on our list? The Phone alerts panel
// asks, so it can say "not registered" instead of a false "on". Also hands
// the service worker the public key when it has to sign up again.
app.get("/api/push/status", async (c) => {
  const endpoint = c.req.query("endpoint") ?? "";
  const sub = endpoint ? (await db.listPushSubs(c.env)).find((s) => s.endpoint === endpoint) : undefined;
  c.header("Cache-Control", "no-store");
  return c.json({ registered: !!sub, id: sub?.id ?? null, last_error: sub?.last_error ?? null, vapid: c.env.VAPID_PUBLIC_KEY ?? null });
});

app.post("/api/push/test", async (c) => {
  await c.env.STATUS.delete("notify:last_error");
  await notify(c.env, "wg-admin: test alert", "Phone alerts work. Tap to open the dashboard.", { tags: ["test"], buttons: [dashboardButton(c.env)] });
  const err = await lastNotifyError(c.env);
  const subs = await db.listPushSubs(c.env);
  return c.json(err ? { ok: false, error: err.why } : { ok: true, phones: subs.length });
});

app.post("/settings/push/:id/delete", async (c) => {
  const gone = (await db.listPushSubs(c.env)).find((s) => s.id === Number(c.req.param("id")));
  await db.deletePushSub(c.env, { id: Number(c.req.param("id")) });
  if (gone) await db.audit(c.env, c.get("user"), "push.remove", gone.label ?? `device ${gone.id}`, gone, null);
  return c.redirect("/settings?saved=1");
});

app.post("/peers/:id/homelan", async (c) => {
  const id = Number(c.req.param("id"));
  const p = await db.getPeer(c.env, id);
  if (p) await db.setPeerHomeLan(c.env, id, !p.home_lan);
  if (p) await db.audit(c.env, c.get("user"), "client.edit", p.name, p, { ...p, home_lan: p.home_lan ? 0 : 1 });
  const [peers, snap] = await Promise.all([db.listPeers(c.env), getSnapshot(c.env)]);
  return c.req.header("HX-Request") ? c.html(peersTable(peers, snap.agent, snap.state === "running", snap.latency, Object.values(snap.talkers ?? {}))) : c.redirect("/peers");
});

app.post("/peers/:id/toggle", async (c) => {
  const id = Number(c.req.param("id"));
  const p = await db.getPeer(c.env, id);
  if (p) await db.setPeerEnabled(c.env, id, !p.enabled);
  if (p) await db.audit(c.env, c.get("user"), p.enabled ? "client.disable" : "client.enable", p.name, p, { ...p, enabled: p.enabled ? 0 : 1 });
  const [peers, snap] = await Promise.all([db.listPeers(c.env), getSnapshot(c.env)]);
  return c.req.header("HX-Request") ? c.html(peersTable(peers, snap.agent, snap.state === "running", snap.latency, Object.values(snap.talkers ?? {}))) : c.redirect("/peers");
});

app.post("/peers/:id/delete", async (c) => {
  const gone = await db.getPeer(c.env, Number(c.req.param("id")));
  await db.deletePeer(c.env, Number(c.req.param("id")));
  if (gone) await db.audit(c.env, c.get("user"), "client.delete", gone.name, gone, null);
  const [peers, snap] = await Promise.all([db.listPeers(c.env), getSnapshot(c.env)]);
  return c.req.header("HX-Request") ? c.html(peersTable(peers, snap.agent, snap.state === "running", snap.latency, Object.values(snap.talkers ?? {}))) : c.redirect("/peers");
});

// ── Activity, cost, settings ───────────────────────────────────────────────

app.get("/activity", async (c) => {
  // The change log's filter and page come from the address (?kind=&q=&page=).
  const kind = AUDIT_KINDS.find((k) => k.value === c.req.query("kind"))?.value ?? "";
  const q = (c.req.query("q") ?? "").trim().slice(0, 60);
  const pageNo = Math.max(1, Math.min(1000, Number(c.req.query("page")) || 1));
  const [runs, alerts, cfg, rows] = await Promise.all([db.listRuns(c.env, 100), db.listAlerts(c.env, 100), effectiveConfig(c.env), db.listAudit(c.env, { kind, q, limit: AUDIT_PAGE, offset: (pageNo - 1) * AUDIT_PAGE })]);
  const changes = { rows: rows.slice(0, AUDIT_PAGE), more: rows.length > AUDIT_PAGE, kind, q, page: pageNo };
  return c.html(await render(c, "activity", "Activity", activityBody({ runs, alerts, cfg, changes })));
});

app.get("/cost", async (c) => {
  const monthStart = new Date().toISOString().slice(0, 8) + "01";
  const [snap, days, runs, cfg, fetchedDay] = await Promise.all([getSnapshot(c.env), db.costDays(c.env, monthStart), db.listRuns(c.env, 200), effectiveConfig(c.env), c.env.STATUS.get("cost:fetched_day")]);
  const budget = await budgetStatus(c.env, cfg, snap);
  return c.html(await render(c, "cost", "Cost", costBody({ snap, days, runs, cfg, fetchedDay, budget })));
});

app.get("/settings", async (c) => {
  const [cfg, overrides, lock, serverPub] = await Promise.all([effectiveConfig(c.env), db.allSettings(c.env), lockStatus(c.env), serverPublicKey(c.env)]);
  const saved = c.req.query("saved") === "1";
  const backups = await backupStatus(c.env, true);
  return c.html(
    await render(c, "settings", "Settings", settingsBody({ backups, restored: c.req.query("restored") === "1", cfg, overrides, missing: missingSecrets(c.env), lock, serverPub, saved, repo: c.env.GITHUB_REPO ?? null, webhook: !!c.env.NOTIFY_WEBHOOK_URL, ntfy: c.env.NOTIFY_WEBHOOK_URL ? ntfyParts(c.env.NOTIFY_WEBHOOK_URL) : null, ntfyToken: !!c.env.NOTIFY_TOKEN, notifyError: await lastNotifyError(c.env), profiles: await db.listProfiles(c.env), schedules: await db.listSchedules(c.env), err: c.req.query("err") ?? null, publicUrl: config(c.env).publicUrl, pushSubs: await db.listPushSubs(c.env), vapidPublic: c.env.VAPID_PUBLIC_KEY ?? null, rotation: await rotationStatus(c.env) }))
  );
});

app.post("/settings", async (c) => {
  const form = (await c.req.parseBody()) as Record<string, string>;
  const was = await db.allSettings(c.env);
  const rejected = await saveOverrides(c.env, form);
  await db.audit(c.env, c.get("user"), "settings.save", "Settings", was, await db.allSettings(c.env));
  if (rejected.length) {
    const [cfg, overrides, lock, serverPub] = await Promise.all([effectiveConfig(c.env), db.allSettings(c.env), lockStatus(c.env), serverPublicKey(c.env)]);
    return c.html(
      await render(c, "settings", "Settings", settingsBody({ cfg, overrides, missing: missingSecrets(c.env), lock, serverPub, repo: c.env.GITHUB_REPO ?? null, webhook: !!c.env.NOTIFY_WEBHOOK_URL, ntfy: c.env.NOTIFY_WEBHOOK_URL ? ntfyParts(c.env.NOTIFY_WEBHOOK_URL) : null, ntfyToken: !!c.env.NOTIFY_TOKEN, notifyError: await lastNotifyError(c.env), profiles: await db.listProfiles(c.env), schedules: await db.listSchedules(c.env), err: c.req.query("err") ?? null, publicUrl: config(c.env).publicUrl, pushSubs: await db.listPushSubs(c.env), vapidPublic: c.env.VAPID_PUBLIC_KEY ?? null }), {
        kind: "bad",
        text: `Not saved: ${rejected.join(", ")} did not look right.`,
      })
    );
  }
  return c.redirect("/settings?saved=1");
});

app.post("/settings/profiles", async (c) => {
  const f = (await c.req.parseBody()) as Record<string, string>;
  const name = String(f.name ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,23}$/.test(name) || !Object.hasOwn(REGIONS, f.region ?? "") || !/^Standard_[A-Za-z0-9_]{1,30}$/.test(f.vm_size ?? "")) return c.redirect("/settings?err=profile");
  try {
    await db.addProfile(c.env, { name, region: f.region, vm_size: f.vm_size });
  } catch {
    return c.redirect("/settings?err=profile");
  }
  await db.audit(c.env, c.get("user"), "profile.add", name, null, { name, region: f.region, vm_size: f.vm_size });
  return c.redirect("/settings?saved=1");
});

app.post("/settings/profiles/:id/delete", async (c) => {
  const gone = await db.getProfile(c.env, Number(c.req.param("id")));
  await db.deleteProfile(c.env, Number(c.req.param("id")));
  if (gone) await db.audit(c.env, c.get("user"), "profile.delete", gone.name, gone, null);
  return c.redirect("/settings?saved=1");
});

app.post("/settings/schedules", async (c) => {
  const form = await c.req.parseBody({ all: true });
  const days = ([] as unknown[]).concat(form.day ?? []).map(String).filter((d) => /^[1-7]$/.test(d)).sort().join("");
  const start = String(form.start ?? ""), end = String(form.end ?? "");
  if (validRule(days, start, end)) return c.redirect("/settings?err=schedule");
  const profileId = Number(form.profile) || null;
  await db.addSchedule(c.env, { days, start_time: start, end_time: end, profile_id: profileId });
  await db.addAlert(c.env, "info", `Schedule added by ${c.get("user")}: days ${days}, ${start}–${end}.`);
  await db.audit(c.env, c.get("user"), "schedule.add", `days ${days}, ${start}–${end}`, null, { days, start_time: start, end_time: end, profile_id: profileId });
  return c.redirect("/settings?saved=1");
});

app.post("/settings/schedules/:id/toggle", async (c) => {
  const id = Number(c.req.param("id"));
  const r = (await db.listSchedules(c.env)).find((x) => x.id === id);
  if (r) await db.setScheduleEnabled(c.env, id, !r.enabled);
  if (r) await db.audit(c.env, c.get("user"), r.enabled ? "schedule.disable" : "schedule.enable", `days ${r.days}, ${r.start_time}–${r.end_time}`, r, { ...r, enabled: r.enabled ? 0 : 1 });
  return c.redirect("/settings?saved=1");
});

app.post("/settings/schedules/:id/delete", async (c) => {
  const gone = (await db.listSchedules(c.env)).find((x) => x.id === Number(c.req.param("id")));
  await db.deleteSchedule(c.env, Number(c.req.param("id")));
  if (gone) await db.audit(c.env, c.get("user"), "schedule.delete", `days ${gone.days}, ${gone.start_time}–${gone.end_time}`, gone, null);
  return c.redirect("/settings?saved=1");
});

app.post("/settings/release-lock", async (c) => {
  const held = await lockStatus(c.env);
  await releaseLock(c.env, undefined, true);
  await db.audit(c.env, c.get("user"), "lock.release", held.lock?.runId ?? "run lock", held, { held: false, lock: null });
  await db.addAlert(c.env, "info", `Run lock released by hand (${c.get("user")}).`);
  return c.redirect("/settings");
});

// ── Backups: export, restore (backup.ts) ──────────────────────────────────
// Download the dashboard's data as a file, fetch one of the nightly copies
// from R2, or put a file back. A restore is two steps: upload shows what the
// file holds next to what is here now; only typing "restore" replaces it.

app.get("/settings/backup/export", async (c) => {
  const exp = await buildExport(c.env);
  return c.body(JSON.stringify(exp, null, 1), 200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${exportFileName(exp.exported_at.slice(0, 10))}"`, "Cache-Control": "no-store" });
});

app.get("/settings/backup/config/:day", async (c) => {
  const day = c.req.param("day");
  const obj = /^\d{4}-\d{2}-\d{2}$/.test(day) ? await c.env.STATE.get(`config-backups/${day}.json`) : null;
  if (!obj) return c.text("That nightly export is no longer kept.", 404);
  return new Response(obj.body, { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${exportFileName(day)}"`, "Cache-Control": "no-store" } });
});

/** Why a restore must wait, or null. Swapping clients mid-deploy would muddle what the VM gets. */
async function restoreBlocked(env: Env): Promise<string | null> {
  const [run, lock, snap] = await Promise.all([db.activeRun(env), lockStatus(env), getSnapshot(env)]);
  if (run || lock.held || ["deploying", "destroying", "hibernating", "resuming"].includes(snap.state)) return "A run is in progress. Wait for it to finish, then restore.";
  return null;
}

app.post("/settings/backup/restore", async (c) => {
  const show = async (o: Omit<Parameters<typeof restoreBody>[0], "current">) => c.html(await render(c, "settings", "Restore", restoreBody({ ...o, current: await currentCounts(c.env) })));
  if (Number(c.req.header("Content-Length") ?? 0) > MAX_RESTORE_BYTES + 10_000) return show({ error: "That file is too big to be a wg-admin export." });
  const blocked = await restoreBlocked(c.env);
  if (blocked) return show({ error: blocked });
  const file = (await c.req.parseBody()).file;
  if (!(file instanceof File) || !file.size) return show({ error: "Choose a file first." });
  if (file.size > MAX_RESTORE_BYTES) return show({ error: "That file is too big to be a wg-admin export." });
  const plan = await checkRestoreFile(c.env, await file.text());
  if (typeof plan === "string") return show({ error: plan });
  // The checked file waits in KV for 15 minutes under a random name, so the
  // confirm step does not have to upload it again.
  const token = randomToken();
  await c.env.STATUS.put(`restore:${token}`, JSON.stringify(plan), { expirationTtl: 900 });
  return show({ plan, token, fileName: file.name });
});

app.post("/settings/backup/restore/confirm", async (c) => {
  const f = await c.req.parseBody();
  const token = String(f.token ?? "");
  const back = async (error: string, keep?: RestorePlan) => c.html(await render(c, "settings", "Restore", restoreBody({ error, current: await currentCounts(c.env), ...(keep ? { plan: keep, token } : {}) })));
  const plan = /^[0-9a-f]{64}$/.test(token) ? await c.env.STATUS.get<RestorePlan>(`restore:${token}`, "json") : null;
  if (!plan) return back("That upload has expired (they are kept 15 minutes). Choose the file again.");
  if (String(f.confirm ?? "").trim().toLowerCase() !== "restore") return back('Not restored: type "restore" to confirm.', plan);
  const blocked = await restoreBlocked(c.env);
  if (blocked) return back(blocked);
  try {
    await applyRestore(c.env, plan);
  } catch (e) {
    return back(`Nothing was changed: the database refused the file (${(e as Error).message}).`);
  }
  await c.env.STATUS.delete(`restore:${token}`);
  await db.audit(c.env, c.get("user"), "config.restore", "backup", null, { exported_at: plan.exported_at, counts: plan.counts });
  await db.addAlert(c.env, "info", `Dashboard data restored from an export of ${plan.exported_at} by ${c.get("user")}: ${plan.counts.peers} client(s), ${plan.counts.fw_rules} firewall rule(s).`);
  await syncPublished(c.env);
  return c.redirect("/settings?restored=1");
});

// ── Firewall ──────────────────────────────────────────────────────────────

/**
 * The Firewall page. Actions from the page itself (htmx) get just the page
 * section back, read in one parallel round of queries, so a toggle or a move
 * comes back fast; a plain visit gets the whole page.
 */
async function firewallPage(c: Context<App>, notice: { kind: "good" | "bad"; text: string } | null = null) {
  const [rules, peers, cfg, snap, forwards, captures] = await Promise.all([db.listFwRules(c.env), db.listPeers(c.env), effectiveConfig(c.env), getSnapshot(c.env), db.listForwards(c.env), db.listCaptures(c.env)]);
  const fw = await compileFirewall(rules, cfg, peers, cfg.firewallDefault, forwards);
  const body = firewallBody({ rules, peers, cfg, snap, hash: fw.hash, problems: fw.problems, notice, forwards, captures });
  if (c.req.header("HX-Request") && c.req.method === "POST") return c.html(body);
  return c.html(await render(c, "firewall", "Firewall", body));
}

// ── Published ports ──────────────────────────────────────────────────────

/** Keep Azure's edge in step with the published ports, while there is a VM. */
async function syncPublished(env: Env): Promise<string | null> {
  const snap = await getSnapshot(env);
  if (snap.state !== "running" && snap.state !== "standby") return null;
  try {
    await setPublishedPorts(env, publishedNsgRules(await db.listForwards(env), await effectiveConfig(env)));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

app.post("/firewall/forwards", async (c) => {
  const f = await c.req.parseBody();
  const cfg = await effectiveConfig(c.env);
  const name = String(f.name ?? "").trim().slice(0, 60);
  const proto = f.proto === "udp" ? "udp" : "tcp";
  const pub = Number(f.public_port), tport = Number(f.target_port || f.public_port);
  const target = String(f.target_ip ?? "").trim();
  const from = String(f.allow_from ?? "").trim();
  const fromC = from ? parseCidr(from) : null;
  const reserved = reservedPort(pub, cfg);
  const problem = !name
    ? "Give it a name."
    : !(pub >= 1 && pub <= 65535) || !(tport >= 1 && tport <= 65535)
      ? "Ports are 1 to 65535."
      : reserved
        ? `Port ${pub} is ${reserved}; pick another public port.`
        : !forwardTargetOk(target, cfg)
          ? `The target must be an address in the Azure VNet (${cfg.vnetCidr})${cfg.homeLanCidr ? ` or the home LAN (${cfg.homeLanCidr})` : ""}.`
          : from && (!fromC || fromC.family !== 4)
            ? "Allowed from must be an IPv4 address or network, or blank for anywhere."
            : null;
  if (problem) return firewallPage(c, { kind: "bad", text: `Not published: ${problem}` });
  try {
    await db.addForward(c.env, { name, proto, public_port: pub, target_ip: target, target_port: tport, allow_from: fromC?.text ?? "" });
  } catch {
    return firewallPage(c, { kind: "bad", text: `Not published: ${proto.toUpperCase()} ${pub} is already published.` });
  }
  await db.addAlert(c.env, "info", `Published ${proto.toUpperCase()} ${pub} to ${target}:${tport} (${name}) by ${c.get("user")}.`);
  await db.audit(c.env, c.get("user"), "firewall.forward.add", `${name} (${proto.toUpperCase()} ${pub})`, null, { name, proto, public_port: pub, target_ip: target, target_port: tport, allow_from: fromC?.text ?? "" });
  const err = await syncPublished(c.env);
  return firewallPage(c, err ? { kind: "bad", text: `Saved, but Azure did not open the port: ${err}` } : { kind: "good", text: `Published ${proto.toUpperCase()} ${pub} → ${target}:${tport}. It works within 30 seconds.` });
});

app.post("/firewall/forwards/:id/:op{toggle|delete}", async (c) => {
  const id = Number(c.req.param("id"));
  const f = (await db.listForwards(c.env)).find((x) => x.id === id);
  if (c.req.param("op") === "delete") await db.deleteForward(c.env, id);
  else if (f) await db.setForwardEnabled(c.env, id, !f.enabled);
  if (f) await db.audit(c.env, c.get("user"), c.req.param("op") === "delete" ? "firewall.forward.delete" : f.enabled ? "firewall.forward.disable" : "firewall.forward.enable", `${f.name} (${f.proto.toUpperCase()} ${f.public_port})`, f, c.req.param("op") === "delete" ? null : { ...f, enabled: f.enabled ? 0 : 1 });
  const err = await syncPublished(c.env);
  return firewallPage(c, err ? { kind: "bad", text: `Saved, but Azure did not update: ${err}` } : null);
});

// ── Packet capture ───────────────────────────────────────────────────────

app.post("/firewall/capture", async (c) => {
  const f = await c.req.parseBody();
  const who = String(f.who ?? "any");
  let filter = String(f.filter ?? "").trim();
  if (who.startsWith("client:")) {
    const p = await db.getPeer(c.env, Number(who.slice(7)));
    if (p) filter = filter ? `host ${p.ip} and (${filter})` : `host ${p.ip}`;
  }
  if (!validFilter(filter)) return firewallPage(c, { kind: "bad", text: "That filter has characters a capture filter never needs." });
  try {
    const msg = await startCapture(c.env, { iface: String(f.iface ?? "wg0"), filter, seconds: Number(f.seconds) || 60, by: c.get("user") });
    await db.audit(c.env, c.get("user"), "capture.start", String(f.iface ?? "wg0"), null, { iface: String(f.iface ?? "wg0"), filter, seconds: Number(f.seconds) || 60 });
    return firewallPage(c, { kind: "good", text: msg });
  } catch (e) {
    return firewallPage(c, { kind: "bad", text: e instanceof RunError ? e.message : (e as Error).message });
  }
});

app.get("/captures/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{16}$/.test(id)) return c.text("Not found", 404);
  const obj = await c.env.STATE.get(`captures/${id}.pcap.gz`);
  if (!obj) return c.text("That capture is no longer kept.", 404);
  return new Response(obj.body, { headers: { "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="wg-admin-capture-${id.slice(0, 8)}.pcap.gz"` } });
});

app.post("/firewall/clear", async (c) => {
  await clearFirewallCounters(c.env);
  await db.addAlert(c.env, "info", `Firewall hit counters cleared by ${c.get("user")}.`);
  await db.audit(c.env, c.get("user"), "firewall.counters.clear", "hit counters");
  return firewallPage(c, { kind: "good", text: "Counters cleared. Hits count from zero again." });
});

app.get("/firewall", (c) => firewallPage(c));

/** One end of a rule from the form: "any", "zone:home", "client:3", or "cidr" plus its text box. */
function parseEnd(v: unknown, cidr: unknown): { kind: EndKind; value: string } | string {
  const s = String(v ?? "any");
  if (s === "any") return { kind: "any", value: "" };
  if (s === "cidr") {
    const c = parseCidr(String(cidr ?? ""));
    return c ? { kind: "cidr", value: c.text } : `"${String(cidr ?? "")}" is not an address or network`;
  }
  const m = s.match(/^(zone|client):([a-z0-9]+)$/);
  return m ? { kind: m[1] as EndKind, value: m[2] } : "Pick where the traffic comes from and goes to.";
}

app.post("/firewall/rules", async (c) => {
  const f = await c.req.parseBody();
  const name = String(f.name ?? "").trim().slice(0, 60);
  const from = parseEnd(f.from, f.from_cidr);
  const to = parseEnd(f.to, f.to_cidr);
  const proto = (["tcp", "udp", "icmp", "any"].includes(String(f.proto)) ? String(f.proto) : "any") as Proto;
  const ports = proto === "tcp" || proto === "udp" ? String(f.ports ?? "").replace(/\s+/g, "") : "";
  const problem = !name ? "Give the rule a name." : typeof from === "string" ? from : typeof to === "string" ? to : parsePorts(ports) === null ? `"${ports}" is not a port list (try 8080, 80,443 or 8000-8100).` : null;
  if (problem || typeof from === "string" || typeof to === "string") return firewallPage(c, { kind: "bad", text: `Not added: ${problem}` });
  await db.addFwRule(c.env, { enabled: 1, name, src_kind: from.kind, src_value: from.value, dst_kind: to.kind, dst_value: to.value, proto, ports, action: f.action === "deny" ? "deny" : "allow", log: f.log ? 1 : 0 });
  await db.audit(c.env, c.get("user"), "firewall.rule.add", name, null, (await db.listFwRules(c.env)).at(-1));
  return firewallPage(c, { kind: "good", text: `Added "${name}". The VM picks it up within 30 seconds.` });
});

app.post("/firewall/rules/:id/:op{up|down|toggle|delete}", async (c) => {
  const id = Number(c.req.param("id"));
  const op = c.req.param("op");
  const was = await db.listFwRules(c.env);
  const r = was.find((x) => x.id === id);
  if (op === "up" || op === "down") await db.moveFwRule(c.env, id, op === "up" ? -1 : 1);
  else if (op === "delete") await db.deleteFwRule(c.env, id);
  else if (r) await db.updateFwRule(c.env, id, { enabled: r.enabled ? 0 : 1 });
  // Change log: the rule before and after, with its place in the list (1 = checked first).
  const after = (await db.listFwRules(c.env)).map((x, i) => ({ ...x, place: i + 1 })).find((x) => x.id === id) ?? null;
  if (r) await db.audit(c.env, c.get("user"), op === "toggle" ? (r.enabled ? "firewall.rule.disable" : "firewall.rule.enable") : op === "delete" ? "firewall.rule.delete" : "firewall.rule.move", r.name, { ...r, place: was.indexOf(r) + 1 }, after);
  return firewallPage(c);
});

app.post("/firewall/default", async (c) => {
  const f = await c.req.parseBody();
  const v = f.value === "allow" ? "allow" : "deny";
  const was = (await db.getSetting(c.env, "firewall_default")) ?? "deny";
  await db.setSetting(c.env, "firewall_default", v);
  await db.audit(c.env, c.get("user"), "firewall.default", "default rule", { firewall_default: was }, { firewall_default: v });
  await db.addAlert(c.env, "info", `Firewall default set to ${v} by ${c.get("user")}.`);
  return firewallPage(c, { kind: "good", text: `Default is now ${v}.` });
});

// "Allow this" on a recent drop: an allow rule for exactly that flow.
app.post("/firewall/allow-drop", async (c) => {
  const f = await c.req.parseBody();
  const src = parseCidr(String(f.src ?? "")), dst = parseCidr(String(f.dst ?? ""));
  if (!src || !dst) return firewallPage(c, { kind: "bad", text: "That drop has no usable addresses." });
  const peers = await db.listPeers(c.env);
  const client = peers.find((p) => `${p.ip}/32` === src.text);
  const proto = ({ TCP: "tcp", UDP: "udp", ICMP: "icmp", ICMPV6: "icmp" } as Record<string, Proto>)[String(f.proto ?? "").toUpperCase()] ?? "any";
  const port = /^\d{1,5}$/.test(String(f.dport ?? "")) && (proto === "tcp" || proto === "udp") ? String(f.dport) : "";
  const name = `Allow ${client?.name ?? src.text.replace(/\/(32|128)$/, "")} to ${dst.text.replace(/\/(32|128)$/, "")} ${proto === "any" ? "" : proto.toUpperCase()}${port ? ` ${port}` : ""}`.trim();
  await db.addFwRule(c.env, { enabled: 1, name, src_kind: client ? "client" : "cidr", src_value: client ? String(client.id) : src.text, dst_kind: "cidr", dst_value: dst.text, proto, ports: port, action: "allow", log: 0 });
  await db.audit(c.env, c.get("user"), "firewall.rule.add", name, null, (await db.listFwRules(c.env)).at(-1));
  return firewallPage(c, { kind: "good", text: `Added "${name}". It applies within 30 seconds.` });
});

app.get("/icon.svg", (c) =>
  c.body(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2457f5"/><circle cx="32" cy="32" r="9" fill="#fff"/><path d="M6 32h17M41 32h17" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>`, 200, { "Content-Type": "image/svg+xml" })
);

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
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runScheduled(env).then((notes) => {
        if (notes.length) console.log("watchman:", notes.join(" | "));
      })
    );
  },
};
