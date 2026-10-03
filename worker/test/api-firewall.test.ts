// api-firewall.test.ts
//
// Plain English: the Firewall screen's data and its published-port and
// packet-capture actions (/api/v1/firewall...): the rule table with hits and policy state, recent drops, published ports
// (saved, then Azure told; a refusal from Azure is a warning, not a loss),
// captures, and clearing the counters.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv, base } from "./api-helpers";
import { lastGhRun } from "./harness";
import * as db from "../src/db";
import worker from "../src/index";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent, currentFirewall } from "../src/runs";
import { getSnapshot } from "../src/state";
import { dropsSince } from "../src/fwview";
import type { FwRule } from "../src/firewall";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const PHONE = "P".repeat(43) + "=";
const DUMP = (lines: string[]) => ["PRIV\tS=\t51820\toff", ...lines].join("\n");

async function deployWith(env: Env, world: ReturnType<typeof apiEnv>["world"]) {
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "dev@localhost" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return sec.body.agent_token as string;
}

const fwd = { name: "Test VM web", proto: "tcp", public_port: 8080, target_ip: "10.50.2.4" };

const rule = (o: Partial<FwRule> & { name: string }) => ({ enabled: 1, src_kind: "any" as const, src_value: "", dst_kind: "any" as const, dst_value: "", proto: "any" as const, ports: "", action: "allow" as const, log: 0, ...o });

/** Count the Worker's calls to Azure's management API, and let them through. */
function countAzure(): { n: () => number } {
  const inner = globalThis.fetch;
  let n = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).hostname === "management.azure.com") n++;
    return inner(input, init);
  });
  return { n: () => n };
}

