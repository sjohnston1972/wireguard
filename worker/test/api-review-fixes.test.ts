// api-review-fixes.test.ts
//
// Plain English: what the whole-branch review of the data API found, each
// pinned: a malformed body is refused rather than read as "nothing"; a
// region that is not text is refused; an Azure refusal says so (502) with
// Azure's reason; the old deploy route refuses an empty region as before.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv, base } from "./api-helpers";
import { lastGhRun } from "./harness";
import * as db from "../src/db";
import worker from "../src/index";
import { startDeploy, issueRunSecrets, handleCallback } from "../src/runs";
import { getSnapshot } from "../src/state";
import { resolveDeployTarget } from "../src/profiles";
import { projection } from "../src/costview";
import type { CostDay } from "../src/db";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());
const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;

async function raw(env: Env, method: string, path: string, bodyText: string, contentType: string | null) {
  const headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" };
  if (contentType) headers["Content-Type"] = contentType;
  const r = await worker.fetch(new Request(`${base}/api/v1${path}`, { method, headers, body: bodyText }), env, ctx);
  return { status: r.status, json: (await r.json()) as { error?: { code: string; message: string } } };
}

async function running(env: Env, world: ReturnType<typeof apiEnv>["world"]) {
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "dev@localhost" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
}

describe("a malformed body is refused, not read as nothing", () => {
  it("keeps the auto-destroy timer when the extend body is broken or unlabelled", async () => {
    const { env, world } = apiEnv();
    await running(env, world);
    const before = (await getSnapshot(env)).auto_destroy_at;
    expect(before).not.toBeNull();
    const broken = await raw(env, "POST", "/extend", '{"hours":4,}', "application/json");
    expect(broken.status).toBe(400);
    expect(broken.json.error?.code).toBe("bad_input");
    const unlabelled = await raw(env, "POST", "/extend", '{"hours":4}', "text/plain");
    expect(unlabelled.status).toBe(400);
    const notAnObject = await raw(env, "POST", "/extend", "[4]", "application/json");
    expect(notAnObject.status).toBe(400);
    expect((await getSnapshot(env)).auto_destroy_at).toBe(before);
  });

  it("still treats no body at all as no options", async () => {
    const { env } = apiEnv();
    expect((await api(env, "POST", "/cancel")).status).toBe(200);
  });

  it("writes nothing to a client for a broken body", async () => {
    const { env } = apiEnv();
    const p = await db.addPeer(env, { name: "Phone", public_key: "P".repeat(43) + "=", ip: "10.13.13.2", full_tunnel: false });
    const r = await raw(env, "PUT", `/clients/${p.id}`, "{not json", "application/json");
    expect(r.status).toBe(400);
    expect(await db.auditFor(env, "Phone")).toEqual([]);
  });
});

describe("regions are checked, never silently defaulted", () => {
  it("refuses a region that is not text (400, field region) and starts nothing", async () => {
    const { env, world } = apiEnv();
    const r = await api(env, "POST", "/deploy", { region: 5 });
    expect(r.status).toBe(400);
    expect(r.json.error.field).toBe("region");
    expect(world.dispatches).toHaveLength(0);
  });

  it("treats an empty region as an unknown one, as the old deploy page always did", async () => {
    const { env, world } = apiEnv();
    await expect(resolveDeployTarget(env, { region: "" })).rejects.toMatchObject({ code: "bad_input", message: "Unknown region." });
    const r = await api(env, "POST", "/deploy", { region: "", hours: 2 });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toBe("Unknown region.");
    expect(world.dispatches).toHaveLength(0);
  });
});

describe("an Azure refusal says so", () => {
  it("answers 502 with Azure's reason when Allow SSH is refused", async () => {
    const { env, world } = apiEnv();
    await running(env, world);
    world.azure.rg = false; // Azure now answers 404 to the NSG change
    const r = await api(env, "POST", "/allow-ssh", undefined, { "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": "203.0.113.7" });
    expect(r.status).toBe(502);
    expect(r.json.error.code).toBe("upstream");
    expect(r.json.error.message).toMatch(/^Azure did not accept the change: /);
  });
});

