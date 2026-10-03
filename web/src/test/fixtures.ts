import type {
  ActivityResponse,
  ClientsResponse,
  CostResponse,
  FirewallResponse,
  FirewallRuleRow,
  OverviewResponse,
  RunDetailResponse,
  SessionResponse,
  SettingsResponse,
  VmHistoryResponse,
} from "@shared/api";
import type { Snapshot } from "../../../worker/src/state";
import type { ClientView } from "../../../worker/src/clients";

// Whole API answers for jsdom tests: every field shared/api.ts promises is
// present (no casts), so a view never meets a shape the Worker cannot send.
// A test overrides only what it is about. No personal data: dev@localhost,
// wg.example.net and TEST-NET addresses only.

const NOW = "2026-10-02T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const ago = (ms: number) => new Date(NOW_MS - ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const sessionFixture = (over: Partial<SessionResponse> = {}): SessionResponse => ({
  user: "dev@localhost",
  build: "test",
  now: NOW,
  setupMissing: {},
  notes: [],
  ...over,
});

/** A snapshot with every field present and nothing in it (the Worker's EMPTY, as of NOW). */
export const emptySnapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
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
  ...over,
});

/** GET /overview in a state (default running), run "r1" in UK South. */
export function overviewFixture(state = "running", over: { auto_destroy_at?: string | null; heartbeatStale?: boolean; region?: string } = {}): OverviewResponse {
  const up = state === "running";
  return {
    now: NOW,
    snapshot: emptySnapshot({
      state: state as Snapshot["state"],
      region: over.region ?? "uksouth",
      vm_size: "Standard_B1s",
      auto_destroy_at: over.auto_destroy_at ?? null,
      run_id: "r1",
      action: state === "destroying" ? "destroy" : "apply",
      since: ago(2 * HOUR),
      running_since: up ? ago(2 * HOUR) : null,
      public_ip: up ? "203.0.113.10" : null,
      dns_ip: up ? "203.0.113.10" : null,
      dns_live: up,
      last_agent_at: up ? ago(5_000) : null,
    }),
    derived: { heartbeatStale: over.heartbeatStale ?? false, verifying: false, selftestFailures: [], clientsOnline: 2, clientsEnabled: 3, publicIp6: null, dnsParked: false },
    config: {
      dnsName: "wg.example.net",
      port: 51820,
      subnet: "10.13.13.0/24",
      subnet6: "fd13:13::/64",
      loopbackIp: "10.13.13.1",
      region: "uksouth",
      vmSize: "Standard_B1s",
      vnetCidr: "10.50.0.0/16",
      homeLanCidr: "192.168.1.0/24",
      hourlyRateGbp: 0.0144,
      standbyRateGbp: 0.002,
      autoDestroyDefaultHours: 4,
      expiryAction: "destroy",
      standbyMaxDays: 7,
    },
    actions: { canDispatch: true, lockHolder: null },
    near: { country: "GB", region: "uksouth" },
    profiles: [{ id: 1, name: "Usual settings", region: "uksouth", vm_size: "Standard_B1s", sort: 1 }],
    speedtests: [],
    site: { id: 2, name: "Home site", routes: "192.168.1.0/24" },
    nextScheduledStart: null,
    budget: { budget: 10, actual: 0.3, session: up ? 0.03 : 0, total: up ? 0.33 : 0.3, pct: up ? 3.3 : 3, level: "ok", month: "2026-10", alerted: 0 },
    deployment: null,
    stateBackups: null,
    typicalSeconds: { deploy: 250, destroy: 120 },
  };
}

const clientConfig = { subnet: "10.13.13.0/24", subnet6: "fd13:13::/64", loopbackIp: "10.13.13.1", vnetCidr: "10.50.0.0/16", homeLanCidr: "192.168.1.0/24", dnsName: "wg.example.net", port: 51820 };

