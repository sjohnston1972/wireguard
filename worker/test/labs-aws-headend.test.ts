// labs-aws-headend.test.ts
//
// Plain English: a lab peers only to a VPN server in its own cloud (AWS labs
// spec §2, decision 5): an Azure lab by VNet peering to an Azure server, an
// AWS lab by VPC peering to an AWS server. While the server is in AWS, an
// Azure lab: a deploy that asks to connect runs unconnected (see
// labs-peering.test.ts), and everything that would peer refuses with the
// same-cloud sentence and dispatches nothing: Peer, Re-peer, a release test
// of a lab that peers, and a lab whose peering is required. Every mix of AWS
// lab and server is in labs-aws-engine.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { saveSnapshot } from "../src/state";
import { api, deployLab, freeze, labDispatches, labEnv, runningLab, NOW } from "./labs-helpers";
import type { Env } from "../src/env";

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const awsUp = (env: Env) => saveSnapshot(env, { state: "running", running_since: NOW, cloud: "aws" });
const azureUp = (env: Env) => saveSnapshot(env, { state: "running", running_since: NOW, cloud: "azure" });
const NAMES_AWS = /Azure labs connect only to an Azure server \(the server is in AWS\)/;

describe("labs on an AWS headend refuse what would peer", () => {
  it("Peer refuses and dispatches nothing", async () => {
    freeze();
    const { env, world } = await labEnv();
    await runningLab(env, world, "az104-07-files");
    await awsUp(env);
    const before = labDispatches(world).length;
    const r = await api(env, "POST", "/labs/az104-07-files/peer");
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(NAMES_AWS);
    expect(labDispatches(world)).toHaveLength(before);
  });

  it("Re-peer refuses while labs wait, and dispatches nothing", async () => {
    freeze();
    const { env, world } = await labEnv();
    const a = await runningLab(env, world, "az104-07-files");
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'disconnected' WHERE id = ?1").bind(a.sid).run();
    await awsUp(env);
    const before = labDispatches(world).length;
    const r = await api(env, "POST", "/labs/repeer");
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(NAMES_AWS);
    expect(labDispatches(world)).toHaveLength(before);
  });

  it("a release test of a lab that peers refuses; one that never peers runs", async () => {
    freeze();
    const { env, world } = await labEnv();
    await awsUp(env);
    const t = await api(env, "POST", "/labs/az104-07-files/test");
    expect(t.status).toBe(409);
    expect(t.json.error.message).toMatch(NAMES_AWS);
    expect(labDispatches(world)).toHaveLength(0);
    const off = await api(env, "POST", "/labs/az104-05-storage/test");
    expect(off.status, off.text).toBe(200);
    expect(labDispatches(world).map((d) => d.action)).toEqual(["test"]);
  });

  it("a lab whose peering is required refuses to deploy, rather than claiming to run unconnected", async () => {
    freeze();
    const { env, world } = await labEnv();
    await awsUp(env);
    for (const peer of [true, false]) {
      const r = await deployLab(env, "az305-28-hub-spoke-fw", { hours: 2, peer, overBudgetOk: true, capacityOk: true });
      expect(r.status).toBe(409);
      expect(r.json.error.message).toMatch(/Hub-spoke with Azure Firewall needs its peering/);
      expect(r.json.error.message).toMatch(NAMES_AWS);
      expect(r.json.error.message).not.toMatch(/runs unconnected/);
    }
    expect(labDispatches(world)).toHaveLength(0);
  });

  it("with an Azure headend the same calls go ahead", async () => {
    freeze();
    const { env, world } = await labEnv();
    await runningLab(env, world, "az104-07-files");
    await azureUp(env);
    expect((await api(env, "POST", "/labs/az104-07-files/peer")).status).toBe(200);
    expect((await deployLab(env, "az305-28-hub-spoke-fw", { hours: 2, peer: true, overBudgetOk: true, capacityOk: true })).status).toBe(200);
  });

  it("an AWS headend that is torn down no longer blocks", async () => {
    freeze();
    const { env } = await labEnv();
    await saveSnapshot(env, { state: "destroyed", cloud: "aws" });
    expect((await api(env, "POST", "/labs/az104-07-files/test")).status).toBe(200);
  });
});
