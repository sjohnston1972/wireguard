// The watchman's safety nets, on the harness: a failed run that left a VM
// behind, a hibernate that never finished, the home site keeping the VM
// "busy", a refused KV mirror write, racing pollers, and the clock changes.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import type { Env } from "../src/env";
import * as db from "../src/db";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent, sessionSummary } from "../src/runs";
import { startHibernate, refreshPower } from "../src/standby";
import { runScheduled, FAILED_GRACE_MINUTES } from "../src/monitor";
import { runSchedules, windowNow, londonInstant } from "../src/schedule";
import { getSnapshot, saveSnapshot, saveSnapshotIf } from "../src/state";

let env: Env;
let world: World;
beforeEach(() => {
  ({ env, world } = makeEnv());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const PHONE = "P".repeat(43) + "=";
const HOME = "H".repeat(43) + "=";
const secs = () => Math.floor(Date.now() / 1000);
const DUMP = (lines: string[]) => ["PRIV\tS=\t51820\toff", ...lines].join("\n");

async function toRunning(hours: number | null = 4) {
  await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
  const run = await startDeploy(env, { hours, requesterIp: null, requestedBy: "steven" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return sec.body.agent_token as string;
}

async function addSite() {
  await env.DB.prepare("INSERT INTO peers (name, public_key, ip, enabled, full_tunnel, azure_vnet, tunnel_dns, routes, home_lan, created_at) VALUES ('home-site', ?1, '10.13.13.10', 1, 0, 0, 0, '192.168.1.0/24', 0, 'x')").bind(HOME).run();
}

describe("a failed run that left a VM in Azure (#20)", () => {
  it("is torn down after the grace period, with a push", async () => {
    await toRunning();
    await saveSnapshot(env, { state: "failed", error: "boom", since: new Date(Date.now() - (FAILED_GRACE_MINUTES + 5) * 60_000).toISOString() });
    const before = world.dispatches.length;
    await runScheduled(env);
    expect(world.dispatches.length).toBe(before + 1);
    expect(world.dispatches.at(-1)!.action).toBe("destroy");
    expect((await getSnapshot(env)).state).toBe("destroying");
    expect(world.notes.find((n) => /failed run/.test(n.title))).toBeTruthy();
    expect((await db.listAlerts(env)).some((a) => a.kind === "cost_guard" && /failed/.test(a.message))).toBe(true);
  });

  it("waits out the grace period first", async () => {
    await toRunning();
    await saveSnapshot(env, { state: "failed", error: "boom", since: new Date(Date.now() - 5 * 60_000).toISOString() });
    const before = world.dispatches.length;
    await runScheduled(env);
    expect(world.dispatches.length).toBe(before);
    expect((await getSnapshot(env)).state).toBe("failed");
  });

  it("does nothing when Azure is already empty", async () => {
    await toRunning();
    world.azure.rg = false;
    await saveSnapshot(env, { state: "failed", error: "boom", since: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    const before = world.dispatches.length;
    await runScheduled(env);
    expect(world.dispatches.length).toBe(before);
  });
});

describe("a hibernate that never finishes (#21)", () => {
  it("goes back to Running with its auto-destroy deadline restored", async () => {
    await toRunning(4);
    const deadline = (await getSnapshot(env)).auto_destroy_at;
    expect(deadline).toBeTruthy();
    await startHibernate(env, "steven", "test");
    expect((await getSnapshot(env)).auto_destroy_at).toBeNull();
    world.azure.power = "running"; // Azure never deallocates
    await refreshPower(env, Date.now() + 16 * 60_000);
    const snap = await getSnapshot(env);
    expect(snap.state).toBe("running");
    expect(snap.auto_destroy_at).toBe(deadline);
  });

  it("and so the timer (or the cost guard) still fires if the deadline has passed", async () => {
    await toRunning(4);
    await saveSnapshot(env, { auto_destroy_at: new Date(Date.now() - 60_000).toISOString() });
    const dep = await db.currentDeployment(env);
    await db.updateRun(env, dep!.id, { auto_destroy_at: new Date(Date.now() - 60_000).toISOString() });
    await startHibernate(env, "watchman", "auto-destroy timer");
    world.azure.power = "running";
    await refreshPower(env, Date.now() + 16 * 60_000);
    expect((await getSnapshot(env)).auto_destroy_at).toBeTruthy();
    await runScheduled(env, new Date(Date.now() + 17 * 60_000));
    expect(world.dispatches.at(-1)!.action).toBe("destroy");
  });
});

describe("the home site is not a user (#22)", () => {
  it("idle tear-down fires while only the site is connected", async () => {
    ({ env, world } = makeEnv({ IDLE_DESTROY_MINUTES: "30" } as Partial<Env>));
    await addSite();
    const token = await toRunning(null);
    // The phone last connected an hour ago; the site shook hands just now.
    await handleAgent(env, token, { dump: DUMP([`${PHONE}\t(none)\t203.0.113.25:4000\t10.13.13.2/32\t${secs() - 3600}\t1\t1\t0`, `${HOME}\t(none)\t203.0.113.9:4000\t10.13.13.10/32,192.168.1.0/24\t${secs() - 30}\t1\t1\t25`]) });
    await saveSnapshot(env, { running_since: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    await runScheduled(env);
    expect(world.dispatches.at(-1)!.action).toBe("destroy");
    expect((await db.listAlerts(env)).some((a) => a.kind === "idle")).toBe(true);
  });

  it("but a real client still counts", async () => {
    ({ env, world } = makeEnv({ IDLE_DESTROY_MINUTES: "30" } as Partial<Env>));
    await addSite();
    const token = await toRunning(null);
    await handleAgent(env, token, { dump: DUMP([`${PHONE}\t(none)\t203.0.113.25:4000\t10.13.13.2/32\t${secs() - 60}\t1\t1\t0`]) });
    await saveSnapshot(env, { running_since: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    await runScheduled(env);
    expect(world.dispatches.at(-1)!.action).toBe("apply");
  });

  it("the session summary leaves the site out of 'Used by'", async () => {
    await addSite();
    const token = await toRunning();
    await handleAgent(env, token, { dump: DUMP([`${PHONE}\t(none)\t203.0.113.25:4000\t10.13.13.2/32\t${secs() - 10}\t1\t1\t0`, `${HOME}\t(none)\t203.0.113.9:4000\t10.13.13.10/32,192.168.1.0/24\t${secs() - 10}\t1\t1\t25`]) });
    const text = await sessionSummary(env, await getSnapshot(env), "Torn down");
    expect(text).toMatch(/Used by Phone\./);
    expect(text).not.toMatch(/home-site/);
  });
});

describe("the KV status mirror (#25)", () => {
  it("a refused KV write does not stop a state change", async () => {
    const put = env.STATUS.put.bind(env.STATUS);
    env.STATUS.put = (async (k: string, v: string, o?: unknown) => {
      if (k === "status") throw new Error("429 Too Many Requests");
      return (put as any)(k, v, o);
    }) as typeof env.STATUS.put;
    const snap = await saveSnapshot(env, { state: "running", public_ip: "20.0.0.10" });
    expect(snap.state).toBe("running");
    expect((await getSnapshot(env)).public_ip).toBe("20.0.0.10");
  });
});

describe("standby is announced once (#30)", () => {
  it("saveSnapshotIf only lets one caller through", async () => {
    await saveSnapshot(env, { state: "hibernating" });
    const [a, b] = await Promise.all([saveSnapshotIf(env, "hibernating", { state: "standby" }), saveSnapshotIf(env, "hibernating", { state: "standby" })]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await saveSnapshotIf(env, "running", { state: "destroyed" })).toBeNull();
    expect((await getSnapshot(env)).state).toBe("standby");
  });

  it("two pollers seeing 'deallocated' at once send one notification", async () => {
    await toRunning();
    await startHibernate(env, "steven", "test");
    world.azure.power = "deallocated";
    await Promise.all([refreshPower(env), refreshPower(env), refreshPower(env)]);
    expect(world.notes.filter((n) => n.title === "wg-admin: in standby")).toHaveLength(1);
    expect((await db.listAlerts(env)).filter((a) => a.kind === "session")).toHaveLength(1);
    expect((await getSnapshot(env)).state).toBe("standby");
  });
});

describe("schedules across the clock changes (#27)", () => {
  // 2026: clocks go forward Sunday 29 March at 01:00 GMT, back Sunday 25 October at 02:00 BST (01:00 UTC).
  const sunday = "7";
  it("finds the real moment for a UK clock time", () => {
    expect(new Date(londonInstant("2026-03-28", "09:00")).toISOString()).toBe("2026-03-28T09:00:00.000Z"); // GMT
    expect(new Date(londonInstant("2026-03-30", "09:00")).toISOString()).toBe("2026-03-30T08:00:00.000Z"); // BST
    expect(new Date(londonInstant("2026-03-29", "01:30")).toISOString()).toBe("2026-03-29T01:30:00.000Z"); // skipped: 02:30 BST
    expect(new Date(londonInstant("2026-10-25", "01:30")).toISOString()).toBe("2026-10-25T00:30:00.000Z"); // twice: the first
    expect(new Date(londonInstant("2026-10-25", "02:00")).toISOString()).toBe("2026-10-25T02:00:00.000Z"); // GMT again
  });

  it("spring forward: a window across the change is an hour shorter in real time", () => {
    // 00:30-03:00 on the clock is 00:30 GMT to 03:00 BST: 90 real minutes, not 150.
    const w = windowNow({ days: sunday, start_time: "00:30", end_time: "03:00" }, new Date("2026-03-29T00:30:00Z"));
    expect(w).toMatchObject({ open: true, minutesLeft: 90, date: "2026-03-29" });
  });

  it("spring forward: a window that starts in the skipped hour still opens", () => {
    const rule = { days: sunday, start_time: "01:00", end_time: "01:45" };
    // The clock jumps from 00:59 GMT to 02:00 BST; the window runs 01:00-01:45 UTC.
    expect(windowNow(rule, new Date("2026-03-29T00:55:00Z")).open).toBe(false);
    expect(windowNow(rule, new Date("2026-03-29T01:10:00Z"))).toMatchObject({ open: true, minutesLeft: 35 });
    expect(windowNow(rule, new Date("2026-03-29T01:45:00Z")).open).toBe(false);
  });

  it("fall back: a window across the change is an hour longer in real time", () => {
    // 01:00-02:00 on the clock: 01:00 BST (00:00 UTC) to 02:00 GMT (02:00 UTC) is two real hours.
    const rule = { days: sunday, start_time: "01:00", end_time: "02:00" };
    expect(windowNow(rule, new Date("2026-10-25T00:00:00Z"))).toMatchObject({ open: true, minutesLeft: 120 });
    expect(windowNow(rule, new Date("2026-10-25T00:30:00Z"))).toMatchObject({ open: true, minutesLeft: 90 }); // 01:30 BST
    expect(windowNow(rule, new Date("2026-10-25T01:30:00Z"))).toMatchObject({ open: true, minutesLeft: 30 }); // 01:30 GMT
    expect(windowNow(rule, new Date("2026-10-25T02:00:00Z")).open).toBe(false);
  });

  it("an ordinary day is unchanged", () => {
    expect(windowNow({ days: "3", start_time: "08:00", end_time: "18:00" }, new Date("2026-09-23T08:30:00Z"))).toMatchObject({ open: true, minutesLeft: 510 });
  });

  it("the watchman sets the timer to the window's real end on a change day", async () => {
    await db.addSchedule(env, { days: sunday, start_time: "00:30", end_time: "03:00", profile_id: null });
    await runSchedules(env, new Date("2026-03-29T00:30:00Z"));
    const left = (Date.parse((await getSnapshot(env)).auto_destroy_at!) - Date.now()) / 60_000;
    expect(left).toBeGreaterThan(88);
    expect(left).toBeLessThan(92);
  });
});
