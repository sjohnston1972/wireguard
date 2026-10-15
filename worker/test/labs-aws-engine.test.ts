// labs-aws-engine.test.ts
//
// Plain English: AWS labs through the lab engine (AWS labs spec §2, §6):
// the right workflow, region, name prefix and gateway range in the payload;
// secrets only to the workflow of the lab's cloud; the same-cloud peering
// rule in every mix of lab and server; and an AWS server tear-down that
// unpeers the AWS labs first (ruling A30) and leaves them ready to Re-peer.

import { afterEach, describe, expect, it, vi } from "vitest";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { saveSnapshot, getSnapshot } from "../src/state";
import { claimsProblem } from "../src/oidc";
import { issueLabSecrets, handleLabPeer } from "../src/labs/callbacks";
import { estimateSoFar } from "../src/labs/view";
import { finishRun } from "../src/labs/settle";
import { getLabRun } from "../src/labs/store";
import { startDestroy, startDeploy } from "../src/runs";
import { UNPEER_FOR_SERVER } from "../src/labs/engine";
import { runLabWatch } from "../src/labs/watch";
import { api, deployLab, freeze, ghIdFor, labDispatches, labEnv, peerRunFor, runningLab, withAwsLabs, NOW } from "./labs-helpers";
import type { Env } from "../src/env";

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const server = (env: Env, cloud: "azure" | "aws", state: "running" | "destroyed" = "running") => saveSnapshot(env, { state, running_since: NOW, cloud });

describe("dispatch by cloud", () => {
  it("an AWS lab dispatches lab-aws.yml with London, an a<NN> prefix and the gateway range; an Azure payload is unchanged", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await deployLab(env, "soa-03-auto-scaling");
    await deployLab(env, "az104-05-storage");
    const [aws, az] = labDispatches(world);
    expect(aws.workflow).toBe("lab-aws.yml");
    expect(aws.payload).toMatchObject({ lab_id: "soa-03-auto-scaling", region: "eu-west-2", gateway_cidr: "10.50.0.0/16" });
    expect(aws.payload.name_prefix).toMatch(/^a03[a-z0-9]{5}$/);
    expect(az.workflow).toBe("lab.yml");
    expect("gateway_cidr" in az.payload).toBe(false);
    expect(az.payload.name_prefix).toMatch(/^l05[a-z0-9]{5}$/);
    // Byte-identical to before: exactly the §5 keys, in their order.
    expect(Object.keys(az.payload)).toEqual(["lab_id", "version", "run_id", "session_id", "region", "secondary_region", "slot_cidr", "name_prefix", "peering", "timeout_min", "callback_url", "secrets_url"]);
    expect(Object.keys(aws.payload)).toEqual(["lab_id", "version", "run_id", "session_id", "region", "secondary_region", "slot_cidr", "name_prefix", "peering", "timeout_min", "callback_url", "secrets_url", "gateway_cidr"]);
  });

  it("an AWS lab refuses another region", async () => {
    freeze();
    const { env } = await labEnv();
    withAwsLabs();
    const r = await api(env, "POST", "/labs/soa-03-auto-scaling/deploy", { hours: 1, peer: false, region: "eu-west-1" });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toBe("AWS labs run in London (eu-west-2).");
  });

  it("an Azure lab still refuses an AWS region", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const r = await api(env, "POST", "/labs/az104-05-storage/deploy", { hours: 1, peer: false, region: "eu-west-2" });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toBe("That is not a region on offer.");
    expect(labDispatches(world)).toHaveLength(0);
  });

  it("cancelling an AWS deploy looks for its run among lab-aws.yml's runs", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await deployLab(env, "soa-03-auto-scaling");
    await api(env, "POST", "/labs/soa-03-auto-scaling/cancel");
    expect(world.calls.some((c) => c.path.includes("/actions/workflows/lab-aws.yml/runs"))).toBe(true);
    expect(world.calls.some((c) => c.path.includes("/actions/workflows/lab.yml/runs"))).toBe(false);
  });
});

