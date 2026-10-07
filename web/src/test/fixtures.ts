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
  PagePrefs,
  PrefsPage,
  PrefsResponse,
  AgentVitals,
  AzureChangesResponse,
  AzureDiagnosticsResponse,
  AzureMetricsResponse,
  AzureServiceHealthResponse,
  AzureSummaryResponse,
  BootLogResponse,
  CapacityCheck,
  FeedId,
  FeedStatus,
  PriceInfo,
  LabCard,
  LabCoverageResponse,
  LabDetail,
  LabSession,
  LabSessionsResponse,
  LabsResponse,
} from "@shared/api";
import { FEEDS, PIP_COLUMNS, VITALS_COLUMNS, VM_COLUMNS } from "@shared/azureMetrics";
import { PAGE_IDS, PREFS_SCHEMA, normalisePagePrefs, validatePagePrefs, type PageId } from "@shared/widgets";
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
    capacity: null,
    labs: { running: [], gbpH: 0, rePeer: 0 },
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
    labsConfigDue: false,
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
  labs: [],
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
    labsMaxRunning: 3,
    labsDefaultPeering: true,
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
  rateSource: "fixed",
  price: priceFixture({ source: "fixed", totalGbpPerHour: 0.0144, standbyGbpPerHour: 0.002, reason: "Azure prices aren't collected yet, so the fixed rates apply." }),
  ...over,
});

// ── Azure insights (spec 2026-10-04-azure-insights-design.md, section 8) ──

/** A feed's status: ok two minutes ago unless told otherwise. */
export const feedFixture = (id: FeedId, over: Partial<FeedStatus> = {}): FeedStatus => {
  const f = FEEDS.find((x) => x.id === id)!;
  return { id, title: f.title, status: "ok", lastOkAt: ago(2 * MIN), error: null, cadenceMin: f.cadenceMin, ...over };
};

/** What every feed reports without Azure credentials. */
export const notConfiguredFeeds = (): FeedStatus[] => FEEDS.map((f) => feedFixture(f.id, { status: "not_configured", lastOkAt: null }));

/** AgentVitals from a version-7 agent: a healthy 1-vCPU VM. */
export const vitalsFixture = (over: Partial<AgentVitals> = {}): AgentVitals => ({
  at: ago(20_000),
  memUsedPct: 40,
  diskUsedPct: 24,
  diskFreeBytes: 23_700_000_000,
  load1: 0.12,
  ncpu: 1,
  stealPct: 0.4,
  uptimeS: 7_900,
  conntrack: { count: 61, max: 32_768 },
  updates: { pending: 3, security: 0, at: ago(2 * HOUR) },
  net: { at: ago(3 * MIN), method: "icmp", targets: [{ ip: "1.1.1.1", rttMs: 9.4, lossPct: 0 }, { ip: "8.8.8.8", rttMs: 10.1, lossPct: 0 }] },
  ...over,
});

/**
 * GET /azure/summary for a running VM with Azure connected and every feed
 * ok, nothing wrong: no maintenance, no issue, a current agent. Override
 * what a test is about (configured: false gives the not-connected shape).
 */
export const azureSummaryFixture = (over: Partial<AzureSummaryResponse> = {}): AzureSummaryResponse => {
  const configured = over.configured ?? true;
  return {
    configured,
    region: { id: "uksouth", name: "UK South" },
    feeds: configured ? FEEDS.map((f) => feedFixture(f.id)) : notConfiguredFeeds(),
    health: configured
      ? { state: "Available", title: "Available", summary: "There aren't any known Azure platform problems affecting this virtual machine.", reason: null, since: ago(2 * HOUR), power: "VM running", provisioning: "Provisioning succeeded", vmAgent: { status: "Ready", version: "2.11.1.12" }, bootDiagnostics: true, annotations: [], checkedAt: ago(2 * MIN) }
      : null,
    maintenance: [],
    serviceIssues: [],
    vitals: configured ? vitalsFixture() : null,
    agent: configured ? "current" : "none",
    latest: configured ? { cpuPct: 6, creditsLeft: 120, memFreeBytes: 412_000_000, vipAvailPct: 100, underDdos: false, at: ago(5 * MIN) } : { cpuPct: null, creditsLeft: null, memFreeBytes: null, vipAvailPct: null, underDdos: null, at: null },
    ...over,
  };
};

