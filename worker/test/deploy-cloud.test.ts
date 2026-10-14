// deploy-cloud.test.ts
//
// Plain English: choosing a cloud at deploy. An AWS deploy goes through
// wg-aws.yml with London and t4g.micro, an Azure one through wg.yml as
// always; only one cloud has a headend at a time; each run's secrets go
// only to a run of its own workflow; Move stays an Azure thing. GitHub's
// OIDC signature check (jose) is stood in for, so a test can present a
// token from either workflow; everything after it is the real code.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("jose", () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: async (token: string) => ({ payload: JSON.parse(atob(token)) }),
}));

import { makeEnv, lastGhRun, wgRef, type World } from "./harness";
import { api, apiEnv } from "./api-helpers";
import type { Env } from "../src/env";
import worker from "../src/index";
import * as db from "../src/db";
import { startDeploy, startDestroy, issueRunSecrets, handleCallback, refreshActiveRun, runCloud } from "../src/runs";
import { startResume } from "../src/standby";
import { startMove } from "../src/profiles";
import { getSnapshot, saveSnapshot } from "../src/state";

let env: Env;
let world: World;
beforeEach(() => ({ env, world } = makeEnv()));
afterEach(() => vi.unstubAllGlobals());

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const token = (e: Env, wf: string, ghRunId: number) =>
  btoa(JSON.stringify({ repository: e.GITHUB_REPO, ref: "refs/heads/main", workflow_ref: wgRef(e, wf), event_name: "workflow_dispatch", run_id: String(ghRunId) }));
const collect = (e: Env, bearer: string, runId: string) =>
  worker.fetch(new Request("http://localhost:8787/api/callback/secrets", { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify({ run_id: runId }) }), e, ctx);

describe("deploy to AWS", () => {
  it("dispatches wg-aws.yml with London, t4g.micro and cloud=aws, and records aws", async () => {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" });
    expect(world.dispatches[0]).toMatchObject({ workflow: "wg-aws.yml", action: "apply" });
    expect(world.dispatches[0].payload).toMatchObject({ cloud: "aws", region: "eu-west-2", vm_size: "t4g.micro" });
    expect((await getSnapshot(env)).cloud).toBe("aws");
    expect(runCloud(run)).toBe("aws");
  });
  it("is refused without the Worker's AWS keys", async () => {
    ({ env, world } = makeEnv({ AWS_WORKER_ACCESS_KEY_ID: undefined, AWS_WORKER_SECRET_ACCESS_KEY: undefined }));
    await expect(startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" })).rejects.toThrow(/AWS is not set up/);
  });
  it("is refused while Azure is failed (it may have left things behind)", async () => {
    await saveSnapshot(env, { state: "failed", cloud: "azure" });
    await expect(startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" })).rejects.toThrow(/Tear down the Azure headend first/);
  });
  it("is refused while Azure is torn down but drift says it still has resources", async () => {
    await saveSnapshot(env, { state: "destroyed", cloud: "azure", drift: "Azure still has resource group rg-wg but the dashboard says Destroyed." });
    await expect(startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" })).rejects.toThrow(/Clean up the Azure leftovers first/);
    expect(world.dispatches).toHaveLength(0);
  });
  it("GitHub's run is found under wg-aws.yml, so the run gets its GitHub id", async () => {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" });
    await refreshActiveRun(env);
    expect((await db.getRun(env, run.id))!.github_run_id).toBe(lastGhRun(world));
    expect(world.calls.some((c) => c.path.includes("/actions/workflows/wg-aws.yml/runs"))).toBe(true);
  });
  it("an AWS tear-down's secrets are refused to a wg.yml token", async () => {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" });
    const s = await issueRunSecrets(env, run.id, lastGhRun(world), wgRef(env, "wg-aws.yml"));
    world.aws.exists = true;
    await handleCallback(env, s.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.aws.ip } });
    const d = await startDestroy(env, "steven");
    expect(runCloud(d)).toBe("aws");
    expect((await issueRunSecrets(env, d.id, lastGhRun(world), wgRef(env, "wg.yml"))).status).toBe(403);
    expect((await issueRunSecrets(env, d.id, lastGhRun(world), wgRef(env, "wg-aws.yml"))).status).toBe(200);
  });
  it("the AWS run's secrets go only to a wg-aws.yml run, and tear-down uses wg-aws.yml", async () => {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" });
    expect((await issueRunSecrets(env, run.id, lastGhRun(world), wgRef(env, "wg.yml"))).status).toBe(403);
    const s = await issueRunSecrets(env, run.id, lastGhRun(world), wgRef(env, "wg-aws.yml"));
    expect(s.status).toBe(200);
    world.aws.exists = true;
    await handleCallback(env, s.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.aws.ip } });
    await startDestroy(env, "steven");
    expect(world.dispatches[1]).toMatchObject({ workflow: "wg-aws.yml", action: "destroy" });
    expect(world.dispatches[1].payload).toMatchObject({ cloud: "aws" });
  });
});