function clientView(over: Partial<ClientView> & Pick<ClientView, "id" | "name" | "ip" | "public_key">): ClientView {
  return {
    enabled: 1,
    full_tunnel: 0,
    azure_vnet: 0,
    tunnel_dns: 0,
    routes: "",
    home_lan: 0,
    created_at: ago(30 * DAY),
    note: null,
    expires_at: null,
    last_handshake_at: ago(2 * MIN),
    needs_config: 0,
    status: "offline",
    live: null,
    latency: [],
    lastLatencyMs: null,
    allowedIps: ["10.13.13.0/24", "10.13.13.1/32", "fd13:13::/64"],
    siteRoutes: [],
    ip6: null,
    expired: false,
    stale: false,
    expiresSoon: false,
    isSite: false,
    roam: null,
    ...over,
  };
}

/** GET /clients: a phone online and the home site offline. */
export const clientsFixture = (): ClientsResponse => ({
  now: NOW,
  running: true,
  heartbeatAt: ago(5_000),
  clients: [
    clientView({ id: 1, name: "test-phone", ip: "10.13.13.2", public_key: `${"P".repeat(43)}=`, status: "online", latency: [24, 26, 25], lastLatencyMs: 25, ip6: "fd13:13::2" }),
    clientView({ id: 2, name: "Home site", ip: "10.13.13.3", public_key: `${"H".repeat(43)}=`, routes: "192.168.1.0/24", isSite: true, allowedIps: [], siteRoutes: ["192.168.1.0/24"] }),
  ],
  kpis: { total: 2, online: 1, avgLatencyMs: 25, fullTunnel: 0, stale: 0, expiringSoon: 0 },
  nextIp: "10.13.13.4",
  nextIp6: "fd13:13::4",
  serverPub: `${"S".repeat(43)}=`,
  config: clientConfig,
  talkers: [],
  trafficHist: [],
});

/** 24 hourly counts, oldest first; null for the hours the VM was not running (no data, not 0). */
const hourly = (scale: number, downFrom = 2, downTo = 5): (number | null)[] =>
  Array.from({ length: 24 }, (_, h) => (h >= downFrom && h < downTo ? null : ((h * 7) % 11) * scale));

const fwRule = (r: Pick<FirewallRuleRow, "id" | "name" | "place" | "hits24h" | "trend24h" | "starter"> & Partial<FirewallRuleRow>): FirewallRuleRow => ({
  position: r.place * 10,
  enabled: 1,
  src_kind: "zone",
  src_value: "clients",
  dst_kind: "any",
  dst_value: "",
  proto: "any",
  ports: "",
  action: "allow",
  log: 0,
  fromLabel: "Tunnel clients",
  toLabel: "Anywhere",
  service: "Any",
  hits: r.hits24h === null ? null : [r.hits24h, r.hits24h * 120],
  lastHit: r.hits24h === null ? null : ago(MIN),
  problem: null,
  ...r,
});

