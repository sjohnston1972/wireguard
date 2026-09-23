import { describe, it, expect } from "vitest";
import { nextLatency, detectRoams, nextSession, selfTestFailures, endpointHost, LATENCY_SAMPLES, type AgentReport } from "../src/state";
import { nearestRegion, REGIONS } from "../src/region";
import { ntfyParts, ntfyMessage } from "../src/notify";
import { claimsProblem } from "../src/oidc";
import { peerIp6, hostLabel } from "../src/peers";
import type { Env } from "../src/env";

const report = (peers: { k: string; ep?: string | null; rx?: number; tx?: number; hs?: number }[]): AgentReport => ({
  at: new Date().toISOString(),
  hostname: "vm-wg",
  uptime_seconds: 1,
  load: "0 0 0",
  listen_port: 51820,
  server_public_key: "S=",
  loopback: "10.13.255.1",
  peers: peers.map((p) => ({ public_key: p.k, endpoint: p.ep ?? null, allowed_ips: "", latest_handshake: p.hs ?? 0, rx: p.rx ?? 0, tx: p.tx ?? 0 })),
});

describe("latency history", () => {
  it("appends pings per client, keeps a bounded window, forgets removed clients", () => {
    let h = nextLatency({}, { A: 12.345 }, ["A", "B"]);
    expect(h).toEqual({ A: [12.3], B: [] });
    for (let i = 0; i < LATENCY_SAMPLES + 5; i++) h = nextLatency(h, { A: i }, ["A"]);
    expect(h.A.length).toBe(LATENCY_SAMPLES);
    expect(h.A[h.A.length - 1]).toBe(LATENCY_SAMPLES + 4);
    expect(h.B).toBeUndefined();
  });
  it("keeps the history when a heartbeat has no ping for a client", () => {
    expect(nextLatency({ A: [5] }, null, ["A"])).toEqual({ A: [5] });
  });
});

describe("roaming", () => {
  it("spots a client changing networks, ignoring port changes and first sightings", () => {
    const a = report([{ k: "A", ep: "203.0.113.25:5000" }, { k: "B", ep: "198.51.100.7:1" }]);
    const b = report([{ k: "A", ep: "203.0.113.25:6000" }, { k: "B", ep: "[2001:db8::1]:1" }, { k: "C", ep: "192.0.2.9:1" }]);
    const r = detectRoams(a, b, "now");
    expect(Object.keys(r)).toEqual(["B"]);
    expect(r.B).toEqual({ at: "now", from: "198.51.100.7", to: "2001:db8::1" });
  });
  it("parses IPv4 and IPv6 endpoints", () => {
    expect(endpointHost("203.0.113.25:51820")).toBe("203.0.113.25");
    expect(endpointHost("[2001:db8::1]:51820")).toBe("2001:db8::1");
    expect(endpointHost(null)).toBeNull();
  });
});

describe("session totals", () => {
  const now = 1_800_000_000_000;
  const hs = now / 1000 - 30;
  it("adds deltas, survives a counter reset, and records who connected", () => {
    let s = nextSession(null, null, report([{ k: "A", rx: 100, tx: 10, hs }]), now);
    expect(s).toMatchObject({ rx: 100, tx: 10, seen: ["A"] });
    const prev = report([{ k: "A", rx: 100, tx: 10, hs }]);
    s = nextSession(s, prev, report([{ k: "A", rx: 150, tx: 30, hs }, { k: "B", rx: 5, tx: 5, hs: 0 }]), now);
    expect(s).toMatchObject({ rx: 155, tx: 35, seen: ["A"] });
    // A reboot resets WireGuard's counters: count the new value from zero.
    s = nextSession(s, report([{ k: "A", rx: 150, tx: 30, hs }]), report([{ k: "A", rx: 20, tx: 2, hs }]), now);
    expect(s).toMatchObject({ rx: 175, tx: 37 });
  });
});

