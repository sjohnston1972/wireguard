// verdict.test.ts
//
// Plain English: the Health summary's head line (shared/verdict.ts, spec
// 2026-10-04 section 10.3). The first rule that matches wins; with no Azure
// or vitals data the head is exactly today's; the thresholds come from the
// System vitals and VM performance widgets, or their defaults while those
// widgets are off.
import { describe, expect, it } from "vitest";
import type { AgentVitals, AzureHealth, AzureSummaryResponse, CapacityCheck, ScheduledEvent, ServiceEvent } from "../../shared/api";
import { todayHead, verdict, verdictThresholds, type VerdictCheck, type VerdictInput } from "../../shared/verdict";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

const CHECKS: VerdictCheck[] = [
  { key: "vm", name: "VM reachable", ok: true },
  { key: "wireguard", name: "WireGuard service", ok: true },
  { key: "dns", name: "DNS resolving", ok: true },
  { key: "tunnel", name: "Tunnel connectivity", ok: true },
  { key: "selftest", name: "Self-test", ok: true },
];
const failing = (...keys: string[]) => CHECKS.map((c) => (keys.includes(c.key) ? { ...c, ok: false } : c));

const health = (over: Partial<AzureHealth> = {}): AzureHealth => ({
  state: "Available",
  title: "Available",
  summary: "There aren't any known Azure platform problems affecting this virtual machine.",
  reason: null,
  since: iso(NOW - 120 * MIN),
  power: "VM running",
  provisioning: "Provisioning succeeded",
  vmAgent: { status: "Ready", version: "2.11.1.12" },
  bootDiagnostics: true,
  annotations: [],
  checkedAt: iso(NOW - 2 * MIN),
  ...over,
});

const vitals = (over: Partial<AgentVitals> = {}): AgentVitals => ({
  at: iso(NOW - 20_000),
  memUsedPct: 40,
  diskUsedPct: 24,
  diskFreeBytes: 23_700_000_000,
  load1: 0.12,
  ncpu: 1,
  stealPct: 0.4,
  uptimeS: 7_900,
  conntrack: { count: 61, max: 32_768 },
  updates: { pending: 3, security: 0, at: iso(NOW - 120 * MIN) },
  net: { at: iso(NOW - 3 * MIN), method: "icmp", targets: [{ ip: "1.1.1.1", rttMs: 9.4, lossPct: 0 }, { ip: "8.8.8.8", rttMs: 10.1, lossPct: 0 }] },
  ...over,
});

const event = (over: Partial<ScheduledEvent> = {}): ScheduledEvent => ({ id: "ev-1", type: "Reboot", status: "Scheduled", notBefore: iso(NOW + 3 * 60 * MIN), source: "Platform", description: null, durationS: 900, ...over });
const issue = (over: Partial<ServiceEvent> = {}): ServiceEvent => ({
  trackingId: "TRK-1",
  type: "ServiceIssue",
  status: "Active",
  level: "Warning",
  title: "Virtual Machines - UK South - connectivity",
  summary: "Some customers may see connection failures.",
  services: ["Virtual Machines"],
  startsAt: iso(NOW - 30 * MIN),
  endsAt: null,
  updatedAt: iso(NOW - 10 * MIN),
  ...over,
});

/** A connected Azure with nothing wrong. */
const azure = (over: Partial<AzureSummaryResponse> = {}, latest: Partial<AzureSummaryResponse["latest"]> = {}): AzureSummaryResponse => ({
  configured: true,
  region: { id: "uksouth", name: "UK South" },
  feeds: [],
  health: health(),
  maintenance: [],
  serviceIssues: [],
  vitals: vitals(),
  agent: "current",
  latest: { cpuPct: 6, creditsLeft: 120, memFreeBytes: 412_000_000, vipAvailPct: 100, underDdos: false, at: iso(NOW - 5 * MIN), ...latest },
  ...over,
});

const notConnected: AzureSummaryResponse = {
  configured: false,
  region: { id: "uksouth", name: "UK South" },
  feeds: [],
  health: null,
  maintenance: [],
  serviceIssues: [],
  vitals: null,
  agent: "none",
  latest: { cpuPct: null, creditsLeft: null, memFreeBytes: null, vipAvailPct: null, underDdos: null, at: null },
};

const capacityFail: CapacityCheck = {
  region: "uksouth",
  size: "Standard_B2ats_v2",
  available: false,
  reason: "NotAvailableForSubscription",
  vcpusNeeded: 2,
  family: null,
  total: null,
  ok: false,
  message: "Standard_B2ats_v2 isn't offered to this subscription in UK South (NotAvailableForSubscription).",
  fetchedAt: iso(NOW - 60 * MIN),
};