describe("GET /firewall", () => {
  it("while destroyed: the rules in order, policy not running, no hits, no drops", async () => {
    const { env } = apiEnv();
    await db.addFwRule(env, rule({ name: "Clients to web", dst_kind: "zone", dst_value: "workloads", proto: "tcp", ports: "8080" }));
    await db.addFwRule(env, rule({ name: "Block", action: "deny", src_kind: "zone", src_value: "clients" }));
    const r = await api(env, "GET", "/firewall");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ running: false, defaultAction: "deny", defaultHits: null, defaultLastHit: null, countersClearedAt: null, forwards: [], captures: [], publicIp: null, dnsName: "wg.clydeford.net" });
    expect(r.json.policy.state).toBe("not_running");
    expect(r.json.policy.hash).toMatch(/^[0-9a-f]{8,}/);
    const seeded = (await db.listFwRules(env)).length - 2; // the migration seeds starter rules
    expect(r.json.rules.slice(seeded).map((x: { name: string; place: number }) => [x.name, x.place])).toEqual([["Clients to web", seeded + 1], ["Block", seeded + 2]]);
    expect(r.json.rules.map((x: { place: number }) => x.place)).toEqual(r.json.rules.map((_: unknown, i: number) => i + 1));
    expect(r.json.rules[seeded]).toMatchObject({ service: "TCP 8080", hits: null, lastHit: null, problem: null, toLabel: "Workloads subnet", fromLabel: "Anywhere" });
    expect(r.json.drops).toEqual({ recent: [], last24h: 0, uniqueSources24h: 0, previous24h: 0, hourly24h: Array(24).fill(null) }); // the VM never ran: no data, not 0
    expect(r.json.zones.map((z: { zone: string }) => z.zone)).toEqual(["clients", "home", "azure", "workloads", "internet"]);
    expect(r.json.kpis).toEqual({ rules: seeded + 2, enabled: seeded + 2, defaultAction: "deny", drops24h: 0, published: 0, captureBusy: false });
    expect(r.json.capture.ifaces).toHaveProperty("wg0");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    // The draft contract: a version number, and no draft until someone edits one.
    expect(typeof r.json.version).toBe("number");
    expect(r.json.draft).toBeNull();
  });

  it("running: hits and last hit per rule, drops counted and named, policy pending then applied", async () => {
    const { env, world } = apiEnv();
    await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    await db.addFwRule(env, rule({ name: "Allow all" }));
    await db.addFwRule(env, rule({ name: "Broken", src_kind: "client", src_value: "99" }));
    const token = await deployWith(env, world);
    const rules = await db.listFwRules(env);
    const first = rules.find((r) => r.name === "Allow all")!;
    const broken = rules.find((r) => r.name === "Broken")!;
    const hash = (await currentFirewall(env)).hash;
    const drop = { src: "10.13.13.2", dst: "10.50.2.9", proto: "TCP", dport: 22, in: "wg0", out: "eth0" };
    await handleAgent(env, token, { dump: DUMP([]), firewall: { hash: "stale", counters: { [`r${first.id}`]: [7, 700], default: [2, 120] }, drops: [drop, { ...drop, dport: 23 }] } });
    const a = await api(env, "GET", "/firewall");
    expect(a.json.running).toBe(true);
    expect(a.json.policy.state).toBe("pending");
    const row = (j: { rules: { id: number }[] }, id: number) => j.rules.find((x) => x.id === id);
    expect(row(a.json, first.id)).toMatchObject({ hits: [7, 700], lastHit: expect.stringMatching(/^20/) });
    expect(row(a.json, broken.id)).toMatchObject({ hits: null, problem: expect.stringMatching(/no longer exists/) });
    expect(a.json.defaultHits).toEqual([2, 120]);
    expect(a.json.defaultLastHit).toMatch(/^20/);
    expect(a.json.drops.last24h).toBe(2);
    expect(a.json.drops.recent[0]).toMatchObject({ src: "10.13.13.2", dst: "10.50.2.9", proto: "TCP", dport: 23, fromName: "Phone", toName: "10.50.2.9" });
    expect(a.json.publicIp).toBe("20.0.0.10");
    await handleAgent(env, token, { dump: DUMP([]), firewall: { hash, counters: { [`r${first.id}`]: [8, 800] }, drops: [] } });
    const b = await api(env, "GET", "/firewall");
    expect(b.json.policy).toMatchObject({ state: "applied", hash });
    expect(b.json.policy.text).toContain("Applied on the VM");
    expect(b.json.kpis).toMatchObject({ rules: rules.length, drops24h: 2 });
    expect(b.text).not.toContain("ssh_password");
  });

  it("lists a published port with its connection count", async () => {
    const { env, world } = apiEnv();
    const token = await deployWith(env, world);
    await api(env, "POST", "/firewall/forwards", fwd);
    const [f] = await db.listForwards(env);
    await handleAgent(env, token, { dump: DUMP([]), firewall: { hash: "x", counters: { [`f${f.id}`]: [3, 300] }, drops: [] } });
    const r = await api(env, "GET", "/firewall");
    expect(r.json.forwards).toMatchObject([{ id: f.id, name: "Test VM web", connections: [3, 300] }]);
    expect(r.json.kpis.published).toBe(1);
  });
});