/** PriceInfo for UK South B1s from Azure's list prices, unless told otherwise. */
export const priceFixture = (over: Partial<PriceInfo> = {}): PriceInfo => ({
  region: "uksouth",
  size: "Standard_B1s",
  vmGbpPerHour: 0.0093,
  diskGbpPerHour: 0.0027,
  ipGbpPerHour: 0.0037,
  totalGbpPerHour: 0.0157,
  standbyGbpPerHour: 0.0064,
  fetchedAt: ago(5 * HOUR),
  stale: false,
  source: "azure",
  reason: null,
  ...over,
});

/**
 * What the Worker answers on every /api/v1/azure/* route before anything is
 * collected and without credentials (the X0 stubs), keyed by path. mockFetch
 * falls back to these, so a view that reads Azure data needs no new routes in
 * existing tests. Answers undefined for any other path.
 */
export function azureNotConfigured(method: string, url: string): unknown {
  const u = new URL(url, "http://x");
  const q = (k: string) => u.searchParams.get(k);
  const feed = (id: FeedId) => feedFixture(id, { status: "not_configured", lastOkAt: null });
  const bootlog: BootLogResponse = { fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason: "Azure isn't connected. Add the service principal secrets to the Worker." };
  if (method === "POST") return u.pathname === "/api/v1/azure/bootlog" ? bootlog : undefined;
  if (method !== "GET") return undefined;
  switch (u.pathname) {
    case "/api/v1/azure/summary":
      return azureSummaryFixture({ configured: false });
    case "/api/v1/azure/metrics": {
      const resource = (q("resource") ?? "vm") as AzureMetricsResponse["resource"];
      const cols = resource === "vm" ? VM_COLUMNS : resource === "pip" ? PIP_COLUMNS : VITALS_COLUMNS;
      return { resource, range: (q("range") ?? "24h") as AzureMetricsResponse["range"], step: 300, columns: ["t", ...cols], points: [] } satisfies AzureMetricsResponse;
    }
    case "/api/v1/azure/changes":
      return { range: (q("range") ?? "7d") as AzureChangesResponse["range"], feed: feed("activity"), rows: [] } satisfies AzureChangesResponse;
    case "/api/v1/azure/service-health":
      return { events: [], feed: feed("serviceHealth") } satisfies AzureServiceHealthResponse;
    case "/api/v1/azure/capacity":
      return { region: q("region") ?? "", size: q("size") ?? "", available: null, reason: null, vcpusNeeded: null, family: null, total: null, ok: null, message: null, fetchedAt: null } satisfies CapacityCheck;
    case "/api/v1/azure/price":
      return priceFixture({ region: q("region") ?? "", size: q("size") ?? "", vmGbpPerHour: null, diskGbpPerHour: null, ipGbpPerHour: null, fetchedAt: null, source: "fixed", reason: "Azure prices aren't collected yet, so the fixed rates apply." });
    case "/api/v1/azure/diagnostics":
      return { configured: false, feeds: notConfiguredFeeds().map((f) => ({ ...f, lastTryAt: null, nextDueAt: null })), metricNames: { vm: null, pip: null } } satisfies AzureDiagnosticsResponse;
    case "/api/v1/azure/bootlog":
      return bootlog;
    default:
      return undefined;
  }
}

// ── Labs (labs spec §7.2, plan L0) ────────────────────────────────────────
// Lab 6 of the spec, running and peered, as the Worker would answer it. Only
// lab-pool addresses (10.64.0.0/13), contoso.onmicrosoft.com and fake ids.

/** One session: lab 6, running 45 minutes, peered, ending in 75 minutes. */
export const labSessionFixture = (over: Partial<LabSession> = {}): LabSession => ({
  id: "ls-20261002111500-b6r1",
  labId: "az104-06-blob-security",
  labVersion: 1,
  title: "Blob security: SAS, access policies, private endpoint",
  state: "running",
  test: false,
  region: "uksouth",
  secondaryRegion: null,
  slot: 0,
  cidr: "10.64.0.0/18",
  peering: "on",
  requestedAt: ago(52 * MIN),
  readyAt: ago(45 * MIN),
  endedAt: null,
  autoDestroyAt: new Date(NOW_MS + 75 * MIN).toISOString(),
  maxUntil: new Date(NOW_MS - 52 * MIN + 6 * HOUR).toISOString(),
  estGbpH: 0.0082,
  costGbp: 0.0071,
  costBasis: "estimate",
  endReason: null,
  note: null,
  outputs: { privateIps: { "pe-blob": "10.64.0.4" }, connect: [], users: {} },
  leftovers: null,
  activeRun: null,
  ...over,
});