describe("secrets go only to the workflow of the lab's cloud", () => {
  it("lab-secrets accepts either lab workflow's token, never wg.yml's", () => {
    const env = { GITHUB_REPO: "o/r" } as Env;
    const c = (wf: string) => ({ repository: "o/r", ref: "refs/heads/main", workflow_ref: `o/r/.github/workflows/${wf}@refs/heads/main`, event_name: "workflow_dispatch", run_id: "1" });
    expect(claimsProblem(env, c("lab-aws.yml"), ["lab.yml", "lab-aws.yml"])).toBeNull();
    expect(claimsProblem(env, c("lab.yml"), ["lab.yml", "lab-aws.yml"])).toBeNull();
    expect(claimsProblem(env, c("wg-aws.yml"), ["lab.yml", "lab-aws.yml"])).toMatch(/wrong workflow/);
  });

  it("an AWS run's secrets are refused to a lab.yml token, and handed to a lab-aws.yml one", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const r = await deployLab(env, "soa-03-auto-scaling");
    const runId = r.json.runId as string;
    const wrong = await issueLabSecrets(env, runId, ghIdFor(world, runId), `${env.GITHUB_REPO}/.github/workflows/lab.yml@refs/heads/main`);
    expect(wrong).toEqual({ status: 403, body: { error: "that workflow does not build this lab's cloud" } });
    const right = await issueLabSecrets(env, runId, ghIdFor(world, runId), `${env.GITHUB_REPO}/.github/workflows/lab-aws.yml@refs/heads/main`);
    expect(right.status).toBe(200);
  });

  it("an Azure run's secrets are refused to a lab-aws.yml token", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const r = await deployLab(env, "az104-05-storage");
    const runId = r.json.runId as string;
    const wrong = await issueLabSecrets(env, runId, ghIdFor(world, runId), `${env.GITHUB_REPO}/.github/workflows/lab-aws.yml@refs/heads/main`);
    expect(wrong.status).toBe(403);
    expect((await issueLabSecrets(env, runId, ghIdFor(world, runId), `${env.GITHUB_REPO}/.github/workflows/lab.yml@refs/heads/main`)).status).toBe(200);
  });
});

// [lab, server cloud or null for none, deploy-with-peer's session peering, message pattern or null]
const MIX: [string, "azure" | "aws" | null, "waiting" | "off", RegExp | null][] = [
  ["soa-03-auto-scaling", "aws", "waiting", null],
  ["soa-03-auto-scaling", "azure", "off", /AWS labs connect only to an AWS server \(the server is in Azure\)\. This lab runs unconnected\./],
  ["az104-07-files", "aws", "off", /Azure labs connect only to an Azure server \(the server is in AWS\)\. This lab runs unconnected\./],
  ["az104-07-files", "azure", "waiting", null],
  ["soa-03-auto-scaling", null, "waiting", null],
];
describe("same-cloud peering (spec §2, decision 5)", () => {
  for (const [lab, cloud, peering, re] of MIX) {
    it(`${lab} with ${cloud ?? "no"} server: deploy with Peer → ${peering}`, async () => {
      freeze();
      const { env } = await labEnv();
      withAwsLabs();
      if (cloud) await server(env, cloud);
      const r = await api(env, "POST", `/labs/${lab}/deploy`, { hours: 1, peer: true });
      expect(r.status).toBe(200);
      if (re) expect(r.json.message).toMatch(re);
      else expect(r.json.message).not.toMatch(/runs unconnected/);
      const s = await env.DB.prepare("SELECT peering FROM lab_sessions WHERE lab_id = ?1").bind(lab).first<{ peering: string }>();
      expect(s?.peering).toBe(peering);
    });
  }

  it("Peer and a release test refuse across clouds with the sentence; the same cloud goes ahead", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "soa-03-auto-scaling");
    await server(env, "azure");
    const p = await api(env, "POST", "/labs/soa-03-auto-scaling/peer");
    expect(p.status).toBe(409);
    expect(p.json.error.message).toBe("AWS labs connect only to an AWS server (the server is in Azure). It keeps running unconnected.");
    const t = await api(env, "POST", "/labs/soa-05-rds/test");
    expect(t.status).toBe(409);
    expect(t.json.error.message).toMatch(/^AWS labs connect only to an AWS server \(the server is in Azure\)\. The release test of .* peers it, so it cannot run now\.$/);
    await server(env, "aws");
    expect((await api(env, "POST", "/labs/soa-03-auto-scaling/peer")).status).toBe(200);
  });

  it("peer begin says go only when the running server is in the lab's cloud, and never links DNS for AWS", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const { sid } = await runningLab(env, world, "soa-03-auto-scaling");
    const { run, token } = await peerRunFor(env, world, sid);
    await server(env, "azure");
    const no = await handleLabPeer(env, token, { run_id: run.id, phase: "begin" });
    expect(no.body).toEqual({ go: false, reason: "AWS labs connect only to an AWS server (the server is in Azure)." });
    await server(env, "aws");
    const yes = await handleLabPeer(env, token, { run_id: run.id, phase: "begin" });
    expect(yes.body).toEqual({ go: true, dns_link: false });
  });

  it("Re-peer acts on the running server's cloud only and names the others", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const a = await runningLab(env, world, "soa-03-auto-scaling");
    const z = await runningLab(env, world, "az104-07-files");
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'disconnected' WHERE id IN (?1, ?2)").bind(a.sid, z.sid).run();
    await server(env, "aws");
    const before = labDispatches(world).length;
    const r = await api(env, "POST", "/labs/repeer");
    expect(r.status).toBe(200);
    const sent = labDispatches(world).slice(before);
    expect(sent.map((d) => [d.workflow, d.action, d.payload.lab_id])).toEqual([["lab-aws.yml", "peer", "soa-03-auto-scaling"]]);
    expect(r.json.message).toMatch(/Azure labs connect only to an Azure server \(the server is in AWS\)/);
  });

  it("the Overview's Re-peer count is the running server's cloud only", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const a = await runningLab(env, world, "soa-03-auto-scaling");
    const z = await runningLab(env, world, "az104-07-files");
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'disconnected' WHERE id IN (?1, ?2)").bind(a.sid, z.sid).run();
    const { labsSummary } = await import("../src/labs/summary");
    expect((await labsSummary(env, new Date())).rePeer).toBe(2);
    await server(env, "aws");
    expect((await labsSummary(env, new Date())).rePeer).toBe(1);
  });
});

