// Time-limited guest clients and the "no handshake in 30 days" marker (issue #47).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun } from "./harness";
import type { Env } from "../src/env";
import worker from "../src/index";
import * as db from "../src/db";
import { expiryFrom, peerExpired, peerStale, agentPeerList, terraformPeerList } from "../src/peers";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";
import { runScheduled } from "../src/monitor";
import { lifeMarkers } from "../src/views/peers";
import type { Peer } from "../src/db";

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const DAY = 86400_000;
const PHONE = "P".repeat(43) + "=";
const GUEST = "G".repeat(43) + "=";
const HOME = "H".repeat(43) + "=";

let env: Env;
let world: ReturnType<typeof makeEnv>["world"];
beforeEach(() => {
  ({ env, world } = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: "http://localhost:8787" } as Partial<Env>));
});
afterEach(() => vi.unstubAllGlobals());

function post(url: string, body: unknown): Promise<Response> {
  const init = { method: "POST", body: JSON.stringify(body), headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" } };
  return worker.fetch(new Request(`http://localhost:8787${url}`, init), env, ctx) as Promise<Response>;
}

const base: Peer = { id: 1, name: "Guest", public_key: GUEST, ip: "10.13.13.2", enabled: 1, full_tunnel: 0, azure_vnet: 0, tunnel_dns: 0, routes: "", home_lan: 0, created_at: new Date().toISOString(), note: null };

describe("expiry rules", () => {
  it("only offers never, 1 day, 1 week and 30 days", () => {
    const now = new Date("2026-09-26T12:00:00Z");
    expect(expiryFrom(0, now)).toBeNull();
    expect(expiryFrom(1, now)).toBe("2026-09-27T12:00:00.000Z");
    expect(expiryFrom(7, now)).toBe("2026-10-03T12:00:00.000Z");
    expect(expiryFrom(30, now)).toBe("2026-10-26T12:00:00.000Z");
    expect(expiryFrom(5, now)).toBeNull();
    expect(expiryFrom("junk", now)).toBeNull();
  });

  it("expired clients are left off the VM and out of Terraform", () => {
    const now = Date.now();
    const peers = [
      { ...base, expires_at: new Date(now - 1000).toISOString() },
      { ...base, id: 2, name: "Phone", public_key: PHONE, ip: "10.13.13.3", expires_at: new Date(now + DAY).toISOString() },
      { ...base, id: 3, name: "Laptop", public_key: HOME, ip: "10.13.13.4", expires_at: null },
    ];
    expect(peerExpired(peers[0], now)).toBe(true);
    expect(agentPeerList(peers, "", [], now).map((p) => p.name)).toEqual(["Phone", "Laptop"]);
    expect(terraformPeerList(peers, [], now).map((p) => p.name)).toEqual(["Phone", "Laptop"]);
  });

  it("stale: no handshake in 30 days, or never and added over 30 days ago", () => {
    const now = Date.now();
    const old = new Date(now - 31 * DAY).toISOString();
    expect(peerStale({ created_at: old, last_handshake_at: null }, now)).toBe(true);
    expect(peerStale({ created_at: old, last_handshake_at: new Date(now - 2 * DAY).toISOString() }, now)).toBe(false);
    expect(peerStale({ created_at: new Date(now - DAY).toISOString(), last_handshake_at: null }, now)).toBe(false);
  });

  it("the Clients page says when it expires, that it expired, and when it has gone quiet", () => {
    const now = Date.now();
    expect(String(lifeMarkers({ ...base, expires_at: new Date(now + 3 * DAY).toISOString() }, now))).toContain("expires in 3 days");
    expect(String(lifeMarkers({ ...base, expires_at: new Date(now + 5 * 3600_000).toISOString() }, now))).toContain("expires in 5 hours");
    expect(String(lifeMarkers({ ...base, expires_at: new Date(now - 1000).toISOString() }, now))).toContain(">expired<");
    expect(String(lifeMarkers({ ...base, created_at: new Date(now - 40 * DAY).toISOString() }, now))).toContain("no handshake in 30 days");
    expect(String(lifeMarkers(base, now))).toBe("");
  });
});

describe("expiry in the database, the API and the watchman", () => {
  it("adds a guest with an expiry, changes it, and removes it", async () => {
    let r = await post("/api/peers", { name: "Guest", public_key: GUEST, expires_days: 7 });
    expect(r.status).toBe(200);
    const { peer } = (await r.json()) as { peer: Peer };
    expect(Date.parse(peer.expires_at!) - Date.now()).toBeGreaterThan(7 * DAY - 60_000);

    r = await post(`/api/peers/${peer.id}/expiry`, { days: 1 });
    expect(r.status).toBe(200);
    expect(Date.parse((await db.getPeer(env, peer.id))!.expires_at!) - Date.now()).toBeLessThan(DAY + 60_000);

    r = await post(`/api/peers/${peer.id}/expiry`, { days: 0 });
    expect((await db.getPeer(env, peer.id))!.expires_at).toBeNull();

    const plain = (await (await post("/api/peers", { name: "Phone", public_key: PHONE })).json()) as { peer: Peer };
    expect(plain.peer.expires_at).toBeNull();
  });

  it("the home site never expires", async () => {
    const site = await db.addPeer(env, { name: "home-site", public_key: HOME, ip: "10.13.13.10", full_tunnel: false });
    await env.DB.prepare("UPDATE peers SET routes = '192.168.1.0/24' WHERE id = ?1").bind(site.id).run();
    const r = await post(`/api/peers/${site.id}/expiry`, { days: 1 });
    expect(r.status).toBe(400);
    expect((await db.getPeer(env, site.id))!.expires_at).toBeNull();
  });

  it("an expired client is off the VM at once, then the watchman switches it off with a note", async () => {
    const guest = await db.addPeer(env, { name: "Guest", public_key: GUEST, ip: "10.13.13.2", full_tunnel: false, expires_at: new Date(Date.now() - 1000).toISOString() });
    await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.3", full_tunnel: false });
    expect((await db.enabledPeers(env)).map((p) => p.name)).toEqual(["Phone"]);

    await runScheduled(env);
    expect((await db.getPeer(env, guest.id))!.enabled).toBe(0);
    expect((await db.unacknowledgedAlerts(env)).some((a) => /Client "Guest" expired and was switched off/.test(a.message))).toBe(true);

    // A second pass has nothing to say.
    const before = (await db.unacknowledgedAlerts(env)).length;
    await runScheduled(env);
    expect((await db.unacknowledgedAlerts(env)).length).toBe(before);

    // Switching it back on clears the old expiry, so it stays on.
    await db.setPeerEnabled(env, guest.id, true);
    expect(await db.getPeer(env, guest.id)).toMatchObject({ enabled: 1, expires_at: null });
  });

  it("heartbeats remember the last handshake, but only rewrite it when it moves by over an hour", async () => {
    const phone = await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
    const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
    world.azure.rg = true;
    await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
    const token = sec.body.agent_token as string;
    const beat = (hs: number) => handleAgent(env, token, { dump: ["PRIV\tS=\t51820\toff", `${PHONE}\t(none)\t203.0.113.9:4000\t10.13.13.2/32\t${hs}\t1\t1\t25`].join("\n") });

    const t0 = Math.floor(Date.now() / 1000) - 2 * 3600;
    await beat(t0);
    expect((await db.getPeer(env, phone.id))!.last_handshake_at).toBe(new Date(t0 * 1000).toISOString());
    await beat(t0 + 600); // ten minutes later: not worth a write
    expect((await db.getPeer(env, phone.id))!.last_handshake_at).toBe(new Date(t0 * 1000).toISOString());
    await beat(t0 + 2 * 3600);
    expect((await db.getPeer(env, phone.id))!.last_handshake_at).toBe(new Date((t0 + 2 * 3600) * 1000).toISOString());
  });
});
