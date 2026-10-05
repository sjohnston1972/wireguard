// labs-callbacks.test.ts
//
// Plain English: plan L2.2. What lab.yml tells the Worker: its result (deploy
// ready or failed, destroy clean or dirty, a release test), its secrets (once,
// over OIDC, only to lab.yml), its live log (with the run's secrets hidden),
// and how lab runs show in Activity.

import { afterEach, describe, expect, it, vi } from "vitest";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { lockStatus, labLock } from "../src/lock";
import { claimsProblem } from "../src/oidc";
import { issueLabSecrets, handleLabCallback } from "../src/labs/callbacks";
import { receiveLiveLog, readLiveLog } from "../src/livelog";
import { api, deployLab, freeze, advance, ghIdFor, labDispatches, labEnv, labRun, report, rows, runningLab, secrets, session, HOUR, MIN, NOW } from "./labs-helpers";

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const OUT = { private_ips: { vm: "10.64.0.4" }, connect: ["ssh azureuser@10.64.0.4"], users: { ann: "lab-az104-07-files-ann@contoso.onmicrosoft.com" }, clean: true, leftovers: [], deploy_seconds: 150, destroy_seconds: 0 };

describe("results (L2.2)", () => {
  it("deploy success sets running, ready_at, auto_destroy_at capped at max_until, and outputs", async () => {
    freeze();
    const { env, world } = await labEnv();
    const r = await deployLab(env, "az104-07-files", { hours: 6, peer: false });
    const s = await secrets(env, world, r.json.runId);
    // Ready 10 minutes later: 6 hours from then would pass max_until (requested + 6 h).
    advance(10 * MIN);
    const done = await report(env, r.json.runId, s.callback_token, "success", OUT);
    expect(done.status).toBe(200);
    const row = (await session(env, r.json.sessionId))!;
    expect(row).toMatchObject({ state: "running", ready_at: "2026-10-04T12:10:00.000Z", auto_destroy_at: "2026-10-04T18:00:00.000Z", max_until: "2026-10-04T18:00:00.000Z" });
    expect(JSON.parse(row.outputs_json)).toEqual({ private_ips: { vm: "10.64.0.4" }, connect: ["ssh azureuser@10.64.0.4"], users: { ann: "lab-az104-07-files-ann@contoso.onmicrosoft.com" }, peer_vnet_id: null });
    expect(await labRun(env, r.json.runId)).toMatchObject({ status: "succeeded", finished_at: "2026-10-04T12:10:00.000Z" });
    // The run's lock is released; a second result changes nothing.
    expect((await lockStatus(env, labLock("az104-07-files"))).held).toBe(false);
    expect((await report(env, r.json.runId, s.callback_token, "failure")).body).toMatchObject({ message: "already settled" });
    // A short session: ready + hours.
    const r2 = await runningLab(env, world, "az104-05-storage", { hours: 1, peer: false });
    expect((await session(env, r2.sid))!.auto_destroy_at).toBe("2026-10-04T13:10:00.000Z");
  });

  it("deploy failure sets failed", async () => {
    freeze();
    const { env, world } = await labEnv();
    const r = await deployLab(env, "az104-05-storage");
    const s = await secrets(env, world, r.json.runId);
    expect((await report(env, r.json.runId, s.callback_token, "failure", { clean: null })).status).toBe(200);
    expect((await session(env, r.json.sessionId))!).toMatchObject({ state: "failed", end_reason: null, slot: 0 });
    expect(await labRun(env, r.json.runId)).toMatchObject({ status: "failed" });
    expect((await lockStatus(env, labLock("az104-05-storage"))).held).toBe(false);
  });

  it("destroy clean ends the session, frees the slot and clears the admin password", async () => {
    freeze();
    const { env, world } = await labEnv();
    const up = await runningLab(env, world, "az104-05-storage");
    expect((await labRun(env, up.runId))!.admin_password).toBe(up.password);
    advance(HOUR);
    const d = await api(env, "POST", "/labs/az104-05-storage/destroy", { confirm: true });
    expect(d.status, d.text).toBe(200);
    expect((await session(env, up.sid))!).toMatchObject({ state: "tearing_down", end_reason: "manual" });
    const destroyRun = labDispatches(world).at(-1)!;
    expect(destroyRun.action).toBe("destroy");
    const s = await secrets(env, world, destroyRun.payload.run_id as string);
    advance(5 * MIN);
    expect((await report(env, destroyRun.payload.run_id as string, s.callback_token, "success", { ...OUT, destroy_seconds: 200 })).status).toBe(200);
    const row = (await session(env, up.sid))!;
    expect(row).toMatchObject({ state: "ended", end_reason: "manual", ended_at: "2026-10-04T13:05:00.000Z" });
    // estimate = est_gbp_h × (ended_at − requested_at) = 0.01 × 65 min.
    expect(row.est_gbp).toBeCloseTo((0.01 * 65) / 60, 6);
    expect((await rows(env, "SELECT * FROM lab_slots WHERE session_id = ?1", up.sid))).toHaveLength(0);
    expect((await rows(env, "SELECT * FROM lab_runs WHERE session_id = ?1 AND admin_password IS NOT NULL", up.sid))).toHaveLength(0);
  });

  it("a destroy that reports clean false ends ended_dirty and keeps the slot until a clean sweep", async () => {
    freeze();
    const { env, world } = await labEnv();
    const up = await runningLab(env, world, "az104-07-files");
    await api(env, "POST", "/labs/az104-07-files/destroy", { confirm: true });
    const runId = labDispatches(world).at(-1)!.payload.run_id as string;
    const s = await secrets(env, world, runId);
    await report(env, runId, s.callback_token, "success", { ...OUT, clean: false, leftovers: ["rg-lab-az104-07-files"] });
    const row = (await session(env, up.sid))!;
    expect(row).toMatchObject({ state: "ended_dirty", end_reason: "manual", slot: 0 });
    expect(JSON.parse(row.leftovers_json)).toEqual(["rg-lab-az104-07-files"]);
    expect((await rows(env, "SELECT session_id FROM lab_slots WHERE slot = 0"))[0].session_id).toBe(up.sid);
    const note = (await rows(env, "SELECT kind, message FROM alerts WHERE message LIKE 'Lab leftovers%'"))[0];
    expect(note).toMatchObject({ kind: "cost_guard" });
    expect(note.message).toContain("rg-lab-az104-07-files");
    // The password is gone even though Azure is not clean yet.
    expect((await rows(env, "SELECT * FROM lab_runs WHERE session_id = ?1 AND admin_password IS NOT NULL", up.sid))).toHaveLength(0);
    // A failed destroy with no clean check goes back to failed, for the watch to try again.
    const up2 = await runningLab(env, world, "az104-05-storage");
    await api(env, "POST", "/labs/az104-05-storage/destroy", { confirm: true });
    const run2 = labDispatches(world).at(-1)!.payload.run_id as string;
    const s2 = await secrets(env, world, run2);
    await report(env, run2, s2.callback_token, "failure", {});
    expect((await session(env, up2.sid))!).toMatchObject({ state: "failed", end_reason: "manual" });
  });

  it("cancel stops the GitHub run, then dispatches destroy", async () => {
    freeze();
    const { env, world } = await labEnv();
    const r = await deployLab(env, "az104-05-storage");
    await secrets(env, world, r.json.runId);
    const gh = ghIdFor(world, r.json.runId);
    const c = await api(env, "POST", "/labs/az104-05-storage/cancel");
    expect(c.status, c.text).toBe(200);
    const cancel = world.calls.findIndex((x) => x.method === "POST" && x.path.endsWith(`/actions/runs/${gh}/cancel`));
    const destroy = world.calls.findIndex((x, i) => i > cancel && x.path.endsWith("/lab.yml/dispatches"));
    expect(cancel).toBeGreaterThan(-1);
    expect(destroy).toBeGreaterThan(cancel);
    expect(await labRun(env, r.json.runId)).toMatchObject({ status: "cancelled" });
    expect((await session(env, r.json.sessionId))!).toMatchObject({ state: "tearing_down", end_reason: "manual" });
    expect(labDispatches(world).map((d) => d.action)).toEqual(["deploy", "destroy"]);
    // The lock now belongs to the destroy run.
    expect((await lockStatus(env, labLock("az104-05-storage"))).lock?.runId).toBe(labDispatches(world)[1].payload.run_id);
    // Nothing to cancel: 409.
    expect((await api(env, "POST", "/labs/az104-07-files/cancel")).status).toBe(409);
    // Destroy also cancels a deploy in progress first.
    const r7 = await deployLab(env, "az104-07-files");
    const d = await api(env, "POST", "/labs/az104-07-files/destroy", { confirm: true });
    expect(d.status).toBe(200);
    expect(await labRun(env, r7.json.runId)).toMatchObject({ status: "cancelled" });
  });

  it("test runs record lab_release_tests and end with reason test", async () => {
    freeze();
    const { env, world } = await labEnv();
    const t = await api(env, "POST", "/labs/az104-05-storage/test");
    expect(t.status, t.text).toBe(200);
    const d = labDispatches(world)[0];
    expect(d.action).toBe("test");
    const sid = d.payload.session_id as string;
    expect((await session(env, sid))!).toMatchObject({ test: 1, state: "deploying" });
    const s = await secrets(env, world, d.payload.run_id as string);
    advance(9 * MIN);
    await report(env, d.payload.run_id as string, s.callback_token, "success", { ...OUT, deploy_seconds: 180, destroy_seconds: 150 });
    expect((await session(env, sid))!).toMatchObject({ state: "ended", end_reason: "test" });
    const rt = (await rows(env, "SELECT * FROM lab_release_tests"))[0];
    expect(rt).toMatchObject({ lab_id: "az104-05-storage", version: 1, run_id: d.payload.run_id, result: "pass", deploy_seconds: 180, destroy_seconds: 150, at: "2026-10-04T12:09:00.000Z" });
    expect(JSON.parse(rt.leftovers_json)).toEqual([]);
    const card = (await api(env, "GET", "/labs")).json.labs.find((c: { id: string }) => c.id === "az104-05-storage");
    expect(card).toMatchObject({ released: true, lastReleaseTest: { result: "pass", clean: true } });
    // A dirty test fails, and keeps the slot.
    await api(env, "POST", "/labs/az104-07-files/test");
    const d7 = labDispatches(world)[1];
    const s7 = await secrets(env, world, d7.payload.run_id as string);
    await report(env, d7.payload.run_id as string, s7.callback_token, "success", { ...OUT, clean: false, leftovers: ["rg-lab-az104-07-files"] });
    expect((await rows(env, "SELECT result FROM lab_release_tests WHERE lab_id = 'az104-07-files'"))[0].result).toBe("fail");
    expect((await session(env, d7.payload.session_id as string))!).toMatchObject({ state: "ended_dirty", end_reason: "test" });
  });

  it("a callback needs the run's own token and refuses keys it does not know", async () => {
    freeze();
    const { env, world } = await labEnv();
    const r = await deployLab(env, "az104-05-storage");
    const s = await secrets(env, world, r.json.runId);
    expect((await handleLabCallback(env, null, { run_id: r.json.runId, action: "deploy", status: "success" })).status).toBe(401);
    expect((await handleLabCallback(env, "wrong", { run_id: r.json.runId, action: "deploy", status: "success" })).status).toBe(401);
    expect((await handleLabCallback(env, s.callback_token, { run_id: "lab-deploy-x", action: "deploy", status: "success" })).status).toBe(404);
    const extra = await handleLabCallback(env, s.callback_token, { run_id: r.json.runId, action: "deploy", status: "success", password: "x" });
    expect(extra.status).toBe(400);
    expect(JSON.stringify(extra.body)).toContain("password");
    expect((await handleLabCallback(env, s.callback_token, { run_id: r.json.runId, action: "deploy", status: "success", outputs: { admin_password: "x" } })).status).toBe(400);
    expect((await session(env, r.json.sessionId))!.state).toBe("deploying");
  });
});