describe("an Azure deploy is as it was", () => {
  it("dispatches wg.yml with no cloud key, and records azure", async () => {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven" });
    expect(world.dispatches[0]).toMatchObject({ workflow: "wg.yml", action: "apply" });
    expect(world.dispatches[0].payload).not.toHaveProperty("cloud");
    expect((await getSnapshot(env)).cloud).toBe("azure");
    expect(runCloud(run)).toBe("azure");
  });
  it("an Azure tear-down dispatches wg.yml with no cloud key", async () => {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven" });
    const s = await issueRunSecrets(env, run.id, lastGhRun(world), wgRef(env));
    world.azure.rg = true;
    await handleCallback(env, s.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
    const d = await startDestroy(env, "steven");
    expect(world.dispatches[1]).toMatchObject({ workflow: "wg.yml", action: "destroy" });
    expect(world.dispatches[1].payload).not.toHaveProperty("cloud");
    expect(runCloud(d)).toBe("azure");
  });
  it("an Azure deploy is refused while AWS is failed", async () => {
    await saveSnapshot(env, { state: "failed", cloud: "aws" });
    await expect(startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "azure" })).rejects.toThrow(/Tear down the AWS headend first/);
  });
});

describe("each run's secrets go only to its own workflow (OIDC)", () => {
  it("an AWS run refuses a wg.yml token, and takes a wg-aws.yml one", async () => {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" });
    const gh = lastGhRun(world);
    // A wg.yml run titled with this run's id still is not this dispatch's workflow.
    world.ghRuns.set(77, { id: 77, display_title: `wg apply ${run.id}`, status: "in_progress", conclusion: null, html_url: "", created_at: "", workflow: "wg.yml" });
    expect((await collect(env, token(env, "wg.yml", 77), run.id)).status).toBe(403);
    expect((await collect(env, token(env, "wg.yml", gh), run.id)).status).toBe(403);
    expect((await db.getRun(env, run.id))!.callback_token_hash).toBeNull();
    expect((await collect(env, token(env, "wg-aws.yml", gh), run.id)).status).toBe(200);
  });
  it("an Azure run refuses a wg-aws.yml token, and takes a wg.yml one", async () => {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven" });
    const gh = lastGhRun(world);
    expect((await collect(env, token(env, "wg-aws.yml", gh), run.id)).status).toBe(403);
    expect((await issueRunSecrets(env, run.id, gh, wgRef(env, "wg-aws.yml"))).status).toBe(403);
    expect((await collect(env, token(env, "wg.yml", gh), run.id)).status).toBe(200);
  });
  it("a token from neither workflow is not trusted at all", async () => {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" });
    expect((await collect(env, token(env, "lab.yml", lastGhRun(world)), run.id)).status).toBe(401);
  });
});

describe("a headend keeps its cloud", () => {
  it("standby in Azure resumes through Azure with AWS configured", async () => {
    world.azure.rg = true;
    world.azure.power = "deallocated";
    await saveSnapshot(env, { state: "standby", cloud: "azure", standby_since: new Date().toISOString() });
    await startResume(env, "steven", null);
    expect(world.powerCalls).toEqual(["start"]);
    expect(world.calls.some((c) => c.host.startsWith("ec2."))).toBe(false);
  });
  it("Move is refused on AWS", async () => {
    await db.addProfile(env, { name: "Test exit", region: "eastus", vm_size: "Standard_B1s" });
    const p = (await db.listProfiles(env)).find((x) => x.name === "Test exit")!;
    await saveSnapshot(env, { state: "running", cloud: "aws" });
    await expect(startMove(env, { profileId: p.id, hours: null, by: "steven", requesterIp: null })).rejects.toThrow(/Move works between Azure regions/);
    expect(world.dispatches).toHaveLength(0);
  });
});

describe("POST /deploy with a cloud", () => {
  it("deploys to AWS", async () => {
    const a = apiEnv();
    const r = await api(a.env, "POST", "/deploy", { cloud: "aws" });
    expect(r.status).toBe(200);
    expect(a.world.dispatches[0]).toMatchObject({ workflow: "wg-aws.yml" });
    expect(a.world.dispatches[0].payload).toMatchObject({ cloud: "aws", region: "eu-west-2" });
  });
  it("refuses an unknown cloud, and a region or profile with AWS", async () => {
    const a = apiEnv();
    const bad = await api(a.env, "POST", "/deploy", { cloud: "gcp" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatchObject({ code: "bad_input", message: "Unknown cloud.", field: "cloud" });
    const region = await api(a.env, "POST", "/deploy", { cloud: "aws", region: "eastus" });
    expect(region.status).toBe(400);
    expect(region.json.error).toMatchObject({ field: "cloud", message: "AWS deploys to London; leave region and profile empty." });
    expect((await api(a.env, "POST", "/deploy", { cloud: "aws", profileId: 1 })).status).toBe(400);
    expect(a.world.dispatches).toHaveLength(0);
  });
  it("cloud azure is the usual deploy", async () => {
    const a = apiEnv();
    expect((await api(a.env, "POST", "/deploy", { cloud: "azure" })).status).toBe(200);
    expect(a.world.dispatches[0]).toMatchObject({ workflow: "wg.yml" });
    expect(a.world.dispatches[0].payload).not.toHaveProperty("cloud");
  });
});
