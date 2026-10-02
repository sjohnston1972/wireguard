// api-simulate.test.ts
//
// Plain English: the firewall rule simulator. Given a flow (from, to,
// protocol, port) it says whether the live rules would allow it and which
// rule decides, using the same address sets the compiled nftables rules use.
// Covers the evaluation (first match wins, disabled and broken rules are
// skipped, partial overlaps are noted but do not stop it) and the route's
// input checks.
import { describe, it, expect } from "vitest";
import { api, apiEnv } from "./api-helpers";
import * as db from "../src/db";
import { config } from "../src/env";
import { simulate } from "../src/simulate";
import { STARTER_RULES, type FwRule } from "../src/firewall";
import type { Env } from "../src/env";
import type { Peer } from "../src/db";

const cfg = { ...config({ WG_SUBNET6: "fd13:13::/64", HOME_LAN_CIDR: "192.168.1.0/24" } as unknown as Env), firewallDefault: "deny" as const };
const PHONE = "P".repeat(43) + "=";
const peer = (id: number, ip: string): Peer => ({ id, name: `Client ${id}`, public_key: PHONE, ip, enabled: 1, full_tunnel: 0, azure_vnet: 0, tunnel_dns: 0, routes: "", home_lan: 0, created_at: "t", note: null });
const peers = [peer(1, "10.13.13.2"), peer(2, "10.13.13.3")];

let nextId = 100;
const rule = (o: Partial<FwRule>): FwRule => ({ id: nextId++, position: 500, enabled: 1, name: `Rule ${nextId}`, src_kind: "any", src_value: "", dst_kind: "any", dst_value: "", proto: "any", ports: "", action: "allow", log: 0, ...o });
const starters = (): FwRule[] => STARTER_RULES.map((r, i) => ({ ...r, id: i + 1 }));
const z = (value: string) => ({ kind: "zone" as const, value });
const cidr = (value: string) => ({ kind: "cidr" as const, value });
const ctx = (rules: FwRule[], defaultAction: "allow" | "deny" = "deny") => ({ rules, defaultAction, cfg, peers });
const flow = (from: any, to: any, proto: "tcp" | "udp" | "icmp" = "tcp", port: number | null = null) => ({ from, to, proto, port });

describe("simulate: the starter rules", () => {
  it("tunnel clients to the home LAN on TCP 22 is allowed by 'Clients to the home LAN'", () => {
    const r = simulate(flow(z("clients"), z("home"), "tcp", 22), ctx(starters()));
    expect(r.verdict).toBe("allow");
    expect(r.matched).toEqual({ id: 3, name: "Clients to the home LAN", place: 3 });
    expect(r.reason).toBe("Allowed by rule 3, Clients to the home LAN.");
    expect(r.partial).toEqual([]);
  });
  it("workloads to the home LAN is denied by the default", () => {
    const r = simulate(flow(z("workloads"), z("home"), "tcp", 22), ctx(starters()));
    expect(r.verdict).toBe("deny");
    expect(r.matched).toBeNull();
    expect(r.reason).toBe("No rule matched; the default denies it.");
  });
});

