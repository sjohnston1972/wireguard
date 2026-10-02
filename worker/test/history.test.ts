// history.test.ts
//
// Plain English: the dashboard's own history (history.ts). Samples from
// heartbeats, the watchman filling in missed minutes, folding old samples
// into 5-minute summaries, and the run step list kept with each run.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, type World } from "./harness";
import type { Env } from "../src/env";
import { bucket, vmSample, clientSamples } from "../src/history";
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
