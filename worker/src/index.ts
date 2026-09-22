// index.ts
//
// Plain English: the front desk. Every request lands here and is routed to
// a screen or an action. Screens are server-rendered HTML; htmx swaps them
// in place so the page never fully reloads. Two API routes take bearer
// tokens instead of a login: the VM's heartbeat and GitHub's result
// callback. The cron entry point at the bottom is the night watchman.

import { Hono, type Context } from "hono";
import type { Env } from "./env";
import { config, missingSecrets, canDispatch } from "./env";
import { requireAccess, bearer, type AuthedVars } from "./auth";
import * as db from "./db";
import { getSnapshot } from "./state";
import { lockStatus, releaseLock } from "./lock";
import { serverPublicKey, nextFreeIp, clientConfigTemplate, validPeerName, isWgKey } from "./peers";
import { effectiveConfig, saveOverrides } from "./settings";
import { startDeploy, startDestroy, cancelActive, reconcile, extendAutoDestroy, refreshActiveRun, handleCallback, handleAgent, RunError } from "./runs";
import { runScheduled } from "./monitor";
import { page, type Tab } from "./views/layout";
import { liveSection } from "./views/dashboard";
import { peersBody, peersTable } from "./views/peers";
import { activityBody } from "./views/activity";
import { settingsBody } from "./views/settings";
import { costBody } from "./views/cost";

export { RunLock } from "./lock";

type App = { Bindings: Env; Variables: AuthedVars };
const app = new Hono<App>();

// ── Token-authenticated API (no Cloudflare Access) ─────────────────────────

const rateBuckets = new Map<string, { n: number; reset: number }>();
function rateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || b.reset < now) {
    rateBuckets.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  b.n++;
  return b.n > limit;
}

app.post("/api/callback", async (c) => {
  if (rateLimited("callback", 30, 60_000)) return c.json({ error: "slow down" }, 429);
  const body = await c.req.json().catch(() => null);
  const r = await handleCallback(c.env, bearer(c), body);
  return c.json({ message: r.message }, r.status as 200);
});

app.post("/api/agent", async (c) => {
  if (rateLimited("agent", 10, 60_000)) return c.json({ error: "slow down" }, 429);
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "bad json" }, 400);
  const r = await handleAgent(c.env, bearer(c), body);
  return c.json(r.body as object, r.status as 200);
});

app.get("/manifest.webmanifest", (c) =>
  c.json(
    {
      name: "wg-admin",
      short_name: "wg-admin",
      start_url: "/",
      display: "standalone",
      background_color: "#eef2f6",
      theme_color: "#2457f5",
      icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
    },
    200,
    { "Content-Type": "application/manifest+json" }
  )
);

// ── Everything below requires Cloudflare Access ───────────────────────────

app.use("*", requireAccess);

async function render(c: { env: Env; get: (k: "user") => string }, tab: Tab, title: string, body: Parameters<typeof page>[0]["body"], notice?: Parameters<typeof page>[0]["notice"]) {
  const [snapshot, alerts] = await Promise.all([getSnapshot(c.env), db.unacknowledgedAlerts(c.env)]);
  return page({ title, tab, user: c.get("user"), snapshot, body, missing: missingSecrets(c.env), alerts, notice });
}

async function live(env: Env, notice?: { kind: "good" | "warn" | "bad" | "info"; text: string } | null) {
  const [snap, cfg, peers, lock, deployment, serverPub] = await Promise.all([
    getSnapshot(env),
    effectiveConfig(env),
    db.enabledPeers(env),
    lockStatus(env),
    db.currentDeployment(env),
    serverPublicKey(env),
  ]);
  return liveSection({
    snap,
    cfg,
    peerCount: peers.length,
    canDispatch: canDispatch(env),
    notice,
    lockHolder: lock.held && !["deploying", "destroying"].includes(snap.state) ? lock.lock?.runId ?? null : null,
    deployment,
    serverPub,
  });
}

app.get("/", async (c) => {
  await refreshActiveRun(c.env).catch(() => {});
  return c.html(await render(c, "dashboard", "Overview", await live(c.env)));
});

