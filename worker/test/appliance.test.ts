// Top talkers, published ports and packet capture.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import type { Env } from "../src/env";
import { config } from "../src/env";
import * as db from "../src/db";
import { nextTalkers, talkerTotal, getSnapshot } from "../src/state";
import { compileFirewall, forwardTargetOk, reservedPort, publishedNsgRules } from "../src/firewall";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";
import { startCapture, receiveCapture, validFilter } from "../src/capture";
import { setPublishedPorts } from "../src/azure";

const cfg = { ...config({ HOME_LAN_CIDR: "192.168.1.0/24" } as unknown as Env), firewallDefault: "deny" as const };

describe("top talkers", () => {
  it("adds up per client and remote, survives a counter restart, keeps names", () => {
    let t = nextTalkers({}, [{ c: "10.13.13.3", r: "142.250.1.1", up: 100, down: 5000, name: "www.google.com" }], "t1");
    t = nextTalkers(t, [{ c: "10.13.13.3", r: "142.250.1.1", up: 150, down: 9000 }], "t2");
    expect(talkerTotal(t["10.13.13.3|142.250.1.1"])).toEqual({ up: 150, down: 9000 });
    expect(t["10.13.13.3|142.250.1.1"].name).toBe("www.google.com");
    // The VM reloaded its rules: counters restart at 20 / 30, the earlier totals are kept.
    t = nextTalkers(t, [{ c: "10.13.13.3", r: "142.250.1.1", up: 20, down: 30 }], "t3");
    expect(talkerTotal(t["10.13.13.3|142.250.1.1"])).toEqual({ up: 170, down: 9030 });
    // Junk is ignored.
    expect(Object.keys(nextTalkers({}, [{ c: "x", r: "y" }, null, 3], "t"))).toEqual([]);
  });
});

