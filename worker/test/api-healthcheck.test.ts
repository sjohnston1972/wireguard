// api-healthcheck.test.ts
//
// Plain English: the on-demand health check. The request rides the VM's next
// heartbeat reply, the self-test result rides a later heartbeat back, and a
// VM that never answers (an old agent) is given up on after 5 minutes. Also
// checks that the VM agent script is still valid bash.
import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
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
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return { env, token: sec.body.agent_token as string };
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
