// labs-peering.test.ts
//
// Plain English: plan L2.6. A lab peers to the gateway only with the
// gateway's own lock held for at most 10 minutes (so it never races a
// gateway apply or destroy on vnet-wg), and only while the gateway is up;
// wg.yml's destroy disconnects peered labs; Re-peer brings them back. Tunnel
// clients with the Azure route reach the lab pool, and the firewall gets a
// Labs rule: built in for a fresh install, proposed (never applied) for an
// existing one.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { acquireLock, lockStatus, releaseLock, labLock } from "../src/lock";
import { handleLabPeeringsRemoved } from "../src/labs/callbacks";
import { runLabWatch } from "../src/labs/watch";
import { proposeLabsRule } from "../src/labs/fwproposal";
import { saveSnapshot } from "../src/state";
import { startDeploy, startDestroy, issueRunSecrets, handleCallback } from "../src/runs";
import { clientAllowedIps } from "../src/peers";
import { compileFirewall, STARTER_RULES, type FwRule } from "../src/firewall";
import { simulate } from "../src/simulate";
import { config } from "../src/env";
import { lastGhRun } from "./harness";
import { api, deployLab, freeze, labDispatches, labEnv, peer, report, rows, runningLab, secrets, session, NOW } from "./labs-helpers";
import type { Env } from "../src/env";

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const up = (env: Env, state: "running" | "standby" | "destroyed" = "running") => saveSnapshot(env, { state, running_since: NOW });

