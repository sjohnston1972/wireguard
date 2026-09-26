// Races and state edges in the change-control desk (runs.ts), on the harness.
// Each test is one of the "two things happened at once" or "this arrived
// late" cases that used to leave the dashboard wrong.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import type { Env } from "../src/env";
import * as db from "../src/db";
import { startDeploy, startDestroy, issueRunSecrets, handleCallback, refreshActiveRun } from "../src/runs";
import { getSnapshot, saveSnapshot } from "../src/state";

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
