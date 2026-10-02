// api-overview.test.ts
//
// Plain English: the Overview's data: the stored state plus the facts
// worked out from it, what can be pressed, and the SSH password on its own
// route only.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv } from "./api-helpers";
import { lastGhRun } from "./harness";
import * as db from "../src/db";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";
import { typicalSeconds, isVerifying, heartbeatStale } from "../src/overview";
import type { Env } from "../src/env";
import type { Snapshot } from "../src/state";

afterEach(() => vi.unstubAllGlobals());

const PHONE = "P".repeat(43) + "=";
const DUMP = (lines: string[]) => ["PRIV\tS=\t51820\toff", ...lines].join("\n");

async function toRunning(env: Env, world: ReturnType<typeof apiEnv>["world"]) {
  await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "dev@localhost" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  await handleAgent(env, sec.body.agent_token as string, { dump: DUMP([`${PHONE}\t(none)\t203.0.113.25:4000\t10.13.13.2/32\t${Math.floor(Date.now() / 1000) - 5}\t10\t20\t0`]) });
  return { run, callbackToken: sec.body.callback_token as string, agentToken: sec.body.agent_token as string };
}

describe("GET /overview", () => {
  it("describes a destroyed environment", async () => {
    const { env } = apiEnv();
    const r = await api(env, "GET", "/overview");
    expect(r.status).toBe(200);
    expect(r.json.snapshot.state).toBe("destroyed");
    expect(r.json.derived).toEqual({ verifying: false, heartbeatStale: false, selftestFailures: [], clientsOnline: 0, clientsEnabled: 0, publicIp6: null, dnsParked: false });
    expect(r.json.config).toMatchObject({ dnsName: "wg.clydeford.net", port: 51820, subnet: "10.13.13.0/24", region: "uksouth", vmSize: "Standard_B1s" });
    expect(r.json.actions).toEqual({ canDispatch: true, lockHolder: null });
    expect(r.json.deployment).toBeNull();
    expect(r.json.typicalSeconds).toEqual({ deploy: null, destroy: null });
    expect(r.json.budget).toMatchObject({ budget: 10 });
  });

  it("describes a running environment, with nothing secret in it", async () => {
    const { env, world } = apiEnv();
    const { run, callbackToken, agentToken } = await toRunning(env, world);
    const r = await api(env, "GET", "/overview");
    expect(r.json.snapshot.state).toBe("running");
    expect(r.json.derived).toMatchObject({ verifying: true, heartbeatStale: false, clientsOnline: 1, clientsEnabled: 1 });
    expect(r.json.deployment).toMatchObject({ id: run.id, hasSshPassword: true, peersLoaded: 1 });
    const text = JSON.stringify(r.json);
    const stored = (await db.getRun(env, run.id))!;
    for (const secret of [stored.ssh_password!, stored.agent_token_hash!, stored.callback_token_hash!, callbackToken, agentToken]) expect(text).not.toContain(secret);
    expect(text).not.toContain("payload_json");
  });
});

describe("GET /ssh-password", () => {
  it("gives the password only while running", async () => {
    const { env, world } = apiEnv();
    const none = await api(env, "GET", "/ssh-password");
    expect(none.status).toBe(404);
    expect(none.json.error.code).toBe("none");
    const { run } = await toRunning(env, world);
    const r = await api(env, "GET", "/ssh-password");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ password: (await db.getRun(env, run.id))!.ssh_password });
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("overview facts", () => {
  const run = (action: "apply" | "destroy", status: string, secs: number | null, i: number) =>
    ({ id: `r${i}`, action, status, requested_at: `2026-10-01T10:${String(i).padStart(2, "0")}:00Z`, started_at: `2026-10-01T10:${String(i).padStart(2, "0")}:00Z`, finished_at: secs === null ? null : new Date(Date.parse(`2026-10-01T10:${String(i).padStart(2, "0")}:00Z`) + secs * 1000).toISOString() }) as db.Run;

  it("takes the median of the last 10 successful runs of that kind", () => {
    const runs = [run("apply", "success", 140, 1), run("apply", "success", 150, 2), run("apply", "failure", 60, 3), run("apply", "success", 900, 4), run("destroy", "success", 130, 5), run("apply", "running", null, 6)];
    expect(typicalSeconds(runs, "apply")).toBe(150);
    expect(typicalSeconds(runs, "destroy")).toBe(130);
    expect(typicalSeconds([], "apply")).toBeNull();
  });

  it("is verifying for 5 minutes after coming up without a self-test, and stale after 2 minutes without a heartbeat", () => {
    const now = Date.parse("2026-10-02T10:10:00Z");
    const s = { state: "running", running_since: "2026-10-02T10:06:00Z", since: null, selftest: null, last_agent_at: "2026-10-02T10:07:30Z" } as unknown as Snapshot;
    expect(isVerifying(s, now)).toBe(true);
    expect(isVerifying({ ...s, running_since: "2026-10-02T10:04:00Z" }, now)).toBe(false);
    expect(heartbeatStale(s, now)).toBe(true);
    expect(heartbeatStale({ ...s, last_agent_at: "2026-10-02T10:09:00Z" }, now)).toBe(false);
    expect(heartbeatStale({ ...s, state: "destroyed" } as Snapshot, now)).toBe(false);
  });
});
