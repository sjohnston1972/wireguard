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
import { getSnapshot, saveSnapshot, parseWgDump, nextTraffic, nextLatency, detectRoams, nextSession, selfTestFailures, nextTalkers, type AgentReport, type Snapshot, type SelfTest } from "./state";
import { checkDns } from "./dns";
import { agentPeerList, terraformPeerList } from "./peers";
import { notify } from "./notify";
import { dashboardButton } from "./actions";
import { bytesText } from "./format";
import { compileFirewall } from "./firewall";
import type { FirewallStatus } from "./state";
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

/** A password a person can read out: 4 groups of 5 from an unambiguous alphabet. */
function readablePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  const chars = [...b].map((x) => alphabet[x % alphabet.length]);
  return `${chars.slice(0, 5).join("")}-${chars.slice(5, 10).join("")}-${chars.slice(10, 15).join("")}-${chars.slice(15, 20).join("")}`;
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
  region?: string;
  vmSize?: string;
  profile?: string | null;
}

/** Start a deploy. Throws RunError with a message fit for the screen. */
export async function startDeploy(env: Env, opts: DeployOptions): Promise<db.Run> {
  if (!canDispatch(env)) throw new RunError("GitHub is not connected yet. Add GITHUB_TOKEN and GITHUB_REPO in Settings > Setup.");
  const snap = await getSnapshot(env);
  if (snap.state === "running") throw new RunError("Already running. Tear it down first if you want a rebuild.");
  if (snap.state === "standby") throw new RunError("The VM is in Standby. Resume it instead (about a minute), or tear it down first.");
  if (isBusyState(snap.state)) throw new RunError("A run is already in progress.");

  const cfg = await effectiveConfig(env);
  // Read what the payload needs before taking the lock, so a database hiccup
  // here cannot leave the lock held with no run behind it.
  const peers = terraformPeerList(await db.enabledPeers(env));
  const publishedPorts = [...new Set((await db.listForwards(env)).filter((f) => f.enabled).map((f) => String(f.public_port)))];
  const id = newRunId("apply");
  const lock = await acquireLock(env, id);
  if (!lock.ok) throw new RunError(`Another run holds the lock (${lock.holder?.runId}). Wait for it or release it in Settings.`);

  // The per-run secrets (SSH password, heartbeat and callback tokens, and the
  // SSH allow-list, which is Steven's home address) are NOT in the dispatch
  // payload: the repo is public and so is its log. The workflow proves who it
  // is with a GitHub OIDC token and collects them from /api/callback/secrets.
  const sshPassword = readablePassword();
  const sshCidr = cfg.sshAllowedCidr || (opts.requesterIp && !opts.requesterIp.includes(":") ? `${opts.requesterIp}/32` : "");
  const auto_destroy_at = opts.hours ? new Date(Date.now() + opts.hours * 3_600_000).toISOString() : null;
  const region = opts.region ?? cfg.region;
  const vmSize = opts.vmSize ?? cfg.vmSize;

  const payload = {
    run_id: id,
    region,
    vm_size: vmSize,
    peers_json: JSON.stringify(peers),
    home_lan_cidr: cfg.homeLanCidr,
    wg_dns_name: cfg.dnsName,
    wg_port: cfg.port,
    wg_subnet: cfg.subnet,
    wg_subnet6: cfg.subnet6,
    loopback_ip: cfg.loopbackIp,
    vnet_cidr: cfg.vnetCidr,
    workload_subnet_cidr: cfg.workloadCidr,
    test_vm: cfg.testVm,
    published_ports: publishedPorts,
    agent_url: `${cfg.publicUrl}/api/agent`,
    callback_url: `${cfg.publicUrl}/api/callback`,
    secrets_url: `${cfg.publicUrl}/api/callback/secrets`,
  };

  const now = new Date().toISOString();
  try {
    await db.createRun(env, {
      id,
      action: "apply",
      status: "queued",
      requested_at: now,
      requested_by: opts.requestedBy,
      callback_token_hash: null,
      agent_token_hash: null,
      // Kept in D1 (private) with the allow-list, for the dashboard's panels.
      payload_json: JSON.stringify({ ...payload, ssh_allowed_cidr: sshCidr }),
      auto_destroy_at,
      reason: opts.reason ?? null,
      ssh_password: sshPassword,
    });
  } catch (e) {
    await releaseLock(env, id); // no run was recorded, so nothing else would free it
    throw e;
  }

  try {
    await dispatchWorkflow(env, "apply", payload);
  } catch (e) {
    try {
      await db.updateRun(env, id, { status: "failure", finished_at: new Date().toISOString(), error: (e as Error).message });
    } finally {
      await releaseLock(env, id);
    }
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
    selftest: null,
    latency: {},
    roams: {},
    session: null,
    standby_since: null,
    power_op_at: null,
    region,
    vm_size: vmSize,
    profile: opts.profile ?? null,
    pending_deploy: null,
    speedtest_req: null,
    talkers: {},
    traffic_hist: [],
    capture_req: null,
  });
  // A capture left over from the previous VM will never arrive; say so.
  if (snap.capture_req) await db.failPendingCapture(env, snap.capture_req.id, "VM torn down");
  return (await db.getRun(env, id))!;
}

