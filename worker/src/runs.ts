// runs.ts
//
// Plain English: the change-control desk. A deploy or destroy is a "run":
// take the lock, write a ticket (a row in D1), mint two one-time tokens (one
// for the VM's heartbeat, one for GitHub's result callback), press the
// workflow button, then keep the status snapshot honest as events arrive:
// GitHub step progress, the result callback, the VM's first heartbeat.
//
// Nothing here trusts a previous guess. refreshActiveRun() re-reads GitHub
// each time, and the cron re-checks Azure, so a missed callback heals.

import type { Env } from "./env";
import { config, canDispatch } from "./env";
import { effectiveConfig } from "./settings";
import * as db from "./db";
import { acquireLock, releaseLock } from "./lock";
import { randomToken, sha256Hex, safeEqual } from "./auth";
import { dispatchWorkflow, findRunByTitle, getGhRun, getJobs, getJobLogTail, cancelGhRun, stepsFromJobs } from "./github";
import { getSnapshot, saveSnapshot, parseWgDump, nextTraffic, type AgentReport } from "./state";
import { checkDns } from "./dns";
import { agentPeerList, terraformPeerList } from "./peers";
import { notify } from "./notify";
import { azureView, azureInventory } from "./azure";
import { canAzure } from "./env";

export class RunError extends Error {}

/** Re-read what exists in Azure and store it in the snapshot. Never throws. */
export async function refreshInventory(env: Env): Promise<void> {
  if (!canAzure(env)) return;
  try {
    const azure = await azureInventory(env);
    const snap = await saveSnapshot(env, { azure });
    // Self-heal: if we are Running but lost the public IP (the old KV race),
    // take it from Azure and re-check DNS against it.
    if (snap.state === "running" && !snap.public_ip) {
      const ip = azure.resources.find((r) => r.kind === "Public IP")?.detail.split(",")[0]?.trim();
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        const dns = await checkDns(env, ip);
        await saveSnapshot(env, { public_ip: ip, dns_ip: dns.resolver, dns_live: dns.live });
      }
    }
  } catch {
    /* the panel just shows the last good check */
  }
}

