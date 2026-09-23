// Whole journeys through the Worker, on the harness (see harness.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import type { Env } from "../src/env";
import * as db from "../src/db";
import { startDeploy, startDestroy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";
import { startHibernate, startResume, refreshPower } from "../src/standby";
import { runScheduled } from "../src/monitor";
import { getSnapshot, saveSnapshot } from "../src/state";
import { consumeAction } from "../src/actions";
import { lockStatus } from "../src/lock";

let env: Env;
let world: World;

beforeEach(() => {
  ({ env, world } = makeEnv());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const DUMP = (peers: string[] = []) => ["PRIV\tS=\t51820\toff", ...peers].join("\n");
const selftest = (over: Record<string, unknown> = {}) => ({ at: new Date().toISOString(), ms: 4100, handshake: true, tunnel: true, loopback: true, dns: true, internet: true, internet6: true, ...over });

/** Deploy, let GitHub collect its secrets and call back: the VM is Running. */
async function deployToRunning(hours: number | null = 4) {
  await db.addPeer(env, { name: "Phone", public_key: "P".repeat(43) + "=", ip: "10.13.13.2", full_tunnel: false });
  const run = await startDeploy(env, { hours, requesterIp: "203.0.113.25", requestedBy: "steven" });
  const secrets = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  const cb = await handleCallback(env, secrets.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  expect(cb.status).toBe(200);
  return { run, agentToken: secrets.body.agent_token as string };
}

describe("deploy never puts secrets in the public dispatch", () => {
  it("dispatches no token, password or home address; GitHub collects them once, over OIDC", async () => {
    const run = await startDeploy(env, { hours: 4, requesterIp: "203.0.113.25", requestedBy: "steven" });
    const sent = JSON.stringify(world.dispatches[0].payload);
    for (const word of ["token", "password", "203.0.113.25"]) expect(sent).not.toContain(word);
    expect(world.dispatches[0].payload.secrets_url).toBe("https://wg-admin.example/api/callback/secrets");

    const first = await issueRunSecrets(env, run.id, lastGhRun(world));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ssh_allowed_cidr: "203.0.113.25/32" });
    expect(String(first.body.agent_token)).toMatch(/^[0-9a-f]{64}$/);
    expect(first.body.ssh_password).toBe((await db.getRun(env, run.id))!.ssh_password);

    expect((await issueRunSecrets(env, run.id, lastGhRun(world))).status).toBe(409);
  });

  it("refuses a GitHub run that is not this dispatch", async () => {
    const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
    world.ghRuns.set(42, { id: 42, display_title: "wg apply someone-else", status: "in_progress", conclusion: null, html_url: "", created_at: "" });
    expect((await issueRunSecrets(env, run.id, 42)).status).toBe(403);
  });

  it("only stores token hashes", async () => {
    const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
    const s = await issueRunSecrets(env, run.id, lastGhRun(world));
    const row = (await db.getRun(env, run.id))!;
    expect(row.agent_token_hash).not.toBe(s.body.agent_token);
    expect(row.payload_json).not.toContain(String(s.body.agent_token));
  });
});

describe("running: heartbeat, self-test, latency", () => {
  it("says Ready only when the self-test passes, and records latency and the peer list with IPv6", async () => {
    const { agentToken } = await deployToRunning();
    expect((await getSnapshot(env)).state).toBe("running");
    expect(world.notes.find((n) => n.title === "wg-admin: ready")).toBeUndefined();

    const key = "P".repeat(43) + "=";
    const now = Math.floor(Date.now() / 1000);
    const r = await handleAgent(env, agentToken, {
      dump: DUMP([`${key}\t(none)\t203.0.113.25:4000\t10.13.13.2/32,fd13:13::2/128\t${now}\t100\t200\t25`, `CANARY=\t(none)\t127.0.0.1:1\t10.13.13.254/32,fd13:13::fe/128\t${now}\t1\t1\t1`]),
      selftest: selftest(),
      rtt: { [key]: 23.4 },
      wan6: "2001:db8::10",
    });
    expect(r.body).toEqual({ peers: [{ name: "Phone", host: "phone", public_key: key, allowed_ips: "10.13.13.2/32,fd13:13::2/128" }] });
    const snap = await getSnapshot(env);
    expect(snap.agent!.peers.map((p) => p.public_key)).toEqual([key]); // the canary is left out
    expect(snap.latency[key]).toEqual([23.4]);
    expect(snap.session!.seen).toEqual([key]);
    const ready = world.notes.find((n) => n.title === "wg-admin: ready");
    expect(ready?.message).toContain("IPv6");
    expect(ready?.actions?.[0]).toMatchObject({ action: "view" });
  });

  it("warns loudly when the self-test fails", async () => {
    const { agentToken } = await deployToRunning();
    await handleAgent(env, agentToken, { dump: DUMP(), selftest: selftest({ internet: false }) });
    const n = world.notes.find((x) => x.title?.includes("self-test failed"));
    expect(n?.message).toContain("internet (IPv4)");
    expect(n?.priority).toBe(4);
  });
});

describe("the timer: heads-up with buttons, then expiry", () => {
  it("sends one heads-up with Extend / Hibernate buttons; Extend works once", async () => {
    await deployToRunning();
    await saveSnapshot(env, { auto_destroy_at: new Date(Date.now() + 10 * 60_000).toISOString() });
    await runScheduled(env);
    await runScheduled(env);
    const warns = world.notes.filter((n) => /tearing down in/.test(n.title));
    expect(warns).toHaveLength(1);
    expect(warns[0].actions.map((a: any) => a.label)).toEqual(["Extend 1h", "Hibernate", "Open dashboard"]);

    const token = warns[0].actions[0].url.split("/").pop();
    expect(await consumeAction(env, token)).toBe("extend");
    expect(await consumeAction(env, token)).toBeNull(); // single use
  });

  it("tears down at the deadline by default", async () => {
    await deployToRunning();
    await saveSnapshot(env, { auto_destroy_at: new Date(Date.now() - 60_000).toISOString() });
    await runScheduled(env);
    expect(world.dispatches.at(-1)!.action).toBe("destroy");
    expect((await getSnapshot(env)).state).toBe("destroying");
  });

  it("hibernates at the deadline when Settings says so, but the cost guard still destroys", async () => {
    await db.setSetting(env, "expiry_action", "hibernate");
    await deployToRunning();
    await saveSnapshot(env, { auto_destroy_at: new Date(Date.now() - 60_000).toISOString() });
    await runScheduled(env);
    expect(world.powerCalls).toEqual(["deallocate"]);
    expect((await getSnapshot(env)).state).toBe("hibernating");

    const g = makeEnv();
    ({ env, world } = g);
    await db.setSetting(env, "expiry_action", "hibernate");
    await deployToRunning();
    await saveSnapshot(env, { auto_destroy_at: new Date(Date.now() - 20 * 60_000).toISOString() });
    await runScheduled(env);
    expect(world.powerCalls).toEqual([]);
    expect(world.dispatches.at(-1)!.action).toBe("destroy");
  });
});

describe("warm standby", () => {
  it("hibernate -> standby -> resume -> running, holding the lock throughout and summarising the session", async () => {
    const { agentToken } = await deployToRunning();
    const key = "P".repeat(43) + "=";
    const now = Math.floor(Date.now() / 1000);
    await handleAgent(env, agentToken, { dump: DUMP([`${key}\t(none)\t203.0.113.25:4000\t10.13.13.2/32\t${now}\t2048\t4096\t25`]), selftest: selftest() });

    await startHibernate(env, "steven", "test");
    expect((await getSnapshot(env)).state).toBe("hibernating");
    expect((await lockStatus(env)).held).toBe(true);
    await expect(startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "x" })).rejects.toThrow(/in progress/);

    world.azure.power = "deallocated";
    await refreshPower(env);
    let snap = await getSnapshot(env);
    expect(snap.state).toBe("standby");
    expect(snap.standby_since).toBeTruthy();
    expect((await lockStatus(env)).held).toBe(false);
    const standbyNote = world.notes.find((n) => n.title === "wg-admin: in standby");
    expect(standbyNote?.message).toMatch(/Used by Phone/);
    expect(standbyNote?.actions.map((a: any) => a.label)).toEqual(["Resume from dashboard", "Tear down"]);
    await expect(startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "x" })).rejects.toThrow(/Standby/);

    await startResume(env, "steven", 2);
    expect(world.powerCalls).toEqual(["deallocate", "start"]);
    snap = await getSnapshot(env);
    expect(snap.state).toBe("resuming");
    expect(Date.parse(snap.auto_destroy_at!)).toBeGreaterThan(Date.now() + 110 * 60_000);

    world.azure.power = "running";
    await handleAgent(env, agentToken, { dump: DUMP(), selftest: selftest() });
    snap = await getSnapshot(env);
    expect(snap.state).toBe("running");
    expect(snap.standby_since).toBeNull();
    expect((await lockStatus(env)).held).toBe(false);
    expect(world.notes.filter((n) => n.title === "wg-admin: ready")).toHaveLength(2); // one per boot
  });

  it("tears a forgotten standby down after the limit", async () => {
    await deployToRunning();
    await saveSnapshot(env, { state: "standby", standby_since: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    world.azure.power = "deallocated";
    await runScheduled(env);
    expect(world.dispatches.at(-1)!.action).toBe("destroy");
  });

  it("flags drift when a standby VM is actually running", async () => {
    await deployToRunning();
    await saveSnapshot(env, { state: "standby", standby_since: new Date().toISOString() });
    world.azure.power = "running";
    await runScheduled(env);
    expect((await getSnapshot(env)).drift).toMatch(/full rate/);
  });
});

describe("tear down", () => {
  it("sends a session summary and clears the snapshot", async () => {
    const { agentToken } = await deployToRunning();
    await handleAgent(env, agentToken, { dump: DUMP(), selftest: selftest() });
    const run = await startDestroy(env, "steven", "test");
    const s = await issueRunSecrets(env, run.id, lastGhRun(world));
    expect(Object.keys(s.body)).toEqual(["callback_token"]); // a destroy gets nothing else
    world.azure.rg = false;
    await handleCallback(env, s.body.callback_token as string, { run_id: run.id, action: "destroy", status: "success" });
    const snap = await getSnapshot(env);
    expect(snap.state).toBe("destroyed");
    expect(snap.session).toBeNull();
    const n = world.notes.find((x) => x.title === "wg-admin: torn down");
    expect(n?.message).toMatch(/^Torn down after .*about £0\.\d\d\..*Azure cost is £0\.$/);
    expect((await db.listAlerts(env)).some((a) => a.kind === "session")).toBe(true);
  });
});