describe("POST /firewall/forwards", () => {
  it("names the field at fault and writes nothing", async () => {
    const { env } = apiEnv();
    const bad = async (b: object, field: string, message?: RegExp) => {
      const r = await api(env, "POST", "/firewall/forwards", b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.json.error.field).toBe(field);
      if (message) expect(r.json.error.message).toMatch(message);
    };
    await bad({ ...fwd, name: "" }, "name", /Give it a name/);
    await bad({ ...fwd, name: 7 }, "name");
    await bad({ ...fwd, proto: "icmp" }, "proto");
    await bad({ ...fwd, public_port: "8080" }, "public_port");
    await bad({ ...fwd, public_port: 0 }, "public_port", /1 to 65535/);
    await bad({ ...fwd, public_port: 51820 }, "public_port", /Port 51820 is/);
    await bad({ ...fwd, target_port: "80" }, "target_port");
    await bad({ ...fwd, target_port: 70000 }, "target_port");
    await bad({ ...fwd, target_ip: 5 }, "target_ip");
    await bad({ ...fwd, target_ip: "8.8.8.8" }, "target_ip", /Azure VNet/);
    await bad({ ...fwd, allow_from: "nope" }, "allow_from", /IPv4/);
    await bad({ ...fwd, allow_from: 4 }, "allow_from");
    expect(await db.listForwards(env)).toEqual([]);
    expect((await db.listAudit(env, { limit: 10 })).filter((a) => a.action.startsWith("firewall.forward"))).toEqual([]);
  });

  it("while destroyed: saves, audits and alerts without calling Azure, and gives no warning", async () => {
    const { env } = apiEnv();
    const az = countAzure();
    const r = await api(env, "POST", "/firewall/forwards", { ...fwd, name: " Web ", allow_from: "203.0.113.7" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, message: "Published TCP 8080 → 10.50.2.4:8080. It works within 30 seconds." });
    expect(await db.listForwards(env)).toMatchObject([{ name: "Web", proto: "tcp", public_port: 8080, target_port: 8080, allow_from: "203.0.113.7/32", enabled: 1 }]);
    expect((await db.listAudit(env, { limit: 10 })).map((a) => a.action)).toContain("firewall.forward.add");
    expect((await db.listAlerts(env, 10)).some((a) => a.message.includes("Published TCP 8080"))).toBe(true);
    expect(az.n()).toBe(0);
  });

  it("while running and Azure refuses: saved, with a warning that says so", async () => {
    const { env, world } = apiEnv();
    await deployWith(env, world);
    world.azure.rg = false;
    const r = await api(env, "POST", "/firewall/forwards", fwd);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.warning).toMatch(/^Saved, but Azure did not open the port: /);
    expect(await db.listForwards(env)).toHaveLength(1);
  });

  it("while running and Azure takes it: opens the port and gives no warning", async () => {
    const { env, world } = apiEnv();
    await deployWith(env, world);
    const inner = globalThis.fetch;
    const puts: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(url);
      const reply = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (u.hostname === "management.azure.com" && u.pathname.endsWith("/networkSecurityGroups/nsg-wg")) {
        if ((init?.method ?? "GET") === "PUT") puts.push(String(init?.body));
        return reply({ properties: { securityRules: [] } });
      }
      if (u.hostname === "management.azure.com" && u.pathname.endsWith("/networkInterfaces/nic-wg")) return reply({ properties: { ipConfigurations: [{ properties: { privateIPAddress: "10.50.1.4" } }] } });
      return inner(input, init);
    });
    const r = await api(env, "POST", "/firewall/forwards", fwd);
    expect(r.status).toBe(200);
    expect(r.json.warning).toBeUndefined();
    expect(puts.join()).toContain("published-");
  });

  it("a second publish of the same protocol and port is 409", async () => {
    const { env } = apiEnv();
    await api(env, "POST", "/firewall/forwards", fwd);
    const r = await api(env, "POST", "/firewall/forwards", { ...fwd, name: "Again" });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toBe("TCP 8080 is already published.");
    expect(await db.listForwards(env)).toHaveLength(1);
    expect((await api(env, "POST", "/firewall/forwards", { ...fwd, proto: "udp" })).status).toBe(200);
  });
});

