// api-settings.test.ts
//
// Plain English: the Settings screen's data and changes through the JSON API:
// the values, profiles, schedules, the run lock.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv, base } from "./api-helpers";
import * as db from "../src/db";
import { saveSnapshot } from "../src/state";
import { acquireLock, lockStatus } from "../src/lock";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

async function audits(env: Env, action: string) {
  return (await env.DB.prepare("SELECT * FROM audit WHERE action = ?1").bind(action).all<{ target: string; before_json: string | null; after_json: string | null }>()).results;
}

describe("GET /settings", () => {
  it("answers values, profiles, schedules and the lock, with no secrets or push keys anywhere", async () => {
    const { env } = apiEnv({ GITHUB_TOKEN: "ghp_SECRETVALUE", AZURE_CLIENT_SECRET: "AZSECRETVALUE", NOTIFY_TOKEN: "tk_SECRETVALUE", VAPID_PUBLIC_KEY: "PUBLICVAPID" });
    await db.savePushSub(env, { endpoint: "https://fcm.googleapis.com/fcm/send/ENDPOINTSECRET", p256dh: "P256SECRET".padEnd(87, "x"), auth: "AUTHSECRET".padEnd(22, "y"), label: "Pixel" });
    await db.setSetting(env, "internal_marker", "keep-me-private");
    await db.setSetting(env, "idle_destroy_minutes", "30");
    const r = await api(env, "GET", "/settings");
    expect(r.status).toBe(200);
    expect(r.json.values).toMatchObject({ region: "uksouth", vmSize: "Standard_B1s", idleDestroyMinutes: 30, firewallDefault: "deny", testVm: false });
    expect(r.json.overrides).toEqual({ idle_destroy_minutes: "30" });
    expect(r.json.overridable).toContain("test_vm");
    expect(r.json.vmSizes).toContain("Standard_B2ats_v2");
    expect(r.json.regions.uksouth).toBeTruthy();
    expect(r.json.profiles).toHaveLength(3);
    expect(r.json.profiles.every((p: { deployed: boolean }) => p.deployed === false)).toBe(true);
    expect(r.json.phones).toEqual([expect.objectContaining({ label: "Pixel", last_ok: null, last_error: null })]);
    expect(r.json.lock).toEqual({ held: false, runId: null, since: null });
    expect(r.json.vapidPublic).toBe("PUBLICVAPID");
    expect(r.json.backups.state).toBeTruthy();
    expect(r.json.key.rotation).toBeTruthy();
    expect(r.json.publicUrl).toBe(base);
    for (const secret of ["ENDPOINTSECRET", "P256SECRET", "AUTHSECRET", "ghp_SECRETVALUE", "AZSECRETVALUE", "tk_SECRETVALUE", "keep-me-private", "p256dh", "endpoint"]) expect(r.text).not.toContain(secret);
  });

  it("marks the profile the running VM was built from, and says which secrets are missing by name only", async () => {
    const { env } = apiEnv({ CLOUDFLARE_DNS_TOKEN: "REPLACE_ME" });
    await saveSnapshot(env, { state: "running", profile: "UK" });
    const r = await api(env, "GET", "/settings");
    expect(r.json.profiles.filter((p: { deployed: boolean }) => p.deployed).map((p: { name: string }) => p.name)).toEqual(["UK"]);
    expect(r.json.setup).toContainEqual({ group: "DNS verification", missing: expect.arrayContaining(["CLOUDFLARE_DNS_TOKEN"]) });
    await saveSnapshot(env, { state: "destroyed" });
    expect((await api(env, "GET", "/settings")).json.profiles.some((p: { deployed: boolean }) => p.deployed)).toBe(false);
  });

  it("lists schedules with their days in words, the profile name and the next start", async () => {
    const { env } = apiEnv();
    await db.addSchedule(env, { days: "1234567", start_time: "08:00", end_time: "18:00", profile_id: 1 });
    const r = await api(env, "GET", "/settings");
    expect(r.json.schedules).toEqual([expect.objectContaining({ days: "1234567", daysText: "Every day", profileName: "UK" })]);
    expect(r.json.nextScheduledStart).toMatch(/\d\d:\d\d$/);
  });

  it("shows the run lock when held", async () => {
    const { env } = apiEnv();
    await acquireLock(env, "run-1");
    const r = await api(env, "GET", "/settings");
    expect(r.json.lock).toMatchObject({ held: true, runId: "run-1" });
  });
});

