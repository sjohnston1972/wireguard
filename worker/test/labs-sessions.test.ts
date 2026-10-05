// labs-sessions.test.ts
//
// Plain English: plan L2.1. Deploying a lab: a session takes the lowest free
// slot of the pool in one statement, the lab's own run lock, and a lab.yml
// dispatch with the §5 payload. Races between labs, the 32-slot limit and
// labs_max_running are refused before anything is reserved or dispatched.

import { afterEach, describe, expect, it, vi } from "vitest";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { acquireLock, lockStatus, labLock } from "../src/lock";
import { reserveSlot } from "../src/labs/store";
import { sessionTimeoutMin, slotCidr } from "../../shared/labs";
import { api, deployLab, freeze, labDispatches, labEnv, labRun, NOW, rows, session, TEST_LABS } from "./labs-helpers";

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sessions and slots (L2.1)", () => {
  it("deploy reserves the lowest free slot in one statement", async () => {
    freeze();
    const { env } = await labEnv();
    // Slot 0 is held by an older dirty session; 1 is free.
    await env.DB.prepare("UPDATE lab_slots SET session_id = 'ls-old', since = ?1 WHERE slot = 0").bind(NOW).run();
    const r = await deployLab(env, "az104-05-storage");
    expect(r.status, r.text).toBe(200);
    const s = await session(env, r.json.sessionId);
    expect(s).toMatchObject({ slot: 1, cidr: slotCidr(1), state: "deploying", lab_id: "az104-05-storage", lab_version: 1, test: 0 });
    expect((await rows(env, "SELECT slot FROM lab_slots WHERE session_id = ?1", r.json.sessionId)).map((x) => x.slot)).toEqual([1]);
    // reserveSlot is one UPDATE ... RETURNING: two callers never get the same slot.
    const [a, b] = await Promise.all([reserveSlot(env, "ls-a", NOW, 5), reserveSlot(env, "ls-b", NOW, 5)]);
    expect(a?.slot).not.toBe(b?.slot);
    expect([a?.slot, b?.slot].sort()).toEqual([2, 3]);
  });

  it("two deploys of different labs at once get different slots", async () => {
    freeze();
    const { env, world } = await labEnv();
    const [x, y] = await Promise.all([deployLab(env, "az104-05-storage"), deployLab(env, "az104-07-files")]);
    expect([x.status, y.status]).toEqual([200, 200]);
    const slots = await rows<{ slot: number }>(env, "SELECT slot FROM lab_sessions ORDER BY slot");
    expect(slots.map((s) => s.slot)).toEqual([0, 1]);
    expect(labDispatches(world).map((d) => d.payload.slot_cidr).sort()).toEqual([slotCidr(0), slotCidr(1)]);
  });

  it("the 33rd concurrent session gets no slot and nothing is dispatched", async () => {
    freeze();
    const { env, world } = await labEnv();
    await env.DB.prepare("UPDATE lab_slots SET session_id = 'ls-held-' || slot, since = ?1").bind(NOW).run();
    const r = await deployLab(env, "az104-05-storage");
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/slot/i);
    expect(labDispatches(world)).toHaveLength(0);
    expect(await rows(env, "SELECT * FROM lab_sessions")).toHaveLength(0);
    expect(await rows(env, "SELECT * FROM lab_runs")).toHaveLength(0);
    // The lab's lock was not left behind.
    expect((await lockStatus(env, labLock("az104-05-storage"))).held).toBe(false);
  });

  it("a second deploy of the same lab while its lock is held is 409 and reserves nothing", async () => {
    freeze();
    const { env, world } = await labEnv();
    await acquireLock(env, "lab-destroy-20261004115900-aaaa", { name: labLock("az104-05-storage"), ttlMs: 60 * 60_000 });
    const r = await deployLab(env, "az104-05-storage");
    expect(r.status).toBe(409);
    expect(await rows(env, "SELECT * FROM lab_sessions")).toHaveLength(0);
    expect((await rows<{ n: number }>(env, "SELECT COUNT(*) AS n FROM lab_slots WHERE session_id IS NOT NULL"))[0].n).toBe(0);
    expect(labDispatches(world)).toHaveLength(0);
    // And a lab with a live session refuses another deploy too.
    const first = await deployLab(env, "az104-07-files");
    expect(first.status).toBe(200);
    const again = await deployLab(env, "az104-07-files");
    expect(again.status).toBe(409);
    expect(await rows(env, "SELECT * FROM lab_sessions WHERE lab_id = 'az104-07-files'")).toHaveLength(1);
  });

  it("labs_max_running refuses the fourth", async () => {
    freeze();
    const { env, world } = await labEnv();
    for (const id of ["az104-05-storage", "az104-06-blob-security", "az104-07-files"]) expect((await deployLab(env, id)).status, id).toBe(200);
    const fourth = await deployLab(env, "az104-01-identity");
    expect(fourth.status).toBe(409);
    expect(fourth.json.error.message).toMatch(/3 labs/);
    expect(labDispatches(world)).toHaveLength(3);
    expect((await rows<{ n: number }>(env, "SELECT COUNT(*) AS n FROM lab_slots WHERE session_id IS NOT NULL"))[0].n).toBe(3);
    // The setting moves the limit.
    expect((await api(env, "PUT", "/settings", { labs_max_running: 4 })).status).toBe(200);
    expect((await deployLab(env, "az104-01-identity")).status).toBe(200);
    // An ended_dirty session holds its slot but is not running.
    await env.DB.prepare("UPDATE lab_sessions SET state = 'ended_dirty' WHERE lab_id = 'az104-01-identity'").run();
    expect((await deployLab(env, "az305-28-hub-spoke-fw", { hours: 2, peer: true, overBudgetOk: true })).status).toBe(200);
  });

  it("ids are ls- and lab-<action>- stamps", async () => {
    freeze();
    const { env } = await labEnv();
    const r = await deployLab(env, "az104-05-storage");
    expect(r.json.sessionId).toMatch(/^ls-20261004120000-[a-z0-9]{6}$/);
    expect(r.json.runId).toMatch(/^lab-deploy-20261004120000-[a-z0-9]{6}$/);
    const run = await labRun(env, r.json.runId);
    expect(run).toMatchObject({ session_id: r.json.sessionId, lab_id: "az104-05-storage", action: "deploy", status: "queued", requested_by: "dev@localhost" });
  });

  it("name_prefix is l + lab number + 5 lowercase", async () => {
    freeze();
    const { env } = await labEnv();
    const r = await deployLab(env, "az104-05-storage");
    expect((await session(env, r.json.sessionId))!.name_prefix).toMatch(/^l05[a-z0-9]{5}$/);
    const r28 = await deployLab(env, "az305-28-hub-spoke-fw", { hours: 1, peer: true, overBudgetOk: true });
    expect((await session(env, r28.json.sessionId))!.name_prefix).toMatch(/^l28[a-z0-9]{5}$/);
  });

  it("deploy dispatches lab.yml with the §5 payload, catalogue version and timeout", async () => {
    freeze();
    const { env, world } = await labEnv();
    const r = await deployLab(env, "az104-06-blob-security", { hours: 3, peer: true, region: "ukwest" });
    expect(r.status).toBe(200);
    const d = labDispatches(world);
    expect(d).toHaveLength(1);
    expect(d[0].action).toBe("deploy");
    const s = (await session(env, r.json.sessionId))!;
    expect(d[0].payload).toEqual({
      lab_id: "az104-06-blob-security",
      version: 1,
      run_id: r.json.runId,
      session_id: r.json.sessionId,
      region: "ukwest",
      secondary_region: null,
      slot_cidr: slotCidr(0),
      name_prefix: s.name_prefix,
      peering: true,
      timeout_min: sessionTimeoutMin(TEST_LABS[2].timing),
      callback_url: "http://localhost:8787/api/callback/lab",
      secrets_url: "http://localhost:8787/api/callback/lab-secrets",
    });
    // Nothing secret travels in the public payload; the gateway's workflow is never touched.
    expect(JSON.stringify(d[0].payload)).not.toMatch(/password|token/i);
    expect(world.dispatches.filter((x) => x.workflow !== "lab.yml")).toHaveLength(0);
    expect(s).toMatchObject({ peering: "waiting", region: "ukwest", requested_at: NOW, max_until: "2026-10-04T18:00:00.000Z", auto_destroy_at: null, est_gbp_h: 0.0077 });
    // Hours above the lab's max_h are refused with the field.
    const tooLong = await deployLab(env, "az104-05-storage", { hours: 7, peer: false });
    expect(tooLong.status).toBe(400);
    expect(tooLong.json.error.field).toBe("hours");
    // Peering off labs never peer; required ones always do.
    const off = await deployLab(env, "az104-05-storage", { hours: 1, peer: true });
    expect(labDispatches(world).at(-1)!.payload.peering).toBe(false);
    expect((await session(env, off.json.sessionId))!.peering).toBe("off");
  });

  it("a lab needing permissions is unavailable until the check passes", async () => {
    freeze();
    const { env, world } = await labEnv();
    await env.STATUS.put("labs:permissions", JSON.stringify({ checkedAt: NOW, role: true, users: false, groups: false, message: "Graph refused" }));
    const r = await deployLab(env, "az104-06-blob-security");
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("unavailable");
    expect(r.json.error.message).toMatch(/permission/i);
    // A lab that needs nothing extra still deploys.
    expect((await deployLab(env, "az104-05-storage")).status).toBe(200);
    expect(labDispatches(world)).toHaveLength(1);
    // Never checked: unavailable too.
    await env.STATUS.delete("labs:permissions");
    expect((await deployLab(env, "az104-01-identity")).status).toBe(409);
    const cards = (await api(env, "GET", "/labs")).json;
    expect(cards.labs.find((c: { id: string }) => c.id === "az104-01-identity").unavailable).toMatch(/permission/i);
  });

  it("the lab lock TTL is timeout_min + 15 minutes", async () => {
    freeze();
    const { env } = await labEnv();
    const r = await deployLab(env, "az104-06-blob-security");
    const lock = await lockStatus(env, labLock("az104-06-blob-security"));
    expect(lock.lock?.runId).toBe(r.json.runId);
    expect(lock.lock?.expiresAt).toBe(Date.parse(NOW) + (sessionTimeoutMin(TEST_LABS[2].timing) + 15) * 60_000);
    // The gateway's lock is untouched.
    expect((await lockStatus(env)).held).toBe(false);
  });

  it("a dispatch GitHub refuses frees the slot, releases the lock and ends the session with a reason", async () => {
    freeze();
    const { env } = await labEnv({ GITHUB_TOKEN: "gh-test" });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/lab.yml/dispatches")) return new Response("nope", { status: 422 });
      return real(input, init);
    });
    const r = await deployLab(env, "az104-05-storage");
    expect(r.status).toBe(502);
    const s = (await rows(env, "SELECT * FROM lab_sessions"))[0];
    expect(s).toMatchObject({ state: "ended", end_reason: "failed" });
    expect((await rows<{ n: number }>(env, "SELECT COUNT(*) AS n FROM lab_slots WHERE session_id IS NOT NULL"))[0].n).toBe(0);
    expect((await lockStatus(env, labLock("az104-05-storage"))).held).toBe(false);
  });
});
