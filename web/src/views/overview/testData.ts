// Test-only data for the Overview's tests: whole, typed API answers (the
// shared fixtures are partial). Names and addresses are invented: dev@localhost,
// wg.example.net and TEST-NET ranges only.

import type { ActivityResponse, CostResponse, OverviewResponse, PagePrefs, SessionResponse, SettingValue, VmHistoryResponse } from "@shared/api";
import type { Snapshot, Step } from "../../../../worker/src/state";
import type { Alert } from "../../../../worker/src/db";
import type { ActivityEvent } from "../../../../worker/src/activity";
import { prefsServer } from "@/test/fixtures";

export const NOW = "2026-10-02T12:00:00.000Z";
export const NOW_MS = Date.parse(NOW);
const iso = (ms: number) => new Date(ms).toISOString();

export const STEP_NAMES = [
  "Check out code from GitHub",
  "Parse deployment configuration",
  "Collect secrets from GitHub Actions",
  "Create Azure resources (VM, network, disk)",
  "Wait for VM to be ready",
  "Set up WireGuard and system config",
  "Apply Terraform configuration",
  "Configure firewall rules",
  "Verify Azure is clean (fallback delete)",
  "Set DNS record",
  "Run connectivity tests",
  "Report result to GitHub",
];

/** Twelve deploy steps: `done` finished, the next one running (or failed at `failAt`, the rest skipped). */
export function deploySteps(o: { done?: number; failAt?: number } = {}): Step[] {
  let t = NOW_MS - 10 * 60_000;
  return STEP_NAMES.map((name, i) => {
    const s = t;
    t += 20_000;
    if (o.failAt !== undefined) {
      if (i < o.failAt) return { name, status: "completed", conclusion: "success", started_at: iso(s), completed_at: iso(t) };
      if (i === o.failAt) return { name, status: "completed", conclusion: "failure", started_at: iso(s), completed_at: iso(t) };
      return { name, status: "completed", conclusion: "skipped", started_at: null, completed_at: null };
    }
    const done = o.done ?? STEP_NAMES.length;
    if (i < done) return { name, status: "completed", conclusion: "success", started_at: iso(s), completed_at: iso(t) };
    if (i === done) return { name, status: "in_progress", conclusion: null, started_at: iso(s), completed_at: null };
    return { name, status: "queued", conclusion: null, started_at: null, completed_at: null };
  });
}

const BASE_SNAPSHOT: Snapshot = {
  state: "destroyed",
  run_id: null,
  action: null,
  since: null,
  running_since: null,
  public_ip: null,
  dns_ip: null,
  dns_live: false,
  auto_destroy_at: null,
  last_agent_at: null,
  agent: null,
  drift: null,
  github_run_url: null,
  steps: [],
  log_tail: null,
  error: null,
  azure: null,
  traffic: null,
  selftest: null,
  latency: {},
  roams: {},
  session: null,
  standby_since: null,
  power_op_at: null,
  pending_summary: null,
  region: null,
  vm_size: null,
  profile: null,
  pending_deploy: null,
  speedtest_req: null,
  selftest_req: null,
  firewall: null,
  fw_base: {},
  fw_cleared_at: null,
  talkers: {},
  traffic_hist: [],
  capture_req: null,
  test_vm_ip: null,
  updated_at: NOW,
};

export type State = Snapshot["state"];

export interface OverviewOver {
  snapshot?: Partial<Snapshot>;
  derived?: Partial<OverviewResponse["derived"]>;
  actions?: Partial<OverviewResponse["actions"]>;
  budget?: Partial<OverviewResponse["budget"]>;
  typicalSeconds?: Partial<OverviewResponse["typicalSeconds"]>;
  profiles?: OverviewResponse["profiles"];
  near?: OverviewResponse["near"];
  speedtests?: OverviewResponse["speedtests"];
}

