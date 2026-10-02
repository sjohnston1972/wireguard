// api-clients.test.ts
//
// Plain English: the Clients screen's data: every client with what the VM
// says about it, the exact routes its config sends through the tunnel,
// stale and expiry flags, and the counts across the top; one client's
// detail with its top destinations and change history.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv } from "./api-helpers";
import { lastGhRun } from "./harness";
import * as db from "../src/db";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";
import { clientAllowedIps } from "../src/peers";
import { clientStatus } from "../src/clients";
import { saveSnapshot } from "../src/state";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const PHONE = "P".repeat(43) + "=";
const LAPTOP = "L".repeat(43) + "=";
const cfg = { subnet: "10.13.13.0/24", subnet6: "fd13:13::/64", loopbackIp: "10.13.255.1", vnetCidr: "10.50.0.0/16", homeLanCidr: "192.168.1.0/24" };
const DUMP = (lines: string[]) => ["PRIV\tS=\t51820\toff", ...lines].join("\n");
const line = (key: string, ip: string, hs: number) => `${key}\t(none)\t203.0.113.25:4000\t${ip}/32\t${hs}\t1000\t2000\t0`;

async function deployWith(env: Env, world: ReturnType<typeof apiEnv>["world"]) {
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return sec.body.agent_token as string;
}

describe("clientAllowedIps", () => {
  it("lists exactly what each kind of config sends through the tunnel", () => {
    expect(clientAllowedIps(cfg, { full_tunnel: 0 })).toEqual(["10.13.13.0/24", "10.13.255.1/32", "fd13:13::/64"]);
    expect(clientAllowedIps(cfg, { full_tunnel: 0, azure_vnet: 1, home_lan: 1 })).toEqual(["10.13.13.0/24", "10.13.255.1/32", "fd13:13::/64", "10.50.0.0/16", "192.168.1.0/24"]);
    expect(clientAllowedIps(cfg, { full_tunnel: 1, azure_vnet: 1 })).toEqual(["0.0.0.0/0", "::/0"]);
    expect(clientAllowedIps({ ...cfg, homeLanCidr: "" }, { full_tunnel: 0, home_lan: 1 })).toEqual(["10.13.13.0/24", "10.13.255.1/32", "fd13:13::/64"]);
  });
});

describe("clientStatus", () => {
  const now = Date.parse("2026-10-02T10:00:00Z");
  const peer = (o: Partial<db.Peer> = {}) => ({ id: 1, name: "x", public_key: PHONE, ip: "10.13.13.2", enabled: 1, full_tunnel: 0, azure_vnet: 0, tunnel_dns: 0, routes: "", home_lan: 0, created_at: "x", note: null, ...o }) as db.Peer;
  const live = (hsAgo: number) => ({ public_key: PHONE, endpoint: null, allowed_ips: "", latest_handshake: now / 1000 - hsAgo, rx: 0, tx: 0 });
  it("says what the VM reports, not just what the table says", () => {
    expect(clientStatus(peer(), live(10), true, now)).toBe("online");
    expect(clientStatus(peer(), live(600), true, now)).toBe("offline");
    expect(clientStatus(peer(), undefined, true, now)).toBe("loading");
    expect(clientStatus(peer(), undefined, false, now)).toBe("headend_down");
    expect(clientStatus(peer({ enabled: 0 }), live(10), true, now)).toBe("removing");
    expect(clientStatus(peer({ enabled: 0 }), undefined, true, now)).toBe("disabled");
    expect(clientStatus(peer({ enabled: 0, expires_at: "2026-10-01T00:00:00Z" }), undefined, false, now)).toBe("expired");
    expect(clientStatus(peer({ expires_at: "2026-10-01T00:00:00Z" }), undefined, false, now)).toBe("expired");
  });
});

describe("GET /clients", () => {
  it("lists clients with live state, routes, flags and counts", async () => {
    const { env, world } = apiEnv();
    await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false, azure_vnet: true });
    await db.addPeer(env, { name: "Laptop", public_key: LAPTOP, ip: "10.13.13.3", full_tunnel: true, expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    const token = await deployWith(env, world);
    const s = Math.floor(Date.now() / 1000);
    await handleAgent(env, token, { dump: DUMP([line(PHONE, "10.13.13.2", s - 5), line(LAPTOP, "10.13.13.3", s - 900)]), rtt: { [PHONE]: 20 } });
    const r = await api(env, "GET", "/clients");
    expect(r.status).toBe(200);
    expect(r.json.running).toBe(true);
    const phone = r.json.clients.find((x: { name: string }) => x.name === "Phone");
    expect(phone).toMatchObject({ status: "online", lastLatencyMs: 20, allowedIps: ["10.13.13.0/24", "10.13.255.1/32", "fd13:13::/64", "10.50.0.0/16"], ip6: "fd13:13::2", isSite: false, expiresSoon: false });
    expect(phone.live).toMatchObject({ rx: 1000, tx: 2000 });
    const laptop = r.json.clients.find((x: { name: string }) => x.name === "Laptop");
    expect(laptop).toMatchObject({ status: "offline", allowedIps: ["0.0.0.0/0", "::/0"], expiresSoon: true });
    expect(r.json.kpis).toEqual({ total: 2, online: 1, avgLatencyMs: 20, fullTunnel: 1, stale: 0, expiringSoon: 1 });
    expect(r.json.nextIp).toBe("10.13.13.4");
    expect(r.json.serverPub).toBe("wapbe4SDSmZoefARMVLSAR2KHjjCU3DJ3McGiXQ+3yc=");
  });

  it("shows every client as headend down while nothing runs, with no latency", async () => {
    const { env } = apiEnv();
    await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    const r = await api(env, "GET", "/clients");
    expect(r.json.running).toBe(false);
    expect(r.json.clients[0]).toMatchObject({ status: "headend_down", live: null, lastLatencyMs: null });
    expect(r.json.kpis.avgLatencyMs).toBeNull();
  });
});

describe("GET /clients/:id", () => {
  it("gives one client with its destinations and changes", async () => {
    const { env } = apiEnv();
    const p = await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    await db.audit(env, "steven", "client.add", "Phone", null, { name: "Phone" });
    await db.audit(env, "steven", "client.add", "Other", null, { name: "Other" });
    await saveSnapshot(env, { talkers: { "10.13.13.2|1.1.1.1": { c: "10.13.13.2", r: "1.1.1.1", name: "one.one.one.one", up: 10, down: 20, bu: 0, bd: 0, at: "x" }, "10.13.13.9|8.8.8.8": { c: "10.13.13.9", r: "8.8.8.8", name: null, up: 1, down: 1, bu: 0, bd: 0, at: "x" } } });
    const r = await api(env, "GET", `/clients/${p.id}`);
    expect(r.status).toBe(200);
    expect(r.json.client.name).toBe("Phone");
    expect(r.json.talkers.map((t: { r: string }) => t.r)).toEqual(["1.1.1.1"]);
    expect(r.json.changes.map((a: { target: string }) => a.target)).toEqual(["Phone"]);
  });

  it("answers 404 for a client that does not exist and 400 for a bad id", async () => {
    const { env } = apiEnv();
    expect((await api(env, "GET", "/clients/99")).status).toBe(404);
    expect((await api(env, "GET", "/clients/abc")).status).toBe(400);
  });
});