/** GET /firewall: two live rules (7 and 8), no draft, version 1. */
export const firewallFixture = (): FirewallResponse => ({
  now: NOW,
  running: true,
  defaultAction: "deny",
  policy: { hash: "abcdef0123456789", state: "applied", text: "Applied on the VM (rule set abcdef01)." },
  rules: [
    fwRule({ id: 7, name: "Allow DNS to resolver", place: 1, dst_kind: "cidr", dst_value: "10.13.13.1/32", toLabel: "10.13.13.1/32", proto: "udp", ports: "53", service: "UDP 53", hits24h: 1240, trend24h: hourly(12), starter: true }),
    fwRule({ id: 8, name: "Block telemetry", place: 2, dst_kind: "cidr", dst_value: "203.0.113.0/24", toLabel: "203.0.113.0/24", action: "deny", hits24h: null, trend24h: [], starter: false }),
  ],
  defaultHits: [342, 41_000],
  defaultLastHit: ago(MIN),
  countersClearedAt: null,
  defaultHits24h: 342,
  defaultTrend24h: hourly(3),
  drops: { recent: [], last24h: 342, uniqueSources24h: 18, previous24h: 305, hourly24h: hourly(3) },
  zones: [
    { zone: "clients", label: "Tunnel clients", v4: ["10.13.13.0/24"], v6: ["fd13:13::/64"], negate: false },
    { zone: "home", label: "Home LAN", v4: ["192.168.1.0/24"], v6: [], negate: false },
    { zone: "azure", label: "Azure VNet", v4: ["10.50.0.0/16"], v6: [], negate: false },
    { zone: "workloads", label: "Workloads subnet", v4: ["10.50.2.0/24"], v6: [], negate: false },
    { zone: "internet", label: "Internet", v4: ["0.0.0.0/0"], v6: [], negate: true },
  ],
  testVm: { ip: null, enabled: false },
  forwards: [],
  captures: [],
  capture: { busy: false, ifaces: { wg0: "Inside the tunnel (decrypted client traffic)", eth0: "Azure side (the VNet and the internet)", any: "Both" } },
  publicIp: "203.0.113.10",
  dnsName: "wg.example.net",
  kpis: { rules: 2, enabled: 2, defaultAction: "deny", drops24h: 342, published: 0, captureBusy: false },
  version: 1,
  draft: null,
});

const noKpis = (): ActivityResponse["kpis"] => ({ deploys: 0, medianDeploySeconds: null, successRate: { success: 0, finished: 0, pct: null }, failedRuns: 0, configChanges: 0, watchmanProblems: 0 });

/** GET /activity: one successful deploy, run-42. */
export const activityFixture = (): ActivityResponse => ({
  range: "7d",
  now: NOW,
  kpis: { deploys: 1, medianDeploySeconds: 240, successRate: { success: 1, finished: 1, pct: 100 }, failedRuns: 0, configChanges: 0, watchmanProblems: 0 },
  previous: noKpis(),
  timeline: [],
  runs: [
    {
      id: "run-42",
      action: "apply",
      status: "success",
      requested_at: "2026-10-02T10:00:00.000Z",
      requested_by: "dev@localhost",
      started_at: "2026-10-02T10:00:05.000Z",
      finished_at: "2026-10-02T10:04:05.000Z",
      github_run_url: null,
      public_ip: "203.0.113.10",
      reason: null,
      error: null,
      durationSeconds: 240,
      sessionCostGbp: 0.03,
      source: "dashboard",
    },
  ],
  notes: [],
  all: [{ at: "2026-10-02T10:04:05.000Z", type: "deploy", title: "Deployed", detail: null, ref: { kind: "run", id: "run-42" } }],
  changes: { rows: [], more: false, page: 1, kind: "", q: "" },
});

/** GET /runs/:id for a run in activityFixture (or any id): finished, two steps. */
export const runDetailFixture = (id = "run-42"): RunDetailResponse => ({
  run: { ...activityFixture().runs[0]!, id },
  steps: [
    { name: "Create Azure resources (VM, network, disk)", status: "completed", conclusion: "success", started_at: "2026-10-02T10:00:05.000Z", completed_at: "2026-10-02T10:02:05.000Z" },
    { name: "Run connectivity tests", status: "completed", conclusion: "success", started_at: "2026-10-02T10:02:05.000Z", completed_at: "2026-10-02T10:04:05.000Z" },
  ],
  active: false,
});

/** GET /history (any scope): the range asked for, with no points yet. */
export const historyFixture = (range: VmHistoryResponse["range"] = "1h"): VmHistoryResponse => ({
  range,
  step: 60,
  from: ago(HOUR),
  to: NOW,
  points: [],
  latest: null,
  availability: { expected: 0, received: 0, pct: null },
});