describe("secrets and logs (L2.2)", () => {
  const claims = (env: { GITHUB_REPO?: string }, wf: string) => ({ repository: env.GITHUB_REPO, ref: "refs/heads/main", workflow_ref: `${env.GITHUB_REPO}/.github/workflows/${wf}@refs/heads/main`, event_name: "workflow_dispatch", run_id: "1001" });

  it("lab-secrets refuses a wg.yml token and /callback/secrets refuses a lab.yml token", async () => {
    const { env } = await labEnv();
    // The gateway's route (default workflow) and the labs' route (lab.yml) each take only their own.
    expect(claimsProblem(env, claims(env, "wg.yml"))).toBeNull();
    expect(claimsProblem(env, claims(env, "lab.yml"))).toMatch(/wrong workflow/);
    expect(claimsProblem(env, claims(env, "lab.yml"), "lab.yml")).toBeNull();
    expect(claimsProblem(env, claims(env, "wg.yml"), "lab.yml")).toMatch(/wrong workflow/);
    // A lab run id is unknown to the gateway's secrets, and a gateway run id to the labs'.
    expect((await issueLabSecrets(env, "apply-20261004T120000Z-abcdef", 1000)).status).toBe(404);
  });

  it("secrets are handed out once per run", async () => {
    freeze();
    const { env, world } = await labEnv();
    const r = await deployLab(env, "az104-05-storage");
    const gh = ghIdFor(world, r.json.runId);
    // A GitHub run that is not this run's is refused.
    expect((await issueLabSecrets(env, r.json.runId, gh + 50)).status).toBe(403);
    const first = await issueLabSecrets(env, r.json.runId, gh);
    expect(first.status).toBe(200);
    const body = first.body as { callback_token: string; admin_password: string };
    expect(body.callback_token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.admin_password).toMatch(/^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){3}$/);
    expect(body.admin_password).toBe((await labRun(env, r.json.runId))!.admin_password);
    const run = (await labRun(env, r.json.runId))!;
    expect(run).toMatchObject({ github_run_id: gh, status: "running" });
    expect(run.callback_token_hash).not.toBe(body.callback_token);
    expect((await issueLabSecrets(env, r.json.runId, gh)).status).toBe(409);
  });

  it("lab live log redacts the admin password and the callback token", async () => {
    freeze();
    const { env, world } = await labEnv();
    const r = await deployLab(env, "az104-05-storage");
    const s = await secrets(env, world, r.json.runId);
    const text = `2026-10-04T12:00:01Z password ${s.admin_password} token ${s.callback_token}\n`;
    expect((await receiveLiveLog(env, "wrong", { run_id: r.json.runId, seq: 1, text })).status).toBe(401);
    expect((await receiveLiveLog(env, s.callback_token, { run_id: r.json.runId, seq: 1, text })).status).toBe(200);
    const log = (await readLiveLog(env, r.json.runId))!.text;
    expect(log).not.toContain(s.admin_password);
    expect(log).not.toContain(s.callback_token);
    expect(log).toContain("password ***");
    // The API serves it while the run is going.
    const viaApi = await api(env, "GET", `/runs/${r.json.runId}/log`);
    expect(viaApi.json).toMatchObject({ source: "live", active: true });
    expect(viaApi.json.log).toContain("***");
    // And the watchman's prune keeps it.
    const { pruneLiveLogs } = await import("../src/db");
    await pruneLiveLogs(env, new Date());
    expect(await readLiveLog(env, r.json.runId)).not.toBeNull();
    // Once the run has finished, nothing more is taken.
    await report(env, r.json.runId, s.callback_token, "success", OUT);
    expect((await receiveLiveLog(env, s.callback_token, { run_id: r.json.runId, seq: 2, text: "late\n" })).status).toBe(409);
  });

  it("the admin password is cleared when the session ends", async () => {
    freeze();
    const { env, world } = await labEnv();
    const up = await runningLab(env, world, "az104-05-storage");
    expect((await api(env, "GET", "/labs/az104-05-storage/secret")).json.adminPassword).toBe(up.password);
    await api(env, "POST", "/labs/az104-05-storage/destroy", { confirm: true });
    const runId = labDispatches(world).at(-1)!.payload.run_id as string;
    const s = await secrets(env, world, runId);
    await report(env, runId, s.callback_token, "success", OUT);
    const left = await rows(env, "SELECT id FROM lab_runs WHERE admin_password IS NOT NULL");
    expect(left).toEqual([]);
    expect((await api(env, "GET", "/labs/az104-05-storage/secret")).status).toBe(409);
  });
});

