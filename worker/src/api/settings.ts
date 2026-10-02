// api/settings.ts
//
// Plain English: the Settings screen's data and changes: the values the next
// deploy will use, profiles, schedules, and the run lock. Saving settings is
// all or nothing here: one bad value saves none of them (the old page saved
// the good ones and rejected the bad). Nothing secret is sent: the setup
// checklist names what is missing, phones are listed without their push keys.

import type { Hono, Context } from "hono";
import { body, fail, type ApiEnv } from "./app";
import { idParam } from "./clients";
import * as db from "../db";
import { config, missingSecrets } from "../env";
import { getSnapshot } from "../state";
import { effectiveConfig, saveOverrides, OVERRIDABLE, VM_SIZES } from "../settings";
import { REGIONS } from "../region";
import { profileProblemAt } from "../profiles";
import { daysText, nextStart, validRule } from "../schedule-time";
import { lockStatus, releaseLock } from "../lock";
import { backupStatus } from "../backup";
import { rotationStatus, shortKey } from "../keyrotation";
import { serverPublicKey } from "../peers";
import { lastNotifyError } from "../notify";
import type { ApiOk, SettingsResponse } from "../../../shared/api";

const ok = (c: Context<ApiEnv>, message: string) => {
  const out: ApiOk = { ok: true, message };
  return c.json(out);
};
const bad = (c: Context<ApiEnv>, message: string, field?: string) => fail(c, 400, "bad_input", message, field);
const noId = (c: Context<ApiEnv>, what: string) => bad(c, `id must be ${what}'s number.`, "id");

/** Fields in a body that are not on the allowed list, or null when all are known. */
function unknownField(b: Record<string, unknown>, allowed: string[]): string | null {
  return Object.keys(b).find((k) => !allowed.includes(k)) ?? null;
}