describe("simulate: matching", () => {
  it("a client end inside a zone rule is fully matched", () => {
    const r = simulate(flow({ kind: "client", value: "1" }, z("home")), ctx(starters()));
    expect(r.matched?.id).toBe(3);
    expect(r.partial).toEqual([]);
  });
  it("a zone end against a single-client rule is partial, and evaluation continues", () => {
    const only1 = rule({ name: "Only client 1", position: 1, src_kind: "client", src_value: "1", dst_kind: "zone", dst_value: "home", action: "deny" });
    const r = simulate(flow(z("clients"), z("home")), ctx([only1, ...starters()]));
    expect(r.partial).toEqual([{ id: only1.id, name: "Only client 1", place: 1 }]);
    expect(r.verdict).toBe("allow");
    expect(r.matched?.name).toBe("Clients to the home LAN");
  });
  it("a disabled rule is skipped", () => {
    const off = rule({ name: "Off", enabled: 0, action: "deny", position: 1 });
    const r = simulate(flow(z("clients"), z("home")), ctx([off, ...starters()]));
    expect(r.verdict).toBe("allow");
    expect(r.matched?.id).toBe(3);
    expect(r.matched?.place).toBe(4);
  });
  it("a rule with a compile problem (deleted client) is skipped, as the VM skips it", () => {
    const gone = rule({ name: "Gone", src_kind: "client", src_value: "99", action: "deny", position: 1 });
    const r = simulate(flow(z("clients"), z("home")), ctx([gone, ...starters()]));
    expect(r.verdict).toBe("allow");
    expect(r.partial).toEqual([]);
  });
  it("a home-LAN rule with no home LAN configured is skipped", () => {
    const noHome = { ...cfg, homeLanCidr: "" };
    const r = simulate(flow(z("clients"), z("home")), { rules: starters(), defaultAction: "deny", cfg: noHome, peers });
    expect(r.matched).toBeNull();
    expect(r.limited).toMatch(/no IPv4 addresses/);
    // Without a home LAN, 192.168.x.x is just another internet address, as the VM sees it.
    expect(simulate(flow(z("clients"), cidr("192.168.1.5")), { rules: starters(), defaultAction: "deny", cfg: noHome, peers }).matched?.id).toBe(1);
  });
  it("port lists and ranges", () => {
    const web = rule({ name: "Web", proto: "tcp", ports: "80, 443,8000-8100", dst_kind: "zone", dst_value: "workloads" });
    const c = ctx([web]);
    for (const p of [80, 443, 8000, 8050, 8100]) expect(simulate(flow(z("clients"), z("workloads"), "tcp", p), c).verdict, String(p)).toBe("allow");
    for (const p of [81, 7999, 8101, 22]) expect(simulate(flow(z("clients"), z("workloads"), "tcp", p), c).verdict, String(p)).toBe("deny");
  });
  it("protocol must be covered; 'any' covers all and ignores ports; ICMP ignores ports", () => {
    const tcpOnly = rule({ name: "TCP", proto: "tcp", ports: "22" });
    expect(simulate(flow(z("clients"), z("home"), "udp", 22), ctx([tcpOnly])).verdict).toBe("deny");
    const anyWithPorts = rule({ name: "Any", proto: "any", ports: "22" });
    expect(simulate(flow(z("clients"), z("home"), "udp", 53), ctx([anyWithPorts])).verdict).toBe("allow");
    const ping = rule({ name: "Ping", proto: "icmp", ports: "junk" });
    expect(simulate(flow(z("clients"), z("home"), "icmp"), ctx([ping])).verdict).toBe("allow");
  });
  it("no port given against a port-limited rule is partial", () => {
    const ssh = rule({ name: "SSH", proto: "tcp", ports: "22", position: 1 });
    const r = simulate(flow(z("clients"), z("home"), "tcp", null), ctx([ssh]));
    expect(r.partial.map((p) => p.name)).toEqual(["SSH"]);
    expect(r.verdict).toBe("deny");
  });
  it("the internet zone is everything outside the private nets", () => {
    const out = rule({ name: "Out", src_kind: "zone", src_value: "clients", dst_kind: "zone", dst_value: "internet" });
    const c = ctx([out]);
    expect(simulate(flow(z("clients"), cidr("8.8.8.8")), c).verdict).toBe("allow");
    expect(simulate(flow(z("clients"), cidr("8.8.8.0/24")), c).verdict).toBe("allow");
    expect(simulate(flow(z("clients"), cidr("10.50.2.4")), c).verdict).toBe("deny");
    expect(simulate(flow(z("clients"), cidr("192.168.1.9")), c).verdict).toBe("deny");
    expect(simulate(flow(z("clients"), cidr("10.13.255.1")), c).verdict).toBe("deny");
    // A range straddling the private edge only partly matches.
    const straddle = simulate(flow(z("clients"), cidr("10.0.0.0/8")), c);
    expect(straddle.verdict).toBe("deny");
    expect(straddle.partial.map((p) => p.name)).toEqual(["Out"]);
    // 'Anywhere' is wider than the internet, so a rule for the internet only partly covers it.
    expect(simulate(flow(z("clients"), { kind: "any", value: "" }), c).partial.map((p) => p.name)).toEqual(["Out"]);
  });
  it("a rule from the internet matches the internet zone as a flow end, not a private zone", () => {
    const inb = rule({ name: "In", src_kind: "zone", src_value: "internet", dst_kind: "zone", dst_value: "workloads", proto: "tcp", ports: "443" });
    expect(simulate(flow(z("internet"), z("workloads"), "tcp", 443), ctx([inb])).verdict).toBe("allow");
    expect(simulate(flow(z("clients"), z("workloads"), "tcp", 443), ctx([inb])).verdict).toBe("deny");
  });
  it("the default decides when nothing matches: allow or deny", () => {
    expect(simulate(flow(z("clients"), z("home")), ctx([], "allow"))).toMatchObject({ verdict: "allow", matched: null, reason: "No rule matched; the default allows it." });
    expect(simulate(flow(z("clients"), z("home")), ctx([], "deny"))).toMatchObject({ verdict: "deny", matched: null, reason: "No rule matched; the default denies it." });
  });
  it("first match wins, in position order, not list order", () => {
    const allow = rule({ name: "Allow", position: 20 });
    const deny = rule({ name: "Deny", position: 10, action: "deny" });
    const r = simulate(flow(z("clients"), z("home")), ctx([allow, deny]));
    expect(r).toMatchObject({ verdict: "deny", matched: { name: "Deny", place: 1 } });
    expect(r.reason).toBe("Denied by rule 1, Deny.");
  });
  it("a rule naming only IPv6 addresses never applies to an IPv4 flow", () => {
    const v6 = rule({ name: "v6", dst_kind: "cidr", dst_value: "fd00::/8" });
    expect(simulate(flow(z("clients"), z("home")), ctx([v6])).matched).toBeNull();
  });
});

