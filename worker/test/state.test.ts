import { describe, it, expect } from "vitest";
import { parseWgDump, estimateCostGbp, peerOnline, anyHandshakeWithin, nextTraffic, trafficFlowing, type AgentReport } from "../src/state";

const DUMP = [
  "PRIVATE\tSERVERPUB=\t51820\toff",
  "PEER1=\t(none)\t203.0.113.25:41234\t10.13.13.2/32\t1790097398\t948\t604\t25",
  "PEER2=\t(none)\t(none)\t10.13.13.3/32\t0\t0\t0\toff",
].join("\n");

describe("parseWgDump", () => {
  it("reads the interface line and each peer", () => {
    const r = parseWgDump(DUMP);
    expect(r.listen_port).toBe(51820);
    expect(r.server_public_key).toBe("SERVERPUB=");
    expect(r.peers).toHaveLength(2);
    expect(r.peers[0]).toMatchObject({ public_key: "PEER1=", endpoint: "203.0.113.25:41234", allowed_ips: "10.13.13.2/32", latest_handshake: 1790097398, rx: 948, tx: 604 });
    expect(r.peers[1].endpoint).toBeNull();
    expect(r.peers[1].latest_handshake).toBe(0);
  });
  it("handles an empty dump", () => {
    expect(parseWgDump("")).toEqual({ listen_port: null, server_public_key: null, peers: [] });
  });
});

describe("estimateCostGbp", () => {
  it("is rate × hours", () => {
    const since = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(estimateCostGbp(since, 0.015)).toBeCloseTo(0.03, 3);
  });
  it("is zero when not running or in the future", () => {
    expect(estimateCostGbp(null, 1)).toBe(0);
    expect(estimateCostGbp(new Date(Date.now() + 60_000).toISOString(), 1)).toBe(0);
  });
});

describe("handshake helpers", () => {
  const now = 1_800_000_000_000;
  const fresh = { public_key: "a", endpoint: null, allowed_ips: "", latest_handshake: now / 1000 - 60, rx: 0, tx: 0 };
  const stale = { ...fresh, public_key: "b", latest_handshake: now / 1000 - 600 };
  const never = { ...fresh, public_key: "c", latest_handshake: 0 };
  it("peerOnline is within 3 minutes", () => {
    expect(peerOnline(fresh, now)).toBe(true);
    expect(peerOnline(stale, now)).toBe(false);
    expect(peerOnline(never, now)).toBe(false);
  });
  it("anyHandshakeWithin checks the whole report", () => {
    const report: AgentReport = { at: "", hostname: "", uptime_seconds: 0, load: "", listen_port: null, server_public_key: null, loopback: null, peers: [stale, never] };
    expect(anyHandshakeWithin(report, 5, now)).toBe(false);
    expect(anyHandshakeWithin(report, 15, now)).toBe(true);
    expect(anyHandshakeWithin(null, 15, now)).toBe(false);
  });
});

describe("traffic", () => {
  const now = 1_800_000_000_000;
  const mk = (rx: number, tx: number, hs = now / 1000 - 10): AgentReport => ({
    at: "", hostname: "", uptime_seconds: 0, load: "", listen_port: null, server_public_key: null, loopback: null,
    peers: [{ public_key: "a", endpoint: null, allowed_ips: "", latest_handshake: hs, rx, tx }],
  });
  it("first heartbeat has totals but no rate", () => {
    const t = nextTraffic(null, mk(1000, 500), now);
    expect(t).toMatchObject({ rx: 1000, tx: 500, rx_rate: 0, tx_rate: 0, peers_online: 1 });
    expect(trafficFlowing(t, now)).toBe(false);
  });
  it("rate is the delta over the interval", () => {
    const t0 = nextTraffic(null, mk(1000, 500), now - 30_000);
    const t1 = nextTraffic(t0, mk(4000, 2000), now);
    expect(t1.rx_rate).toBeCloseTo(100, 5);
    expect(t1.tx_rate).toBeCloseTo(50, 5);
    expect(trafficFlowing(t1, now)).toBe(true);
    expect(trafficFlowing(t1, now + 120_000)).toBe(false);
  });
  it("a counter reset (rebuild) never gives a negative rate", () => {
    const t0 = nextTraffic(null, mk(9000, 9000), now - 30_000);
    const t1 = nextTraffic(t0, mk(10, 10), now);
    expect(t1.rx_rate).toBe(0);
    expect(t1.tx_rate).toBe(0);
  });
});
