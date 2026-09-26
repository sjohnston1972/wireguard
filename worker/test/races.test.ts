// Races and state edges in the change-control desk (runs.ts), on the harness.
// Each test is one of the "two things happened at once" or "this arrived
// late" cases that used to leave the dashboard wrong.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import type { Env } from "../src/env";
import * as db from "../src/db";
import { startDeploy, startDestroy, issueRunSecrets, handleCallback, refreshActiveRun, reconcile, handleAgent, clearFirewallCounters } from "../src/runs";
import { getSnapshot, saveSnapshot } from "../src/state";
import { lockStatus } from "../src/lock";

let env: Env;
let world: World;
beforeEach(() => {
  ({ env, world } = makeEnv());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Deploy, collect secrets, call back: Running. Returns the agent token. */
async function toRunning() {
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return { run, agentToken: sec.body.agent_token as string };
}

/** Mark the latest GitHub run finished successfully, `msAgo` ago. */
function ghFinished(msAgo: number) {
  const r = world.ghRuns.get(lastGhRun(world))!;
  r.status = "completed";
  r.conclusion = "success";
  r.updated_at = ago(msAgo);
}

describe("SSH passwords are forgotten once the VM is gone (#15)", () => {
  it("clears every stored password when a tear-down completes", async () => {
    const { run } = await toRunning();
    expect((await db.getRun(env, run.id))!.ssh_password).toBeTruthy();
    const d = await startDestroy(env, "steven", "done");
    const sec = await issueRunSecrets(env, d.id, lastGhRun(world));
    world.azure.rg = false;
    await handleCallback(env, sec.body.callback_token as string, { run_id: d.id, action: "destroy", status: "success" });
    expect((await db.listRuns(env)).filter((r) => r.ssh_password)).toEqual([]);
  });
});

describe("a packet capture pending at tear-down (#29)", () => {
  const capture = async () => {
    await db.addCapture(env, { id: "cap-1", requested_by: "steven", iface: "wg0", filter: "", seconds: 30 });
    await saveSnapshot(env, { capture_req: { id: "cap-1", iface: "wg0", filter: "", seconds: 30, at: new Date().toISOString() } });
  };

  it("is marked failed when the VM is torn down", async () => {
    await toRunning();
    await capture();
    const d = await startDestroy(env, "steven", "done");
    const sec = await issueRunSecrets(env, d.id, lastGhRun(world));
    world.azure.rg = false;
    await handleCallback(env, sec.body.callback_token as string, { run_id: d.id, action: "destroy", status: "success" });
    expect(await db.getCapture(env, "cap-1")).toMatchObject({ status: "failed", error: "VM torn down" });
    expect((await getSnapshot(env)).capture_req).toBeNull();
  });

  it("is marked failed when a new deploy replaces it", async () => {
    await capture();
    await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven" });
    expect(await db.getCapture(env, "cap-1")).toMatchObject({ status: "failed" });
  });

  it("leaves a finished capture alone", async () => {
    await capture();
    await db.updateCapture(env, "cap-1", { status: "done" });
    await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven" });
    expect((await db.getCapture(env, "cap-1"))!.status).toBe("done");
  });
});

describe("Clean up (reconcile) during a run (#23)", () => {
  it("refuses while a deploy is still building, before the resource group exists", async () => {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven" });
    world.azure.rg = false;
    await expect(reconcile(env, "steven")).rejects.toThrow(/in progress/);
    expect((await db.getRun(env, run.id))!.finished_at).toBeNull();
    expect((await getSnapshot(env)).state).toBe("deploying");
    expect((await lockStatus(env)).held).toBe(true);
  });

  it("refuses while a tear-down is running", async () => {
    await toRunning();
    await startDestroy(env, "steven", "done");
    await expect(reconcile(env, "steven")).rejects.toThrow(/in progress/);
  });

  it("drops a queued Move and summary when it finds Azure empty", async () => {
    await toRunning();
    await saveSnapshot(env, { state: "failed", pending_deploy: { region: "eastus", vm_size: "Standard_B1s", profile: "US exit", hours: 2, requested_by: "steven", requester_ip: null }, pending_summary: "Torn down." });
    world.azure.rg = false;
    expect(await reconcile(env, "steven")).toMatch(/State set to Destroyed/);
    expect(await getSnapshot(env)).toMatchObject({ state: "destroyed", pending_deploy: null, pending_summary: null });
  });
});

describe("the run lock is not left held by a database error (#28)", () => {
  /** Make every INSERT into runs fail, as a D1 hiccup would. */
  function breakRunInserts() {
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/INSERT INTO runs/.test(sql)) throw new Error("D1 unavailable");
      return prepare(sql);
    }) as typeof env.DB.prepare;
  }

  it("deploy", async () => {
    breakRunInserts();
    await expect(startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven" })).rejects.toThrow(/D1 unavailable/);
    expect((await lockStatus(env)).held).toBe(false);
    expect(world.dispatches).toHaveLength(0);
  });

  it("tear-down", async () => {
    await toRunning();
    breakRunInserts();
    await expect(startDestroy(env, "steven", "done")).rejects.toThrow(/D1 unavailable/);
    expect((await lockStatus(env)).held).toBe(false);
  });
});