describe("simulate: what it cannot see", () => {
  it("is silent for an ordinary flow", () => {
    expect(simulate(flow(z("clients"), z("home"), "tcp", 22), ctx(starters())).limited).toBeNull();
  });
  it("says so for ping, the VM's own address, the public address and traffic that never reaches the VM", () => {
    expect(simulate(flow(z("clients"), z("home"), "icmp"), ctx(starters())).limited).toMatch(/ICMP/);
    expect(simulate(flow(z("clients"), cidr("10.13.255.1")), ctx(starters())).limited).toMatch(/VM itself/);
    const pub = { ...ctx(starters()), publicIp: "20.0.0.5", forwards: [] };
    expect(simulate(flow(z("internet"), cidr("20.0.0.5"), "tcp", 8080), pub).limited).toMatch(/public address/);
    expect(simulate(flow(z("workloads"), z("azure")), ctx(starters())).limited).toMatch(/does not pass through the VM/);
  });
  it("mentions published ports when the flow hits one", () => {
    const fwds = [{ id: 1, enabled: 1, name: "Web", proto: "tcp" as const, public_port: 8080, target_ip: "10.50.2.4", target_port: 80, allow_from: "" }];
    const r = simulate(flow(z("internet"), cidr("20.0.0.5"), "tcp", 8080), { ...ctx(starters()), publicIp: "20.0.0.5", forwards: fwds });
    expect(r.limited).toMatch(/Published ports/);
  });
});

describe("POST /api/v1/firewall/simulate", () => {
  it("answers against the live rules and default", async () => {
    const { env } = apiEnv({ HOME_LAN_CIDR: "192.168.1.0/24" });
    const ok = await api(env, "POST", "/firewall/simulate", { from: z("clients"), to: z("home"), proto: "tcp", port: 22 });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ verdict: "allow", matched: { name: "Clients to the home LAN" }, partial: [] });
    const no = await api(env, "POST", "/firewall/simulate", { from: z("workloads"), to: z("home"), proto: "tcp" });
    expect(no.json).toMatchObject({ verdict: "deny", matched: null });
  });
  it("resolves a client by id and a cidr", async () => {
    const { env } = apiEnv();
    const p = await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    const r = await api(env, "POST", "/firewall/simulate", { from: { kind: "client", value: String(p.id) }, to: cidr("8.8.8.8"), proto: "udp", port: 53 });
    expect(r.json).toMatchObject({ verdict: "allow", matched: { name: "Clients to the internet (full tunnel)" } });
    const n = await api(env, "POST", "/firewall/simulate", { from: { kind: "client", value: p.id }, to: z("internet"), proto: "icmp" });
    expect(n.status).toBe(200);
  });
  it("refuses bad input with 400 naming the field, and a missing client with 404", async () => {
    const { env } = apiEnv();
    const ok = { from: z("clients"), to: z("home"), proto: "tcp", port: 22 };
    const bad = async (patch: object, field: string, status = 400) => {
      const r = await api(env, "POST", "/firewall/simulate", { ...ok, ...patch });
      expect(r.status, JSON.stringify(patch)).toBe(status);
      expect(r.json.error.field, JSON.stringify(patch)).toBe(field);
      return r;
    };
    await bad({ from: { kind: "planet", value: "x" } }, "from");
    await bad({ from: "clients" }, "from");
    await bad({ from: undefined }, "from");
    await bad({ to: { kind: "zone", value: "mars" } }, "to");
    await bad({ to: { kind: "zone", value: 5 } }, "to");
    await bad({ to: { kind: "client", value: "0" } }, "to");
    await bad({ to: { kind: "client", value: "abc" } }, "to");
    await bad({ from: cidr("not-an-ip") }, "from");
    expect((await bad({ to: cidr("fd00::/8") }, "to")).json.error.message).toBe("IPv6 is not simulated yet");
    await bad({ proto: "sctp" }, "proto");
    await bad({ proto: undefined }, "proto");
    await bad({ port: 0 }, "port");
    await bad({ port: 65536 }, "port");
    await bad({ port: "22" }, "port");
    await bad({ port: 22.5 }, "port");
    await bad({ proto: "icmp", port: 22 }, "port");
    await bad({ from: { kind: "client", value: "999" } }, "from", 404);
    await bad({ to: { kind: "client", value: 999 } }, "to", 404);
    expect((await api(env, "POST", "/firewall/simulate", { ...ok, port: null })).status).toBe(200);
    expect((await api(env, "POST", "/firewall/simulate", { from: { kind: "any" }, to: { kind: "any", value: "" }, proto: "udp" })).status).toBe(200);
  });
});