/** A whole /overview answer for a state, as the Worker would give it. */
export function overview(state: State, over: OverviewOver = {}): OverviewResponse {
  const running = state === "running";
  const snap: Snapshot = { ...BASE_SNAPSHOT, state };
  if (state === "deploying") Object.assign(snap, { run_id: "run-dep", action: "apply", since: iso(NOW_MS - 148_000), steps: deploySteps({ done: 6 }), log_tail: "12:00:01 INFO Applying Terraform configuration...\n12:00:03 INFO azurerm_public_ip.wg: Creating...", github_run_url: "https://github.example/run/1", region: "uksouth", vm_size: "Standard_B1s" });
  if (state === "destroying") Object.assign(snap, { run_id: "run-des", action: "destroy", since: iso(NOW_MS - 30_000), steps: deploySteps({ done: 1 }).slice(0, 6) });
  if (state === "failed") Object.assign(snap, { run_id: "run-fail", action: "apply", since: iso(NOW_MS - 600_000), steps: deploySteps({ failAt: 6 }), error: "Terraform apply failed: SkuNotAvailable", region: "uksouth", vm_size: "Standard_B1s" });
  if (state === "standby") Object.assign(snap, { run_id: "run-old", since: iso(NOW_MS - 3 * 3_600_000), standby_since: iso(NOW_MS - 3 * 3_600_000), public_ip: "203.0.113.10", dns_ip: "203.0.113.10", dns_live: true, region: "uksouth", vm_size: "Standard_B1s" });
  if (running)
    Object.assign(snap, {
      run_id: "run-ok",
      action: "apply",
      since: iso(NOW_MS - 2 * 3_600_000),
      running_since: iso(NOW_MS - 2 * 3_600_000),
      public_ip: "203.0.113.10",
      dns_ip: "203.0.113.10",
      dns_live: true,
      auto_destroy_at: iso(NOW_MS + 3 * 3_600_000),
      last_agent_at: iso(NOW_MS - 3_000),
      agent: { at: iso(NOW_MS - 3_000), hostname: "wg", uptime_seconds: 7200, load: "0.01", listen_port: 51820, server_public_key: "SERVERKEY=", loopback: "10.13.13.254", dns: { up: true, blocked: 1000 }, peers: [] },
      steps: deploySteps(),
      selftest: { at: iso(NOW_MS - 3_600_000), ms: 8000, handshake: true, tunnel: true, loopback: true, dns: true, internet: true, internet6: null },
      latency: { a: [20, 22, 28], b: [30, 26, 28] },
      azure: { checked_at: iso(NOW_MS - 120_000), resource_group: "rg-wg", exists: true, resources: [{ kind: "Virtual machine", name: "vm-wg", detail: "Standard_B1s, running" }] },
      traffic: { at: iso(NOW_MS - 3_000), rx: 1e6, tx: 2e6, rx_rate: 1200, tx_rate: 800, peers_online: 2 },
      traffic_hist: [0, 1, 2, 3, 4, 5].map((i) => ({ t: iso(NOW_MS - (6 - i) * 60_000), rx: 1000 * i, tx: 500 * i })),
      region: "uksouth",
      vm_size: "Standard_B1s",
    });
  Object.assign(snap, over.snapshot ?? {});
  return {
    now: NOW,
    snapshot: snap,
    derived: { verifying: false, heartbeatStale: false, selftestFailures: [], clientsOnline: running ? 2 : 0, clientsEnabled: 3, publicIp6: null, dnsParked: false, ...over.derived },
    config: {
      dnsName: "wg.example.net",
      port: 51820,
      subnet: "10.13.13.0/24",
      subnet6: "fd00:13::/64",
      loopbackIp: "10.13.13.254",
      region: "uksouth",
      vmSize: "Standard_B1s",
      vnetCidr: "10.50.0.0/16",
      homeLanCidr: "192.168.1.0/24",
      hourlyRateGbp: 0.01,
      standbyRateGbp: 0.002,
      autoDestroyDefaultHours: 4,
      expiryAction: "destroy",
      standbyMaxDays: 7,
    },
    actions: { canDispatch: true, lockHolder: null, ...over.actions },
    near: over.near ?? { country: "GB", region: "uksouth" },
    profiles: over.profiles ?? [
      { id: 1, name: "UK", region: "uksouth", vm_size: "Standard_B1s", sort: 1 },
      { id: 2, name: "US exit", region: "eastus", vm_size: "Standard_B1s", sort: 2 },
    ],
    speedtests: over.speedtests ?? [],
    site: { id: 2, name: "home-site", routes: "192.168.1.0/24" },
    nextScheduledStart: null,
    budget: { budget: 10, actual: 1, session: 0.05, total: 1.05, pct: 10.5, level: "ok", month: "2026-10", alerted: 0, ...over.budget },
    deployment: running ? { id: "run-ok", requestedBy: "dev@localhost", finishedAt: iso(NOW_MS - 2 * 3_600_000), githubRunUrl: null, hasSshPassword: true, sshAllowedFrom: "198.51.100.7", peersLoaded: 3 } : null,
    stateBackups: null,
    typicalSeconds: { deploy: 250, destroy: 120, ...over.typicalSeconds },
    capacity: null,
  };
}

/** A /history?scope=vm answer: `points` as given (default: none at all). */
export function vmHistory(range: VmHistoryResponse["range"] = "1h", over: Partial<VmHistoryResponse> = {}): VmHistoryResponse {
  return { range, step: 60, from: iso(NOW_MS - 3_600_000), to: NOW, points: [], latest: null, availability: { expected: 0, received: 0, pct: null }, ...over };
}

export function session(notes: Alert[] = []): SessionResponse {
  return { user: "dev@localhost", build: "test", now: NOW, setupMissing: {}, notes };
}

export function activity(): ActivityResponse {
  return {
    range: "24h",
    now: NOW,
    kpis: {},
    previous: {},
    timeline: [],
    runs: [],
    notes: [],
    all: [
      { at: iso(NOW_MS - 600_000), type: "deploy", title: "Deployed", detail: null, ref: { kind: "run", id: "run-ok" } },
      { at: iso(NOW_MS - 3_600_000), type: "config", title: "Client added", detail: "laptop", ref: { kind: "change", id: 3 } },
    ],
    changes: { rows: [], more: false, page: 1, kind: "", q: "" },
  } as unknown as ActivityResponse;
}