/** The rule table as it stands, compiled for the VM. */
export async function currentFirewall(env: Env) {
  const [rules, peers, cfg, forwards] = await Promise.all([db.listFwRules(env), db.listPeers(env), effectiveConfig(env), db.listForwards(env)]);
  return compileFirewall(rules, cfg, peers, cfg.firewallDefault, forwards);
}

/** Add one set of counters into another: [packets, bytes] per key. */
export function addCounters(a: Record<string, [number, number]>, b: Record<string, [number, number]> | undefined): Record<string, [number, number]> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = [(out[k]?.[0] ?? 0) + v[0], (out[k]?.[1] ?? 0) + v[1]];
  return out;
}

/**
 * The VM's counters restart whenever a rule set is loaded or the VM reboots.
 * Whatever the previous reading had counted, for any counter that went
 * backwards or vanished (or all of them, on a new rule set), moves into the
 * carried-over totals, so hits keep adding up.
 */
export function nextBase(base: Record<string, [number, number]>, prev: FirewallStatus | null, counters: Record<string, [number, number]>, sameSet: boolean): Record<string, [number, number]> {
  const out = { ...base };
  for (const [k, v] of Object.entries(prev?.counters ?? {})) {
    const now = counters[k];
    if (!sameSet || !now || now[0] < v[0]) out[k] = [(out[k]?.[0] ?? 0) + v[0], (out[k]?.[1] ?? 0) + v[1]];
  }
  return out;
}

/** Fold a heartbeat's firewall report into the status: hits, when each rule last matched, recent drops. */
export function nextFirewall(prev: FirewallStatus | null, rep: { hash?: string; error?: string | null; counters?: Record<string, [number, number]>; drops?: unknown[] } | null | undefined, at: string): FirewallStatus | null {
  if (!rep) return prev;
  const counters = rep.counters && typeof rep.counters === "object" ? rep.counters : {};
  const sameSet = prev?.applied_hash === (rep.hash || null);
  const last_hit: Record<string, string> = { ...(prev?.last_hit ?? {}) };
  for (const [k, v] of Object.entries(counters)) {
    const was = prev?.counters[k]?.[0] ?? 0;
    const before = sameSet && Number(v[0]) >= was ? was : 0;
    if (Array.isArray(v) && Number(v[0]) > before) last_hit[k] = at;
  }
  const fresh = (Array.isArray(rep.drops) ? rep.drops : [])
    .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
    .map((d) => ({ at, src: String(d.src ?? ""), dst: String(d.dst ?? ""), proto: String(d.proto ?? ""), dport: typeof d.dport === "number" ? d.dport : null, in: String(d.in ?? ""), out: String(d.out ?? "") }))
    .reverse();
  return {
    applied_hash: rep.hash || null,
    error: rep.error || null,
    counters,
    counters_at: at,
    last_hit,
    drops: fresh.concat(prev?.drops ?? []).slice(0, 50),
  };
}

