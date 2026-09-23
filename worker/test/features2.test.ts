// Profiles, moves, schedules, speed test and site-to-site, on the harness.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import type { Env } from "../src/env";
import * as db from "../src/db";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";
import { startMove } from "../src/profiles";
import { startSpeedTest } from "../src/speedtest";
import { runSchedules, windowNow, daysText, nextStart, validRule, londonClock } from "../src/schedule";
import { getSnapshot } from "../src/state";

let env: Env;
let world: World;
beforeEach(() => {
  ({ env, world } = makeEnv({ HOME_LAN_CIDR: "192.168.1.0/24" } as Partial<Env>));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const PHONE = "P".repeat(43) + "=";
const HOME = "H".repeat(43) + "=";
const now = () => Math.floor(Date.now() / 1000);
const DUMP = (lines: string[]) => ["PRIV\tS=\t51820\toff", ...lines].join("\n");

async function toRunning(opts: Partial<Parameters<typeof startDeploy>[1]> = {}) {
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven", ...opts });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return sec.body.agent_token as string;
}

async function finishDestroy() {
  const snap = await getSnapshot(env);
  const sec = await issueRunSecrets(env, snap.run_id!, lastGhRun(world));
  world.azure.rg = false;
  await handleCallback(env, sec.body.callback_token as string, { run_id: snap.run_id!, action: "destroy", status: "success" });
}

describe("profiles", () => {
  it("come seeded, and a deploy from one uses its region and size", async () => {
    const ps = await db.listProfiles(env);
    expect(ps.map((p) => p.name)).toEqual(["UK", "US exit", "EU exit"]);
    await toRunning({ region: "eastus", vmSize: "Standard_B1ms", profile: "US exit" });
    expect(world.dispatches[0].payload).toMatchObject({ region: "eastus", vm_size: "Standard_B1ms" });
    expect(await getSnapshot(env)).toMatchObject({ region: "eastus", vm_size: "Standard_B1ms", profile: "US exit" });
  });

  it("Move tears down, then builds the new profile as soon as the tear-down lands", async () => {
    await toRunning({ region: "uksouth", vmSize: "Standard_B1s", profile: "UK" });
    const us = (await db.listProfiles(env)).find((p) => p.name === "US exit")!;
    const msg = await startMove(env, { profileId: us.id, hours: 2, by: "steven", requesterIp: null });
    expect(msg).toMatch(/Moving to US exit/);
    expect(world.dispatches.at(-1)!.action).toBe("destroy");
    expect((await getSnapshot(env)).pending_deploy).toMatchObject({ region: "eastus", profile: "US exit" });

    await finishDestroy();
    const last = world.dispatches.at(-1)!;
    expect(last.action).toBe("apply");
    expect(last.payload.region).toBe("eastus");
    const snap = await getSnapshot(env);
    expect(snap).toMatchObject({ state: "deploying", profile: "US exit", pending_deploy: null });
    expect(world.notes.find((n) => n.title === "wg-admin: torn down")).toBeUndefined(); // a move is not "back to £0"
  });

  it("refuses a move to where it already is", async () => {
    await toRunning({ region: "uksouth", vmSize: "Standard_B1s", profile: "UK" });
    const uk = (await db.listProfiles(env)).find((p) => p.name === "UK")!;
    await expect(startMove(env, { profileId: uk.id, hours: 2, by: "s", requesterIp: null })).rejects.toThrow(/Already running/);
  });
});

describe("schedules", () => {
  // 2026-09-23 is a Wednesday; London is on BST (UTC+1).
  const wed0930 = new Date("2026-09-23T08:30:00Z");
  it("read UK wall-clock time, clock changes included", () => {
    expect(londonClock(wed0930)).toMatchObject({ weekday: 3, minutes: 9 * 60 + 30, date: "2026-09-23" });
    expect(londonClock(new Date("2026-12-02T08:30:00Z")).minutes).toBe(8 * 60 + 30); // GMT in winter
  });
  it("know when a window is open and how long is left", () => {
    expect(windowNow({ days: "12345", start_time: "08:00", end_time: "18:00" }, wed0930)).toMatchObject({ open: true, minutesLeft: 510 });
    expect(windowNow({ days: "67", start_time: "08:00", end_time: "18:00" }, wed0930).open).toBe(false);
    expect(windowNow({ days: "12345", start_time: "10:00", end_time: "18:00" }, wed0930).open).toBe(false);
  });
  it("describe themselves and the next start", () => {
    expect(daysText("12345")).toBe("Mon–Fri");
    expect(daysText("67")).toBe("Sat, Sun");
    expect(daysText("1234567")).toBe("Every day");
    expect(nextStart([{ days: "12345", start_time: "10:00", enabled: 1 }], wed0930)).toBe("today 10:00");
    expect(nextStart([{ days: "12345", start_time: "08:00", enabled: 1 }], wed0930)).toBe("tomorrow 08:00");
    expect(nextStart([{ days: "1", start_time: "08:00", enabled: 1 }], wed0930)).toBe("Mon 08:00");
    expect(nextStart([{ days: "1", start_time: "08:00", enabled: 0 }], wed0930)).toBeNull();
  });
  it("validate", () => {
    expect(validRule("12345", "08:00", "18:00")).toBeNull();
    expect(validRule("", "08:00", "18:00")).toMatch(/day/);
    expect(validRule("1", "18:00", "08:00")).toMatch(/later/);
  });
  it("deploy once when a window opens, with the timer at the window's end", async () => {
    const us = (await db.listProfiles(env)).find((p) => p.name === "US exit")!;
    await db.addSchedule(env, { days: "3", start_time: "09:00", end_time: "12:00", profile_id: us.id });
    const notes = await runSchedules(env, wed0930);
    expect(notes[0]).toMatch(/Scheduled start/);
    expect(world.dispatches).toHaveLength(1);
    expect(world.dispatches[0].payload.region).toBe("eastus");
    const snap = await getSnapshot(env);
    const left = (Date.parse(snap.auto_destroy_at!) - Date.now()) / 60_000;
    expect(left).toBeGreaterThan(145); // 150 minutes left in the window, measured from "now"
    expect(left).toBeLessThan(155);
    // The same window does not fire twice in a day, even after a manual tear-down.
    await runSchedules(env, new Date("2026-09-23T09:00:00Z"));
    expect(world.dispatches).toHaveLength(1);
  });
});

describe("site-to-site and the speed test", () => {
  async function withSite() {
    await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    await env.DB.prepare("INSERT INTO peers (name, public_key, ip, enabled, full_tunnel, azure_vnet, tunnel_dns, routes, home_lan, created_at) VALUES ('home-site', ?1, '10.13.13.10', 1, 0, 0, 0, '192.168.1.0/24', 0, 'x')").bind(HOME).run();
  }

  it("the VM is told to route the home LAN to the site, and Terraform gets it at deploy", async () => {
    await withSite();
    const token = await toRunning();
    expect(JSON.parse(String(world.dispatches[0].payload.peers_json))).toContainEqual({ name: "home-site", public_key: HOME, ip: "10.13.13.10", routes: "192.168.1.0/24" });
    const r = await handleAgent(env, token, { dump: DUMP([]) });
    expect((r.body as any).peers.find((p: any) => p.name === "home-site").allowed_ips).toBe("10.13.13.10/32,fd13:13::a/128,192.168.1.0/24");
  });

  it("speed test: needs the site online, rides the heartbeat both ways, and is saved", async () => {
    await withSite();
    const token = await toRunning();
    await expect(startSpeedTest(env)).rejects.toThrow(/not connected/);

    const online = DUMP([`${HOME}\t(none)\t203.0.113.25:4000\t10.13.13.10/32,192.168.1.0/24\t${now()}\t1\t1\t25`]);
    await handleAgent(env, token, { dump: online });
    await startSpeedTest(env);
    await expect(startSpeedTest(env)).rejects.toThrow(/already running/);

    const r1 = await handleAgent(env, token, { dump: online });
    const req = (r1.body as any).speedtest;
    expect(req).toMatchObject({ target: "10.13.13.10" });

    const r2 = await handleAgent(env, token, { dump: online, speedtest_result: { id: req.id, down_bps: 183_400_000, up_bps: 41_950_000, rtt_ms: 24.1, jitter_ms: 2.3, error: null } });
    expect((r2.body as any).speedtest_ack).toBe(req.id);
    expect((r2.body as any).speedtest).toBeUndefined();
    const [t] = await db.listSpeedTests(env);
    expect(t).toMatchObject({ target_name: "home-site", down_mbps: 183.4, up_mbps: 42, rtt_ms: 24.1 });
    expect((await getSnapshot(env)).speedtest_req).toBeNull();
    // A repeated report of the same result is acknowledged but not saved twice.
    await handleAgent(env, token, { dump: online, speedtest_result: { id: req.id, down_bps: 1 } });
    expect(await db.listSpeedTests(env)).toHaveLength(1);
  });
});