describe("runs in Activity (L2.2)", () => {
  it("GET /runs/lab-… reads lab_runs", async () => {
    freeze();
    const { env, world } = await labEnv();
    const r = await deployLab(env, "az104-05-storage");
    const run = await api(env, "GET", `/runs/${r.json.runId}`);
    expect(run.status, run.text).toBe(200);
    expect(run.json.run).toMatchObject({ id: r.json.runId, action: "apply", status: "queued", lab: { id: "az104-05-storage", title: "Storage accounts", action: "deploy" } });
    expect(run.json.active).toBe(true);
    expect(JSON.stringify(run.json)).not.toMatch(/admin_password|callback_token|payload/);
    const steps = [{ name: "Check out, Parse payload", status: "completed", conclusion: "success" }, { name: "Collect run secrets", status: "in_progress", conclusion: null }];
    await env.DB.prepare("UPDATE lab_runs SET steps_json = ?1 WHERE id = ?2").bind(JSON.stringify(steps), r.json.runId).run();
    expect((await api(env, "GET", `/runs/${r.json.runId}`)).json.steps).toHaveLength(2);
    expect((await api(env, "GET", "/runs/lab-deploy-20200101000000-zzzzzz")).status).toBe(404);
    void world;
  });

  it("activity lists lab runs with the lab title", async () => {
    freeze();
    const { env, world } = await labEnv();
    const up = await runningLab(env, world, "az104-05-storage");
    advance(MIN);
    await api(env, "POST", "/labs/az104-05-storage/destroy", { confirm: true });
    const a = await api(env, "GET", "/activity?range=24h");
    expect(a.status).toBe(200);
    const labRuns = a.json.runs.filter((x: { lab?: unknown }) => x.lab);
    expect(labRuns.map((x: { action: string; lab: { action: string; title: string } }) => [x.action, x.lab.action, x.lab.title])).toEqual([
      ["destroy", "destroy", "Storage accounts"],
      ["apply", "deploy", "Storage accounts"],
    ]);
    expect(labRuns[1]).toMatchObject({ id: up.runId, status: "success" });
    // A finished lab run is an event in the feed, named for its lab.
    expect(a.json.all.some((e: { ref: { id: string }; title: string }) => e.ref.id === up.runId && e.title.includes("Storage accounts"))).toBe(true);
    void NOW;
  });
});