describe("published ports", () => {
  it("only to places the VM can route back from", () => {
    expect(forwardTargetOk("10.50.2.4", cfg)).toBe(true);
    expect(forwardTargetOk("192.168.1.20", cfg)).toBe(true);
    expect(forwardTargetOk("8.8.8.8", cfg)).toBe(false);
    expect(forwardTargetOk("10.13.13.3", cfg)).toBe(false);
  });
  it("compile to DNAT, an accept for the translated flow, and a masquerade for home targets", async () => {
    const fw = await compileFirewall([], cfg, [], "deny", [
      { id: 1, enabled: 1, name: "web", proto: "tcp", public_port: 443, target_ip: "10.50.2.4", target_port: 8080, allow_from: "" },
      { id: 2, enabled: 1, name: "nas", proto: "udp", public_port: 5000, target_ip: "192.168.1.20", target_port: 5000, allow_from: "203.0.113.0/24" },
      { id: 3, enabled: 0, name: "off", proto: "tcp", public_port: 9, target_ip: "10.50.2.4", target_port: 9, allow_from: "" },
    ]);
    expect(fw.text).toContain(`iifname "eth0" tcp dport 443 counter name "f1" dnat ip to 10.50.2.4:8080`);
    expect(fw.text).toContain(`iifname "eth0" ip saddr 203.0.113.0/24 udp dport 5000 counter name "f2" dnat ip to 192.168.1.20:5000`);
    expect(fw.text).toContain(`ct status dnat ip daddr 10.50.2.4 tcp dport 8080 accept`);
    expect(fw.text).toContain(`oifname "wg0" ct status dnat ip daddr 192.168.1.0/24 masquerade`);
    expect(fw.text).not.toContain(`"f3"`);
    expect(fw.text).toContain("tcp option maxseg size set rt mtu");
    // Azure targets are masqueraded too, or nsg-workloads drops the internet source.
    expect(fw.text).toContain(`oifname "eth0" ct status dnat ip daddr 10.50.0.0/16 masquerade`);
    // The VM drops a published port for itself (wrong source, IPv6), after replies.
    const input = fw.text.slice(fw.text.indexOf("chain input {"));
    expect(input).toContain("type filter hook input priority filter; policy accept;");
    expect(input.indexOf("ct state established,related accept")).toBeLessThan(input.indexOf(`iifname "eth0" tcp dport 443 drop`));
    expect(input).toContain(`iifname "eth0" udp dport 5000 drop`);
    expect(input).not.toContain("dport 9 ");
  });
  it("no masquerade to Azure and no input chain when nothing is published there", async () => {
    const none = await compileFirewall([], cfg, [], "deny", []);
    expect(none.text).not.toContain("chain input");
    expect(none.text).not.toContain("masquerade");
    const home = await compileFirewall([], cfg, [], "deny", [{ id: 2, enabled: 1, name: "nas", proto: "udp", public_port: 5000, target_ip: "192.168.1.20", target_port: 5000, allow_from: "" }]);
    expect(home.text).not.toContain(`daddr 10.50.0.0/16 masquerade`);
  });
  it("the SSH and WireGuard ports are reserved in both protocols, WireGuard's as configured", async () => {
    expect(reservedPort(22, cfg)).toMatch(/SSH/);
    expect(reservedPort(51820, cfg)).toMatch(/WireGuard/);
    expect(reservedPort(443, cfg)).toBeNull();
    const moved = { ...cfg, port: 443 };
    expect(reservedPort(443, moved)).toMatch(/WireGuard/);
    expect(reservedPort(51820, moved)).toBeNull();
    // A row saved before the check existed (UDP 22) is left out of everything.
    const old = [
      { id: 7, enabled: 1, name: "sneaky", proto: "udp" as const, public_port: 22, target_ip: "10.50.2.4", target_port: 22, allow_from: "" },
      { id: 8, enabled: 1, name: "web", proto: "tcp" as const, public_port: 8443, target_ip: "10.50.2.4", target_port: 8080, allow_from: "203.0.113.7" },
    ];
    const fw = await compileFirewall([], cfg, [], "deny", old);
    expect(fw.text).not.toContain(`"f7"`);
    expect(fw.text).not.toContain("dport 22");
    expect(publishedNsgRules(old, cfg)).toEqual([{ name: "published-tcp-8443", protocol: "Tcp", port: "8443", source: "203.0.113.7/32" }]);
  });
  it("Azure's edge opens one rule per port, with the port's own protocol and source", () => {
    const rules = publishedNsgRules(
      [
        { id: 1, enabled: 1, name: "web", proto: "tcp", public_port: 443, target_ip: "10.50.2.4", target_port: 8080, allow_from: "" },
        { id: 2, enabled: 1, name: "nas", proto: "udp", public_port: 5000, target_ip: "192.168.1.20", target_port: 5000, allow_from: "203.0.113.0/24" },
        { id: 3, enabled: 0, name: "off", proto: "tcp", public_port: 9, target_ip: "10.50.2.4", target_port: 9, allow_from: "" },
        { id: 4, enabled: 1, name: "nowhere", proto: "tcp", public_port: 10, target_ip: "8.8.8.8", target_port: 9, allow_from: "" },
      ],
      cfg,
    );
    expect(rules).toEqual([
      { name: "published-tcp-443", protocol: "Tcp", port: "443", source: "*" },
      { name: "published-udp-5000", protocol: "Udp", port: "5000", source: "203.0.113.0/24" },
    ]);
  });
});

