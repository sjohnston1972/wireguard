// monitor.ts
//
// Plain English: the night watchman. Every 5 minutes, without anyone
// looking at the dashboard, it:
//   - refreshes the active run from GitHub (so a missed callback heals)
//   - moves a hibernate or resume along (standby.ts)
//   - opens scheduled windows: deploys or resumes, timer to the window's end
//   - 15 minutes before the auto-destroy deadline, pings the phone with
//     one-tap buttons: Extend 1h, Hibernate, Tear down
//   - at the deadline tears down, or hibernates if Settings says so (the
//     big cost saver)
//   - tears down anyway if running 15 minutes past that (cost guard)
//   - does the same on idle if IDLE_DESTROY_MINUTES is set and no client has
//     shaken hands for that long (the home site does not count: it is always
//     connected)
//   - tears down a VM left in Standby longer than STANDBY_MAX_DAYS
//   - tears down what a failed run left in Azure, after FAILED_GRACE_MINUTES
//   - flags drift: Azure and the dashboard disagree
//   - flags an unreachable VM: no heartbeat for 2 minutes while Running
//   - pulls yesterday's actual cost from Azure once a day
//   - checks the month against the budget: one alert at 80%, one at 100%
//     (budget.ts)
// Everything it notices is written to alerts so the Activity page can show
// what happened overnight, and pushed to the webhook if one is set.

import type { Env } from "./env";
import { canAzure } from "./env";
import { effectiveConfig } from "./settings";
import * as db from "./db";
import { getSnapshot, saveSnapshot, anyHandshakeWithin } from "./state";
import { refreshActiveRun, startDestroy, detectDrift, refreshInventory } from "./runs";
import { startHibernate, refreshPower } from "./standby";
import { runSchedules } from "./schedule";
import { notify } from "./notify";
import { actionButton, dashboardButton } from "./actions";
import { costMonthToDate, azureView } from "./azure";
import { checkDns } from "./dns";
import { checkBudget } from "./budget";

/**
 * How long a Failed deployment may leave its resource group in Azure before
 * the watchman tears it down. Long enough to look at what went wrong (or press
 * Clean up yourself), short enough that a VM nobody is using does not bill all
 * night.
 */
export const FAILED_GRACE_MINUTES = 30;

