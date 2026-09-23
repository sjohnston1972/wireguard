// schedule.ts
//
// Plain English: time-of-day windows, like a scheduled interface or a
// time-based ACL. "Monday to Friday, 08:00 to 18:00, UK profile" means: when
// the window opens, the watchman deploys (or resumes from Standby) and sets
// the auto-destroy timer to the window's end; the timer does the rest. Times
// are UK time (Europe/London), including the clock changes.
//
// Each window fires once per day. If you tear down by hand in the middle of
// a window, it stays down until the next day's window.

import type { Env } from "./env";
import { effectiveConfig } from "./settings";
import * as db from "./db";
import { getSnapshot } from "./state";
import { startDeploy, extendAutoDestroy } from "./runs";
import { startResume } from "./standby";
import { notify } from "./notify";
import { dashboardButton } from "./actions";

export { londonClock, toMinutes, windowNow, daysText, nextStart, validRule } from "./schedule-time";
import { windowNow, daysText } from "./schedule-time";

/** The watchman's schedule check, every 5 minutes. Returns notes for the log. */
export async function runSchedules(env: Env, now = new Date()): Promise<string[]> {
  const notes: string[] = [];
  const rules = (await db.listSchedules(env)).filter((r) => r.enabled);
  for (const rule of rules) {
    const w = windowNow(rule, now);
    if (!w.open) continue;
    const key = `sched:${rule.id}:${w.date}`;
    if (await env.STATUS.get(key)) continue;
    const snap = await getSnapshot(env);
    const hours = w.minutesLeft / 60;
    const label = `${daysText(rule.days)} ${rule.start_time}–${rule.end_time}`;
    const profile = rule.profile_id ? await db.getProfile(env, rule.profile_id) : null;
    let did: string | null = null;
    try {
      if (snap.state === "destroyed") {
        const cfg = await effectiveConfig(env);
        const r = await startDeploy(env, { hours, requesterIp: null, requestedBy: "schedule", reason: `schedule ${label}`, region: profile?.region ?? cfg.region, vmSize: profile?.vm_size ?? cfg.vmSize, profile: profile?.name ?? null });
        did = `Scheduled start (${label}): deploying${profile ? ` ${profile.name}` : ""} until ${rule.end_time} (${r.id}).`;
      } else if (snap.state === "standby") {
        await startResume(env, "schedule", hours);
        did = `Scheduled start (${label}): resuming from Standby until ${rule.end_time}.`;
      } else if (snap.state === "running") {
        const end = Date.now() + w.minutesLeft * 60_000;
        if (snap.auto_destroy_at && Date.parse(snap.auto_destroy_at) < end) {
          await extendAutoDestroy(env, hours);
          did = `Scheduled window (${label}): already running, timer moved to ${rule.end_time}.`;
        } else {
          did = `Scheduled window (${label}): already running.`;
        }
      } else {
        continue; // busy or failed: look again in 5 minutes
      }
    } catch (e) {
      notes.push(`schedule ${rule.id}: ${(e as Error).message}`);
      continue;
    }
    await env.STATUS.put(key, "1", { expirationTtl: 2 * 86400 });
    await db.addAlert(env, "info", did);
    if (!/already running\.$/.test(did)) await notify(env, "wg-admin: scheduled start", did, { tags: ["alarm_clock"], buttons: [dashboardButton(env)] });
    notes.push(did);
  }
  return notes;
}
