// Top talkers, published ports and packet capture.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import type { Env } from "../src/env";
import { config } from "../src/env";
import * as db from "../src/db";
import { nextTalkers, talkerTotal, getSnapshot } from "../src/state";
import { compileFirewall, forwardTargetOk } from "../src/firewall";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";
import { startCapture, receiveCapture, validFilter } from "../src/capture";

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