describe("PUT /firewall/forwards/:id", () => {
  async function one(env: Env) {
    await api(env, "POST", "/firewall/forwards", fwd);
    return (await db.listForwards(env))[0];
  }

  it("merges the body onto the forward and audits an edit", async () => {
    const { env } = apiEnv();
    const f = await one(env);
    const r = await api(env, "PUT", `/firewall/forwards/${f.id}`, { name: "Renamed", target_port: 80 });
    expect(r.status).toBe(200);
    expect((await db.listForwards(env))[0]).toMatchObject({ name: "Renamed", target_port: 80, public_port: 8080, target_ip: "10.50.2.4", proto: "tcp", enabled: 1 });
    expect((await db.listAudit(env, { limit: 5 }))[0].action).toBe("firewall.forward.edit");
  });

  it("only enabled changing is audited as disable or enable", async () => {
    const { env } = apiEnv();
    const f = await one(env);
    expect((await api(env, "PUT", `/firewall/forwards/${f.id}`, { enabled: false })).status).toBe(200);
    expect((await db.listForwards(env))[0].enabled).toBe(0);
    expect((await db.listAudit(env, { limit: 5 }))[0].action).toBe("firewall.forward.disable");
    await api(env, "PUT", `/firewall/forwards/${f.id}`, { enabled: true });
    expect((await db.listAudit(env, { limit: 5 }))[0].action).toBe("firewall.forward.enable");
  });

  it("a bad merged value is 400 naming the field, and nothing changes", async () => {
    const { env } = apiEnv();
    const f = await one(env);
    const r = await api(env, "PUT", `/firewall/forwards/${f.id}`, { target_ip: "8.8.8.8" });
    expect(r.status).toBe(400);
    expect(r.json.error.field).toBe("target_ip");
    expect((await api(env, "PUT", `/firewall/forwards/${f.id}`, { enabled: "yes" })).json.error.field).toBe("enabled");
    expect((await api(env, "PUT", `/firewall/forwards/${f.id}`, { public_port: "1" })).json.error.field).toBe("public_port");
    expect((await db.listForwards(env))[0]).toMatchObject({ target_ip: "10.50.2.4", enabled: 1 });
  });

  it("moving onto a port already published is 409; a missing forward is 404; a bad id is 400", async () => {
    const { env } = apiEnv();
    const f = await one(env);
    await api(env, "POST", "/firewall/forwards", { ...fwd, public_port: 9090 });
    const r = await api(env, "PUT", `/firewall/forwards/${f.id}`, { public_port: 9090, target_port: 8080 });
    expect(r.status).toBe(409);
    expect((await api(env, "PUT", "/firewall/forwards/999", { name: "x" })).status).toBe(404);
    expect((await api(env, "PUT", "/firewall/forwards/abc", { name: "x" })).status).toBe(400);
  });
});

describe("DELETE /firewall/forwards/:id", () => {
  it("deletes and audits, then the second time is 404", async () => {
    const { env } = apiEnv();
    await api(env, "POST", "/firewall/forwards", fwd);
    const [f] = await db.listForwards(env);
    const a = await api(env, "DELETE", `/firewall/forwards/${f.id}`);
    expect(a.status).toBe(200);
    expect(a.json.ok).toBe(true);
    expect(await db.listForwards(env)).toEqual([]);
    expect((await db.listAudit(env, { limit: 5 }))[0].action).toBe("firewall.forward.delete");
    expect((await api(env, "DELETE", `/firewall/forwards/${f.id}`)).status).toBe(404);
  });
});

describe("POST /firewall/captures", () => {
  const cap = { iface: "wg0", who: "any", seconds: 30 };

  it("names the field at fault and starts nothing", async () => {
    const { env, world } = apiEnv();
    await deployWith(env, world);
    const bad = async (b: object, field: string) => {
      const r = await api(env, "POST", "/firewall/captures", b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.json.error.field).toBe(field);
    };
    await bad({ ...cap, iface: "eth9" }, "iface");
    await bad({ ...cap, iface: 3 }, "iface");
    await bad({ ...cap, seconds: 4 }, "seconds");
    await bad({ ...cap, seconds: 301 }, "seconds");
    await bad({ ...cap, seconds: 30.5 }, "seconds");
    await bad({ ...cap, seconds: "30" }, "seconds");
    await bad({ ...cap, who: "everyone" }, "who");
    await bad({ ...cap, who: 0 }, "who");
    await bad({ ...cap, filter: 5 }, "filter");
    await bad({ ...cap, filter: "-w /tmp/x" }, "filter");
    await bad({ ...cap, who: 1, filter: "-w /tmp/x" }, "filter");
    await bad({ ...cap, filter: "a;b" }, "filter");
    expect(await db.listCaptures(env)).toEqual([]);
    expect((await getSnapshot(env)).capture_req).toBeNull();
  });

  it("a client that does not exist is 404", async () => {
    const { env, world } = apiEnv();
    await deployWith(env, world);
    const r = await api(env, "POST", "/firewall/captures", { ...cap, who: 99 });
    expect(r.status).toBe(404);
    expect(r.json.error).toMatchObject({ code: "not_found", message: "No such client.", field: "who" });
    expect(await db.listCaptures(env)).toEqual([]);
  });

  it("while nothing runs: 409 Nothing is running.", async () => {
    const { env } = apiEnv();
    const r = await api(env, "POST", "/firewall/captures", cap);
    expect(r.status).toBe(409);
    expect(r.json.error.message).toBe("Nothing is running.");
  });

  it("starts a capture of one client's traffic, audits it, and refuses a second while one runs", async () => {
    const { env, world } = apiEnv();
    const p = await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    await deployWith(env, world);
    const r = await api(env, "POST", "/firewall/captures", { iface: "wg0", who: p.id, filter: "tcp port 443", seconds: 60 });
    expect(r.status).toBe(200);
    expect(r.json.message).toMatch(/^Capture started/);
    expect((await getSnapshot(env)).capture_req).toMatchObject({ iface: "wg0", filter: "host 10.13.13.2 and (tcp port 443)", seconds: 60 });
    expect((await db.listAudit(env, { limit: 5 }))[0]).toMatchObject({ action: "capture.start", target: "wg0" });
    const again = await api(env, "POST", "/firewall/captures", cap);
    expect(again.status).toBe(409);
    expect(again.json.error.message).toBe("A capture is already running.");
    const g = await api(env, "GET", "/firewall");
    expect(g.json.capture.busy).toBe(true);
    expect(g.json.kpis.captureBusy).toBe(true);
    expect(g.json.captures).toHaveLength(1);
  });
});