/** "Clear counters": every rule's hits back to zero from now. */
export async function clearFirewallCounters(env: Env): Promise<void> {
  const snap = await getSnapshot(env);
  // Totals are base + the VM's current counter, so a base of minus the
  // current reading makes every total zero without touching the VM.
  const neg: Record<string, [number, number]> = {};
  for (const [k, v] of Object.entries(snap.firewall?.counters ?? {})) neg[k] = [-v[0], -v[1]];
  await saveSnapshot(env, { fw_base: neg, fw_cleared_at: new Date().toISOString(), firewall: snap.firewall ? { ...snap.firewall, last_hit: {} } : null });
}

export function isBusyState(s: string): boolean {
  return s === "deploying" || s === "destroying" || s === "hibernating" || s === "resuming";
}

/**
 * One paragraph on what a Running stretch did: how long, roughly what it
 * cost, how much traffic, and which clients used it. Sent when the VM is
 * torn down or hibernated, and kept on the Activity page.
 */
export async function sessionSummary(env: Env, snap: Snapshot, ending: string, now = Date.now()): Promise<string> {
  const cfg = await effectiveConfig(env);
  if (!snap.running_since) return `${ending}.`;
  const ms = Math.max(0, now - Date.parse(snap.running_since));
  const h = Math.floor(ms / 3_600_000), m = Math.round((ms % 3_600_000) / 60_000);
  const cost = (ms / 3_600_000) * cfg.hourlyRateGbp;
  const peers = await db.listPeers(env);
  const names = (snap.session?.seen ?? []).map((k) => peers.find((p) => p.public_key === k)?.name ?? "an old key");
  const traffic = snap.session ? `${bytesText(snap.session.rx)} in, ${bytesText(snap.session.tx)} out` : "no traffic recorded";
  const who = names.length ? `Used by ${names.join(", ")}` : "No client connected";
  return `${ending} after ${h ? `${h}h ` : ""}${m}m, about £${cost.toFixed(2)}. ${traffic}. ${who}.`;
}

/** Start a destroy. Works from Running, Standby, Failed, or a drifted Destroyed. */
export async function startDestroy(env: Env, requestedBy: string, reason?: string): Promise<db.Run> {
  if (!canDispatch(env)) throw new RunError("GitHub is not connected yet. Add GITHUB_TOKEN and GITHUB_REPO in Settings > Setup.");
  const snap = await getSnapshot(env);
  if (isBusyState(snap.state)) throw new RunError("A run is already in progress.");

  const cfg = config(env);
  // Remember what this session did before the snapshot is cleared. Worked
  // out before taking the lock, so an error here cannot leave it held.
  const pending_summary = snap.state === "running" ? await sessionSummary(env, snap, "Torn down") : snap.state === "standby" ? "Torn down from Standby." : null;
  const id = newRunId("destroy");
  const lock = await acquireLock(env, id);
  if (!lock.ok) throw new RunError(`Another run holds the lock (${lock.holder?.runId}). Wait for it or release it in Settings.`);

  const payload = {
    run_id: id,
    wg_dns_name: cfg.dnsName,
    callback_url: `${cfg.publicUrl}/api/callback`,
    secrets_url: `${cfg.publicUrl}/api/callback/secrets`,
  };
  const now = new Date().toISOString();
  try {
    await db.createRun(env, {
      id,
      action: "destroy",
      status: "queued",
      requested_at: now,
      requested_by: requestedBy,
      callback_token_hash: null,
      agent_token_hash: null,
      payload_json: JSON.stringify(payload),
      auto_destroy_at: null,
      reason: reason ?? null,
      ssh_password: null,
    });
  } catch (e) {
    await releaseLock(env, id); // no run was recorded, so nothing else would free it
    throw e;
  }

  try {
    await dispatchWorkflow(env, "destroy", payload);
  } catch (e) {
    try {
      await db.updateRun(env, id, { status: "failure", finished_at: new Date().toISOString(), error: (e as Error).message });
    } finally {
      await releaseLock(env, id);
    }
    throw new RunError((e as Error).message);
  }

  await saveSnapshot(env, { state: "destroying", run_id: id, action: "destroy", since: now, github_run_url: null, steps: [], log_tail: null, error: null, drift: null, pending_summary });
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
      // The callback normally lands first. If it has not 2 minutes after
      // GitHub finished, settle from what we know. (updated_at is when the
      // run last changed, i.e. when it completed.)
      const fresh = await db.getRun(env, run.id);
      const finishedAt = Date.parse(gh.updated_at ?? gh.created_at);
      if (fresh && !fresh.finished_at && Date.now() - finishedAt > CALLBACK_GRACE_MS) {
        await settleWithoutCallback(env, fresh);
      }
    } else {
      await failRun(env, run, `GitHub run finished with "${gh.conclusion}".`);
    }
  }
}