describe("heartbeats (#26)", () => {
  const DUMP = "PRIV\tS=\t51820\toff";
  const selftest = () => ({ at: new Date().toISOString() + Math.random(), ms: 4000, handshake: true, tunnel: true, loopback: true, dns: true, internet: true, internet6: null });

  it("a late heartbeat after a tear-down changes nothing", async () => {
    const { agentToken } = await toRunning();
    const d = await startDestroy(env, "steven", "done");
    const sec = await issueRunSecrets(env, d.id, lastGhRun(world));
    world.azure.rg = false;
    await handleCallback(env, sec.body.callback_token as string, { run_id: d.id, action: "destroy", status: "success" });
    const r = await handleAgent(env, agentToken, { dump: DUMP, selftest: selftest() });
    expect(r.status).toBe(200);
    expect(await getSnapshot(env)).toMatchObject({ state: "destroyed", agent: null, last_agent_at: null });
  });

  it("a late heartbeat in Standby changes nothing", async () => {
    const { agentToken } = await toRunning();
    await saveSnapshot(env, { state: "standby", agent: null, last_agent_at: null });
    await handleAgent(env, agentToken, { dump: DUMP });
    expect(await getSnapshot(env)).toMatchObject({ state: "standby", agent: null, last_agent_at: null });
  });

  it("'Clear counters' pressed while a heartbeat is in flight is not undone", async () => {
    const { agentToken } = await toRunning();
    await handleAgent(env, agentToken, { dump: DUMP, firewall: { hash: "h1", counters: { r1: [10, 1000] } } });
    // Press Clear counters in the middle of the next heartbeat: while it is
    // sending its self-test notification.
    const inner = globalThis.fetch;
    let pressed = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!pressed && String(input).includes("ntfy.sh")) {
        pressed = true;
        await clearFirewallCounters(env);
      }
      return inner(input, init);
    });
    await handleAgent(env, agentToken, { dump: DUMP, selftest: selftest(), firewall: { hash: "h1", counters: { r1: [12, 1200] } } });
    expect(pressed).toBe(true);
    const snap = await getSnapshot(env);
    expect(snap.fw_base.r1).toEqual([-10, -1000]); // total now = -10 + 12 = 2 hits since the clear
    expect(snap.firewall!.counters.r1).toEqual([12, 1200]);
  });
});

describe("settling without the callback (#24)", () => {
  it("waits 2 minutes after GitHub finishes, so the callback's outputs are not lost", async () => {
    const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
    const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
    world.azure.rg = true;
    ghFinished(10_000);
    await refreshActiveRun(env);
    expect((await db.getRun(env, run.id))!.finished_at).toBeNull();

    const cb = await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip, test_vm_ip: "10.20.1.4" } });
    expect(cb.message).toBe("ok");
    expect(await getSnapshot(env)).toMatchObject({ state: "running", test_vm_ip: "10.20.1.4" });
  });

  it("settles from GitHub's status once the callback is overdue", async () => {
    const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
    await issueRunSecrets(env, run.id, lastGhRun(world));
    world.azure.rg = true;
    ghFinished(3 * 60_000);
    await refreshActiveRun(env);
    expect((await db.getRun(env, run.id))!.status).toBe("success");
    expect((await getSnapshot(env)).state).toBe("running");
  });

  it("two pollers at once finish a Move's tear-down once and start the new deploy once", async () => {
    await toRunning();
    await startDestroy(env, "steven", "move");
    await saveSnapshot(env, { pending_deploy: { region: "eastus", vm_size: "Standard_B1s", profile: "US exit", hours: 2, requested_by: "steven", requester_ip: null } });
    world.azure.rg = false;
    ghFinished(3 * 60_000);
    const before = world.dispatches.length;
    await Promise.all([refreshActiveRun(env), refreshActiveRun(env)]);
    expect(world.dispatches.slice(before).map((d) => d.action)).toEqual(["apply"]);
    expect(world.notes.find((n) => n.title === "wg-admin: move stopped")).toBeUndefined();
    expect((await db.listAlerts(env)).filter((a) => a.kind === "destroy")).toHaveLength(1);
  });

  it("a callback after a poll already settled the run says so and changes nothing", async () => {
    const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
    const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
    world.azure.rg = true;
    ghFinished(3 * 60_000);
    await Promise.all([
      refreshActiveRun(env),
      handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } }),
    ]);
    expect((await db.listAlerts(env)).filter((a) => a.kind === "deploy")).toHaveLength(1);
  });
});