const labCard = (over: Partial<LabCard> = {}): LabCard => ({
  id: "az104-06-blob-security",
  number: 6,
  version: 1,
  title: "Blob security: SAS, access policies, private endpoint",
  summary: "A storage account with a private container, a stored access policy and a private endpoint in a small VNet.",
  exam: "AZ-104",
  exams: ["AZ-104"],
  skillAreas: ["az104.storage", "az104.networking"],
  level: "associate",
  type: "explore",
  prerequisites: ["az104-05-storage"],
  peering: "optional",
  estGbpH: 0.0082,
  marker: "£",
  pricey: null,
  timing: { deployMin: 4, destroyMin: 3, sessionH: 2, maxH: 6 },
  running: null,
  lastSession: null,
  runs: 0,
  lastReleaseTest: null,
  released: false,
  unavailable: null,
  blockers: [],
  learning: {
    objective: "Control who reaches one blob container with keys and SAS tokens, Entra roles and a private endpoint.",
    learn: ["Make a SAS from a stored access policy and revoke it without rotating keys", "Grant blob data access to an Entra group and test it with your own sign-in", "Resolve the account to a private endpoint address through the tunnel"],
    learningMin: 50,
  },
  resources: { entraPrincipal: 1, privateDnsZone: 1, privateEndpoint: 1, resourceGroup: 1, storage: 1, subnet: 1, vnet: 1 },
  ...over,
});

/** GET /labs: an empty catalogue (what mockFetch answers by default); pass labs, running and so on to fill it. */
export const labsFixture = (over: Partial<LabsResponse> = {}): LabsResponse => ({
  now: NOW,
  labs: [],
  running: [],
  slots: { used: 0, total: 32 },
  maxRunning: 3,
  permissions: { checkedAt: null, role: null, users: null, groups: null, message: null },
  orphans: [],
  autoCleanup: true,
  ...over,
});

/** GET /labs/:id: lab 6 running and peered, with its deploy run finished. */
export const labDetailFixture = (over: Partial<LabDetail> = {}): LabDetail => {
  const session = labSessionFixture();
  return {
    card: labCard({ running: session, runs: 2 }),
    readme: [
      { t: "h", level: 2, text: "What it deploys" },
      { t: "ul", items: [[{ t: "text", text: "A storage account with a private container" }]] },
      { t: "h", level: 2, text: "Things to try" },
      { t: "ul", items: [[{ t: "text", text: "Make a SAS from the stored access policy" }], [{ t: "b", text: "Revoke" }, { t: "text", text: " it" }], [{ t: "code", text: "az storage blob list" }]] },
      { t: "h", level: 2, text: "Learn more" },
      { t: "ul", items: [[{ t: "a", text: "SAS overview", href: "https://learn.microsoft.com/azure/storage/common/storage-sas-overview" }]] },
    ],
    cost: {
      items: [
        { name: "Storage account, LRS hot, a few MB", gbp_h: 0.0001, gbpH: 0.0001, source: "authored", priceAge: null },
        { name: "Private endpoint", gbp_h: 0.0076, retail: { meter: "Standard Private Endpoint", unit: "1 Hour" }, gbpH: 0.0076, source: "azure", priceAge: 3 * 3600 },
        { name: "Private DNS zone", gbp_h: 0.0005, gbpH: 0.0005, source: "authored", priceAge: null },
      ],
      gbpH: 0.0082,
    },
    connectivity: { peering: "optional", dns_link: true, subnets_used: 1 },
    identity: { creates: ["group"], roles: [{ role: "Storage Blob Data Reader", scope: "resource_group" }], governance: false },
    warnings: [],
    defaults: { region: "uksouth", peer: true, hours: 2 },
    gatewayUp: true,
    session,
    runs: [
      {
        id: "lab-deploy-20261002111500-b6d1",
        sessionId: session.id,
        labId: session.labId,
        action: "deploy",
        status: "succeeded",
        requestedAt: ago(52 * MIN),
        requestedBy: "dev@localhost",
        reason: null,
        startedAt: ago(51 * MIN),
        finishedAt: ago(45 * MIN),
        githubRunUrl: "https://ci.example.invalid/actions/runs/7100000001",
        error: null,
        step: { done: 11, of: 11, name: null },
      },
    ],
    resources: [{ name: "l06k3x9q", type: "Microsoft.Storage/storageAccounts", group: "rg-lab-az104-06-blob-security", state: "Succeeded" }],
    portalUrl: "https://portal.azure.com/#resource/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-lab-az104-06-blob-security",
    ...over,
  };
};

