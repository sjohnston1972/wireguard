import { describe, it, expect } from "vitest";
import { parseWgDump, estimateCostGbp, peerOnline, anyHandshakeWithin, type AgentReport } from "../src/state";

const DUMP = [
  "PRIVATE\tSERVERPUB=\t51820\toff",
  "PEER1=\t(none)\t81.97.53.125:41234\t10.13.13.2/32\t1790097398\t948\t604\t25",
  "PEER2=\t(none)\t(none)\t10.13.13.3/32\t0\t0\t0\toff",
].join("\n");

describe("parseWgDump", () => {
  it("reads the interface line and each peer", () => {
    const r = parseWgDump(DUMP);
    expect(r.listen_port).toBe(51820);
    expect(r.server_public_key).toBe("SERVERPUB=");
    expect(r.peers).toHaveLength(2);
    expect(r.peers[0]).toMatchObject({ public_key: "PEER1=", endpoint: "81.97.53.125:41234", allowed_ips: "10.13.13.2/32", latest_handshake: 1790097398, rx: 948, tx: 604 });
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