/** How long after GitHub says "done" we wait for the result callback before settling without it. */
const CALLBACK_GRACE_MS = 2 * 60_000;

async function settleWithoutCallback(env: Env, run: db.Run): Promise<void> {
  // Only called once GitHub says success AND the callback is overdue by 2 min.
  // The dashboard's polling and the cron may both get here at once; the
  // settle itself (completeApply/completeDestroy) lets only one through.
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
  // Close the run in one step; if something else already closed it, leave it be.
  if (!(await db.settleRun(env, run.id, { status: "failure", finished_at: new Date().toISOString(), error: message }))) return;
  await releaseLock(env, run.id);
  await saveSnapshot(env, { state: "failed", error: message, since: new Date().toISOString(), pending_deploy: null });
  await db.addAlert(env, "failure", `${run.action} failed: ${message}`, run.id);
  await notify(env, `wg-admin: ${run.action} failed`, message);
}

/** Returns false (and does nothing) if the run was already settled by someone else. */
async function completeApply(env: Env, run: db.Run, publicIp: string | null, outputs: Record<string, unknown>, meta: { via: string }): Promise<boolean> {
  const now = new Date().toISOString();
  if (!(await db.settleRun(env, run.id, { status: "success", finished_at: now, public_ip: publicIp, outputs_json: JSON.stringify(outputs) }))) return false;
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
    test_vm_ip: typeof outputs.test_vm_ip === "string" && outputs.test_vm_ip ? outputs.test_vm_ip : null,
  });
  await refreshInventory(env);
  const cfg = config(env);
  await db.addAlert(env, "deploy", `Deployed at ${publicIp ?? "unknown IP"} (${meta.via}); ${cfg.dnsName} ${dns.live ? "is live" : "not live yet"}`, run.id);
  // The phone hears about it when the VM's self-test comes in (handleAgent),
  // so "ready" means the tunnel was proven to carry traffic, not just built.
  return true;
}