export async function runScheduled(env: Env, now = new Date()): Promise<string[]> {
  const notes: string[] = [];
  const cfg = await effectiveConfig(env);

  // 1. Keep the active run honest.
  try {
    await refreshActiveRun(env);
  } catch (e) {
    notes.push(`refresh: ${(e as Error).message}`);
  }

  try {
    await refreshPower(env, now.getTime());
  } catch (e) {
    notes.push(`power: ${(e as Error).message}`);
  }

  try {
    notes.push(...(await runSchedules(env, now)));
  } catch (e) {
    notes.push(`schedules: ${(e as Error).message}`);
  }

  let snap = await getSnapshot(env);
  const hibernating = cfg.expiryAction === "hibernate";

  // 2a. Heads-up 15 minutes before the deadline, once per deadline, with
  //     buttons that work from the lock screen.
  if (snap.state === "running" && snap.auto_destroy_at) {
    const left = Date.parse(snap.auto_destroy_at) - now.getTime();
    const key = `warned:${snap.auto_destroy_at}`;
    if (left > 0 && left <= 15 * 60_000 && !(await env.STATUS.get(key))) {
      await env.STATUS.put(key, "1", { expirationTtl: 24 * 3600 });
      const ttl = Math.round(left / 1000) + 30 * 60; // the buttons stop working 30 minutes after the deadline
      const mins = Math.max(1, Math.round(left / 60_000));
      const buttons = [await actionButton(env, "extend", ttl), hibernating ? await actionButton(env, "destroy", ttl) : await actionButton(env, "hibernate", ttl), dashboardButton(env)];
      await notify(env, `wg-admin: ${hibernating ? "hibernating" : "tearing down"} in ${mins} min`, `The auto-destroy timer ends at ${new Date(snap.auto_destroy_at).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" })}. Extend it, or let it ${hibernating ? "hibernate" : "tear down"}.`, { priority: 4, tags: ["hourglass"], buttons });
      notes.push("deadline warning sent");
    }
  }

  // 2b. Deadline reached: hibernate or destroy per Settings. The cost guard
  //     (15 minutes over, so the first attempt failed) always destroys.
  if (snap.state === "running" && snap.auto_destroy_at) {
    const deadline = Date.parse(snap.auto_destroy_at);
    const overBy = now.getTime() - deadline;
    if (overBy >= 0) {
      const guard = overBy > 15 * 60_000;
      try {
        if (hibernating && !guard) {
          await startHibernate(env, "watchman", "auto-destroy timer");
        } else {
          await startDestroy(env, "watchman", guard ? "cost guard: running 15 min past the deadline" : "auto-destroy timer");
        }
        const msg = guard ? "Cost guard fired: the VM was still running 15 minutes past its deadline. Tearing down." : hibernating ? "Timer reached. Hibernating into Standby." : "Auto-destroy timer reached. Tearing down.";
        await db.addAlert(env, guard ? "cost_guard" : "info", msg);
        if (guard) await notify(env, "wg-admin: cost guard", msg, { priority: 4, tags: ["rotating_light"] });
        notes.push(msg);
        return notes;
      } catch (e) {
        notes.push(`auto-destroy: ${(e as Error).message}`);
      }
    }
  }

  // 3. Idle timeout.
  if (snap.state === "running" && cfg.idleDestroyMinutes > 0 && snap.running_since) {
    const upFor = now.getTime() - Date.parse(snap.running_since);
    const idleWindow = cfg.idleDestroyMinutes * 60_000;
    // Site peers (the home container, a peer with routes) keep the tunnel up
    // by themselves every couple of minutes; they are not someone using it.
    const sites = (await db.listPeers(env)).filter((p) => p.routes).map((p) => p.public_key);
    if (upFor > idleWindow && !anyHandshakeWithin(snap.agent, cfg.idleDestroyMinutes, now.getTime(), sites)) {
      try {
        if (hibernating) await startHibernate(env, "watchman", `idle: no handshake for ${cfg.idleDestroyMinutes} min`);
        else await startDestroy(env, "watchman", `idle: no handshake for ${cfg.idleDestroyMinutes} min`);
        const msg = `No client has connected for ${cfg.idleDestroyMinutes} minutes. ${hibernating ? "Hibernating" : "Tearing down"}.`;
        await db.addAlert(env, "idle", msg);
        notes.push(msg);
        return notes;
      } catch (e) {
        notes.push(`idle: ${(e as Error).message}`);
      }
    }
  }

  // 3b. Standby has a limit, so a forgotten VM cannot bill for ever.
  if (snap.state === "standby" && snap.standby_since) {
    const days = (now.getTime() - Date.parse(snap.standby_since)) / 86_400_000;
    if (days > cfg.standbyMaxDays) {
      try {
        await startDestroy(env, "watchman", `standby limit: ${cfg.standbyMaxDays} days`);
        const msg = `The VM has been in Standby for ${cfg.standbyMaxDays} days. Tearing it down to get back to £0.`;
        await db.addAlert(env, "info", msg);
        notes.push(msg);
        return notes;
      } catch (e) {
        notes.push(`standby limit: ${(e as Error).message}`);
      }
    }
  }

  // 3c. A run that failed part-way (or was cancelled after Terraform built
  //     things) can leave a VM running in Azure with nothing watching it: no
  //     timer, no idle check. Give it a grace period, then tear it down.
  if (snap.state === "failed" && canAzure(env)) {
    const failedFor = now.getTime() - Date.parse(snap.since ?? now.toISOString());
    if (failedFor >= FAILED_GRACE_MINUTES * 60_000) {
      try {
        const az = await azureView(env);
        if (!az.error && az.rg_exists) {
          await startDestroy(env, "watchman", `failed ${FAILED_GRACE_MINUTES} min ago with resources still in Azure`);
          const msg = `The last run failed ${Math.round(failedFor / 60_000)} minutes ago and left resource group ${cfg.resourceGroup} in Azure, which is costing money. Tearing it down.`;
          await db.addAlert(env, "cost_guard", msg);
          await notify(env, "wg-admin: cleaning up after a failed run", msg, { priority: 4, tags: ["rotating_light"], buttons: [dashboardButton(env)] });
          notes.push(msg);
          return notes;
        }
      } catch (e) {
        notes.push(`failed clean-up: ${(e as Error).message}`);
      }
    }
  }

  // 4. Inventory (what Azure says exists) and drift.
  if (snap.state !== "destroyed" || snap.azure?.exists) await refreshInventory(env);
  try {
    const before = snap.drift;
    const drift = await detectDrift(env);
    if (drift && drift !== before) {
      await db.addAlert(env, "drift", drift);
      await notify(env, "wg-admin: drift", drift, { priority: 4, tags: ["warning"], buttons: [dashboardButton(env)] });
      notes.push(drift);
    }
  } catch (e) {
    notes.push(`drift: ${(e as Error).message}`);
  }

  // 5. Heartbeat watchdog and DNS re-check while Running.
  snap = await getSnapshot(env);
  if (snap.state === "running") {
    const stale = !snap.last_agent_at || now.getTime() - Date.parse(snap.last_agent_at) > 2 * 60_000;
    const flag = "unreachable";
    const wasFlagged = (await env.STATUS.get(`flag:${flag}`)) === "1";
    if (stale && !wasFlagged) {
      await env.STATUS.put(`flag:${flag}`, "1");
      await db.addAlert(env, "unreachable", "No heartbeat from the VM for 2 minutes. It may be down, or the agent token may be wrong.");
      await notify(env, "wg-admin: VM unreachable", "No heartbeat for 2 minutes.", { priority: 4, tags: ["warning"], buttons: [dashboardButton(env)] });
      notes.push("unreachable");
    } else if (!stale && wasFlagged) {
      await env.STATUS.delete(`flag:${flag}`);
      await db.addAlert(env, "info", "Heartbeat from the VM is back.");
    }
    try {
      const dns = await checkDns(env, snap.public_ip);
      await saveSnapshot(env, { dns_ip: dns.resolver, dns_live: dns.live });
      if (!dns.live && snap.dns_live) {
        await db.addAlert(env, "drift", `DNS mismatch: ${cfg.dnsName} resolves to ${dns.resolver ?? "nothing"} but the VM is at ${snap.public_ip}.`);
      }
    } catch {
      /* ignore */
    }
  } else {
    await env.STATUS.delete("flag:unreachable");
    // While destroyed, keep the DNS cell honest too (it should read "parked").
    try {
      const dns = await checkDns(env, null);
      if (dns.resolver !== snap.dns_ip) await saveSnapshot(env, { dns_ip: dns.resolver, dns_live: false });
    } catch {
      /* ignore */
    }
  }

  // 6. Daily actual cost.
  if (canAzure(env)) {
    const today = now.toISOString().slice(0, 10);
    const last = await env.STATUS.get("cost:fetched_day");
    if (last !== today) {
      try {
        const { days } = await costMonthToDate(env);
        for (const d of days) await db.upsertCostDay(env, d.day, d.gbp);
        await env.STATUS.put("cost:fetched_day", today);
        notes.push(`cost: ${days.length} day(s) updated`);
      } catch (e) {
        notes.push(`cost: ${(e as Error).message}`);
      }
    }
  }

  // 7. The monthly budget: this month's actual spend plus the running
  //    session to its timer. Every run, because the session part moves.
  try {
    const note = await checkBudget(env, cfg, now);
    if (note) notes.push(note);
  } catch (e) {
    notes.push(`budget: ${(e as Error).message}`);
  }

  return notes;
}