/** GET /labs/coverage: storage covered by lab 6 (run) and lab 5 (not yet). */
export const labCoverageFixture = (): LabCoverageResponse => ({
  exams: [
    {
      exam: "AZ-104",
      areas: [
        {
          key: "az104.storage",
          name: "Implement and manage storage",
          labs: [
            { id: "az104-05-storage", number: 5, title: "Storage accounts: redundancy, access tiers, lifecycle", run: false },
            { id: "az104-06-blob-security", number: 6, title: "Blob security: SAS, access policies, private endpoint", run: true },
          ],
          run: 1,
          available: 2,
        },
      ],
    },
  ],
});

/**
 * What the Worker answers on /api/v1/labs routes with an empty catalogue, so
 * existing tests need no lab routes: GET /labs, /labs/sessions and
 * /labs/coverage empty; any one lab 404. Undefined for other paths.
 */
export function labsEmpty(method: string, url: string): unknown {
  const path = new URL(url, "http://x").pathname;
  if (method !== "GET" || !path.startsWith("/api/v1/labs")) return undefined;
  if (path === "/api/v1/labs") return labsFixture();
  if (path === "/api/v1/labs/sessions") return { sessions: [] } satisfies LabSessionsResponse;
  if (path === "/api/v1/labs/coverage") return { exams: [] } satisfies LabCoverageResponse;
  return { status: 404, json: { error: { code: "not_found", message: "No such lab." } } };
}

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
  "GET /api/v1/prefs": prefsFixture(),
});

// ── Widget preferences ────────────────────────────────────────────────────

/**
 * GET /api/v1/prefs: the given pages saved (version 1, or `version`), every
 * other page never saved (version 0, {}). Each page's prefs are normalised
 * as the Worker would answer them, so a test can write defaults freely.
 */
export function prefsFixture(pages: Partial<Record<PageId, PagePrefs>> = {}, version = 1): PrefsResponse {
  const out = {} as Record<PageId, PrefsPage>;
  for (const p of PAGE_IDS) out[p] = pages[p] ? { version, updatedAt: NOW, prefs: normalisePagePrefs(p, pages[p]) } : { version: 0, updatedAt: null, prefs: {} };
  return { pages: out };
}

export interface PrefsServer {
  /** GET /api/v1/prefs and PUT /api/v1/prefs/<page> for all five pages; spread into mockFetch or renderApp routes. */
  routes: Record<string, unknown>;
  /** What the fake server holds now. */
  state: PrefsResponse;
  /** Every PUT received, in order, accepted or not. */
  puts: { page: PageId; body: { schema?: number; baseVersion: number; prefs: PagePrefs } }[];
}

/**
 * A working fake of the preferences API, as the Worker behaves: a PUT
 * without schema 2 is 409 outdated, then it lands only on the stored version
 * (else 409 stale), is checked with the same shared/widgets.ts rules (400
 * with the field; 409 outdated), is stored normalised, and answers the page
 * with its new version.
 */
export function prefsServer(initial: Partial<Record<PageId, PagePrefs>> = {}): PrefsServer {
  const server: PrefsServer = { routes: {}, state: prefsFixture(initial), puts: [] };
  server.routes["GET /api/v1/prefs"] = () => structuredClone(server.state);
  for (const page of PAGE_IDS) {
    server.routes[`PUT /api/v1/prefs/${page}`] = ({ body }: { body: { schema?: number; baseVersion: number; prefs: PagePrefs } }) => {
      server.puts.push({ page, body: structuredClone(body) });
      const cur = server.state.pages[page];
      if (body.schema !== PREFS_SCHEMA) return { status: 409, json: { error: { code: "outdated", message: "This tab is running an older dashboard. Reload to change widget settings.", field: "schema" } } };
      const problem = validatePagePrefs(page, body.prefs);
      if (problem?.outdated) return { status: 409, json: { error: { code: "outdated", message: problem.message, field: problem.field } } };
      if (problem) return { status: 400, json: { error: { code: "bad_input", message: problem.message, field: problem.field } } };
      if (body.baseVersion !== cur.version) return { status: 409, json: { error: { code: "stale", message: "Changed on another device. Showing the latest." } } };
      const next: PrefsPage = { version: cur.version + 1, updatedAt: NOW, prefs: normalisePagePrefs(page, body.prefs) };
      server.state.pages[page] = next;
      return structuredClone(next);
    };
  }
  return server;
}