/** Returns false (and does nothing) if the run was already settled by someone else. */
async function completeDestroy(env: Env, run: db.Run, meta: { via: string }): Promise<boolean> {
  const now = new Date().toISOString();
  // Claim the run first: only one caller carries on, so a queued Move is
  // started once, not twice.
  if (!(await db.settleRun(env, run.id, { status: "success", finished_at: now }))) return false;
  // The VM is gone, so its SSH password opens nothing; do not keep it.
  await db.clearSshPasswords(env);
  const before = await getSnapshot(env);
  // The VM and its counters are gone; its hits live on in the totals.
  await saveSnapshot(env, { fw_base: addCounters(before.fw_base ?? {}, before.firewall?.counters) });
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
    selftest: null,
    latency: {},
    roams: {},
    session: null,
    standby_since: null,
    power_op_at: null,
    pending_summary: null,
    region: null,
    vm_size: null,
    profile: null,
    speedtest_req: null,
    firewall: before.firewall ? { ...before.firewall, counters: {}, applied_hash: null, drops: before.firewall.drops } : null,
    test_vm_ip: null,
    capture_req: null,
  });
  // A packet capture still waiting on the VM will never arrive now.
  if (before.capture_req) await db.failPendingCapture(env, before.capture_req.id, "VM torn down");
  await db.addAlert(env, "destroy", `Torn down (${meta.via}). Azure cost is now £0.`, run.id);
  if (before.pending_summary) await db.addAlert(env, "session", before.pending_summary, run.id);
  const next = before.pending_deploy;
  if (!next) {
    await notify(env, "wg-admin: torn down", `${before.pending_summary ? `${before.pending_summary} ` : ""}Everything removed; Azure cost is £0.`, { tags: ["wastebasket"] });
    return true;
  }
  // A move ("Move to US exit"): the old one is gone, build the new one now.
  try {
    const r = await startDeploy(env, { hours: next.hours, requesterIp: next.requester_ip, requestedBy: next.requested_by, region: next.region, vmSize: next.vm_size, profile: next.profile, reason: `move to ${next.profile ?? next.region}` });
    await db.addAlert(env, "info", `Move: torn down, now building ${next.profile ?? next.region} (${r.id}).`, run.id);
  } catch (e) {
    await saveSnapshot(env, { pending_deploy: null });
    await db.addAlert(env, "failure", `Move: torn down, but the new deploy could not start: ${(e as Error).message}`, run.id);
    await notify(env, "wg-admin: move stopped", `Torn down, but the new deploy could not start: ${(e as Error).message}`, { priority: 4 });
  }
  return true;
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
  let settled: boolean;
  if (run.action === "apply") {
    const ip = (body.outputs?.public_ip as string | undefined) ?? null;
    settled = await completeApply(env, run, ip, body.outputs ?? {}, { via: "callback" });
  } else {
    settled = await completeDestroy(env, run, { via: body.status === "success-with-fallback" ? "callback, fallback cleanup used" : "callback" });
  }
  return { status: 200, message: settled ? "ok" : "already settled" };
}

/**
 * Hand a GitHub run its per-run secrets, once. The caller has already
 * verified the OIDC token; `ghRunId` is GitHub's run number from it. The run
 * must carry our run id in its title, so a token from some other dispatch of
 * the same workflow cannot collect this run's secrets. Tokens are minted here
 * and only their hashes are kept.
 */