describe("the AWS server's tear-down (A30) and apply (A15)", () => {
  it("an AWS server destroy dispatches an unpeer per peered AWS lab before wg-aws.yml, and leaves them disconnected", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const a = await runningLab(env, world, "soa-03-auto-scaling");
    const b = await runningLab(env, world, "soa-05-rds");
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'on' WHERE id = ?1").bind(a.sid).run();
    await server(env, "aws");
    const before = world.dispatches.length;
    await startDestroy(env, "steven", "dashboard");
    const sent = world.dispatches.slice(before).map((d) => [d.workflow, d.action, (d.payload as { lab_id?: string }).lab_id ?? null]);
    expect(sent).toEqual([["lab-aws.yml", "unpeer", "soa-03-auto-scaling"], ["wg-aws.yml", "destroy", null]]);
    const peering = async (sid: string) => (await env.DB.prepare("SELECT peering FROM lab_sessions WHERE id = ?1").bind(sid).first<{ peering: string }>())?.peering;
    expect(await peering(a.sid)).toBe("disconnected");
    expect(await peering(b.sid)).toBe("off");
    const unpeer = (await env.DB.prepare("SELECT id FROM lab_runs WHERE session_id = ?1 AND action = 'unpeer'").bind(a.sid).first<{ id: string }>())!;
    const run = (await getLabRun(env, unpeer.id))!;
    expect(run.reason).toBe(UNPEER_FOR_SERVER);
    await finishRun(env, run, { ok: true, via: "callback" });
    expect(await peering(a.sid)).toBe("disconnected");
  });

  it("a peered AWS lab whose lock is held is noted, and the server's destroy still goes", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const a = await runningLab(env, world, "soa-03-auto-scaling");
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'on' WHERE id = ?1").bind(a.sid).run();
    await peerRunFor(env, world, a.sid); // holds the lab's lock
    await server(env, "aws");
    const before = world.dispatches.length;
    await startDestroy(env, "steven", "dashboard");
    expect(world.dispatches.slice(before).map((d) => d.workflow)).toEqual(["wg-aws.yml"]);
    const alert = await env.DB.prepare("SELECT kind, message FROM alerts WHERE message LIKE '%could not be unpeered%'").first<{ kind: string; message: string }>();
    expect(alert?.kind).toBe("info");
    expect(alert?.message).toMatch(/^Auto Scaling behind a load balancer could not be unpeered before the AWS server's tear-down/);
    expect((await env.DB.prepare("SELECT peering FROM lab_sessions WHERE id = ?1").bind(a.sid).first<{ peering: string }>())?.peering).toBe("disconnected");
  });

  it("an Azure server destroy starts no lab run", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const a = await runningLab(env, world, "soa-03-auto-scaling");
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'on' WHERE id = ?1").bind(a.sid).run();
    await server(env, "azure");
    const before = world.dispatches.length;
    await startDestroy(env, "steven", "dashboard");
    expect(world.dispatches.slice(before).map((d) => d.workflow)).toEqual(["wg.yml"]);
  });

  it("at 100% of the budget the guard tears an AWS lab down through lab-aws.yml and never touches the server", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "soa-03-auto-scaling");
    await server(env, "aws");
    await env.DB.prepare("INSERT INTO lab_cost_days (day, rg, lab_id, gbp, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(NOW.slice(0, 10), "aws:soa-03-auto-scaling", "soa-03-auto-scaling", 1000, NOW).run();
    const before = world.dispatches.length;
    await runLabWatch(env, new Date(NOW));
    expect(world.dispatches.slice(before).map((d) => [d.workflow, d.action])).toEqual([["lab-aws.yml", "destroy"]]);
  });

  it("an AWS server apply marks AWS-peered labs disconnected (A15)", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const a = await runningLab(env, world, "soa-03-auto-scaling");
    const z = await runningLab(env, world, "az104-07-files");
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'on' WHERE id IN (?1, ?2)").bind(a.sid, z.sid).run();
    await server(env, "aws", "destroyed");
    await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" });
    expect((await env.DB.prepare("SELECT peering FROM lab_sessions WHERE id = ?1").bind(a.sid).first<{ peering: string }>())?.peering).toBe("disconnected");
    expect((await env.DB.prepare("SELECT peering FROM lab_sessions WHERE id = ?1").bind(z.sid).first<{ peering: string }>())?.peering).toBe("on");
    expect((await getSnapshot(env)).cloud).toBe("aws");
  });
});

