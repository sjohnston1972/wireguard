// api/overview.ts
//
// Plain English: the Overview's data. Before answering it checks on any
// run in progress (GitHub) and any power change (Azure), as the page does,
// so the state is current. The SSH password has its own route and is only
// sent when asked for, never as part of the overview.

import type { Hono } from "hono";
import { fail, type ApiEnv } from "./app";
import * as db from "../db";
import { getSnapshot, peerOnline, selfTestFailures } from "../state";
import { effectiveConfig } from "../settings";
import { canDispatch } from "../env";
import { lockStatus } from "../lock";
import { backupStatus } from "../backup";
import { budgetStatus } from "../budget";
import { nextStart } from "../schedule-time";
import { refreshActiveRun } from "../runs";
import { refreshPower } from "../standby";
import { whereFrom } from "../region";
import { isVerifying, heartbeatStale, publicIp6, sshAllowedFrom, typicalSeconds } from "../overview";
import type { OverviewResponse, SshPasswordResponse } from "../../../shared/api";

export function registerOverview(api: Hono<ApiEnv>): void {
  api.get("/overview", async (c) => {
    await refreshActiveRun(c.env).catch(() => {});
    await refreshPower(c.env).catch(() => {});
    const [snap, cfg, peers, lock, dep, profiles, speedtests, schedules, backups, runs] = await Promise.all([
      getSnapshot(c.env),
      effectiveConfig(c.env),
      db.listPeers(c.env),
      lockStatus(c.env),
      db.currentDeployment(c.env),
      db.listProfiles(c.env),
      db.listSpeedTests(c.env, 5),
      db.listSchedules(c.env),
      backupStatus(c.env).catch(() => null),
      db.listRuns(c.env, 60),
    ]);
    const now = Date.now();
    const site = peers.find((p) => p.enabled && p.routes) ?? null;
    let peersLoaded: number | null = null;
    try {
      peersLoaded = JSON.parse(String((JSON.parse(dep?.payload_json ?? "{}") as { peers_json?: unknown }).peers_json ?? "[]")).length;
    } catch {
      peersLoaded = null;
    }
    const out: OverviewResponse = {
      now: new Date(now).toISOString(),
      snapshot: snap,
      derived: {
        verifying: isVerifying(snap, now),
        heartbeatStale: heartbeatStale(snap, now),
        selftestFailures: selfTestFailures(snap.selftest),
        clientsOnline: snap.state === "running" && snap.agent ? snap.agent.peers.filter((p) => peerOnline(p, now)).length : 0,
        clientsEnabled: peers.filter((p) => p.enabled).length,
        publicIp6: snap.state === "running" ? publicIp6(snap) : null,
        dnsParked: snap.dns_ip === "192.0.2.1",
      },
      config: {
        dnsName: cfg.dnsName,
        port: cfg.port,
        subnet: cfg.subnet,
        subnet6: cfg.subnet6,
        loopbackIp: cfg.loopbackIp,
        region: cfg.region,
        vmSize: cfg.vmSize,
        vnetCidr: cfg.vnetCidr,
        homeLanCidr: cfg.homeLanCidr,
        hourlyRateGbp: cfg.hourlyRateGbp,
        standbyRateGbp: cfg.standbyRateGbp,
        autoDestroyDefaultHours: cfg.autoDestroyDefaultHours,
        expiryAction: cfg.expiryAction,
        standbyMaxDays: cfg.standbyMaxDays,
      },
      actions: { canDispatch: canDispatch(c.env), lockHolder: lock.held && !["deploying", "destroying"].includes(snap.state) ? lock.lock?.runId ?? null : null },
      near: whereFrom(c.req.raw),
      profiles,
      speedtests,
      site: site ? { id: site.id, name: site.name, routes: site.routes } : null,
      nextScheduledStart: nextStart(schedules, new Date(now)),
      budget: await budgetStatus(c.env, cfg, snap),
      deployment: dep
        ? { id: dep.id, requestedBy: dep.requested_by, finishedAt: dep.finished_at, githubRunUrl: dep.github_run_url, hasSshPassword: !!dep.ssh_password, sshAllowedFrom: sshAllowedFrom(snap, dep.payload_json), peersLoaded }
        : null,
      stateBackups: backups && !backups.error ? backups.state : null,
      typicalSeconds: { deploy: typicalSeconds(runs, "apply"), destroy: typicalSeconds(runs, "destroy") },
    };
    return c.json(out);
  });

  api.get("/ssh-password", async (c) => {
    const [snap, dep] = await Promise.all([getSnapshot(c.env), db.currentDeployment(c.env)]);
    if (snap.state !== "running" || !dep?.ssh_password) return fail(c, 404, "none", "There is no SSH password for what is running now.");
    const out: SshPasswordResponse = { password: dep.ssh_password };
    return c.json(out);
  });
}