const input = (over: Partial<VerdictInput> = {}): VerdictInput => ({ state: "running", checks: CHECKS, azure: azure(), capacity: null, now: NOW, ...over });

describe("today's head", () => {
  it("all healthy, failing checks, and no data", () => {
    expect(todayHead("running", CHECKS)).toEqual({ tone: "green", title: "All systems healthy", sub: "Running and responding normally." });
    expect(todayHead("running", failing("dns", "tunnel"))).toEqual({ tone: "red", title: "2 checks failing", sub: "DNS resolving, Tunnel connectivity" });
    expect(todayHead("running", CHECKS.map((c) => ({ ...c, ok: null })))).toEqual({ tone: "grey", title: "No health data", sub: "Waiting for the first heartbeat." });
    expect(todayHead("destroyed", CHECKS.map((c) => ({ ...c, ok: null })))).toEqual({ tone: "grey", title: "No health data", sub: "Nothing is running to check." });
  });
});

describe("verdict rules (first match wins)", () => {
  const rows: [number, string, VerdictInput, Partial<ReturnType<typeof verdict>>][] = [
    [
      1,
      "running and the VM-reachable check fails",
      input({ checks: failing("vm"), azure: azure({ health: health({ state: "Unavailable", title: "Unavailable" }) }) }),
      { tone: "red", title: "1 check failing", sub: "VM reachable · Azure says: Unavailable", bootLog: true },
    ],
    [2, "Resource Health Unavailable", input({ azure: azure({ health: health({ state: "Unavailable", title: "Unavailable", summary: "The VM is stopping." }) }) }), { tone: "red", title: "Azure reports the VM as unavailable", sub: "The VM is stopping." }],
    [3, "another check fails", input({ checks: failing("wireguard"), azure: azure({ health: health({ state: "Degraded" }) }) }), { tone: "red", title: "1 check failing", sub: "WireGuard service" }],
    [4, "under DDoS attack", input({ azure: azure({}, { underDdos: true }) }), { tone: "red", title: "Azure is mitigating a DDoS attack on the public IP" }],
    [5, "loss at bad on both internet targets", input({ azure: azure({ vitals: vitals({ net: { at: iso(NOW), method: "tcp", targets: [{ ip: "1.1.1.1", rttMs: null, lossPct: 10 }, { ip: "8.8.8.8", rttMs: null, lossPct: 100 }] } }) }) }), { tone: "red", title: "The VM can't reach the internet" }],
    [6, "a scheduled event within 15 minutes", input({ azure: azure({ maintenance: [event({ notBefore: iso(NOW + 15 * MIN) })] }) }), { tone: "red", title: "Azure will reboot the VM at 13:15" }],
    [7, "Resource Health Degraded", input({ azure: azure({ health: health({ state: "Degraded", summary: "Slower than usual." }) }) }), { tone: "amber", title: "Azure reports the VM as degraded", sub: "Slower than usual." }],
    [8, "credits left just under bad", input({ azure: azure({}, { creditsLeft: 9 }) }), { tone: "amber", title: "CPU credits nearly gone: the VM will slow to its baseline speed" }],
    [9, "an active service issue in the region", input({ azure: azure({ serviceIssues: [issue()] }) }), { tone: "amber", title: "Azure has an active issue in UK South", sub: "Virtual Machines - UK South - connectivity" }],
    [10, "a later scheduled event", input({ azure: azure({ maintenance: [event({ notBefore: iso(NOW + 16 * MIN) })] }) }), { tone: "amber", title: "Azure maintenance planned for 4 Oct, 13:16" }],
    [11, "a warn-level threshold", input({ azure: azure({}, { cpuPct: 80 }) }), { tone: "amber", title: "CPU busy", sub: "80% used" }],
    [12, "not running and the next deploy's capacity check fails", input({ state: "destroyed", checks: CHECKS.map((c) => ({ ...c, ok: null })), azure: notConnected, capacity: capacityFail }), { tone: "amber", title: `The next deploy may fail: ${capacityFail.message}` }],
    [13, "otherwise", input(), { tone: "green", title: "All systems healthy", sub: "Running and responding normally." }],
  ];
  for (const [rule, what, given, want] of rows)
    it(`verdict rule ${rule}: ${what}`, () => {
      const v = verdict(given);
      expect(v).toMatchObject({ rule, ...want });
    });

  it("each rule just short of its threshold falls through", () => {
    expect(verdict(input({ azure: azure({}, { creditsLeft: 10 }) })).rule).toBe(11); // credits 10: warn (below 30), not bad (below 10)
    expect(verdict(input({ azure: azure({}, { cpuPct: 79 }) })).rule).toBe(13);
    expect(verdict(input({ azure: azure({ maintenance: [event({ notBefore: iso(NOW + 16 * MIN) })] }) })).rule).toBe(10);
    expect(verdict(input({ azure: azure({ vitals: vitals({ net: { at: iso(NOW), method: "icmp", targets: [{ ip: "1.1.1.1", rttMs: 9, lossPct: 9 }, { ip: "8.8.8.8", rttMs: 9, lossPct: 100 }] } }) }) })).rule).toBe(11);
  });

  it("a started event is red whatever its time", () => {
    const v = verdict(input({ azure: azure({ maintenance: [event({ status: "Started", type: "Redeploy", notBefore: null })] }) }));
    expect(v).toMatchObject({ rule: 6, tone: "red", title: "Azure will redeploy the VM now" });
  });

  it("rule 8 also covers memory, disk and conntrack at bad, in that order", () => {
    expect(verdict(input({ azure: azure({ vitals: vitals({ memUsedPct: 95, diskUsedPct: 90 }) }) })).title).toBe("Memory nearly full on the VM");
    expect(verdict(input({ azure: azure({ vitals: vitals({ diskUsedPct: 90 }) }) })).title).toBe("Disk nearly full on the VM");
    expect(verdict(input({ azure: azure({ vitals: vitals({ conntrack: { count: 90, max: 100 } }) }) })).title).toBe("Connection tracking table nearly full");
  });

  it("rule 11 gives the most severe threshold, in the spec's order", () => {
    // CPU bad (95) outranks a credits warn; with both at warn, credits comes first.
    expect(verdict(input({ azure: azure({}, { creditsLeft: 25, cpuPct: 95 }) })).title).toBe("CPU busy");
    expect(verdict(input({ azure: azure({}, { creditsLeft: 25, cpuPct: 85 }) })).title).toBe("CPU credits running low");
    expect(verdict(input({ azure: azure({ vitals: vitals({ stealPct: 10 }) }) })).title).toBe("CPU steal high");
    expect(verdict(input({ azure: azure({ vitals: vitals({ net: { at: iso(NOW), method: "icmp", targets: [{ ip: "1.1.1.1", rttMs: 100, lossPct: 0 }] } }) }) })).title).toBe("Internet latency high");
    expect(verdict(input({ azure: azure({ vitals: vitals({ updates: { pending: 4, security: 1, at: iso(NOW) } }) }) })).title).toBe("Security updates waiting");
  });
});