export async function issueRunSecrets(env: Env, runId: string, ghRunId: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const run = await db.getRun(env, runId);
  if (!run) return { status: 404, body: { error: "unknown run" } };
  if (run.finished_at || !["queued", "running"].includes(run.status)) return { status: 409, body: { error: "run is not active" } };
  if (run.callback_token_hash) return { status: 409, body: { error: "secrets already collected" } };
  const gh = await getGhRun(env, ghRunId);
  if (!gh || !(gh.display_title ?? "").includes(run.id)) return { status: 403, body: { error: "that GitHub run is not this run" } };

  const callbackToken = randomToken();
  const out: Record<string, unknown> = { callback_token: callbackToken };
  const patch: Partial<db.Run> = { callback_token_hash: await sha256Hex(callbackToken), github_run_id: ghRunId, github_run_url: gh.html_url };
  if (run.action === "apply") {
    const agentToken = randomToken();
    patch.agent_token_hash = await sha256Hex(agentToken);
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(run.payload_json ?? "{}"); } catch { /* ignore */ }
    const fw = await currentFirewall(env);
    Object.assign(out, { agent_token: agentToken, ssh_password: run.ssh_password ?? "", ssh_allowed_cidr: String(payload.ssh_allowed_cidr ?? ""), firewall_nft_b64: btoa(fw.text) });
  }
  // Claim and record in one step: if two callers got this far at once, only
  // the first write lands and the other is turned away with no secrets.
  if (!(await db.claimRunSecrets(env, run.id, patch))) return { status: 409, body: { error: "secrets already collected" } };
  return { status: 200, body: out };
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
  wan6?: string;
  selftest?: SelfTest | null;
  rtt?: Record<string, number> | null;
  dns?: { up?: boolean; blocked?: number } | null;
  firewall?: { hash?: string; error?: string | null; counters?: Record<string, [number, number]>; drops?: unknown[] } | null;
  talkers?: unknown[];
  capture_running?: string | null;
  speedtest_result?: { id?: string; down_bps?: number | null; up_bps?: number | null; rtt_ms?: number | null; jitter_ms?: number | null; error?: string | null } | null;
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

  const cfg = config(env);
  const parsed = parseWgDump(body.dump ?? "");
  // The self-test's canary client (.254) is only there for a few seconds; leave it out.
  const canary = `${cfg.subnet.split("/")[0].replace(/\.\d+$/, "")}.254/32`;
  const report: AgentReport = {
    at: new Date().toISOString(),
    hostname: body.hostname ?? "",
    uptime_seconds: Number(body.uptime_seconds) || 0,
    load: body.load ?? "",
    listen_port: parsed.listen_port,
    server_public_key: parsed.server_public_key,
    loopback: body.loopback ? String(body.loopback) : null,
    wan6: body.wan6 ? String(body.wan6) : null,
    dns: body.dns ? { up: !!body.dns.up, blocked: Number(body.dns.blocked) || 0 } : null,
    peers: parsed.peers.filter((p) => !p.allowed_ips.split(",").includes(canary)),
  };
  const snap = await getSnapshot(env);
  const peerList = async () => agentPeerList(await db.enabledPeers(env), cfg.subnet6);
  // A heartbeat that lands after a tear-down or after the VM went into
  // Standby is late mail: record nothing, or it would put a live-looking VM
  // back on a dashboard that has rightly cleared it.
  if (isOutOfService(snap.state)) return { status: 200, body: { peers: await peerList() } };
  // Only the fields the heartbeat owns go in this patch. The ones that build
  // on the previous reading (traffic, hits, session...) are worked out at
  // the end, from a fresh copy, so a button pressed meanwhile is not undone.
  const patch: Partial<Snapshot> = {
    last_agent_at: report.at,
    agent: report,
  };
  let resumed = false;
  // First heartbeat while still "deploying" (callback not yet in) is proof of life.
  if (snap.state === "deploying" && snap.run_id === run.id) {
    patch.state = "running";
    patch.since = report.at;
    patch.running_since = report.at;
  }
  // First heartbeat after a resume from Standby: back in service.
  if (snap.state === "resuming") {
    patch.state = "running";
    patch.since = report.at;
    patch.running_since = report.at;
    patch.standby_since = null;
    patch.power_op_at = null;
    resumed = true;
    await releaseLock(env, undefined, true);
    await db.addAlert(env, "info", "Resumed from Standby; the heartbeat is back.");
  }

  // A new self-test result (once per boot): tell the phone the tunnel is proven, or what failed.
  const st = body.selftest && typeof body.selftest === "object" && body.selftest.at ? body.selftest : null;
  if (st && st.at !== snap.selftest?.at) {
    patch.selftest = st;
    const failed = selfTestFailures(st);
    const deadline = patch.state === "running" || snap.state === "running" ? snap.auto_destroy_at : null;
    if (failed.length) {
      await db.addAlert(env, "failure", `Self-test failed: ${failed.join(", ")}. The VM is up but clients may not work fully.`);
      await notify(env, "wg-admin: up, but the self-test failed", `Failed: ${failed.join(", ")}. ${cfg.dnsName} → ${snap.public_ip ?? "?"}`, { priority: 4, tags: ["warning"], buttons: [dashboardButton(env)] });
    } else {
      const v6 = st.internet6 === true ? ", IPv6" : "";
      await db.addAlert(env, "info", `Self-test passed in ${(st.ms / 1000).toFixed(1)} s: handshake, tunnel, loopback${st.dns ? ", DNS" : ""}, internet${v6}.`);
      const until = deadline ? `. Tears down at ${new Date(deadline).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" })}` : "";
      await notify(env, "wg-admin: ready", `Tunnel proven end to end (handshake${st.dns ? ", DNS" : ""}, internet${v6}). ${cfg.dnsName} → ${snap.public_ip ?? "?"}${until}.`, { tags: ["white_check_mark"], buttons: [dashboardButton(env)] });
    }
  }
  // Speed test: a result coming back, or a request still to hand over.
  const reply: Record<string, unknown> = {};
  const req = snap.speedtest_req;
  const res = body.speedtest_result;
  if (res?.id) {
    reply.speedtest_ack = res.id;
    if (req && req.id === res.id) {
      const mbps = (b: number | null | undefined) => (typeof b === "number" && b > 0 ? Math.round(b / 1e5) / 10 : null);
      const t = { id: res.id, at: report.at, target_name: req.target_name, down_mbps: mbps(res.down_bps), up_mbps: mbps(res.up_bps), rtt_ms: typeof res.rtt_ms === "number" ? res.rtt_ms : null, jitter_ms: typeof res.jitter_ms === "number" ? res.jitter_ms : null, error: res.error || null };
      await db.saveSpeedTest(env, t);
      patch.speedtest_req = null;
      await db.addAlert(env, t.error ? "failure" : "info", t.error ? `Speed test failed: ${t.error}` : `Speed test to ${t.target_name}: Azure to home ${t.down_mbps ?? "?"} Mbit/s, home to Azure ${t.up_mbps ?? "?"} Mbit/s, ${t.rtt_ms ?? "?"} ms.`);
    }
  } else if (req) {
    if (Date.now() - Date.parse(req.at) > 5 * 60_000) {
      patch.speedtest_req = null;
      await db.saveSpeedTest(env, { id: req.id, at: report.at, target_name: req.target_name, down_mbps: null, up_mbps: null, rtt_ms: null, jitter_ms: null, error: "no result within 5 minutes" });
    } else {
      reply.speedtest = { id: req.id, target: req.target };
    }
  }
  // Packet capture: hand the request over until the VM says it has started;
  // give up if nothing has come back well after it should have finished.
  const cap = snap.capture_req;
  if (cap) {
    if (Date.now() - Date.parse(cap.at) > (cap.seconds + 300) * 1000) {
      patch.capture_req = null;
      await db.updateCapture(env, cap.id, { status: "failed", finished_at: report.at, error: "no capture arrived from the VM" });
    } else if (body.capture_running === cap.id) {
      await db.updateCapture(env, cap.id, { status: "running" });
    } else {
      const row = await db.getCapture(env, cap.id);
      if (row?.status === "waiting") reply.capture = { id: cap.id, iface: cap.iface, filter: cap.filter, seconds: cap.seconds };
    }
  }

  // Firewall: send the rule set when the VM's differs from the table's.
  // Agents from before the firewall (no report) are left alone.
  if (body.firewall) {
    const fw = await currentFirewall(env);
    if (body.firewall.hash !== fw.hash) reply.firewall = { hash: fw.hash, nft_b64: btoa(fw.text) };
  }

  // Fold this reading into the running figures, from a fresh copy taken
  // just before saving (the steps above wait on the database and on
  // notifications; "Clear counters" or a tear-down may have landed since).
  const cur = await getSnapshot(env);
  if (isOutOfService(cur.state)) return { status: 200, body: { peers: await peerList() } };
  const known = report.peers.map((p) => p.public_key);
  const traffic = nextTraffic(cur.traffic, report);
  patch.traffic = traffic;
  patch.latency = nextLatency(cur.latency ?? {}, body.rtt, known);
  patch.roams = { ...(cur.roams ?? {}), ...detectRoams(cur.agent, report, report.at) };
  patch.session = resumed ? nextSession(null, null, report) : nextSession(cur.session, cur.agent, report);
  patch.firewall = nextFirewall(cur.firewall, body.firewall, report.at);
  if (body.talkers) patch.talkers = nextTalkers(cur.talkers ?? {}, body.talkers, report.at);
  // Throughput history: one sample per heartbeat, the last two hours.
  patch.traffic_hist = (cur.traffic_hist ?? []).concat({ t: report.at, rx: Math.round(traffic.rx_rate), tx: Math.round(traffic.tx_rate) }).slice(-240);
  if (body.firewall) {
    const reported = body.firewall.counters && typeof body.firewall.counters === "object" ? body.firewall.counters : {};
    patch.fw_base = nextBase(cur.fw_base ?? {}, cur.firewall, reported, cur.firewall?.applied_hash === (body.firewall.hash || null));
  }
  await saveSnapshot(env, patch);

  return { status: 200, body: { peers: await peerList(), ...reply } };
}