describe("review pass 2: decimal ports are refused", () => {
  it("rejects a decimal public_port or target_port and saves nothing", async () => {
    const { env } = apiEnv();
    const a = await api(env, "POST", "/firewall/forwards", { name: "web", proto: "tcp", public_port: 8080.5, target_ip: "10.50.2.4" });
    expect(a.status).toBe(400);
    expect(a.json.error.field).toBe("public_port");
    const b = await api(env, "POST", "/firewall/forwards", { name: "web", proto: "tcp", public_port: 8080, target_ip: "10.50.2.4", target_port: 80.5 });
    expect(b.status).toBe(400);
    expect(b.json.error.field).toBe("target_port");
    expect(await db.listForwards(env)).toHaveLength(0);
  });
});

describe("review pass 2: the month projection allows for Azure's lag", () => {
  it("on the 2nd with only the 1st reported, projects that day's figure over the month", () => {
    const p = projection([{ day: "2026-10-01", gbp: 2 } as CostDay], new Date("2026-10-02T09:00:00Z"));
    expect(p!.gbp).toBeCloseTo(2 * 31, 6);
    expect(p!.basis).toMatch(/1 day Azure has reported/);
  });
});

describe("review pass 2: the cost timezone label tells the truth", () => {
  it("says the cost days are UTC", async () => {
    const { env } = apiEnv();
    const r = await api(env, "GET", "/cost");
    expect(r.json.meta.timezone).toBe("UTC");
  });
});

describe("review pass 2: settings region and VM size must be known", () => {
  it("rejects an unknown region or VM size and saves nothing", async () => {
    const { env } = apiEnv();
    const r = await api(env, "PUT", "/settings", { idle_destroy_minutes: 45, region: "mars" });
    expect(r.status).toBe(400);
    expect(r.json.error.field).toBe("region");
    const v = await api(env, "PUT", "/settings", { vm_size: "Standard_Nonsense" });
    expect(v.status).toBe(400);
    expect(v.json.error.field).toBe("vm_size");
    expect((await db.allSettings(env)).idle_destroy_minutes).toBeUndefined();
    expect((await api(env, "PUT", "/settings", { region: "uksouth", vm_size: "Standard_B1s" })).status).toBe(200);
  });
});

describe("review pass 2: a GitHub outage is not 'no log'", () => {
  it("answers 502 upstream when GitHub refuses or fails the jobs call, 404 no_log when it just has none", async () => {
    const { env, world } = apiEnv();
    await db.createRun(env, { id: "run-g", action: "apply", status: "success", requested_at: new Date().toISOString(), requested_by: "dev@localhost", callback_token_hash: "C", agent_token_hash: "A", payload_json: null, auto_destroy_at: null, reason: null, ssh_password: null });
    await db.updateRun(env, "run-g", { github_run_id: 5001 });
    for (const status of [500, 401]) {
      world.ghFail = status;
      const r = await api(env, "GET", "/runs/run-g/log");
      expect(r.status).toBe(502);
      expect(r.json.error.code).toBe("upstream");
    }
    world.ghFail = undefined;
    const none = await api(env, "GET", "/runs/run-g/log");
    expect(none.status).toBe(404);
    expect(none.json.error.code).toBe("no_log");
  });
});

describe("review pass 2: a busy range is counted in full", () => {
  it("counts all 250 watchman problems in range but returns at most 200 notes", async () => {
    const { env } = apiEnv();
    const now = Date.now();
    for (let i = 0; i < 250; i++) await env.DB.prepare("INSERT INTO alerts (at, kind, message) VALUES (?1, 'failure', 'bad')").bind(new Date(now - 60_000 - i * 1000).toISOString()).run();
    const r = await api(env, "GET", "/activity?range=24h");
    expect(r.status).toBe(200);
    expect(r.json.kpis.watchmanProblems).toBe(250);
    expect(r.json.notes.length).toBeLessThanOrEqual(200);
  });

  it("counts all 250 config changes in range but returns at most 200 events", async () => {
    const { env } = apiEnv();
    const now = Date.now();
    for (let i = 0; i < 250; i++) await env.DB.prepare("INSERT INTO audit (at, user, action, target) VALUES (?1, 'dev@localhost', 'settings.save', 'Settings')").bind(new Date(now - 60_000 - i * 1000).toISOString()).run();
    const r = await api(env, "GET", "/activity?range=24h");
    expect(r.status).toBe(200);
    expect(r.json.kpis.configChanges).toBe(250);
    expect(r.json.all.length).toBeLessThanOrEqual(200);
  });
});