describe("self-test", () => {
  const ok = { at: "t", ms: 4200, handshake: true, tunnel: true, loopback: true, dns: true, internet: true, internet6: null };
  it("names what failed and nothing else", () => {
    expect(selfTestFailures(ok)).toEqual([]);
    expect(selfTestFailures({ ...ok, dns: false, internet6: false })).toEqual(["tunnel DNS", "internet (IPv6)"]);
    expect(selfTestFailures({ ...ok, error: "wg0 is not up" })[0]).toBe("wg0 is not up");
    expect(selfTestFailures(null)).toEqual([]);
  });
});

describe("nearest region", () => {
  it("maps countries and continents to regions it offers", () => {
    expect(nearestRegion({ country: "GB" })).toBe("uksouth");
    expect(nearestRegion({ country: "ES" })).toBe("spaincentral");
    expect(nearestRegion({ country: "US", longitude: "-122.3" })).toBe("westus2");
    expect(nearestRegion({ country: "US", longitude: "-77" })).toBe("eastus");
    expect(nearestRegion({ country: "ZZ", continent: "OC" })).toBe("australiaeast");
    expect(nearestRegion(undefined)).toBeNull();
  });
  it("only ever suggests regions in the list", () => {
    for (const c of ["GB", "IE", "FR", "DE", "JP", "BR", "ZA", "IN", "AU", "CA", "SE", "PL", "AE", "HK", "SG", "MX"]) {
      expect(REGIONS[nearestRegion({ country: c })!]).toBeTruthy();
    }
  });
});

describe("ntfy", () => {
  it("recognises topic URLs", () => {
    expect(ntfyParts("https://ntfy.sh/wg-admin-abc123")).toEqual({ base: "https://ntfy.sh", topic: "wg-admin-abc123" });
    expect(ntfyParts("https://hooks.slack.com/services/x")).toBeNull();
  });
  it("turns buttons into ntfy actions: http buttons POST and clear, view buttons open", () => {
    const m = ntfyMessage("t", "Title", "Body", {
      priority: 4,
      buttons: [
        { label: "Extend 1h", url: "https://x/api/act/1", kind: "http" },
        { label: "Open dashboard", url: "https://x", kind: "view" },
      ],
    });
    expect(m).toMatchObject({ topic: "t", title: "Title", message: "Body", priority: 4 });
    expect(m.actions).toEqual([
      { action: "http", label: "Extend 1h", url: "https://x/api/act/1", method: "POST", clear: true },
      { action: "view", label: "Open dashboard", url: "https://x" },
    ]);
  });
});

describe("GitHub OIDC claims", () => {
  const env = { GITHUB_REPO: "sjohnston1972/wireguard" } as unknown as Env;
  const good = {
    repository: "sjohnston1972/wireguard",
    ref: "refs/heads/main",
    workflow_ref: "sjohnston1972/wireguard/.github/workflows/wg.yml@refs/heads/main",
    event_name: "workflow_dispatch",
    run_id: "35781788714",
  };
  it("accepts wg.yml on main, dispatched", () => {
    expect(claimsProblem(env, good)).toBeNull();
  });
  it("refuses another repo, branch, workflow or trigger", () => {
    expect(claimsProblem(env, { ...good, repository: "someone/fork" })).toMatch(/repository/);
    expect(claimsProblem(env, { ...good, ref: "refs/heads/feature" })).toMatch(/ref/);
    expect(claimsProblem(env, { ...good, workflow_ref: "sjohnston1972/wireguard/.github/workflows/ci.yml@refs/heads/main" })).toMatch(/workflow/);
    expect(claimsProblem(env, { ...good, event_name: "push" })).toMatch(/event/);
    expect(claimsProblem(env, { ...good, run_id: undefined })).toMatch(/run id/);
  });
});

describe("tunnel addressing", () => {
  it("IPv6 mirrors IPv4 in hex, like Terraform's cidrhost", () => {
    expect(peerIp6("fd13:13::/64", "10.13.13.2")).toBe("fd13:13::2");
    expect(peerIp6("fd13:13::/64", "10.13.13.254")).toBe("fd13:13::fe");
    expect(peerIp6("", "10.13.13.2")).toBe("");
  });
  it("makes DNS-safe names", () => {
    expect(hostLabel("Steven's Laptop")).toBe("steven-s-laptop");
    expect(hostLabel("  --Phone 2--  ")).toBe("phone-2");
  });
});