function newRunId(action: string): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${action}-${stamp}-${randomToken().slice(0, 6)}`;
}

export interface DeployOptions {
  hours: number | null; // null = indefinite
  requesterIp: string | null;
  requestedBy: string;
  reason?: string;
}

/** Start a deploy. Throws RunError with a message fit for the screen. */
export async function startDeploy(env: Env, opts: DeployOptions): Promise<db.Run> {
  if (!canDispatch(env)) throw new RunError("GitHub is not connected yet. Add GITHUB_TOKEN and GITHUB_REPO in Settings > Setup.");
  const snap = await getSnapshot(env);
  if (snap.state === "running") throw new RunError("Already running. Tear it down first if you want a rebuild.");
  if (snap.state === "deploying" || snap.state === "destroying") throw new RunError("A run is already in progress.");

  const cfg = await effectiveConfig(env);
  const id = newRunId("apply");
  const lock = await acquireLock(env, id);
  if (!lock.ok) throw new RunError(`Another run holds the lock (${lock.holder?.runId}). Wait for it or release it in Settings.`);

  const agentToken = randomToken();
  const callbackToken = randomToken();
  const peers = terraformPeerList(await db.enabledPeers(env));
  const sshCidr = cfg.sshAllowedCidr || (opts.requesterIp && !opts.requesterIp.includes(":") ? `${opts.requesterIp}/32` : "");
  const auto_destroy_at = opts.hours ? new Date(Date.now() + opts.hours * 3_600_000).toISOString() : null;

  const payload = {
    run_id: id,
    region: cfg.region,
    vm_size: cfg.vmSize,
    peers_json: JSON.stringify(peers),
    home_lan_cidr: cfg.homeLanCidr,
    ssh_allowed_cidr: sshCidr,
    wg_dns_name: cfg.dnsName,
    wg_port: cfg.port,
    wg_subnet: cfg.subnet,
    loopback_ip: cfg.loopbackIp,
    vnet_cidr: cfg.vnetCidr,
    agent_url: `${cfg.publicUrl}/api/agent`,
    agent_token: agentToken,
    callback_url: `${cfg.publicUrl}/api/callback`,
    callback_token: callbackToken,
  };
  const safePayload = { ...payload, agent_token: "(hidden)", callback_token: "(hidden)" };

  const now = new Date().toISOString();
  await db.createRun(env, {
    id,
    action: "apply",
    status: "queued",
    requested_at: now,
    requested_by: opts.requestedBy,
    callback_token_hash: await sha256Hex(callbackToken),
    agent_token_hash: await sha256Hex(agentToken),
    payload_json: JSON.stringify(safePayload),
    auto_destroy_at,
    reason: opts.reason ?? null,
  });

  try {
    await dispatchWorkflow(env, "apply", payload);
  } catch (e) {
    await db.updateRun(env, id, { status: "failure", finished_at: new Date().toISOString(), error: (e as Error).message });
    await releaseLock(env, id);
    throw new RunError((e as Error).message);
  }

  await saveSnapshot(env, {
    state: "deploying",
    run_id: id,
    action: "apply",
    since: now,
    running_since: null,
    public_ip: null,
    dns_ip: null,
    dns_live: false,
    auto_destroy_at,
    last_agent_at: null,
    agent: null,
    drift: null,
    github_run_url: null,
    steps: [],
    log_tail: null,
    error: null,
  });
  return (await db.getRun(env, id))!;
}

/** Start a destroy. Works from Running, Failed, or a drifted Destroyed. */
export async function startDestroy(env: Env, requestedBy: string, reason?: string): Promise<db.Run> {
  if (!canDispatch(env)) throw new RunError("GitHub is not connected yet. Add GITHUB_TOKEN and GITHUB_REPO in Settings > Setup.");
  const snap = await getSnapshot(env);
  if (snap.state === "deploying" || snap.state === "destroying") throw new RunError("A run is already in progress.");

  const cfg = config(env);
  const id = newRunId("destroy");
  const lock = await acquireLock(env, id);
  if (!lock.ok) throw new RunError(`Another run holds the lock (${lock.holder?.runId}). Wait for it or release it in Settings.`);

  const callbackToken = randomToken();
  const payload = {
    run_id: id,
    wg_dns_name: cfg.dnsName,
    callback_url: `${cfg.publicUrl}/api/callback`,
    callback_token: callbackToken,
  };
  const now = new Date().toISOString();
  await db.createRun(env, {
    id,
    action: "destroy",
    status: "queued",
    requested_at: now,
    requested_by: requestedBy,
    callback_token_hash: await sha256Hex(callbackToken),
    agent_token_hash: null,
    payload_json: JSON.stringify({ ...payload, callback_token: "(hidden)" }),
    auto_destroy_at: null,
    reason: reason ?? null,
  });

  try {
    await dispatchWorkflow(env, "destroy", payload);
  } catch (e) {
    await db.updateRun(env, id, { status: "failure", finished_at: new Date().toISOString(), error: (e as Error).message });
    await releaseLock(env, id);
    throw new RunError((e as Error).message);
  }

  await saveSnapshot(env, { state: "destroying", run_id: id, action: "destroy", since: now, github_run_url: null, steps: [], log_tail: null, error: null, drift: null });
  return (await db.getRun(env, id))!;
}

/**
 * Re-read GitHub for the active run and update the snapshot. Called by the
 * dashboard's polling and by the cron. Cheap when nothing is active.
 */
export async function refreshActiveRun(env: Env): Promise<void> {
  const run = await db.activeRun(env);
  if (!run || !canDispatch(env)) return;

  let ghId = run.github_run_id;
  if (!ghId) {
    const found = await findRunByTitle(env, run.id);
    if (!found) {
      // Not visible yet. Give GitHub 3 minutes, then give up.
      if (Date.now() - Date.parse(run.requested_at) > 3 * 60_000) {
        await failRun(env, run, "GitHub never started the workflow. Check the Actions tab and the GITHUB_TOKEN permissions.");
      }
      return;
    }
    ghId = found.id;
    await db.updateRun(env, run.id, { github_run_id: found.id, github_run_url: found.html_url, status: "running", started_at: found.created_at });
    await saveSnapshot(env, { github_run_url: found.html_url });
  }

  const [gh, jobs] = await Promise.all([getGhRun(env, ghId), getJobs(env, ghId)]);
  const steps = stepsFromJobs(jobs);
  let log_tail: string | null = null;
  if (jobs[0]) log_tail = await getJobLogTail(env, jobs[0].id).catch(() => null);
  await saveSnapshot(env, { steps, log_tail, github_run_url: gh?.html_url ?? run.github_run_url });

  if (gh && gh.status === "completed") {
    if (gh.conclusion === "success") {
      // The callback normally lands first. If it has not after 2 minutes, settle from what we know.
      const fresh = await db.getRun(env, run.id);
      if (fresh && fresh.status !== "success" && Date.now() - Date.parse(gh.created_at) > 0) {
        await settleWithoutCallback(env, fresh);
      }
    } else {
      await failRun(env, run, `GitHub run finished with "${gh.conclusion}".`);
    }
  }
}

async function settleWithoutCallback(env: Env, run: db.Run): Promise<void> {
  // Only settle if GitHub says success AND the callback is overdue by 2 min.
  if (run.finished_at) return;
  const snap = await getSnapshot(env);
  if (run.action === "destroy") {
    await completeDestroy(env, run, { via: "github-status" });
  } else {
    let ip: string | null = null;
    if (canAzure(env)) ip = (await azureView(env)).public_ip;
    if (!ip && snap.public_ip) ip = snap.public_ip;
    await completeApply(env, run, ip, {}, { via: "github-status" });
  }
}

async function failRun(env: Env, run: db.Run, message: string): Promise<void> {
  await db.updateRun(env, run.id, { status: "failure", finished_at: new Date().toISOString(), error: message });
  await releaseLock(env, run.id);
  await saveSnapshot(env, { state: "failed", error: message, since: new Date().toISOString() });
  await db.addAlert(env, "failure", `${run.action} failed: ${message}`, run.id);
  await notify(env, `wg-admin: ${run.action} failed`, message);
}

async function completeApply(env: Env, run: db.Run, publicIp: string | null, outputs: Record<string, unknown>, meta: { via: string }): Promise<void> {
  const now = new Date().toISOString();
  await db.updateRun(env, run.id, { status: "success", finished_at: now, public_ip: publicIp, outputs_json: JSON.stringify(outputs) });
  await releaseLock(env, run.id);
  const dns = await checkDns(env, publicIp);
  await saveSnapshot(env, {
    state: "running",
    since: now,
    running_since: now,
    public_ip: publicIp,
    dns_ip: dns.resolver,
    dns_live: dns.live,
    auto_destroy_at: run.auto_destroy_at,
    error: null,
    drift: null,
    log_tail: null,
  });
  await refreshInventory(env);
  const cfg = config(env);
  await db.addAlert(env, "deploy", `Deployed at ${publicIp ?? "unknown IP"} (${meta.via}); ${cfg.dnsName} ${dns.live ? "is live" : "not live yet"}`, run.id);
  await notify(env, "wg-admin: running", `${cfg.dnsName} → ${publicIp ?? "?"}${run.auto_destroy_at ? `, auto-destroy at ${run.auto_destroy_at}` : ""}`);
}

async function completeDestroy(env: Env, run: db.Run, meta: { via: string }): Promise<void> {
  const now = new Date().toISOString();
  await db.updateRun(env, run.id, { status: "success", finished_at: now });
  await releaseLock(env, run.id);
  const dns = await checkDns(env, null);
  await saveSnapshot(env, {
    state: "destroyed",
    since: now,
    running_since: null,
    public_ip: null,
    dns_ip: dns.resolver,
    dns_live: false,
    auto_destroy_at: null,
    last_agent_at: null,
    agent: null,
    traffic: null,
    error: null,
    drift: null,
    steps: [],
    log_tail: null,
  });
  await db.addAlert(env, "destroy", `Torn down (${meta.via}). Azure cost is now £0.`, run.id);
  await notify(env, "wg-admin: destroyed", "Everything removed. Azure cost is £0.");
}

/** GitHub Actions result callback. Returns an HTTP status and message. */
export async function handleCallback(env: Env, token: string, body: CallbackBody): Promise<{ status: number; message: string }> {
  if (!token || !body?.run_id) return { status: 400, message: "missing token or run_id" };
  const run = await db.getRun(env, body.run_id);
  if (!run || !run.callback_token_hash) return { status: 404, message: "unknown run" };
  if (!safeEqual(await sha256Hex(token), run.callback_token_hash)) return { status: 401, message: "bad token" };
  if (run.finished_at) return { status: 200, message: "already settled" };

  await db.updateRun(env, run.id, { github_run_url: body.github_run_url ?? run.github_run_url, github_run_id: body.github_run_id ? Number(body.github_run_id) : run.github_run_id });

  const ok = body.status === "success" || body.status === "success-with-fallback";
  if (!ok) {
    await failRun(env, run, `Workflow reported "${body.status}". See the GitHub log.`);
    return { status: 200, message: "recorded failure" };
  }
  if (run.action === "apply") {
    const ip = (body.outputs?.public_ip as string | undefined) ?? null;
    await completeApply(env, run, ip, body.outputs ?? {}, { via: "callback" });
  } else {
    await completeDestroy(env, run, { via: body.status === "success-with-fallback" ? "callback, fallback cleanup used" : "callback" });
  }
  return { status: 200, message: "ok" };
}

export interface CallbackBody {
  run_id: string;
  action: string;
  status: string;
  github_run_id?: string | number;
  github_run_url?: string;
  outputs?: Record<string, unknown>;
}

export interface AgentBody {
  agent_version?: number;
  hostname?: string;
  uptime_seconds?: number;
  load?: string;
  loopback?: string;
  dump?: string;
}

/** VM heartbeat. Verifies the per-deploy token, stores the report, returns the desired peer list. */
export async function handleAgent(env: Env, token: string, body: AgentBody): Promise<{ status: number; body: unknown }> {
  if (!token) return { status: 401, body: { error: "no token" } };
  const hash = await sha256Hex(token);
  // The token belongs to the most recent apply (running or still deploying).
  const run = await env.DB.prepare("SELECT * FROM runs WHERE action = 'apply' AND agent_token_hash = ?1 ORDER BY requested_at DESC LIMIT 1").bind(hash).first<db.Run>();
  if (!run) return { status: 401, body: { error: "unknown token" } };
  const latestApply = await env.DB.prepare("SELECT id FROM runs WHERE action = 'apply' ORDER BY requested_at DESC LIMIT 1").first<{ id: string }>();
  if (latestApply && latestApply.id !== run.id) return { status: 410, body: { error: "token from an older deployment" } };

  const parsed = parseWgDump(body.dump ?? "");
  const report: AgentReport = {
    at: new Date().toISOString(),
    hostname: body.hostname ?? "",
    uptime_seconds: Number(body.uptime_seconds) || 0,
    load: body.load ?? "",
    listen_port: parsed.listen_port,
    server_public_key: parsed.server_public_key,
    loopback: body.loopback ? String(body.loopback) : null,
    peers: parsed.peers,
  };
  const snap = await getSnapshot(env);
  const patch: Partial<typeof snap> = { last_agent_at: report.at, agent: report, traffic: nextTraffic(snap.traffic, report) };
  // First heartbeat while still "deploying" (callback not yet in) is proof of life.
  if (snap.state === "deploying" && snap.run_id === run.id) {
    patch.state = "running";
    patch.since = report.at;
    patch.running_since = report.at;
  }
  await saveSnapshot(env, patch);

  const peers = agentPeerList(await db.enabledPeers(env));
  return { status: 200, body: { peers } };
}

/** Cancel the active GitHub run and mark it failed. */
export async function cancelActive(env: Env): Promise<string> {
  const run = await db.activeRun(env);
  if (!run) return "Nothing to cancel.";
  if (run.github_run_id) await cancelGhRun(env, run.github_run_id);
  await failRun(env, run, "Cancelled from the dashboard.");
  return "Cancelled. Use Clean up to make sure Azure is empty.";
}

/** Compare our snapshot with Azure. Returns a drift description or null. */
export async function detectDrift(env: Env): Promise<string | null> {
  if (!canAzure(env)) return null;
  const snap = await getSnapshot(env);
  if (snap.state === "deploying" || snap.state === "destroying") return null;
  const az = await azureView(env);
  if (az.error) return null; // unknown, not drift
  let drift: string | null = null;
  if (snap.state === "destroyed" && az.rg_exists) drift = `Azure still has resource group ${config(env).resourceGroup} but the dashboard says Destroyed. That VM is costing money.`;
  if (snap.state === "running" && !az.rg_exists) drift = "The dashboard says Running but Azure has no resource group. Something deleted it outside this app.";
  if (snap.state === "running" && az.rg_exists && az.power && az.power !== "running") drift = `The VM exists but its power state is "${az.power}".`;
  if (snap.state === "running" && az.public_ip && snap.public_ip && az.public_ip !== snap.public_ip) drift = `Azure's public IP ${az.public_ip} differs from the recorded ${snap.public_ip}.`;
  if (drift !== snap.drift) await saveSnapshot(env, { drift });
  return drift;
}

