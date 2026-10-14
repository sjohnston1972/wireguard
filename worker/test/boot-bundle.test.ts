// boot-bundle.test.ts
// Plain English: an AWS VM's first-boot bundle is served only to the current deploy's agent token.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, wgRef, type World } from "./harness";
import type { Env } from "../src/env";
import { startDeploy, issueRunSecrets, bootBundle } from "../src/runs";

let env: Env;
let world: World;
beforeEach(() => ({ env, world } = makeEnv()));
afterEach(() => vi.unstubAllGlobals());

async function deployAws() {
  const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" });
  const s = await issueRunSecrets(env, run.id, lastGhRun(world), wgRef(env, "wg-aws.yml"));
  await env.STATE.put(`boot/${run.id}.tgz`, new Uint8Array([0x1f, 0x8b, 8, 0]));
  return { run, token: s.body.agent_token as string, cb: s.body.callback_token as string };
}

describe("boot bundle", () => {
  it("serves this deploy's bundle to its agent token", async () => {
    const { token } = await deployAws();
    const r = await bootBundle(env, token);
    expect(r.status).toBe(200);
    expect(new Uint8Array(await new Response(r.body as ReadableStream).arrayBuffer())[0]).toBe(0x1f);
  });
  it("refuses a wrong or missing token", async () => {
    await deployAws();
    expect((await bootBundle(env, "nope")).status).toBe(401);
    expect((await bootBundle(env, "")).status).toBe(401);
  });
  it("answers 404 when no bundle was stored, so the VM retries", async () => {
    const { run, token } = await deployAws();
    await env.STATE.delete(`boot/${run.id}.tgz`);
    expect((await bootBundle(env, token)).status).toBe(404);
  });
  it("answers 410 to an older deploy's token", async () => {
    const first = await deployAws();
    // A newer apply exists (as after a fresh deploy): the first token is stale.
    await env.DB.prepare("UPDATE runs SET requested_at = '2000-01-01T00:00:00Z' WHERE id = ?1").bind(first.run.id).run();
    await env.DB.prepare("INSERT INTO runs (id, action, status, requested_at) VALUES ('apply-newer', 'apply', 'success', ?1)").bind(new Date().toISOString()).run();
    expect((await bootBundle(env, first.token)).status).toBe(410);
  });
});