describe("PUT /settings", () => {
  it("saves all values, turning booleans into 1 and 0, and audits the change", async () => {
    const { env } = apiEnv();
    const r = await api(env, "PUT", "/settings", { test_vm: true, idle_destroy_minutes: 45, expiry_action: "hibernate" });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(await db.allSettings(env)).toEqual({ test_vm: "1", idle_destroy_minutes: "45", expiry_action: "hibernate" });
    expect((await api(env, "GET", "/settings")).json.values).toMatchObject({ testVm: true, idleDestroyMinutes: 45, expiryAction: "hibernate" });
    await api(env, "PUT", "/settings", { test_vm: false });
    expect((await db.allSettings(env)).test_vm).toBe("0");
    expect(await audits(env, "settings.save")).toHaveLength(2);
  });

  it("is all or nothing: one bad value saves none, and names the first bad key", async () => {
    const { env } = apiEnv();
    const r = await api(env, "PUT", "/settings", { idle_destroy_minutes: 45, standby_max_days: 999, region: "!!" });
    expect(r.status).toBe(400);
    expect(r.json.error.field).toBe("standby_max_days");
    expect(await db.allSettings(env)).toEqual({});
    expect(await audits(env, "settings.save")).toHaveLength(0);
  });

  it("refuses an unknown key, a nested value, and a boolean where a number goes, saving nothing", async () => {
    const { env } = apiEnv();
    const bad = async (b: unknown, field: string) => {
      const r = await api(env, "PUT", "/settings", b);
      expect(r.status).toBe(400);
      expect(r.json.error.field).toBe(field);
    };
    await bad({ idle_destroy_minutes: 5, server_key: "x" }, "server_key");
    await bad({ region: ["uksouth"] }, "region");
    await bad({ monthly_budget_gbp: true }, "monthly_budget_gbp");
    expect(await db.allSettings(env)).toEqual({});
  });
});