describe("verdict with no new data", () => {
  it("verdict with no new data gives today's head byte for byte", () => {
    const cases: [string, VerdictCheck[]][] = [
      ["running", CHECKS],
      ["running", failing("vm")],
      ["running", failing("dns", "selftest")],
      ["running", CHECKS.map((c) => ({ ...c, ok: null }))],
      ["destroyed", CHECKS.map((c) => ({ ...c, ok: null }))],
      ["standby", CHECKS.map((c) => ({ ...c, ok: null }))],
    ];
    for (const [state, checks] of cases)
      for (const az of [null, undefined, notConnected]) {
        const v = verdict({ state, checks, azure: az, capacity: null, now: NOW });
        const t = todayHead(state, checks);
        expect(JSON.stringify({ tone: v.tone, title: v.title, sub: v.sub })).toBe(JSON.stringify(t));
      }
  });
});

describe("verdict thresholds", () => {
  it("uses vitals and vmPerformance thresholds from prefs, and defaults when those widgets are off", () => {
    const tuned = {
      widgets: {
        "overview.vitals": { v: 1, s: { memory: { warn: 50, bad: 60 } } },
        "overview.vmPerformance": { v: 1, s: { cpu: { warn: 5, bad: null } } },
      },
    };
    // Both off: their saved values are ignored and the defaults apply.
    const off = verdictThresholds(tuned);
    expect(off.vitals.memory).toEqual({ warn: 85, bad: 95 });
    expect(off.perf.cpu).toEqual({ warn: 80, bad: 95 });
    expect(verdict(input({ thresholds: off, azure: azure({ vitals: vitals({ memUsedPct: 61 }) }) })).rule).toBe(13);

    // Both on: the saved values apply.
    const on = verdictThresholds({ ...tuned, layout: { shown: ["overview.vitals", "overview.vmPerformance"] } });
    expect(on.vitals.memory).toEqual({ warn: 50, bad: 60 });
    expect(on.perf.cpu).toEqual({ warn: 5, bad: null });
    expect(verdict(input({ thresholds: on, azure: azure({ vitals: vitals({ memUsedPct: 61 }) }) }))).toMatchObject({ rule: 8, title: "Memory nearly full on the VM" });
    expect(verdict(input({ thresholds: on }))).toMatchObject({ rule: 11, title: "CPU busy" });

    // Nothing saved at all: the defaults.
    expect(verdictThresholds({})).toEqual(off);
  });
});