export function cost(over: Partial<CostResponse> = {}): CostResponse {
  return {
    now: NOW,
    range: "month",
    meta: { currency: "GBP", timezone: "UTC", azureLagHours: 24, hourlyRateGbp: 0.01, standbyRateGbp: 0.002, asOfDay: null },
    session: { running: false, since: null, estimateGbp: null },
    standby: null,
    monthToDate: 0,
    projection: null,
    budget: { budget: 10, actual: 1, session: 0, total: 1, pct: 10, level: "ok", month: "2026-10", alerted: 0 },
    daily: [],
    previous: [],
    sessions: [],
    insights: [],
    breakdown: null,
    ...over,
  };
}

/** Every route the Overview reads, for renderApp. Override any of them. */
export function routes(o: OverviewResponse, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "GET /api/v1/session": session(),
    "GET /api/v1/overview": o,
    "GET /api/v1/history": ({ url }: { url: string }) => vmHistory((new URL(url, "http://x").searchParams.get("range") ?? "1h") as "1h"),
    "GET /api/v1/activity": activity(),
    "GET /api/v1/cost": cost(),
    [`GET /api/v1/runs/${o.snapshot.run_id ?? "none"}/log`]: { log: "", source: "live", active: true, updatedAt: null },
    ...extra,
  };
}

// ── Widget settings (W1): saved preferences and longer lists ───────────────

/** Saved settings for one Overview widget: `{ widgets: { id: { v: 1, s } } }`. */
export function saved(id: string, s: Record<string, SettingValue>): PagePrefs {
  return { widgets: { [id]: { v: 1, s } } };
}

/** Several preference pieces merged (widgets and layout). */
export function merge(...ps: PagePrefs[]): PagePrefs {
  const out: PagePrefs = {};
  for (const p of ps) {
    if (p.widgets) out.widgets = { ...(out.widgets ?? {}), ...p.widgets };
    if (p.layout?.order) out.layout = { ...(out.layout ?? {}), order: { ...(out.layout?.order ?? {}), ...p.layout.order } };
    if (p.layout?.hidden) out.layout = { ...(out.layout ?? {}), hidden: [...(out.layout?.hidden ?? []), ...p.layout.hidden] };
  }
  return out;
}

/** The Overview's routes with these preferences saved on a working fake of the prefs API. */
export function prefsRoutes(o: OverviewResponse, prefs: PagePrefs, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...routes(o, extra), ...prefsServer({ overview: prefs }).routes };
}

const EVENT_ROWS: [ActivityEvent["type"], string, string | null][] = [
  ["deploy", "Deployed", "uksouth"],
  ["config", "Client added", "laptop"],
  ["firewall", "Firewall rule added", "ssh from home"],
  ["watchman", "Heartbeat late", "3 minutes"],
  ["destroy", "Torn down", "timer"],
  ["failure", "Deploy failed", "SkuNotAvailable"],
  ["deploy", "Deployed again", "uksouth"],
  ["config", "Settings changed", "budget"],
];

/** An /activity answer whose combined list has `n` events (newest first, one every 10 minutes, types cycling). */
export function activityOf(n: number): ActivityResponse {
  return {
    ...activity(),
    all: Array.from({ length: n }, (_, i) => {
      const [type, title, detail] = EVENT_ROWS[i % EVENT_ROWS.length];
      return { at: iso(NOW_MS - (i + 1) * 600_000), type, title: `${title} ${i + 1}`, detail, ref: { kind: "run", id: `ev-${i}` } };
    }),
  } as unknown as ActivityResponse;
}

/** `n` speed tests, newest first, with jitter and the test server's name. */
export function speedtestsOf(n: number): OverviewResponse["speedtests"] {
  return Array.from({ length: n }, (_, i) => ({ id: `st-${i}`, at: iso(NOW_MS - (i + 1) * 3_600_000), target_name: `home-site-${i + 1}`, down_mbps: 50 + i, up_mbps: 20 + i, rtt_ms: 30 + i, jitter_ms: 2.5 + i, error: null }));
}

/** `n` finished sessions, newest first, costing £0.01, £0.02, ... */
export function costSessionsOf(n: number): CostResponse["sessions"] {
  return Array.from({ length: n }, (_, i) => ({ runId: `s${i}`, started: iso(NOW_MS - (i + 1) * 86_400_000), ended: iso(NOW_MS - (i + 1) * 86_000_000), durationSeconds: 3600, region: "uksouth", vmSize: "Standard_B1s", estimatedGbp: (i + 1) / 100, perHourGbp: 0.01, stillRunning: false }));
}

/** `n` unread watchman notes, newest first. */
export function notesOf(n: number): Alert[] {
  return Array.from({ length: n }, (_, i) => ({ id: 100 + i, at: iso(NOW_MS - (i + 1) * 300_000), kind: "watchman", message: `Note number ${i + 1}`, run_id: null, acknowledged: 0 }));
}