describe("profiles", () => {
  it("creates one, and refuses a bad name, region or size (naming it), and a duplicate (409)", async () => {
    const { env } = apiEnv();
    const ok = await api(env, "POST", "/profiles", { name: "Japan", region: "mars", vmSize: "Standard_B1s" });
    expect(ok.status).toBe(400); // not a region the dashboard offers
    expect(ok.json.error.field).toBe("region");
    const made = await api(env, "POST", "/profiles", { name: "Japan", region: "uksouth", vmSize: "Standard_B2s" });
    expect(made.status).toBe(200);
    expect((await db.listProfiles(env)).at(-1)).toMatchObject({ name: "Japan", region: "uksouth", vm_size: "Standard_B2s" });
    expect((await audits(env, "profile.add"))[0].target).toBe("Japan");
    const dup = await api(env, "POST", "/profiles", { name: "Japan", region: "ukwest", vmSize: "Standard_B1s" });
    expect(dup.status).toBe(409);
    for (const [b, field] of [[{ name: "!x", region: "uksouth", vmSize: "Standard_B1s" }, "name"], [{ name: "A", region: "uksouth", vmSize: "B1s" }, "vmSize"], [{ name: 5, region: "uksouth", vmSize: "Standard_B1s" }, "name"], [{ name: "A", region: "uksouth" }, "vmSize"]] as const) {
      const r = await api(env, "POST", "/profiles", b);
      expect(r.status).toBe(400);
      expect(r.json.error.field).toBe(field);
    }
    expect(await db.listProfiles(env)).toHaveLength(4);
  });

  it("edits any field, checking the merged value; 404 when missing; duplicate name is 409", async () => {
    const { env } = apiEnv();
    const uk = (await db.listProfiles(env))[0];
    const r = await api(env, "PUT", `/profiles/${uk.id}`, { vmSize: "Standard_B2s" });
    expect(r.status).toBe(200);
    expect(await db.getProfile(env, uk.id)).toMatchObject({ name: uk.name, region: uk.region, vm_size: "Standard_B2s" });
    expect(await audits(env, "profile.edit")).toHaveLength(1);
    const bad = await api(env, "PUT", `/profiles/${uk.id}`, { region: "mars" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.field).toBe("region");
    expect((await db.getProfile(env, uk.id))!.region).toBe(uk.region);
    expect((await api(env, "PUT", `/profiles/${uk.id}`, { name: (await db.listProfiles(env))[1].name })).status).toBe(409);
    expect((await api(env, "PUT", "/profiles/999", { name: "X" })).status).toBe(404);
    expect((await api(env, "PUT", "/profiles/abc", { name: "X" })).status).toBe(400);
    expect((await api(env, "PUT", `/profiles/${uk.id}`, {})).status).toBe(400);
  });

  it("deletes one (and detaches its schedules); 404 the second time", async () => {
    const { env } = apiEnv();
    await db.addSchedule(env, { days: "1", start_time: "08:00", end_time: "09:00", profile_id: 1 });
    expect((await api(env, "DELETE", "/profiles/1")).status).toBe(200);
    expect((await db.listSchedules(env))[0].profile_id).toBeNull();
    expect(await audits(env, "profile.delete")).toHaveLength(1);
    expect((await api(env, "DELETE", "/profiles/1")).status).toBe(404);
  });
});

describe("schedules", () => {
  it("creates one from days, start and end, with the same alert and audit as the page", async () => {
    const { env } = apiEnv();
    const r = await api(env, "POST", "/schedules", { days: [5, 1, 3, 3], start: "08:00", end: "18:00", profileId: 2 });
    expect(r.status).toBe(200);
    expect(await db.listSchedules(env)).toEqual([expect.objectContaining({ days: "135", start_time: "08:00", end_time: "18:00", profile_id: 2, enabled: 1 })]);
    expect(await audits(env, "schedule.add")).toHaveLength(1);
    expect((await db.listAlerts(env, 5)).some((a) => /Schedule added/.test(a.message))).toBe(true);
    expect((await api(env, "POST", "/schedules", { days: [1], start: "08:00", end: "09:00" })).status).toBe(200);
  });

  it("refuses a bad window, naming the field, and a missing profile with 404; nothing is saved", async () => {
    const { env } = apiEnv();
    const bad = async (b: unknown, status: number, field?: string) => {
      const r = await api(env, "POST", "/schedules", b);
      expect(r.status).toBe(status);
      if (field) expect(r.json.error.field).toBe(field);
    };
    await bad({ days: [], start: "08:00", end: "18:00" }, 400, "days");
    await bad({ days: [8], start: "08:00", end: "18:00" }, 400, "days");
    await bad({ days: ["1"], start: "08:00", end: "18:00" }, 400, "days");
    await bad({ days: [1], start: "8am", end: "18:00" }, 400, "start");
    await bad({ days: [1], start: "08:00", end: "25:00" }, 400, "end");
    await bad({ days: [1], start: "18:00", end: "08:00" }, 400, "end");
    await bad({ days: [1], start: "08:00", end: "18:00", profileId: "2" }, 400, "profileId");
    await bad({ days: [1], start: "08:00", end: "18:00", profileId: 999 }, 404);
    expect(await db.listSchedules(env)).toHaveLength(0);
  });

  it("edits fields (checked on the merged value) and audits enable and disable by their own names", async () => {
    const { env } = apiEnv();
    await db.addSchedule(env, { days: "12345", start_time: "08:00", end_time: "18:00", profile_id: null });
    const id = (await db.listSchedules(env))[0].id;
    expect((await api(env, "PUT", `/schedules/${id}`, { end: "20:00", profileId: 1 })).status).toBe(200);
    expect(await db.listSchedules(env)).toEqual([expect.objectContaining({ days: "12345", end_time: "20:00", profile_id: 1 })]);
    expect(await audits(env, "schedule.edit")).toHaveLength(1);
    const merged = await api(env, "PUT", `/schedules/${id}`, { start: "21:00" });
    expect(merged.status).toBe(400); // 21:00 is after the existing 20:00 end
    expect(merged.json.error.field).toBe("end");
    expect((await db.listSchedules(env))[0].start_time).toBe("08:00");
    expect((await api(env, "PUT", `/schedules/${id}`, { enabled: false })).status).toBe(200);
    expect((await db.listSchedules(env))[0].enabled).toBe(0);
    expect(await audits(env, "schedule.disable")).toHaveLength(1);
    await api(env, "PUT", `/schedules/${id}`, { enabled: true });
    expect(await audits(env, "schedule.enable")).toHaveLength(1);
    expect((await api(env, "PUT", `/schedules/${id}`, { enabled: "yes" })).status).toBe(400);
    expect((await api(env, "PUT", `/schedules/${id}`, { profileId: 999 })).status).toBe(404);
    expect((await api(env, "PUT", "/schedules/999", { enabled: true })).status).toBe(404);
  });

  it("deletes one: 200, then 404", async () => {
    const { env } = apiEnv();
    await db.addSchedule(env, { days: "1", start_time: "08:00", end_time: "09:00", profile_id: null });
    const id = (await db.listSchedules(env))[0].id;
    expect((await api(env, "DELETE", `/schedules/${id}`)).status).toBe(200);
    expect(await audits(env, "schedule.delete")).toHaveLength(1);
    expect((await api(env, "DELETE", `/schedules/${id}`)).status).toBe(404);
  });
});

describe("POST /lock/release", () => {
  it("releases a held lock, audits it and leaves a note", async () => {
    const { env } = apiEnv();
    await acquireLock(env, "run-9");
    const r = await api(env, "POST", "/lock/release");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect((await lockStatus(env)).held).toBe(false);
    expect((await audits(env, "lock.release"))[0].target).toBe("run-9");
    expect((await db.listAlerts(env, 5)).some((a) => /Run lock released by hand/.test(a.message))).toBe(true);
  });
});