/** GET /cost: this month, one reported day, no sessions. */
export const costFixture = (over: Partial<CostResponse> = {}): CostResponse => ({
  now: NOW,
  range: "month",
  meta: { currency: "GBP", timezone: "UTC", azureLagHours: 24, hourlyRateGbp: 0.0144, standbyRateGbp: 0.002, asOfDay: "2026-10-01" },
  session: { running: true, since: ago(2 * HOUR), estimateGbp: 0.03 },
  standby: null,
  monthToDate: 0.3,
  projection: { gbp: 9.3, basis: "£0.30 over the 1 day Azure has reported so far this month, carried on at the same pace to all 31 days." },
  budget: { budget: 10, actual: 0.3, session: 0.03, total: 0.33, pct: 3.3, level: "ok", month: "2026-10", alerted: 0 },
  daily: [{ day: "2026-10-01", gbp: 0.3, fetched_at: "2026-10-02T03:00:00.000Z" }],
  previous: [],
  sessions: [],
  insights: [],
  breakdown: null,
  ...over,
});

/** GET /settings: the usual profile deployed, one schedule, nothing missing. */
export const settingsFixture = (over: Partial<SettingsResponse> = {}): SettingsResponse => ({
  values: {
    region: "uksouth",
    vmSize: "Standard_B1s",
    testVm: false,
    autoDestroyDefaultHours: 4,
    expiryAction: "destroy",
    standbyMaxDays: 7,
    idleDestroyMinutes: 0,
    monthlyBudgetGbp: 10,
    hourlyRateGbp: 0.0144,
    standbyRateGbp: 0.002,
    sshAllowedCidr: "",
    firewallDefault: "deny",
  },
  overrides: {},
  overridable: ["region", "vm_size", "auto_destroy_default_hours", "idle_destroy_minutes", "monthly_budget_gbp", "hourly_rate_gbp", "standby_rate_gbp", "expiry_action", "standby_max_days", "test_vm", "firewall_default", "ssh_allowed_cidr"],
  regions: { uksouth: "UK South (London)", westeurope: "West Europe (Netherlands)" },
  vmSizes: ["Standard_B1s", "Standard_B2s"],
  profiles: [{ id: 1, name: "Usual settings", region: "uksouth", vm_size: "Standard_B1s", sort: 1, deployed: true }],
  schedules: [],
  nextScheduledStart: null,
  setup: [],
  phones: [],
  webhook: false,
  repo: "example/wg",
  key: { publicKey: `${"S".repeat(43)}=`, short: "SSSSSSSS…SSS=", rotation: { changedAt: null, previous: null, vmKey: null, clients: [] } },
  backups: { state: { count: 1, newest: ago(9 * HOUR) }, config: { count: 1, newest: ago(9 * HOUR), days: ["2026-10-01"] }, checked_at: ago(MIN) },
  lock: { held: false, runId: null, since: null },
  vapidPublic: null,
  notifyError: null,
  publicUrl: "https://wg.example.net",
  ...over,
});

/** GET /history answers with the range the query asked for. */
const history = ({ url }: { url: string }) => historyFixture((new URL(url, "http://x").searchParams.get("range") ?? "1h") as VmHistoryResponse["range"]);

/** Every route the shell and the six views read on first load; spread and override per test. */
export const defaultRoutes = (): Record<string, unknown> => ({
  "GET /api/v1/session": sessionFixture(),
  "GET /api/v1/overview": overviewFixture(),
  "GET /api/v1/clients": clientsFixture(),
  "GET /api/v1/firewall": firewallFixture(),
  "GET /api/v1/activity": activityFixture(),
  "GET /api/v1/history": history,
  "GET /api/v1/cost": costFixture(),
  "GET /api/v1/settings": settingsFixture(),
  "GET /api/v1/runs/r1": runDetailFixture("r1"),
  "GET /api/v1/runs/r1/log": { log: "", source: "github", active: false, updatedAt: null },
  "GET /api/v1/runs/run-42": runDetailFixture("run-42"),
  "GET /api/v1/runs/run-42/log": { log: "", source: "github", active: false, updatedAt: null },
});