app.get("/partials/live", async (c) => {
  await refreshActiveRun(c.env).catch(() => {});
  return c.html(await live(c.env));
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
  if (c.req.header("HX-Request")) return c.html(await live(c.env, notice));
  return c.redirect("/");
}

app.post("/actions/deploy", async (c) => {
  const form = await c.req.parseBody();
  const hours = Number(form.hours);
  const user = c.get("user");
  return action(c, async () => {
    const run = await startDeploy(c.env, { hours: hours > 0 ? hours : null, requesterIp: ip(c), requestedBy: user });
    return `Deploy started (${run.id}). About 4 minutes.`;
  });
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

app.post("/alerts/ack", async (c) => {
  await db.acknowledgeAlerts(c.env);
  return c.redirect("/");
});

// ── Clients ────────────────────────────────────────────────────────────────

app.get("/peers", async (c) => {
  const [peers, snap, cfg, serverPub] = await Promise.all([db.listPeers(c.env), getSnapshot(c.env), effectiveConfig(c.env), serverPublicKey(c.env)]);
  const nextIp = nextFreeIp(cfg.subnet, peers.map((p) => p.ip));
  return c.html(await render(c, "peers", "Clients", peersBody({ peers, report: snap.agent, running: snap.state === "running", cfg, serverPub, nextIp })));
});

app.get("/partials/peers-table", async (c) => {
  const [peers, snap] = await Promise.all([db.listPeers(c.env), getSnapshot(c.env)]);
  return c.html(peersTable(peers, snap.agent, snap.state === "running"));
});

app.post("/api/peers", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: string; public_key?: string; full_tunnel?: boolean } | null;
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
    peer = await db.addPeer(c.env, { name, public_key: String(body.public_key), ip: ipAddr, full_tunnel: !!body.full_tunnel });
  } catch (e) {
    return c.json({ error: /UNIQUE/.test(String(e)) ? "That key is already registered." : (e as Error).message }, 409);
  }
  return c.json({ peer, template: clientConfigTemplate(c.env, peer, serverPub) });
});

app.post("/peers/:id/toggle", async (c) => {
  const id = Number(c.req.param("id"));
  const p = await db.getPeer(c.env, id);
  if (p) await db.setPeerEnabled(c.env, id, !p.enabled);
  const [peers, snap] = await Promise.all([db.listPeers(c.env), getSnapshot(c.env)]);
  return c.req.header("HX-Request") ? c.html(peersTable(peers, snap.agent, snap.state === "running")) : c.redirect("/peers");
});

app.post("/peers/:id/delete", async (c) => {
  await db.deletePeer(c.env, Number(c.req.param("id")));
  const [peers, snap] = await Promise.all([db.listPeers(c.env), getSnapshot(c.env)]);
  return c.req.header("HX-Request") ? c.html(peersTable(peers, snap.agent, snap.state === "running")) : c.redirect("/peers");
});

// ── Activity, cost, settings ───────────────────────────────────────────────

app.get("/activity", async (c) => {
  const [runs, alerts, cfg] = await Promise.all([db.listRuns(c.env, 100), db.listAlerts(c.env, 100), effectiveConfig(c.env)]);
  return c.html(await render(c, "activity", "Activity", activityBody({ runs, alerts, cfg })));
});

app.get("/cost", async (c) => {
  const monthStart = new Date().toISOString().slice(0, 8) + "01";
  const [snap, days, runs, cfg, fetchedDay] = await Promise.all([getSnapshot(c.env), db.costDays(c.env, monthStart), db.listRuns(c.env, 200), effectiveConfig(c.env), c.env.STATUS.get("cost:fetched_day")]);
  return c.html(await render(c, "cost", "Cost", costBody({ snap, days, runs, cfg, fetchedDay })));
});

app.get("/settings", async (c) => {
  const [cfg, overrides, lock, serverPub] = await Promise.all([effectiveConfig(c.env), db.allSettings(c.env), lockStatus(c.env), serverPublicKey(c.env)]);
  const saved = c.req.query("saved") === "1";
  return c.html(
    await render(c, "settings", "Settings", settingsBody({ cfg, overrides, missing: missingSecrets(c.env), lock, serverPub, saved, repo: c.env.GITHUB_REPO ?? null, webhook: !!c.env.NOTIFY_WEBHOOK_URL }))
  );
});

app.post("/settings", async (c) => {
  const form = (await c.req.parseBody()) as Record<string, string>;
  const rejected = await saveOverrides(c.env, form);
  if (rejected.length) {
    const [cfg, overrides, lock, serverPub] = await Promise.all([effectiveConfig(c.env), db.allSettings(c.env), lockStatus(c.env), serverPublicKey(c.env)]);
    return c.html(
      await render(c, "settings", "Settings", settingsBody({ cfg, overrides, missing: missingSecrets(c.env), lock, serverPub, repo: c.env.GITHUB_REPO ?? null, webhook: !!c.env.NOTIFY_WEBHOOK_URL }), {
        kind: "bad",
        text: `Not saved: ${rejected.join(", ")} did not look right.`,
      })
    );
  }
  return c.redirect("/settings?saved=1");
});

app.post("/settings/release-lock", async (c) => {
  await releaseLock(c.env, undefined, true);
  await db.addAlert(c.env, "info", `Run lock released by hand (${c.get("user")}).`);
  return c.redirect("/settings");
});

app.get("/icon.svg", (c) =>
  c.body(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2457f5"/><circle cx="32" cy="32" r="9" fill="#fff"/><path d="M6 32h17M41 32h17" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>`, 200, { "Content-Type": "image/svg+xml" })
);

app.get("/health", async (c) => {
  const snap = await getSnapshot(c.env);
  return c.json({ state: snap.state, public_ip: snap.public_ip, updated_at: snap.updated_at, config: config(c.env).dnsName });
});

app.notFound((c) => c.text("Not found", 404));
app.onError((err, c) => c.text(`Something broke: ${err.message}`, 500));

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