/** Reconcile: destroy anything Azure has if we think we are Destroyed; or accept Destroyed if Azure is empty. */
export async function reconcile(env: Env, requestedBy: string): Promise<string> {
  await refreshInventory(env);
  const snap = await getSnapshot(env);
  const az = canAzure(env) ? await azureView(env) : null;
  if (!az || az.error) return "Cannot reach Azure to reconcile.";
  if (az.rg_exists && (snap.state === "destroyed" || snap.state === "failed")) {
    await startDestroy(env, requestedBy, "reconcile: Azure had resources");
    return "Azure still had resources. A tear-down has been started.";
  }
  if (!az.rg_exists && snap.state !== "destroyed") {
    const run = await db.activeRun(env);
    if (run) await db.updateRun(env, run.id, { status: "cancelled", finished_at: new Date().toISOString(), error: "reconciled: Azure empty" });
    await releaseLock(env, undefined, true);
    await saveSnapshot(env, { state: "destroyed", since: new Date().toISOString(), public_ip: null, dns_ip: null, dns_live: false, auto_destroy_at: null, agent: null, last_agent_at: null, drift: null, error: null, steps: [], log_tail: null, running_since: null });
    return "Azure is empty. State set to Destroyed.";
  }
  await saveSnapshot(env, { drift: null });
  return "Azure and the dashboard agree. Nothing to do.";
}

/** Move the auto-destroy deadline. hours = null clears it. */
export async function extendAutoDestroy(env: Env, hours: number | null): Promise<string | null> {
  const snap = await getSnapshot(env);
  const at = hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : null;
  await saveSnapshot(env, { auto_destroy_at: at });
  const dep = await db.currentDeployment(env);
  if (dep) await db.updateRun(env, dep.id, { auto_destroy_at: at });
  return at;
}