/** Torn down or powered off: a heartbeat now is a late one and changes nothing. */
function isOutOfService(state: string): boolean {
  return state === "destroyed" || state === "standby";
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
  if (isBusyState(snap.state)) return null;
  const az = await azureView(env);
  if (az.error) return null; // unknown, not drift
  let drift: string | null = null;
  if (snap.state === "destroyed" && az.rg_exists) drift = `Azure still has resource group ${config(env).resourceGroup} but the dashboard says Destroyed. That VM is costing money.`;
  // A failed run can leave a half-built (or fully built) VM behind; nothing
  // else watches a Failed VM, so say so until it is cleaned up.
  if (snap.state === "failed" && az.rg_exists) drift = `The last run failed but Azure still has resource group ${config(env).resourceGroup}. It may be costing money; use Clean up to tear it down.`;
  if (snap.state === "running" && !az.rg_exists) drift = "The dashboard says Running but Azure has no resource group. Something deleted it outside this app.";
  if (snap.state === "running" && az.rg_exists && az.power && az.power !== "running") drift = `The VM exists but its power state is "${az.power}".`;
  if (snap.state === "running" && az.public_ip && snap.public_ip && az.public_ip !== snap.public_ip) drift = `Azure's public IP ${az.public_ip} differs from the recorded ${snap.public_ip}.`;
  if (snap.state === "standby" && !az.rg_exists) drift = "The dashboard says Standby but Azure has no resource group. Something deleted it outside this app.";
  if (snap.state === "standby" && az.rg_exists && az.power && az.power !== "deallocated") drift = `The dashboard says Standby but the VM's power state is "${az.power}". If it is running it is costing the full rate.`;
  if (drift !== snap.drift) await saveSnapshot(env, { drift });
  return drift;
}

