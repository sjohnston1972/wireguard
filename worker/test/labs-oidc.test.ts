// labs-oidc.test.ts
//
// Plain English: plan L2.2, end to end through the front door. GitHub's OIDC
// signature check (jose) is stood in for, so a test can present a token with
// any claims; everything after it (the workflow allow-list per route, the
// run lookup, the failure brake) is the real code.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("jose", () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: async (token: string) => ({ payload: JSON.parse(atob(token)) }),
}));

import worker from "../src/index";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { startDeploy } from "../src/runs";
import { deployLab, freeze, ghIdFor, labEnv, labRun } from "./labs-helpers";
import { lastGhRun } from "./harness";

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const token = (repo: string, wf: string, runId: number) =>
  btoa(JSON.stringify({ repository: repo, ref: "refs/heads/main", workflow_ref: `${repo}/.github/workflows/${wf}@refs/heads/main`, event_name: "workflow_dispatch", run_id: String(runId) }));

describe("OIDC allow-list per route (L2.2)", () => {
  it("lab-secrets refuses a wg.yml token and /callback/secrets refuses a lab.yml token", async () => {
    freeze();
    const { env, world } = await labEnv();
    const post = (path: string, bearer: string, body: unknown) =>
      worker.fetch(new Request(`http://localhost:8787${path}`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify(body) }), env, ctx);
    const repo = env.GITHUB_REPO!;

    const lab = await deployLab(env, "az104-05-storage");
    const labGh = ghIdFor(world, lab.json.runId);
    const gw = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "t" });
    const gwGh = lastGhRun(world);

    // Each route refuses the other workflow's token.
    expect((await post("/api/callback/lab-secrets", token(repo, "wg.yml", labGh), { run_id: lab.json.runId })).status).toBe(401);
    expect((await post("/api/callback/secrets", token(repo, "lab.yml", gwGh), { run_id: gw.id })).status).toBe(401);
    // A lab.yml token cannot collect a gateway run's secrets through the labs' route either.
    expect((await post("/api/callback/lab-secrets", token(repo, "lab.yml", gwGh), { run_id: gw.id })).status).toBe(404);
    // Unknown keys are refused.
    expect((await post("/api/callback/lab-secrets", token(repo, "lab.yml", labGh), { run_id: lab.json.runId, extra: 1 })).status).toBe(400);
    // The right token on the right route works, once.
    const ok = await post("/api/callback/lab-secrets", token(repo, "lab.yml", labGh), { run_id: lab.json.runId });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { callback_token: string; admin_password: string };
    expect(body.admin_password).toBe((await labRun(env, lab.json.runId))!.admin_password);
    expect((await post("/api/callback/lab-secrets", token(repo, "lab.yml", labGh), { run_id: lab.json.runId })).status).toBe(409);
    // The gateway's own route still works for the gateway.
    expect((await post("/api/callback/secrets", token(repo, "wg.yml", gwGh), { run_id: gw.id })).status).toBe(200);
  });
});
