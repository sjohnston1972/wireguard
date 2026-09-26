// The firewall: rule compilation, and the round trip with the VM's agent.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import type { Env } from "../src/env";
import { config } from "../src/env";
import * as db from "../src/db";
import { compileFirewall, ruleLines, parseCidr, parsePorts, STARTER_RULES, type FwRule } from "../src/firewall";
import { startDeploy, startDestroy, issueRunSecrets, handleCallback, handleAgent, currentFirewall, nextFirewall, nextBase, addCounters, clearFirewallCounters } from "../src/runs";
import { totalHits } from "../src/views/firewall";
import { getSnapshot } from "../src/state";

const cfg = { ...config({ WG_SUBNET6: "fd13:13::/64", HOME_LAN_CIDR: "192.168.1.0/24" } as unknown as Env), firewallDefault: "deny" as const };
const phone = { id: 3, name: "sj-phone", ip: "10.13.13.3" } as any;
const rule = (over: Partial<FwRule>): FwRule => ({ id: 9, position: 10, enabled: 1, name: "r", src_kind: "any", src_value: "", dst_kind: "any", dst_value: "", proto: "any", ports: "", action: "allow", log: 0, ...over });

describe("rule compilation", () => {
  it("a client to an address on a port list, logged", () => {
    const { lines } = ruleLines(rule({ src_kind: "client", src_value: "3", dst_kind: "cidr", dst_value: "10.50.2.4/32", proto: "tcp", ports: "3389,8000-8100", log: 1 }), cfg, [phone]);
    expect(lines).toEqual([`ip saddr 10.13.13.3/32 ip daddr 10.50.2.4/32 tcp dport { 3389, 8000-8100 } log prefix "wgfw-r9 " level info counter name "r9" accept`]);
  });
  it("zones expand to both families where they have both, and the internet is 'everything else'", () => {
    const { lines } = ruleLines(rule({ src_kind: "zone", src_value: "clients", dst_kind: "zone", dst_value: "internet" }), cfg, []);
    expect(lines[0]).toBe(`ip saddr 10.13.13.0/24 ip daddr != { 10.13.13.0/24, 10.13.255.1/32, 10.50.0.0/16, 192.168.1.0/24 } counter name "r9" accept`);
    expect(lines[1]).toBe(`ip6 saddr fd13:13::/64 ip6 daddr != { fd13:13::/64, fd50:50::/48 } counter name "r9" accept`);
  });
  it("ping to anywhere covers ICMP and ICMPv6 in one line", () => {
    expect(ruleLines(rule({ proto: "icmp", action: "deny" }), cfg, []).lines).toEqual([`meta l4proto { icmp, ipv6-icmp } counter name "r9" drop`]);
  });
  it("refuses what cannot work, without breaking the rest", async () => {
    expect(ruleLines(rule({ src_kind: "client", src_value: "99" }), cfg, [phone]).problem).toMatch(/no longer exists/);
    expect(ruleLines(rule({ proto: "tcp", ports: "99999" }), cfg, []).problem).toMatch(/port/);
    expect(ruleLines(rule({ src_kind: "cidr", src_value: "10.0.0.0/8", dst_kind: "cidr", dst_value: "fd00::/8" }), cfg, []).problem).toMatch(/family/);
    const fw = await compileFirewall([rule({ id: 1, src_kind: "client", src_value: "99" }), rule({ id: 2, name: "ok" })], cfg, [phone], "deny");
    expect(fw.problems).toEqual({ 1: expect.stringMatching(/no longer exists/) });
    expect(fw.text).toContain(`counter name "r2" accept`);
    expect(fw.text).not.toContain(`"r1"`);
  });
  it("replaces itself atomically, defaults to deny-and-log, and hashes its content", async () => {
    const rules = STARTER_RULES.map((r, i) => ({ ...r, id: i + 1 }));
    const a = await compileFirewall(rules, cfg, [], "deny");
    expect(a.text.split("\n").slice(1, 4)).toEqual(["table inet wgfw", "delete table inet wgfw", "table inet wgfw {"]);
    expect(a.text).toContain("policy drop;");
    expect(a.text).toContain(`limit rate 10/second log prefix "wgfw-drop "`);
    expect(a.text.startsWith(`# ruleset ${a.hash} `)).toBe(true);
    const b = await compileFirewall(rules, cfg, [], "allow");
    expect(b.hash).not.toBe(a.hash);
    expect(b.text).toContain("policy accept;");
    expect(b.text).not.toContain("wgfw-drop");
  });
  it("parses addresses and ports", () => {
    expect(parseCidr("10.50.2.4")).toEqual({ family: 4, text: "10.50.2.4/32" });
    expect(parseCidr("fd13:13::3")).toEqual({ family: 6, text: "fd13:13::3/128" });
    expect(parseCidr("300.1.1.1")).toBeNull();
    expect(parsePorts("80,443")).toBe("{ 80, 443 }");
  });
  it("IPv6 addresses are checked properly, so one typo cannot sink the whole rule set", () => {
    for (const ok of ["::", "::1", "fd13:13::/64", "2001:db8::1/128", "1:2:3:4:5:6:7:8", "1::8", "1:2:3:4:5:6:7::", "::ffff:192.0.2.1", "FD00::/8"]) expect(parseCidr(ok), ok).not.toBeNull();
    expect(parseCidr("FD00::/8")).toEqual({ family: 6, text: "fd00::/8" });
    expect(parseCidr("::ffff:192.0.2.1")).toEqual({ family: 6, text: "::ffff:192.0.2.1/128" });
    for (const bad of ["1::2::3", "1:2:3", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7::8", "12345::", ":1::", "1::2:", ":::", "::/129", "fd00::/", "::ffff:300.1.1.1", "1.2.3.4:5::", "g::1", ":"]) expect(parseCidr(bad), bad).toBeNull();
    expect(parseCidr("1.2.3")).toBeNull();
    expect(parseCidr("1.2.3.4/33")).toBeNull();
  });
  it("parses ports", () => {
    expect(parsePorts("80,443")).toBe("{ 80, 443 }");
    expect(parsePorts("22")).toBe("22");
    expect(parsePorts("100-50")).toBeNull();
  });
});

describe("hits and drops", () => {
  it("records when each rule last matched, and keeps the newest drops first", () => {
    const a = nextFirewall(null, { hash: "h1", counters: { r1: [5, 500], default: [0, 0] }, drops: [] }, "t1")!;
    expect(a.last_hit).toEqual({ r1: "t1" });
    const b = nextFirewall(a, { hash: "h1", counters: { r1: [5, 500], default: [2, 120] }, drops: [{ src: "10.50.2.4", dst: "192.168.1.254", proto: "ICMP", dport: null, in: "eth0", out: "wg0" }] }, "t2")!;
    expect(b.last_hit).toEqual({ r1: "t1", default: "t2" });
    expect(b.drops[0]).toMatchObject({ at: "t2", src: "10.50.2.4", dst: "192.168.1.254", proto: "ICMP" });
    // A new rule set restarts the VM's counters; last-hit times are kept.
    const c = nextFirewall(b, { hash: "h2", counters: { r1: [1, 60] }, drops: [] }, "t3")!;
    expect(c.last_hit).toEqual({ r1: "t3", default: "t2" });
    expect(c.drops).toHaveLength(1);
  });

  it("totals carry on across a new rule set and a reboot, and clearing zeroes them", () => {
    const s1 = { applied_hash: "h1", counters: { r1: [10, 1000] as [number, number] } } as any;
    // Rule change: the VM's counter restarts at 2; the 10 before it are kept.
    let base = nextBase({}, s1, { r1: [2, 200] }, false);
    expect(base).toEqual({ r1: [10, 1000] });
    // Reboot with the same rule set: the counter goes backwards (7 -> 1), so 7 more are kept.
    base = nextBase(base, { applied_hash: "h2", counters: { r1: [7, 700] } } as any, { r1: [1, 100] }, true);
    expect(base).toEqual({ r1: [17, 1700] });
    // Steady growth adds nothing to the base (the live counter carries it).
    expect(nextBase(base, { applied_hash: "h2", counters: { r1: [1, 100] } } as any, { r1: [5, 500] }, true)).toEqual(base);
    expect(addCounters({ r1: [1, 2] }, { r1: [3, 4], r2: [5, 6] })).toEqual({ r1: [4, 6], r2: [5, 6] });
  });
});

describe("with the VM", () => {
  let env: Env;
  let world: World;
  beforeEach(() => {
    ({ env, world } = makeEnv({ TEST_VM: "1", HOME_LAN_CIDR: "192.168.1.0/24" } as Partial<Env>));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("the build gets the compiled rules privately; the VM gets changes on its heartbeat until it reports the same rule set", async () => {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "s" });
    expect(world.dispatches[0].payload).toMatchObject({ test_vm: true, workload_subnet_cidr: "10.50.2.0/24" });
    expect(JSON.stringify(world.dispatches[0].payload)).not.toContain("wgfw");
    const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
    const built = atob(sec.body.firewall_nft_b64 as string);
    expect(built).toContain("Clients to the Azure VNet");
    world.azure.rg = true;
    await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip, test_vm_ip: "10.50.2.4" } });
    expect((await getSnapshot(env)).test_vm_ip).toBe("10.50.2.4");

    const token = sec.body.agent_token as string;
    const fw = await currentFirewall(env);
    // The VM already has what the build gave it: nothing to send.
    let r = await handleAgent(env, token, { dump: "", firewall: { hash: fw.hash, counters: { r1: [3, 300] }, drops: [] } });
    expect((r.body as any).firewall).toBeUndefined();
    // A rule is added on the page: the next heartbeat carries the new rule set.
    await db.addFwRule(env, { enabled: 1, name: "Phone to test VM web", src_kind: "zone", src_value: "clients", dst_kind: "cidr", dst_value: "10.50.2.4/32", proto: "tcp", ports: "8080", action: "allow", log: 0 });
    r = await handleAgent(env, token, { dump: "", firewall: { hash: fw.hash, counters: {}, drops: [] } });
    const sent = (r.body as any).firewall;
    expect(atob(sent.nft_b64)).toContain(`tcp dport 8080`);
    expect(sent.hash).not.toBe(fw.hash);
    // An agent from before the firewall is left alone.
    r = await handleAgent(env, token, { dump: "" });
    expect((r.body as any).firewall).toBeUndefined();
  });

  it("hit totals survive a rule change, a tear-down and a rebuild; Clear counters zeroes them", async () => {
    const up = async () => {
      const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "s" });
      const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
      world.azure.rg = true;
      await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
      return sec.body.agent_token as string;
    };
    let token = await up();
    await handleAgent(env, token, { dump: "", firewall: { hash: "h1", counters: { r1: [40, 4000] }, drops: [] } });
    // A rule change: the VM reloads and its counter restarts.
    await handleAgent(env, token, { dump: "", firewall: { hash: "h2", counters: { r1: [2, 200] }, drops: [] } });
    expect(totalHits(await getSnapshot(env), "r1")).toEqual([42, 4200]);
    // Tear down, build again: the new VM starts from zero, the totals do not.
    const d = await startDestroy(env, "s", "test");
    const ds = await issueRunSecrets(env, d.id, lastGhRun(world));
    world.azure.rg = false;
    await handleCallback(env, ds.body.callback_token as string, { run_id: d.id, action: "destroy", status: "success" });
    expect(totalHits(await getSnapshot(env), "r1")).toEqual([42, 4200]);
    token = await up();
    await handleAgent(env, token, { dump: "", firewall: { hash: "h2", counters: { r1: [3, 300] }, drops: [] } });
    expect(totalHits(await getSnapshot(env), "r1")).toEqual([45, 4500]);
    // Clear: zero now, counting on from here.
    await clearFirewallCounters(env);
    expect(totalHits(await getSnapshot(env), "r1")).toEqual([0, 0]);
    await handleAgent(env, token, { dump: "", firewall: { hash: "h2", counters: { r1: [5, 500] }, drops: [] } });
    expect(totalHits(await getSnapshot(env), "r1")).toEqual([2, 200]);
  });
});