/** Reconcile: destroy anything Azure has if we think we are Destroyed; or accept Destroyed if Azure is empty. */
export async function reconcile(env: Env, requestedBy: string): Promise<string> {
  // Mid-deploy the resource group may simply not exist *yet*, and mid-destroy
  // it is on its way out: either way Azure is not the whole story, so wait.
  await refreshInventory(env);
  const snap = await getSnapshot(env);
  if (isBusyState(snap.state)) throw new RunError("A run is in progress. Wait for it to finish (or Cancel it) before Clean up.");
  const az = canAzure(env) ? await azureView(env) : null;
  if (!az || az.error) return "Cannot reach Azure to reconcile.";
  if (az.rg_exists && (snap.state === "destroyed" || snap.state === "failed")) {
    // A clean-up tear-down must not be followed by an old queued Move.
    await saveSnapshot(env, { pending_deploy: null });
    await startDestroy(env, requestedBy, "reconcile: Azure had resources");
    return "Azure still had resources. A tear-down has been started.";
  }
  if (!az.rg_exists && snap.state !== "destroyed") {
    const run = await db.activeRun(env);
    if (run) await db.settleRun(env, run.id, { status: "cancelled", finished_at: new Date().toISOString(), error: "reconciled: Azure empty" });
    await releaseLock(env, undefined, true);
    await db.clearSshPasswords(env); // nothing left in Azure to log in to
    if (snap.capture_req) await db.failPendingCapture(env, snap.capture_req.id, "VM torn down");
    await saveSnapshot(env, { state: "destroyed", since: new Date().toISOString(), public_ip: null, dns_ip: null, dns_live: false, auto_destroy_at: null, agent: null, last_agent_at: null, drift: null, error: null, steps: [], log_tail: null, running_since: null, pending_deploy: null, pending_summary: null, capture_req: null });
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
