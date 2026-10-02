// history.test.ts
//
// Plain English: the dashboard's own history (history.ts). Samples from
// heartbeats, the watchman filling in missed minutes, folding old samples
// into 5-minute summaries, and the run step list kept with each run.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import * as db from "../src/db";
import type { Env } from "../src/env";
import { bucket, vmSample, clientSamples, recordHeartbeat } from "../src/history";
import { freshDrops, startDeploy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";
import { getSnapshot, saveSnapshot } from "../src/state";
import type { AgentReport, Traffic } from "../src/state";

let env: Env;
let world: World;
beforeEach(() => {
  ({ env, world } = makeEnv());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const columns = async (table: string) =>
  (await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((r) => r.name);

describe("schema", () => {
  it("has the history tables and the run step column", async () => {
    expect(await columns("hist_vm")).toEqual(["res", "t", "expected", "received", "load1", "rx_rate", "tx_rate", "rx_rate_max", "tx_rate_max", "peers_online", "dns_up"]);
    expect(await columns("hist_client")).toEqual(["res", "t", "peer_id", "online", "handshake_age", "latency_avg", "latency_max", "rx", "tx"]);
    expect(await columns("hist_drops")).toEqual(["t", "src", "dst", "proto", "dport", "in_if", "out_if", "n"]);
    expect(await columns("runs")).toContain("steps_json");
  });
});

const PHONE = "P".repeat(43) + "=";
const LAPTOP = "L".repeat(43) + "=";
const T0 = Date.parse("2026-10-02T10:00:00Z");

function report(at: number, peers: { key: string; hs: number; rx: number; tx: number }[], extra: Partial<AgentReport> = {}): AgentReport {
  return {
    at: new Date(at).toISOString(),
    hostname: "vm-wg",
    uptime_seconds: 100,
    load: "0.12 0.10 0.05",
    listen_port: 51820,
    server_public_key: "S=",
    loopback: null,
    wan6: null,
    dns: { up: true, blocked: 10 },
    peers: peers.map((p) => ({ public_key: p.key, endpoint: null, allowed_ips: "10.13.13.2/32", latest_handshake: p.hs, rx: p.rx, tx: p.tx })),
    ...extra,
  } as AgentReport;
}
const traffic = (rx_rate: number, tx_rate: number, peers_online: number): Traffic => ({ at: new Date(T0).toISOString(), rx: 0, tx: 0, rx_rate, tx_rate, peers_online });

describe("bucket", () => {
  it("floors to the slot start, with no milliseconds", () => {
    expect(bucket(Date.parse("2026-10-02T10:03:47.123Z"), 60)).toBe("2026-10-02T10:03:00Z");
    expect(bucket(Date.parse("2026-10-02T10:03:47.123Z"), 300)).toBe("2026-10-02T10:00:00Z");
    expect(bucket(Date.parse("2026-10-02T10:05:00.000Z"), 300)).toBe("2026-10-02T10:05:00Z");
  });
});

describe("vmSample", () => {
  it("takes the 1-minute load, the rates and DNS", () => {
    expect(vmSample(report(T0, []), traffic(100, 200, 2))).toEqual({ load1: 0.12, rx_rate: 100, tx_rate: 200, peers_online: 2, dns_up: 1 });
  });
  it("leaves load and DNS empty when the VM did not report them", () => {
    expect(vmSample(report(T0, [], { load: "", dns: null }), traffic(0, 0, 0))).toEqual({ load1: null, rx_rate: 0, tx_rate: 0, peers_online: 0, dns_up: null });
  });
});

describe("clientSamples", () => {
  const peers = [{ id: 7, public_key: PHONE }, { id: 9, public_key: LAPTOP }];
  const now = T0 + 60_000;
  const s = now / 1000;

  it("counts bytes since the previous heartbeat", () => {
    const prev = report(T0, [{ key: PHONE, hs: s - 30, rx: 1000, tx: 5000 }]);
    const cur = report(now, [{ key: PHONE, hs: s - 10, rx: 1500, tx: 9000 }]);
    expect(clientSamples({ report: cur, prev, rtt: { [PHONE]: 23.456 }, peers, nowMs: now })).toEqual([{ peer_id: 7, online: 1, handshake_age: 10, latency: 23.5, rx: 500, tx: 4000 }]);
  });

  it("counts from zero when the counters went down (VM rebooted or rebuilt)", () => {
    const prev = report(T0, [{ key: PHONE, hs: s - 30, rx: 9_000_000, tx: 9_000_000 }]);
    const cur = report(now, [{ key: PHONE, hs: s - 10, rx: 300, tx: 400 }]);
    expect(clientSamples({ report: cur, prev, rtt: null, peers, nowMs: now })[0]).toMatchObject({ rx: 300, tx: 400 });
  });

  it("counts the whole counter on the first heartbeat of a session", () => {
    const cur = report(now, [{ key: PHONE, hs: s - 10, rx: 300, tx: 400 }]);
    expect(clientSamples({ report: cur, prev: null, rtt: null, peers, nowMs: now })[0]).toMatchObject({ rx: 300, tx: 400 });
  });

  it("is online under 3 minutes since the handshake, offline from 3 minutes", () => {
    const cur = report(now, [{ key: PHONE, hs: s - 179, rx: 0, tx: 0 }, { key: LAPTOP, hs: s - 181, rx: 0, tx: 0 }]);
    const out = clientSamples({ report: cur, prev: null, rtt: null, peers, nowMs: now });
    expect(out.map((c) => [c.peer_id, c.online, c.handshake_age])).toEqual([[7, 1, 179], [9, 0, 181]]);
  });

  it("has no handshake age, and is offline, when the client never connected", () => {
    const cur = report(now, [{ key: PHONE, hs: 0, rx: 0, tx: 0 }]);
    expect(clientSamples({ report: cur, prev: null, rtt: null, peers, nowMs: now })[0]).toMatchObject({ online: 0, handshake_age: null, latency: null });
  });

  it("skips keys that are not a known client", () => {
    const cur = report(now, [{ key: "U".repeat(43) + "=", hs: s - 10, rx: 1, tx: 1 }]);
    expect(clientSamples({ report: cur, prev: null, rtt: null, peers, nowMs: now })).toEqual([]);
  });

  it("ignores a latency that is not a finite number", () => {
    const cur = report(now, [{ key: PHONE, hs: s - 10, rx: 0, tx: 0 }]);
    expect(clientSamples({ report: cur, prev: null, rtt: { [PHONE]: Number.NaN }, peers, nowMs: now })[0].latency).toBeNull();
  });
});

async function addPeer(id: number, key: string) {
  await env.DB.prepare("INSERT INTO peers (id, name, public_key, ip, enabled, full_tunnel, created_at) VALUES (?1, ?2, ?3, ?4, 1, 0, 'x')")
    .bind(id, `client${id}`, key, `10.13.13.${id}`)
    .run();
}
const rows = async (sql: string) => (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;

describe("freshDrops", () => {
  it("stamps each reported drop with the heartbeat time, newest first", () => {
    const at = "2026-10-02T10:00:30.000Z";
    const out = freshDrops({ drops: [{ src: "10.13.13.2", dst: "10.50.2.4", proto: "TCP", dport: 22, in: "wg0", out: "eth0" }, { src: "10.13.13.3", dst: "10.50.2.4", proto: "ICMP" }] }, at);
    expect(out).toEqual([
      { at, src: "10.13.13.3", dst: "10.50.2.4", proto: "ICMP", dport: null, in: "", out: "" },
      { at, src: "10.13.13.2", dst: "10.50.2.4", proto: "TCP", dport: 22, in: "wg0", out: "eth0" },
    ]);
    expect(freshDrops(null, at)).toEqual([]);
    expect(freshDrops({ drops: [null, 5, "x"] as unknown[] }, at)).toEqual([]);
  });
});

describe("recordHeartbeat", () => {
  beforeEach(async () => {
    await addPeer(7, PHONE);
  });

  it("writes one VM row and one row per client for the minute", async () => {
    const s = (T0 + 30_000) / 1000;
    await recordHeartbeat(env, { report: report(T0 + 30_000, [{ key: PHONE, hs: s - 5, rx: 100, tx: 200 }]), prev: null, rtt: { [PHONE]: 20 }, traffic: traffic(10, 20, 1), drops: [] });
    expect(await rows("SELECT res, t, expected, received, load1, rx_rate, tx_rate, rx_rate_max, tx_rate_max, peers_online, dns_up FROM hist_vm")).toEqual([
      { res: 60, t: "2026-10-02T10:00:00Z", expected: 1, received: 1, load1: 0.12, rx_rate: 10, tx_rate: 20, rx_rate_max: 10, tx_rate_max: 20, peers_online: 1, dns_up: 1 },
    ]);
    expect(await rows("SELECT res, t, peer_id, online, handshake_age, latency_avg, latency_max, rx, tx FROM hist_client")).toEqual([
      { res: 60, t: "2026-10-02T10:00:00Z", peer_id: 7, online: 1, handshake_age: 5, latency_avg: 20, latency_max: 20, rx: 100, tx: 200 },
    ]);
  });

  it("merges two heartbeats in the same minute: received stays 1, bytes add, maxima kept", async () => {
    const s1 = (T0 + 5_000) / 1000;
    const s2 = (T0 + 35_000) / 1000;
    const first = report(T0 + 5_000, [{ key: PHONE, hs: s1 - 5, rx: 100, tx: 100 }]);
    await recordHeartbeat(env, { report: first, prev: null, rtt: { [PHONE]: 20 }, traffic: traffic(50, 10, 1), drops: [] });
    await recordHeartbeat(env, { report: report(T0 + 35_000, [{ key: PHONE, hs: s2 - 5, rx: 400, tx: 150 }]), prev: first, rtt: { [PHONE]: 40 }, traffic: traffic(20, 30, 1), drops: [] });
    const [vm] = await rows("SELECT received, rx_rate, rx_rate_max, tx_rate_max FROM hist_vm");
    expect(vm).toEqual({ received: 1, rx_rate: 20, rx_rate_max: 50, tx_rate_max: 30 });
    const [c] = await rows("SELECT rx, tx, latency_avg, latency_max FROM hist_client");
    expect(c).toEqual({ rx: 400, tx: 150, latency_avg: 30, latency_max: 40 });
  });

  it("counts drops per minute per flow, with no port stored as 0", async () => {
    const at = new Date(T0 + 10_000).toISOString();
    const drop = { at, src: "10.13.13.2", dst: "10.50.2.4", proto: "ICMP", dport: null, in: "wg0", out: "eth0" };
    await recordHeartbeat(env, { report: report(T0 + 10_000, []), prev: null, rtt: null, traffic: traffic(0, 0, 0), drops: [drop, drop] });
    await recordHeartbeat(env, { report: report(T0 + 40_000, []), prev: null, rtt: null, traffic: traffic(0, 0, 0), drops: [{ ...drop, at: new Date(T0 + 40_000).toISOString() }] });
    expect(await rows("SELECT t, src, dst, proto, dport, in_if, out_if, n FROM hist_drops")).toEqual([
      { t: "2026-10-02T10:00:00Z", src: "10.13.13.2", dst: "10.50.2.4", proto: "ICMP", dport: 0, in_if: "wg0", out_if: "eth0", n: 3 },
    ]);
  });

  it("fills in a minute the watchman had marked as missed", async () => {
    await env.DB.prepare("INSERT INTO hist_vm (res, t, expected, received) VALUES (60, '2026-10-02T10:00:00Z', 1, 0)").run();
    await recordHeartbeat(env, { report: report(T0 + 20_000, []), prev: null, rtt: null, traffic: traffic(5, 6, 0), drops: [] });
    expect(await rows("SELECT received, rx_rate, rx_rate_max FROM hist_vm")).toEqual([{ received: 1, rx_rate: 5, rx_rate_max: 5 }]);
  });
});

const DUMP = (lines: string[]) => ["PRIV\tS=\t51820\toff", ...lines].join("\n");
const peerLine = (key: string, hsSecs: number, rx: number, tx: number) => `${key}\t(none)\t203.0.113.25:4000\t10.13.13.2/32\t${hsSecs}\t${rx}\t${tx}\t0`;

/** Deploy on the harness and return the VM's agent token. */
async function toRunning() {
  await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return sec.body.agent_token as string;
}

describe("heartbeats write history", () => {
  it("records the VM and the client, by client id", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const token = await toRunning();
    const phone = (await db.listPeers(env)).find((p) => p.public_key === PHONE)!;
    vi.setSystemTime(T0 + 15_000);
    const r = await handleAgent(env, token, { dump: DUMP([peerLine(PHONE, Math.floor((T0 + 10_000) / 1000), 1000, 2000)]), rtt: { [PHONE]: 18 } });
    expect(r.status).toBe(200);
    expect(await rows("SELECT res, t, received FROM hist_vm")).toEqual([{ res: 60, t: "2026-10-02T10:00:00Z", received: 1 }]);
    expect(await rows("SELECT peer_id, online, latency_avg, rx, tx FROM hist_client")).toEqual([{ peer_id: phone.id, online: 1, latency_avg: 18, rx: 1000, tx: 2000 }]);
  });

  it("records nothing for a heartbeat that arrives after a tear-down", async () => {
    const token = await toRunning();
    await saveSnapshot(env, { state: "destroyed" });
    await handleAgent(env, token, { dump: DUMP([peerLine(PHONE, Math.floor(Date.now() / 1000), 1, 1)]) });
    expect(await rows("SELECT * FROM hist_vm")).toEqual([]);
    expect(await rows("SELECT * FROM hist_client")).toEqual([]);
  });

  it("still answers the heartbeat and updates the snapshot when history cannot be written", async () => {
    const token = await toRunning();
    await env.DB.prepare("DROP TABLE hist_client").run();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await handleAgent(env, token, { dump: DUMP([peerLine(PHONE, Math.floor(Date.now() / 1000), 1, 1)]) });
    expect(r.status).toBe(200);
    expect((r.body as { peers: unknown[] }).peers.length).toBe(1);
    expect((await getSnapshot(env)).last_agent_at).not.toBeNull();
    expect(spy.mock.calls.some((c) => String(c[0]).startsWith("history:"))).toBe(true);
    spy.mockRestore();
  });
});
