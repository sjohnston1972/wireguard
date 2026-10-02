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
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
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

  it("treats an empty region as an unknown one, as the old deploy route always did", async () => {
    const { env, world } = apiEnv();
    await expect(resolveDeployTarget(env, { region: "" })).rejects.toMatchObject({ code: "bad_input", message: "Unknown region." });
    const r = await worker.fetch(
      new Request(`${base}/actions/deploy`, { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded" }, body: "choice=r%3A&hours=2" }),
      env,
      ctx,
    );
    expect(r.status).toBe(302);
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
