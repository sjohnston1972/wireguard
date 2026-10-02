// api-healthcheck.test.ts
//
// Plain English: the on-demand health check. The request rides the VM's next
// heartbeat reply, the self-test result rides a later heartbeat back, and a
// VM that never answers (an old agent) is given up on after 5 minutes. Also
// checks that the VM agent script is still valid bash.
import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { api, apiEnv } from "./api-helpers";
import { lastGhRun } from "./harness";
import * as db from "../src/db";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";
import { getSnapshot, saveSnapshot } from "../src/state";
import { requestHealthCheck } from "../src/healthcheck";

afterEach(() => vi.unstubAllGlobals());

const DUMP = "PRIV\tS=\t51820\toff";
const selftest = (over: Record<string, unknown> = {}) => ({ at: new Date().toISOString(), ms: 4100, handshake: true, tunnel: true, loopback: true, dns: true, internet: true, internet6: true, ...over });

async function running() {
  const { env, world } = apiEnv();
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "dev@localhost" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return { env, world, token: sec.body.agent_token as string };
}

describe("POST /health-check", () => {
  it("is 409 while nothing is running, and while a check is already pending", async () => {
    const { env: idle } = apiEnv();
    const r0 = await api(idle, "POST", "/health-check");
    expect(r0.status).toBe(409);
    expect(r0.json.error.message).toBe("Nothing is running.");

    const { env } = await running();
    const r1 = await api(env, "POST", "/health-check");
    expect(r1.status).toBe(200);
    expect(r1.json).toEqual({ ok: true, message: "Health check requested. The VM runs its self-test at its next heartbeat, within about 30 seconds." });
    const snap = await getSnapshot(env);
    expect(snap.selftest_req?.id).toMatch(/^[0-9a-f]{12}$/);
    const r2 = await api(env, "POST", "/health-check");
    expect(r2.status).toBe(409);
    expect(r2.json.error.message).toBe("A health check is already running.");
  });

  it("counts as having read the notes, like every other button (speed test included), even when refused", async () => {
    const { env: idle } = apiEnv();
    await db.addAlert(idle, "info", "Old note");
    expect((await api(idle, "POST", "/health-check")).status).toBe(409);
    expect(await db.unacknowledgedAlerts(idle)).toHaveLength(0);

    const { env } = await running();
    await db.addAlert(env, "failure", "Something happened while you were away");
    expect((await api(env, "POST", "/health-check")).status).toBe(200);
    expect(await db.unacknowledgedAlerts(env)).toHaveLength(0);
  });

  it("shows the pending request in GET /overview", async () => {
    const { env } = await running();
    await requestHealthCheck(env);
    const o = await api(env, "GET", "/overview");
    expect(o.status).toBe(200);
    expect(o.json.snapshot.selftest_req.id).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("the heartbeat side", () => {
  it("the reply carries the request until a matching result arrives, which clears it and records the self-test with its alert", async () => {
    const { env, token } = await running();
    await handleAgent(env, token, { dump: DUMP, selftest: selftest({ at: "2026-10-02T09:00:00Z" }) }); // the boot self-test
    await requestHealthCheck(env);
    const id = (await getSnapshot(env)).selftest_req!.id;

    const r1 = await handleAgent(env, token, { dump: DUMP });
    expect((r1.body as any).selftest).toEqual({ id });
    const r2 = await handleAgent(env, token, { dump: DUMP, selftest: selftest({ at: "2026-10-02T09:00:00Z" }) }); // still the old result
    expect((r2.body as any).selftest).toEqual({ id });

    const result = selftest({ internet: false, id });
    const r3 = await handleAgent(env, token, { dump: DUMP, selftest: result });
    expect((r3.body as any).selftest).toBeUndefined();
    const snap = await getSnapshot(env);
    expect(snap.selftest_req).toBeNull();
    expect(snap.selftest).toMatchObject({ at: result.at, internet: false });
    const alerts = await db.listAlerts(env);
    expect(alerts.some((a) => a.kind === "failure" && /Self-test failed: internet \(IPv4\)/.test(a.message))).toBe(true);
  });

  it("a result newer than the request clears it even without the id", async () => {
    const { env, token } = await running();
    await requestHealthCheck(env);
    await handleAgent(env, token, { dump: DUMP, selftest: selftest({ at: new Date(Date.now() + 5000).toISOString() }) });
    expect((await getSnapshot(env)).selftest_req).toBeNull();
  });

  it("a boot self-test older than the request, with no id, leaves it pending", async () => {
    const { env, token } = await running();
    const boot = selftest({ at: new Date(Date.now() - 60_000).toISOString() });
    await requestHealthCheck(env);
    await handleAgent(env, token, { dump: DUMP, selftest: boot });
    expect((await getSnapshot(env)).selftest_req).not.toBeNull();
  });

  it("after 5 minutes with no result the request is dropped with a failure note", async () => {
    const { env, token } = await running();
    await requestHealthCheck(env);
    const req = (await getSnapshot(env)).selftest_req!;
    await saveSnapshot(env, { selftest_req: { ...req, at: new Date(Date.now() - 6 * 60_000).toISOString() } });
    const r = await handleAgent(env, token, { dump: DUMP });
    expect((r.body as any).selftest).toBeUndefined();
    expect((await getSnapshot(env)).selftest_req).toBeNull();
    const alerts = await db.listAlerts(env);
    expect(alerts.some((a) => a.kind === "failure" && /health check/i.test(a.message) && /did not report/.test(a.message))).toBe(true);
  });

  it("an on-demand result pushes 'Health check passed' or 'Health check failed', never the deploy's 'ready ... Tears down at'", async () => {
    const { env, world, token } = await running();
    await handleAgent(env, token, { dump: DUMP, selftest: selftest({ at: "2026-10-02T09:00:00Z" }) }); // the boot self-test
    const before = world.notes.length;

    await requestHealthCheck(env);
    const id1 = (await getSnapshot(env)).selftest_req!.id;
    await handleAgent(env, token, { dump: DUMP, selftest: selftest({ id: id1 }) });
    const passed = world.notes.slice(before);
    expect(passed.map((n) => n.title)).toEqual(["wg-admin: Health check passed"]);
    expect(passed[0].message).not.toMatch(/Tears down at/);

    await requestHealthCheck(env);
    const id2 = (await getSnapshot(env)).selftest_req!.id;
    await handleAgent(env, token, { dump: DUMP, selftest: selftest({ id: id2, at: new Date(Date.now() + 1000).toISOString(), internet: false }) });
    const failed = world.notes.slice(before + 1);
    expect(failed.map((n) => n.title)).toEqual(["wg-admin: Health check failed"]);
    expect(failed[0].message).toMatch(/internet \(IPv4\)/);
  });

  it("the boot self-test still pushes 'wg-admin: ready' with the tear-down time", async () => {
    const { env, world, token } = await running();
    await handleAgent(env, token, { dump: DUMP, selftest: selftest() });
    const ready = world.notes.find((n) => n.title === "wg-admin: ready");
    expect(ready?.message).toMatch(/Tears down at/);
    expect(world.notes.some((n) => /Health check/.test(n.title ?? ""))).toBe(false);
  });

  it("with no request, a boot self-test is handled exactly as before", async () => {
    const { env, token } = await running();
    const r = await handleAgent(env, token, { dump: DUMP, selftest: selftest() });
    expect((r.body as any).selftest).toBeUndefined();
    expect((await getSnapshot(env)).selftest?.internet).toBe(true);
    expect((await db.listAlerts(env)).some((a) => /^Self-test passed/.test(a.message))).toBe(true);
  });
});

describe("the VM agent script", () => {
  it("is valid bash", () => {
    expect(() => execFileSync("bash", ["-n", "infra/agent/wg-agent.sh"])).not.toThrow();
  });
});

// The hosts here have no flock, systemd-run or netns, so these read the
// scripts for the order of the steps that matter. On the VM: a health check
// asked for while the boot self-test is still queued must not start a second
// copy (both use netns wgcanary and iface wgc), and peer sync must not drop
// the canary peer in the moment before the self-test marks itself running.
describe("the self-test cannot run twice or lose its canary", () => {
  const agent = readFileSync("infra/agent/wg-agent.sh", "utf8");
  const selftestSh = readFileSync("infra/agent/wg-selftest.sh", "utf8");
  const hcBlock = agent.slice(agent.indexOf("# ── Health check"), agent.indexOf("jq -e '.peers | type"));

  it("wg-selftest.sh is valid bash", () => {
    expect(() => execFileSync("bash", ["-n", "infra/agent/wg-selftest.sh"])).not.toThrow();
  });

  it("the agent marks the self-test running before it spawns one, and unmarks it if the spawn fails", () => {
    const touch = hcBlock.search(/touch [^\n]*\/run\/wg-admin\/selftest\.running/);
    const spawn = hcBlock.indexOf("systemd-run");
    expect(touch, "touches selftest.running").toBeGreaterThan(-1);
    expect(spawn).toBeGreaterThan(touch);
    expect(hcBlock.slice(spawn)).toMatch(/\|\|\s*rm -f \/run\/wg-admin\/selftest\.running/);
  });

  it("wg-selftest.sh takes a non-blocking lock on /run/wg-admin/selftest.lock before it touches anything, and a second copy exits without cleaning up", () => {
    const lock = selftestSh.search(/flock -n/);
    expect(lock, "uses flock -n").toBeGreaterThan(-1);
    expect(selftestSh).toMatch(/selftest\.lock/);
    for (const step of ['touch "$FLAG"', "trap cleanup EXIT", "wg genkey", 'ip netns add "$NS"']) expect(selftestSh.indexOf(step), step).toBeGreaterThan(lock);
    // The copy that lost the race exits with its own code, so the health-check unit does not stamp an old result with the new id.
    expect(selftestSh.slice(lock, selftestSh.indexOf('touch "$FLAG"'))).toMatch(/exit 75/);
    expect(hcBlock).toMatch(/75/);
  });
});