describe("peering (L2.6)", () => {
  it("peer begin says wait while the gateway lock is held and go when it is free, then end releases it", async () => {
    freeze();
    const { env, world } = await labEnv();
    await up(env);
    const r = await deployLab(env, "az104-06-blob-security", { hours: 2, peer: true });
    const s = await secrets(env, world, r.json.runId);
    await acquireLock(env, "apply-20261004T115000Z-gwgwgw");
    const wait = await peer(env, s.callback_token, { run_id: r.json.runId, phase: "begin" });
    expect(wait).toMatchObject({ status: 200, body: { go: false } });
    expect((await session(env, r.json.sessionId))!.peering).toBe("waiting");
    await releaseLock(env, "apply-20261004T115000Z-gwgwgw");
    const go = await peer(env, s.callback_token, { run_id: r.json.runId, phase: "begin" });
    expect(go).toMatchObject({ status: 200, body: { go: true } });
    const held = await lockStatus(env);
    expect(held.lock?.runId).toBe(`peer:${r.json.runId}`);
    expect(held.lock!.expiresAt - Date.parse(NOW)).toBe(10 * 60_000);
    // While it is held, the gateway's own runs wait.
    await expect(startDestroy(env, "t")).rejects.toThrow(/lock/);
    const end = await peer(env, s.callback_token, { run_id: r.json.runId, phase: "end", ok: true });
    expect(end.status).toBe(200);
    expect((await lockStatus(env)).held).toBe(false);
    expect((await session(env, r.json.sessionId))!.peering).toBe("on");
    // The lab's own lock was never the gateway's.
    expect((await lockStatus(env, labLock("az104-06-blob-security"))).lock?.runId).toBe(r.json.runId);
    // Bad bodies and tokens are refused.
    expect((await peer(env, s.callback_token, { run_id: r.json.runId, phase: "middle" })).status).toBe(400);
    expect((await peer(env, s.callback_token, { run_id: r.json.runId, phase: "end" })).status).toBe(400);
    expect((await peer(env, s.callback_token, { run_id: r.json.runId, phase: "begin", extra: 1 })).status).toBe(400);
    expect((await peer(env, "wrong", { run_id: r.json.runId, phase: "begin" })).status).toBe(401);
  });

  it("begin says wait unless the gateway is running or in Standby", async () => {
    freeze();
    const { env, world } = await labEnv();
    await up(env, "destroyed");
    const r = await deployLab(env, "az104-06-blob-security", { hours: 2, peer: true });
    const s = await secrets(env, world, r.json.runId);
    expect((await peer(env, s.callback_token, { run_id: r.json.runId, phase: "begin" })).body).toMatchObject({ go: false });
    expect((await lockStatus(env)).held).toBe(false);
    await up(env, "standby");
    expect((await peer(env, s.callback_token, { run_id: r.json.runId, phase: "begin" })).body).toMatchObject({ go: true });
    await peer(env, s.callback_token, { run_id: r.json.runId, phase: "end", ok: false });
    expect((await session(env, r.json.sessionId))!.peering).toBe("waiting");
    expect((await lockStatus(env)).held).toBe(false);
  });

  it("begin links DNS zones only when no other peered lab has linked its own (Azure refuses two same-named zones on one VNet)", async () => {
    freeze();
    const { env, world } = await labEnv();
    // Lab 7 here also links private DNS zones.
    const { TEST_CATALOGUE } = await import("./labs-helpers");
    setCatalogueForTest({ ...TEST_CATALOGUE, labs: TEST_CATALOGUE.labs.map((l) => (l.id === "az104-07-files" ? { ...l, connectivity: { ...l.connectivity, dns_link: true } } : l)) });
    await up(env);
    const six = await deployLab(env, "az104-06-blob-security", { hours: 2, peer: true });
    const s6 = await secrets(env, world, six.json.runId);
    expect((await peer(env, s6.callback_token, { run_id: six.json.runId, phase: "begin" })).body).toEqual({ go: true, dns_link: true });
    await peer(env, s6.callback_token, { run_id: six.json.runId, phase: "end", ok: true });
    const seven = await deployLab(env, "az104-07-files", { hours: 2, peer: true });
    const s7 = await secrets(env, world, seven.json.runId);
    const begin = await peer(env, s7.callback_token, { run_id: seven.json.runId, phase: "begin" });
    expect(begin.body).toMatchObject({ go: true, dns_link: false });
    expect((begin.body as { note: string }).note).toMatch(/Blob security/);
    await peer(env, s7.callback_token, { run_id: seven.json.runId, phase: "end", ok: true });
    // With lab 6 no longer peered, lab 7's next peering links its zones; a lab with dns_link false never does.
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'off' WHERE id = ?1").bind(six.json.sessionId).run();
    const again = await deployLab(env, "az305-28-hub-spoke-fw", { hours: 1, peer: true });
    const s28 = await secrets(env, world, again.json.runId);
    expect((await peer(env, s28.callback_token, { run_id: again.json.runId, phase: "begin" })).body).toEqual({ go: true, dns_link: false });
  });

  it("peerings-removed marks peered sessions disconnected", async () => {
    freeze();
    const { env, world } = await labEnv();
    await up(env);
    const a = await runningLab(env, world, "az104-06-blob-security", { hours: 2, peer: true });
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'on' WHERE id = ?1").bind(a.sid).run();
    const b = await runningLab(env, world, "az104-05-storage");
    // The gateway's destroy, with its own run's callback token.
    const gw = await startDestroy(env, "t");
    const sec = await issueRunSecrets(env, gw.id, lastGhRun(world));
    const token = sec.body.callback_token as string;
    const body = { run_id: gw.id, peerings_removed: 1, dns_links_removed: 1, complete: true };
    expect((await handleLabPeeringsRemoved(env, null, body)).status).toBe(401);
    expect((await handleLabPeeringsRemoved(env, "wrong", body)).status).toBe(401);
    expect((await handleLabPeeringsRemoved(env, token, { ...body, run_id: "destroy-unknown" })).status).toBe(404);
    expect((await handleLabPeeringsRemoved(env, token, { ...body, extra: true })).status).toBe(400);
    expect((await handleLabPeeringsRemoved(env, token, { ...body, complete: "yes" })).status).toBe(400);
    // A lab run's token is not the gateway run's.
    expect((await handleLabPeeringsRemoved(env, a.token, body)).status).toBe(401);
    const ok = await handleLabPeeringsRemoved(env, token, body);
    expect(ok.status).toBe(200);
    expect((await session(env, a.sid))!.peering).toBe("disconnected");
    expect((await session(env, b.sid))!.peering).toBe("off");
    // Once the gateway run has finished, its token no longer works here.
    await handleCallback(env, token, { run_id: gw.id, action: "destroy", status: "success" });
    expect((await handleLabPeeringsRemoved(env, token, body)).status).toBe(409);
  });

  it("repeer dispatches one peer run per waiting or disconnected session", async () => {
    freeze();
    const { env, world } = await labEnv();
    const a = await runningLab(env, world, "az104-06-blob-security", { hours: 2, peer: true });
    const b = await runningLab(env, world, "az104-07-files", { hours: 2, peer: true });
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'disconnected' WHERE id = ?1").bind(b.sid).run();
    await runningLab(env, world, "az104-05-storage");
    // The gateway is down: nothing to peer to.
    await up(env, "destroyed");
    expect((await api(env, "POST", "/labs/repeer")).status).toBe(409);
    await up(env);
    const r = await api(env, "POST", "/labs/repeer");
    expect(r.status, r.text).toBe(200);
    expect(r.json.message).toMatch(/2 labs/);
    const peers = labDispatches(world).filter((d) => d.action === "peer");
    expect(peers.map((d) => d.payload.lab_id).sort()).toEqual(["az104-06-blob-security", "az104-07-files"]);
    expect(peers.every((d) => d.payload.peering === true)).toBe(true);
    expect((await session(env, b.sid))!.peering).toBe("waiting");
    void a;
  });

  it("peer and unpeer routes take the lab lock and dispatch their run", async () => {
    freeze();
    const { env, world } = await labEnv();
    await up(env);
    const a = await runningLab(env, world, "az104-07-files", { hours: 2, peer: false });
    expect((await session(env, a.sid))!.peering).toBe("off");
    const p = await api(env, "POST", "/labs/az104-07-files/peer");
    expect(p.status, p.text).toBe(200);
    const run = labDispatches(world).at(-1)!;
    expect(run.action).toBe("peer");
    expect((await lockStatus(env, labLock("az104-07-files"))).lock?.runId).toBe(run.payload.run_id);
    // While the peer run holds the lab's lock, unpeer waits.
    expect((await api(env, "POST", "/labs/az104-07-files/unpeer")).status).toBe(409);
    const s = await secrets(env, world, run.payload.run_id as string);
    await report(env, run.payload.run_id as string, s.callback_token, "success", {});
    expect((await session(env, a.sid))!.peering).toBe("on");
    const u = await api(env, "POST", "/labs/az104-07-files/unpeer");
    expect(u.status).toBe(200);
    const un = labDispatches(world).at(-1)!;
    expect(un.action).toBe("unpeer");
    const s2 = await secrets(env, world, un.payload.run_id as string);
    await report(env, un.payload.run_id as string, s2.callback_token, "success", {});
    expect((await session(env, a.sid))!.peering).toBe("off");
    // A lab that never peers refuses both.
    await runningLab(env, world, "az104-05-storage");
    expect((await api(env, "POST", "/labs/az104-05-storage/peer")).status).toBe(409);
    expect((await api(env, "POST", "/labs/az104-05-storage/unpeer")).status).toBe(409);
  });

  it("the gateway reaching Running pushes Re-peer N labs once", async () => {
    freeze();
    const { env, world } = await labEnv();
    const a = await runningLab(env, world, "az104-06-blob-security", { hours: 2, peer: true });
    const b = await runningLab(env, world, "az104-07-files", { hours: 2, peer: true });
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'disconnected' WHERE id = ?1").bind(b.sid).run();
    const gw = await startDeploy(env, { hours: 2, requesterIp: null, requestedBy: "t" });
    const sec = await issueRunSecrets(env, gw.id, lastGhRun(world));
    world.azure.rg = true;
    await handleCallback(env, sec.body.callback_token as string, { run_id: gw.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
    await handleCallback(env, sec.body.callback_token as string, { run_id: gw.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
    const pushes = world.notes.filter((n) => /re-peer/i.test(`${n.title} ${n.message}`));
    expect(pushes).toHaveLength(1);
    expect(pushes[0].message).toMatch(/2 labs/);
    expect((await api(env, "GET", "/overview")).json.labs.rePeer).toBe(2);
    void a;
  });
});

describe("clients (L2.6)", () => {
  const cfg = { subnet: "10.13.13.0/24", subnet6: "fd13:13::/64", loopbackIp: "10.13.255.1", vnetCidr: "10.50.0.0/16", homeLanCidr: "192.168.1.0/24" };

  it("clientAllowedIps adds 10.64.0.0/13 with azure_vnet only", () => {
    expect(clientAllowedIps(cfg, { full_tunnel: 0, azure_vnet: 1 })).toEqual(["10.13.13.0/24", "10.13.255.1/32", "fd13:13::/64", "10.50.0.0/16", "10.64.0.0/13"]);
    expect(clientAllowedIps(cfg, { full_tunnel: 0, azure_vnet: 0 })).not.toContain("10.64.0.0/13");
    expect(clientAllowedIps(cfg, { full_tunnel: 1, azure_vnet: 1 })).toEqual(["0.0.0.0/0", "::/0"]);
  });

  it("fetching a client's config clears labs_config_due", async () => {
    const { env } = await labEnv();
    const PHONE = "P".repeat(43) + "=";
    const LAPTOP = "L".repeat(43) + "=";
    const add = await api(env, "POST", "/clients", { name: "laptop", public_key: PHONE, azure_vnet: true });
    expect(add.json.template).toContain("10.64.0.0/13");
    const id = add.json.peer.id as number;
    await env.DB.prepare("UPDATE peers SET labs_config_due = 1 WHERE id = ?1").bind(id).run();
    expect((await api(env, "GET", "/clients")).json.clients[0].labsConfigDue).toBe(true);
    const re = await api(env, "POST", `/clients/${id}/rekey`, { public_key: LAPTOP });
    expect(re.status).toBe(200);
    expect(re.json.template).toContain("10.64.0.0/13");
    expect((await api(env, "GET", "/clients")).json.clients[0].labsConfigDue).toBe(false);
    // Editing it (a new config to download) clears it too.
    await env.DB.prepare("UPDATE peers SET labs_config_due = 1 WHERE id = ?1").bind(id).run();
    expect((await api(env, "PUT", `/clients/${id}`, { tunnel_dns: true })).status).toBe(200);
    expect((await api(env, "GET", "/clients")).json.clients[0].labsConfigDue).toBe(false);
  });
});

describe("firewall (L2.6)", () => {
  const cfg = { ...config({ WG_SUBNET6: "fd13:13::/64", HOME_LAN_CIDR: "192.168.1.0/24" } as unknown as Env), firewallDefault: "deny" as const };
  const starters = (): FwRule[] => STARTER_RULES.map((r, i) => ({ ...r, id: i + 1 }));

  it("a fresh install has Clients to labs at 25", async () => {
    const labs = STARTER_RULES.find((r) => r.dst_value === "labs")!;
    expect(labs).toMatchObject({ position: 25, name: "Clients to labs", src_kind: "zone", src_value: "clients", dst_kind: "zone", dst_value: "labs", proto: "any", action: "allow", enabled: 1 });
    const { text } = await compileFirewall(starters(), cfg, [], "deny");
    expect(text).toMatch(/ip saddr 10\.13\.13\.0\/24 ip daddr 10\.64\.0\.0\/13 counter name "r\d+" accept/);
  });

  it("an existing install gets it once as a draft proposal, never applied", async () => {
    freeze();
    const { env } = await labEnv();
    const liveBefore = await db.listFwRules(env);
    expect(liveBefore.some((r) => r.dst_value === "labs")).toBe(false);
    const versionBefore = (await db.getFwPolicy(env)).live_version;
    await runLabWatch(env, new Date());
    const draft = await db.listFwDraftRules(env);
    const proposed = draft.filter((r) => r.dst_kind === "zone" && r.dst_value === "labs");
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ name: "Clients to labs", position: 25, live_id: null, action: "allow" });
    // The live rules and their version are untouched: nothing reaches the VM until Apply.
    expect(await db.listFwRules(env)).toEqual(liveBefore);
    expect((await db.getFwPolicy(env)).live_version).toBe(versionBefore);
    // The Firewall page shows it in the draft.
    const fw = await api(env, "GET", "/firewall");
    expect(JSON.stringify(fw.json.draft)).toContain("Clients to labs");
    // Once: a later watch run, or a draft dropped by the operator, does not bring it back.
    await runLabWatch(env, new Date());
    await proposeLabsRule(env);
    expect((await db.listFwDraftRules(env)).filter((r) => r.dst_value === "labs")).toHaveLength(1);
    await db.dropFwDraft(env);
    await proposeLabsRule(env);
    expect((await db.listFwDraftRules(env)).filter((r) => r.dst_value === "labs")).toHaveLength(0);
    expect((await rows(env, "SELECT message FROM alerts WHERE message LIKE '%Clients to labs%'"))).toHaveLength(1);
  });

  it("an install that already has a labs rule gets no proposal", async () => {
    const { env } = await labEnv();
    await db.addFwRule(env, { enabled: 1, name: "Mine", src_kind: "zone", src_value: "clients", dst_kind: "zone", dst_value: "labs", proto: "tcp", ports: "22", action: "allow", log: 0 });
    await proposeLabsRule(env);
    expect((await db.listFwDraftRules(env)).filter((r) => r.live_id === null)).toHaveLength(0);
  });

  it("the simulator matches the labs zone", () => {
    const peers = [{ id: 1, name: "phone", public_key: "P".repeat(43) + "=", ip: "10.13.13.2", enabled: 1, full_tunnel: 0, azure_vnet: 1, tunnel_dns: 0, routes: "", home_lan: 0, created_at: "t", note: null }];
    const ctx = (rules: FwRule[]) => ({ rules, defaultAction: "deny" as const, cfg, peers });
    const toLab = { from: { kind: "client" as const, value: "1" }, to: { kind: "cidr" as const, value: "10.64.64.4" }, proto: "tcp" as const, port: 22 };
    const r = simulate(toLab, ctx(starters()));
    expect(r.verdict).toBe("allow");
    expect(r.matched?.name).toBe("Clients to labs");
    expect(r.limited ?? "").not.toMatch(/does not pass through the VM/);
    // "The internet" never matches a lab address.
    const internetOnly = starters().filter((x) => x.dst_value === "internet");
    expect(simulate(toLab, ctx(internetOnly)).verdict).toBe("deny");
    // The home LAN reaches labs through the VM too, so the rules govern it.
    const home = simulate({ from: { kind: "zone", value: "home" }, to: { kind: "zone", value: "labs" }, proto: "tcp", port: 443 }, ctx(starters()));
    expect(home.limited ?? "").not.toMatch(/does not pass through the VM/);
    expect(home.verdict).toBe("deny");
  });
});