/** "08:00" style time. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function registerSettings(api: Hono<ApiEnv>): void {
  api.get("/settings", async (c) => {
    const env = c.env;
    const [cfg, stored, snap, profiles, schedules, pushSubs, lock, backups, rotation, serverPub, notifyError] = await Promise.all([
      effectiveConfig(env), db.allSettings(env), getSnapshot(env), db.listProfiles(env), db.listSchedules(env), db.listPushSubs(env), lockStatus(env), backupStatus(env, true), rotationStatus(env), serverPublicKey(env), lastNotifyError(env),
    ]);
    const out: SettingsResponse = {
      values: {
        region: cfg.region, vmSize: cfg.vmSize, testVm: cfg.testVm, autoDestroyDefaultHours: cfg.autoDestroyDefaultHours, expiryAction: cfg.expiryAction, standbyMaxDays: cfg.standbyMaxDays,
        idleDestroyMinutes: cfg.idleDestroyMinutes, monthlyBudgetGbp: cfg.monthlyBudgetGbp, hourlyRateGbp: cfg.hourlyRateGbp, standbyRateGbp: cfg.standbyRateGbp, sshAllowedCidr: cfg.sshAllowedCidr, firewallDefault: cfg.firewallDefault,
      },
      // Only the settings the screen can change; internal ones stay inside.
      overrides: Object.fromEntries(Object.entries(stored).filter(([k]) => Object.hasOwn(OVERRIDABLE, k))),
      overridable: Object.keys(OVERRIDABLE),
      regions: REGIONS,
      vmSizes: VM_SIZES,
      profiles: profiles.map((p) => ({ ...p, deployed: snap.state !== "destroyed" && snap.profile === p.name })),
      schedules: schedules.map((s) => ({ ...s, daysText: daysText(s.days), profileName: profiles.find((p) => p.id === s.profile_id)?.name ?? null })),
      nextScheduledStart: nextStart(schedules, new Date()),
      setup: Object.entries(missingSecrets(env)).map(([group, missing]) => ({ group, missing })),
      phones: pushSubs.map((s) => ({ id: s.id, label: s.label, created_at: s.created_at, last_ok: s.last_ok, last_error: s.last_error })),
      webhook: !!env.NOTIFY_WEBHOOK_URL,
      repo: env.GITHUB_REPO ?? null,
      key: { publicKey: serverPub, short: shortKey(serverPub), rotation },
      backups,
      lock: { held: lock.held, runId: lock.lock?.runId ?? null, since: lock.lock?.since ?? null },
      vapidPublic: env.VAPID_PUBLIC_KEY ?? null,
      notifyError,
      publicUrl: config(env).publicUrl,
    };
    return c.json(out);
  });

  api.put("/settings", async (c) => {
    const b = (await body<Record<string, unknown>>(c)) ?? {};
    if (!Object.keys(b).length) return bad(c, "Send at least one setting to change.");
    // Check every value before saving any.
    const form: Record<string, string> = {};
    for (const [k, v] of Object.entries(b)) {
      if (!Object.hasOwn(OVERRIDABLE, k)) return bad(c, `${k} is not a setting that can be changed.`, k);
      let s: string;
      if (typeof v === "boolean" && k === "test_vm") s = v ? "1" : "0";
      else if (typeof v === "string") s = v.trim();
      else if (typeof v === "number" && Number.isFinite(v)) s = String(v);
      else return bad(c, `${k} did not look right.`, k);
      if (!OVERRIDABLE[k](s)) return bad(c, `${k} did not look right.`, k);
      if ((k === "region" && !Object.hasOwn(REGIONS, s)) || (k === "vm_size" && !VM_SIZES.includes(s))) return bad(c, `${k} is not one of the choices on offer.`, k);
      form[k] = s;
    }
    const was = await db.allSettings(c.env);
    const rejected = await saveOverrides(c.env, form);
    if (rejected.length) return bad(c, `${rejected[0]} did not look right.`, rejected[0]);
    await db.audit(c.env, c.get("user"), "settings.save", "Settings", was, await db.allSettings(c.env));
    return ok(c, "Settings saved.");
  });

  // ── Profiles ────────────────────────────────────────────────────────────

  const PROFILE_FIELDS = ["name", "region", "vmSize"];

  /** Strings, as given; a wrong type names its field. */
  function profileTypes(b: Record<string, unknown>): string | null {
    return PROFILE_FIELDS.find((k) => b[k] !== undefined && typeof b[k] !== "string") ?? null;
  }

  api.post("/profiles", async (c) => {
    const b = (await body<Record<string, unknown>>(c)) ?? {};
    const wrong = profileTypes(b) ?? PROFILE_FIELDS.find((k) => b[k] === undefined);
    if (wrong) return bad(c, `${wrong} must be given as text.`, wrong);
    const p = { name: String(b.name).trim(), region: String(b.region), vm_size: String(b.vmSize) };
    const problem = profileProblemAt(p);
    if (problem) return bad(c, problem.message, problem.field);
    if ((await db.listProfiles(c.env)).some((x) => x.name === p.name)) return fail(c, 409, "duplicate", `There is already a profile called ${p.name}.`, "name");
    try {
      await db.addProfile(c.env, p);
    } catch {
      return fail(c, 409, "duplicate", `There is already a profile called ${p.name}.`, "name");
    }
    await db.audit(c.env, c.get("user"), "profile.add", p.name, null, p);
    return ok(c, `Profile ${p.name} added.`);
  });

  api.put("/profiles/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return noId(c, "a profile");
    const b = (await body<Record<string, unknown>>(c)) ?? {};
    const extra = unknownField(b, PROFILE_FIELDS);
    if (extra) return bad(c, `${extra} is not something a profile has.`, extra);
    if (!Object.keys(b).length) return bad(c, "Send at least one field to change.");
    const wrong = profileTypes(b);
    if (wrong) return bad(c, `${wrong} must be given as text.`, wrong);
    const was = await db.getProfile(c.env, id);
    if (!was) return fail(c, 404, "not_found", "No such profile.");
    const next = { name: b.name !== undefined ? String(b.name).trim() : was.name, region: b.region !== undefined ? String(b.region) : was.region, vm_size: b.vmSize !== undefined ? String(b.vmSize) : was.vm_size };
    const problem = profileProblemAt(next);
    if (problem) return bad(c, problem.message, problem.field);
    if (next.name !== was.name && (await db.listProfiles(c.env)).some((x) => x.name === next.name)) return fail(c, 409, "duplicate", `There is already a profile called ${next.name}.`, "name");
    await db.updateProfile(c.env, id, next);
    await db.audit(c.env, c.get("user"), "profile.edit", next.name, was, { ...was, ...next });
    return ok(c, `Profile ${next.name} saved.`);
  });

  api.delete("/profiles/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return noId(c, "a profile");
    const gone = await db.getProfile(c.env, id);
    if (!gone) return fail(c, 404, "not_found", "No such profile.");
    await db.deleteProfile(c.env, id);
    await db.audit(c.env, c.get("user"), "profile.delete", gone.name, gone, null);
    return ok(c, `Profile ${gone.name} deleted.`);
  });

  // ── Schedules ───────────────────────────────────────────────────────────

  const SCHEDULE_FIELDS = ["days", "start", "end", "profileId"];

  /** Whichever of days, start and end a validRule message is about. */
  function ruleField(message: string, start: string, end: string): string {
    if (message.startsWith("Pick")) return "days";
    if (message.startsWith("Times")) return TIME.test(start) ? "end" : "start";
    return "end";
  }

  /** Days as the list sent (1 to 7, Monday first), checked and turned into the stored "135" form. */
  function daysInput(v: unknown): string | null {
    if (!Array.isArray(v) || !v.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) return null;
    return [...new Set(v as number[])].sort().join("");
  }

  /** A profileId that is absent, null, or a positive whole number: undefined when it is none of those. */
  function profileIdInput(v: unknown): number | null | undefined {
    if (v === null) return null;
    return Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined;
  }

  /** Checks the fields a body gave (types only), returning the first problem. */
  function scheduleTypes(b: Record<string, unknown>): { message: string; field: string } | null {
    if (b.days !== undefined && daysInput(b.days) === null) return { message: "days must be a list of numbers from 1 (Monday) to 7 (Sunday).", field: "days" };
    for (const k of ["start", "end"]) if (b[k] !== undefined && typeof b[k] !== "string") return { message: `${k} must be a time like 08:00.`, field: k };
    if (b.profileId !== undefined && profileIdInput(b.profileId) === undefined) return { message: "profileId must be a profile's number, or null.", field: "profileId" };
    return null;
  }

  const scheduleName = (s: { days: string; start_time: string; end_time: string }) => `days ${s.days}, ${s.start_time}–${s.end_time}`;

  api.post("/schedules", async (c) => {
    const b = (await body<Record<string, unknown>>(c)) ?? {};
    const extra = unknownField(b, SCHEDULE_FIELDS);
    if (extra) return bad(c, `${extra} is not something a schedule has.`, extra);
    for (const k of ["days", "start", "end"]) if (b[k] === undefined) return bad(c, `${k} is required.`, k);
    const wrong = scheduleTypes(b);
    if (wrong) return bad(c, wrong.message, wrong.field);
    const days = daysInput(b.days)!, start = String(b.start), end = String(b.end);
    const problem = validRule(days, start, end);
    if (problem) return bad(c, problem, ruleField(problem, start, end));
    const profileId = profileIdInput(b.profileId) ?? null;
    if (profileId !== null && !(await db.getProfile(c.env, profileId))) return fail(c, 404, "not_found", "No such profile.");
    await db.addSchedule(c.env, { days, start_time: start, end_time: end, profile_id: profileId });
    await db.addAlert(c.env, "info", `Schedule added by ${c.get("user")}: days ${days}, ${start}–${end}.`);
    await db.audit(c.env, c.get("user"), "schedule.add", `days ${days}, ${start}–${end}`, null, { days, start_time: start, end_time: end, profile_id: profileId });
    return ok(c, "Schedule added.");
  });

  api.put("/schedules/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return noId(c, "a schedule");
    const b = (await body<Record<string, unknown>>(c)) ?? {};
    const extra = unknownField(b, [...SCHEDULE_FIELDS, "enabled"]);
    if (extra) return bad(c, `${extra} is not something a schedule has.`, extra);
    if (!Object.keys(b).length) return bad(c, "Send at least one field to change.");
    const wrong = scheduleTypes(b);
    if (wrong) return bad(c, wrong.message, wrong.field);
    if (b.enabled !== undefined && typeof b.enabled !== "boolean") return bad(c, "enabled must be true or false.", "enabled");
    const was = (await db.listSchedules(c.env)).find((s) => s.id === id);
    if (!was) return fail(c, 404, "not_found", "No such schedule.");
    const next = {
      days: b.days !== undefined ? daysInput(b.days)! : was.days,
      start_time: b.start !== undefined ? String(b.start) : was.start_time,
      end_time: b.end !== undefined ? String(b.end) : was.end_time,
      profile_id: b.profileId !== undefined ? profileIdInput(b.profileId)! : was.profile_id,
      enabled: b.enabled !== undefined ? (b.enabled ? 1 : 0) : was.enabled,
    };
    const problem = validRule(next.days, next.start_time, next.end_time);
    if (problem) return bad(c, problem, ruleField(problem, next.start_time, next.end_time));
    if (next.profile_id !== null && !(await db.getProfile(c.env, next.profile_id))) return fail(c, 404, "not_found", "No such profile.");
    await db.updateSchedule(c.env, id, { ...next, enabled: !!next.enabled });
    const onlyEnabled = Object.keys(b).every((k) => k === "enabled");
    const action = onlyEnabled ? (next.enabled ? "schedule.enable" : "schedule.disable") : "schedule.edit";
    await db.audit(c.env, c.get("user"), action, scheduleName(was), was, { ...was, ...next });
    return ok(c, onlyEnabled ? (next.enabled ? "Schedule switched on." : "Schedule switched off.") : "Schedule saved.");
  });

  api.delete("/schedules/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return noId(c, "a schedule");
    const gone = (await db.listSchedules(c.env)).find((s) => s.id === id);
    if (!gone) return fail(c, 404, "not_found", "No such schedule.");
    await db.deleteSchedule(c.env, id);
    await db.audit(c.env, c.get("user"), "schedule.delete", scheduleName(gone), gone, null);
    return ok(c, "Schedule deleted.");
  });

  // ── Run lock ────────────────────────────────────────────────────────────

  api.post("/lock/release", async (c) => {
    const held = await lockStatus(c.env);
    await releaseLock(c.env, undefined, true);
    await db.audit(c.env, c.get("user"), "lock.release", held.lock?.runId ?? "run lock", held, { held: false, lock: null });
    await db.addAlert(c.env, "info", `Run lock released by hand (${c.get("user")}).`);
    return ok(c, "Run lock released.");
  });
}