describe("published ports at Azure's edge", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("replaces only the published rules, in one write, aimed at the VM's private address", async () => {
    const { env } = makeEnv();
    const rule = (name: string, priority: number, extra: Record<string, unknown> = {}) => ({ name, etag: "x", properties: { priority, direction: "Inbound", access: "Allow", protocol: "*", sourcePortRange: "*", destinationPortRange: "*", sourceAddressPrefix: "*", destinationAddressPrefix: "*", ...extra } });
    const nsg = {
      location: "uksouth",
      tags: { project: "wg-admin" },
      etag: 'W/"1"',
      properties: {
        securityRules: [
          rule("allow-wireguard", 100, { protocol: "Udp", destinationPortRange: "51820" }),
          rule("allow-ssh-from-home", 110, { protocol: "Tcp", destinationPortRange: "22", sourceAddressPrefix: "198.51.100.1/32" }),
          rule("allow-from-vnet", 120),
          rule("published-ports", 130),
          rule("published-tcp-80", 200, { protocol: "Tcp", destinationPortRange: "80" }),
          rule("allow-routed-to-vnet", 100, { direction: "Outbound" }),
          rule("deny-all-inbound", 4000),
        ],
      },
    };
    const puts: { url: string; body: any; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const res = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes("login.microsoftonline.com")) return res({ access_token: "arm", expires_in: 3600 });
      if (url.includes("/networkSecurityGroups/nsg-wg?") && (init?.method ?? "GET") === "GET") return res(nsg);
      if (url.includes("/networkSecurityGroups/nsg-wg?") && init?.method === "PUT") {
        puts.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
        return res({});
      }
      if (url.includes("/networkInterfaces/nic-wg?")) return res({ properties: { ipConfigurations: [{ properties: { privateIPAddressVersion: "IPv4", privateIPAddress: "10.50.1.4" } }, { properties: { privateIPAddressVersion: "IPv6", privateIPAddress: "fd50:50:0:1::4" } }] } });
      throw new Error(`unexpected fetch ${url}`);
    });
    await setPublishedPorts(env, [
      { name: "published-tcp-443", protocol: "Tcp", port: "443", source: "*" },
      { name: "published-udp-5000", protocol: "Udp", port: "5000", source: "203.0.113.0/24" },
    ]);
    expect(puts.length).toBe(1);
    expect(puts[0].headers.get("If-Match")).toBe('W/"1"');
    const rules = puts[0].body.properties.securityRules as any[];
    // Everything that is not a published port goes back untouched.
    for (const n of ["allow-wireguard", "allow-ssh-from-home", "allow-from-vnet", "allow-routed-to-vnet", "deny-all-inbound"]) {
      expect(rules.find((r) => r.name === n).properties).toEqual(nsg.properties.securityRules.find((r) => r.name === n)!.properties);
    }
    expect(rules.map((r) => r.name)).not.toContain("published-ports");
    expect(rules.map((r) => r.name)).not.toContain("published-tcp-80");
    expect(rules.find((r) => r.name === "published-tcp-443").properties).toMatchObject({ priority: 200, protocol: "Tcp", destinationPortRange: "443", sourceAddressPrefix: "*", destinationAddressPrefix: "10.50.1.4" });
    expect(rules.find((r) => r.name === "published-udp-5000").properties).toMatchObject({ priority: 201, protocol: "Udp", destinationPortRange: "5000", sourceAddressPrefix: "203.0.113.0/24", destinationAddressPrefix: "10.50.1.4" });
    const inbound = rules.filter((r) => r.properties.direction === "Inbound").map((r) => r.properties.priority);
    expect(new Set(inbound).size).toBe(inbound.length);

    // Nothing published and nothing there: no write at all.
    nsg.properties.securityRules = nsg.properties.securityRules.filter((r) => !r.name.startsWith("published-"));
    await setPublishedPorts(env, []);
    expect(puts.length).toBe(1);
  });
});

describe("packet capture", () => {
  let env: Env;
  let world: World & { objects: Map<string, ArrayBuffer> };
  beforeEach(() => {
    const m = makeEnv();
    env = m.env;
    world = m.world as typeof world;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("filters are plain", () => {
    expect(validFilter("host 10.13.13.3 and (tcp port 443 or icmp)")).toBe(true);
    expect(validFilter("host x; rm -rf /")).toBe(false);
    expect(validFilter("$(reboot)")).toBe(false);
  });

  it("request rides the heartbeat once, the VM uploads, the file is kept for download", async () => {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "s" });
    const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
    world.azure.rg = true;
    await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
    const token = sec.body.agent_token as string;

    await startCapture(env, { iface: "wg0", filter: "host 10.13.13.3", seconds: 30, by: "s" });
    await expect(startCapture(env, { iface: "wg0", filter: "", seconds: 30, by: "s" })).rejects.toThrow(/already/);
    const id = (await getSnapshot(env)).capture_req!.id;
    let r = await handleAgent(env, token, { dump: "" });
    expect((r.body as any).capture).toEqual({ id, iface: "wg0", filter: "host 10.13.13.3", seconds: 30 });
    // The VM says it has started: no more hand-overs.
    r = await handleAgent(env, token, { dump: "", capture_running: id });
    expect((r.body as any).capture).toBeUndefined();
    expect((await db.getCapture(env, id))!.status).toBe("running");

    expect((await receiveCapture(env, "wrong", id, new ArrayBuffer(3), null)).status).toBe(401);
    const got = await receiveCapture(env, token, id, new Uint8Array([31, 139, 8, 0]).buffer, null);
    expect(got.status).toBe(200);
    expect((await db.getCapture(env, id))).toMatchObject({ status: "done", bytes: 4 });
    expect(world.objects.has(`captures/${id}.pcap.gz`)).toBe(true);
    expect((await getSnapshot(env)).capture_req).toBeNull();
    // A failure report is recorded with its reason.
    await startCapture(env, { iface: "eth0", filter: "", seconds: 30, by: "s" });
    const id2 = (await getSnapshot(env)).capture_req!.id;
    await receiveCapture(env, token, id2, new ArrayBuffer(0), "tcpdump refused: syntax error");
    expect((await db.getCapture(env, id2))).toMatchObject({ status: "failed", error: "tcpdump refused: syntax error" });
  });
});
