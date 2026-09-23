// standby.ts
//
// Plain English: warm standby. Instead of tearing everything down, the VM is
// "deallocated": Azure stops charging for the computer itself but keeps its
// disk and its static IP address. Resuming just powers it back on, so there
// is no GitHub run and no Terraform: about a minute instead of four, and the
// DNS record never changes because the address never changes. In standby
// only the disk and the address are billed, about £4.65 a month instead of
// about £11.50 running or £0 destroyed.
//
// Networking picture: a router shut down but left racked and cabled, versus
// a router returned to stores (destroy) that has to be re-provisioned.
//
// The Worker talks to Azure directly (azure.ts vmPower). Azure answers
// straight away and works in the background, so the power state is polled
// by the dashboard and the watchman until it settles:
//   running -> hibernating -> standby        (deallocate)
//   standby -> resuming   -> running         (start; the first heartbeat ends it)

import type { Env } from "./env";
import { canAzure } from "./env";
import { effectiveConfig } from "./settings";
import * as db from "./db";
import { acquireLock, releaseLock } from "./lock";
import { getSnapshot, saveSnapshot } from "./state";
import { azureView, vmPower } from "./azure";
import { notify } from "./notify";
import { actionButton, dashboardButton } from "./actions";
import { RunError, sessionSummary, refreshInventory } from "./runs";

const lockId = (op: string) => `${op}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;

/** Running -> Standby. */
export async function startHibernate(env: Env, by: string, reason: string): Promise<string> {
  if (!canAzure(env)) throw new RunError("Azure credentials are not set on the Worker, so it cannot power the VM down.");
  const snap = await getSnapshot(env);
  if (snap.state !== "running") throw new RunError("Only a running VM can be hibernated.");
  const id = lockId("hibernate");
  const lock = await acquireLock(env, id);
  if (!lock.ok) throw new RunError(`Another run holds the lock (${lock.holder?.runId}).`);
  const summary = await sessionSummary(env, snap, "Hibernated");
  try {
    await vmPower(env, "deallocate");
  } catch (e) {
    await releaseLock(env, id);
    throw new RunError((e as Error).message);
  }
  const now = new Date().toISOString();
  await saveSnapshot(env, { state: "hibernating", since: now, power_op_at: now, auto_destroy_at: null, pending_summary: summary, error: null });
  await db.addAlert(env, "info", `Hibernate requested by ${by} (${reason}).`);
  return "Hibernating. Azure takes a minute or two to power the VM down; the address and DNS stay.";
}

/** Standby -> Running. `hours` sets a fresh auto-destroy timer (null = none). */
export async function startResume(env: Env, by: string, hours: number | null): Promise<string> {
  if (!canAzure(env)) throw new RunError("Azure credentials are not set on the Worker, so it cannot power the VM up.");
  const snap = await getSnapshot(env);
  if (snap.state !== "standby") throw new RunError("Only a VM in Standby can be resumed.");
  const id = lockId("resume");
  const lock = await acquireLock(env, id);
  if (!lock.ok) throw new RunError(`Another run holds the lock (${lock.holder?.runId}).`);
  try {
    await vmPower(env, "start");
  } catch (e) {
    await releaseLock(env, id);
    throw new RunError((e as Error).message);
  }
  const now = new Date().toISOString();
  const auto_destroy_at = hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : null;
  await saveSnapshot(env, { state: "resuming", since: now, power_op_at: now, auto_destroy_at, selftest: null, last_agent_at: null, error: null });
  // Keep the current deployment's record in step, as the extend button does.
  const dep = await db.currentDeployment(env);
  if (dep) await db.updateRun(env, dep.id, { auto_destroy_at });
  await db.addAlert(env, "info", `Resume requested by ${by}.`);
  return "Resuming. The VM boots, re-runs its self-test and reports in; usually about a minute.";
}

/**
 * Move a power change along by asking Azure how far it has got. Called by the
 * dashboard's polling and the watchman. Cheap when nothing is in flight.
 */
export async function refreshPower(env: Env, now = Date.now()): Promise<void> {
  const snap = await getSnapshot(env);
  if (snap.state !== "hibernating" && snap.state !== "resuming") return;
  const started = Date.parse(snap.power_op_at ?? snap.since ?? new Date(now).toISOString());
  const az = await azureView(env);
  if (az.error) return;

  if (snap.state === "hibernating") {
    if (az.power === "deallocated") {
      const at = new Date(now).toISOString();
      const summary = snap.pending_summary ?? "Hibernated.";
      await saveSnapshot(env, { state: "standby", since: at, standby_since: at, running_since: null, power_op_at: null, agent: null, last_agent_at: null, traffic: null, session: null, latency: {}, pending_summary: null });
      await releaseLock(env, undefined, true);
      await refreshInventory(env);
      const cfg = await effectiveConfig(env);
      await db.addAlert(env, "session", summary);
      await notify(env, "wg-admin: in standby", `${summary} Standby costs about £${(cfg.standbyRateGbp * 24 * 30).toFixed(2)} a month; resume takes about a minute. Torn down automatically after ${cfg.standbyMaxDays} days.`, {
        tags: ["zzz"],
        buttons: [dashboardButton(env, "Resume from dashboard"), await actionButton(env, "destroy", 3 * 24 * 3600)],
      });
    } else if (now - started > 15 * 60_000) {
      await saveSnapshot(env, { state: "running", error: `Hibernate did not finish: Azure still reports "${az.power ?? "unknown"}".`, power_op_at: null });
      await releaseLock(env, undefined, true);
      await db.addAlert(env, "failure", `Hibernate did not finish within 15 minutes (power state "${az.power ?? "unknown"}"). Still treated as Running.`);
    }
    return;
  }

  // Resuming: the first heartbeat (handleAgent) is what completes it. If the
  // VM is on but silent for 6 minutes, call it Running anyway so the heartbeat
  // watchdog and the timers take over, and say so.
  if (az.power === "running" && now - started > 6 * 60_000) {
    const at = new Date(now).toISOString();
    await saveSnapshot(env, { state: "running", since: at, running_since: at, standby_since: null, power_op_at: null });
    await releaseLock(env, undefined, true);
    await db.addAlert(env, "unreachable", "The VM powered on after Resume but has not sent a heartbeat in 6 minutes.");
    await notify(env, "wg-admin: resumed, but silent", "The VM is powered on but has not reported in. Check the dashboard.", { priority: 4, buttons: [dashboardButton(env)] });
  } else if (now - started > 15 * 60_000) {
    await saveSnapshot(env, { state: "standby", error: `Resume did not finish: Azure reports "${az.power ?? "unknown"}".`, power_op_at: null });
    await releaseLock(env, undefined, true);
    await db.addAlert(env, "failure", `Resume did not finish within 15 minutes (power state "${az.power ?? "unknown"}").`);
  }
}