describe("what the screens get", () => {
  it("a session's estimate counts the ALB's started hour whole (A20)", () => {
    const s = { est_gbp_h: 0.0341, requested_at: "2026-10-15T09:00:00.000Z", ended_at: "2026-10-15T09:30:00.000Z", est_gbp: null };
    expect(estimateSoFar(s, 0, 0.0199)).toBeCloseTo(0.0341 * 0.5 + 0.0199 * 0.5, 6);
  });

  it("GET /labs/:id for an AWS lab: cloud, London, console links per region while live, and the connect note", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "saa-16-dr-pilot-light");
    await server(env, "azure");
    const r = await api(env, "GET", "/labs/saa-16-dr-pilot-light");
    expect(r.json).toMatchObject({
      cloud: "aws",
      secondaryRegion: "eu-west-1",
      portalUrl: null,
      defaults: { region: "eu-west-2" },
      gatewayUp: false,
      connect: { possible: false, note: "AWS labs connect only to an AWS server (the server is in Azure). This lab runs unconnected." },
      consoleUrls: [
        { region: "eu-west-2", label: "London", url: "https://eu-west-2.console.aws.amazon.com/resource-groups/group/lab-saa-16-dr-pilot-light?region=eu-west-2" },
        { region: "eu-west-1", label: "Ireland", url: "https://eu-west-1.console.aws.amazon.com/resource-groups/group/lab-saa-16-dr-pilot-light?region=eu-west-1" },
      ],
    });
    expect(r.json.card.cloud).toBe("aws");
  });

  it("GET /labs/:id for an Azure lab keeps the portal link, no console links, and connects on an Azure server", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "az104-07-files");
    await server(env, "azure");
    const r = await api(env, "GET", "/labs/az104-07-files");
    expect(r.json).toMatchObject({ cloud: "azure", consoleUrls: null, gatewayUp: true, connect: { possible: true, note: null } });
    expect(r.json.portalUrl).toMatch(/^https:\/\/portal\.azure\.com\//);
  });

  it("the result callback keeps an AWS lab's peer_vpc_id", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const { sid } = await runningLab(env, world, "soa-03-auto-scaling", { hours: 2, peer: false }, { private_ips: { "vm-web": "10.64.64.10" }, connect: [], users: {}, peer_vpc_id: "vpc-0abc" });
    const s = await env.DB.prepare("SELECT outputs_json FROM lab_sessions WHERE id = ?1").bind(sid).first<{ outputs_json: string }>();
    expect(JSON.parse(s!.outputs_json).peer_vpc_id).toBe("vpc-0abc");
  });
});