describe("POST /firewall/counters/clear", () => {
  it("zeroes the hits, audits and alerts", async () => {
    const { env, world } = apiEnv();
    await db.addFwRule(env, rule({ name: "Allow all" }));
    const token = await deployWith(env, world);
    const first = (await db.listFwRules(env)).find((r) => r.name === "Allow all")!;
    await handleAgent(env, token, { dump: DUMP([]), firewall: { hash: "x", counters: { [`r${first.id}`]: [7, 700] }, drops: [] } });
    const r = await api(env, "POST", "/firewall/counters/clear");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, message: "Counters cleared. Hits count from zero again." });
    const g = await api(env, "GET", "/firewall");
    const mine = g.json.rules.find((x: { id: number }) => x.id === first.id);
    expect(mine.hits).toEqual([0, 0]);
    expect(mine.lastHit).toBeNull();
    expect(g.json.countersClearedAt).toMatch(/^20/);
    expect((await db.listAudit(env, { limit: 5 }))[0].action).toBe("firewall.counters.clear");
    expect((await db.listAlerts(env, 5)).some((a) => a.message.includes("Firewall hit counters cleared"))).toBe(true);
  });
});

describe("dropsSince", () => {
  it("counts drops from a time on, and reads by the index, never the whole table", async () => {
    const { env } = apiEnv();
    await env.DB.prepare("INSERT INTO hist_drops (t, src, dst, proto, n) VALUES ('2026-10-01T10:00:00Z', 'a', 'b', 'TCP', 4), ('2026-10-02T10:00:00Z', 'a', 'b', 'TCP', 5), ('2026-10-02T11:00:00Z', 'c', 'd', 'UDP', 1)").run();
    expect(await dropsSince(env, "2026-10-02T00:00:00Z")).toBe(6);
    expect(await dropsSince(env, "2026-12-01T00:00:00Z")).toBe(0);
    const seen: string[] = [];
    const real = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      seen.push(sql);
      return real(sql);
    });
    await dropsSince(env, "2026-10-02T00:00:00Z");
    vi.mocked(env.DB.prepare).mockRestore();
    expect(seen).toHaveLength(1);
    const plan = await real(`EXPLAIN QUERY PLAN ${seen[0]}`).bind("2026-10-02T00:00:00Z").all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail);
    expect(details.some((d) => /^SEARCH hist_drops/.test(d)), details.join("; ")).toBe(true);
    expect(details.filter((d) => /^SCAN hist_drops/.test(d))).toEqual([]);
  });
});
