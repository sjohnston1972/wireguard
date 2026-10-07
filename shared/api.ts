// shared/api.ts
//
// Plain English: the shapes of the dashboard's data API (/api/v1), shared by
// the Worker that answers and the app (web/) that asks, so both sides agree
// on every field. Types only: nothing here runs.

import type { Alert, AuditEntry, Capture, CostDay, Peer, Profile, Schedule, SpeedTest } from "../worker/src/db";
import type { Forward, FwRule, Zone } from "../worker/src/firewall";
import type { PolicyState } from "../worker/src/fwview";
import type { Snapshot, Step, Talker } from "../worker/src/state";
import type { ClientKpis, ClientView } from "../worker/src/clients";
import type { SessionRow } from "../worker/src/costview";
import type { BudgetStatus } from "../worker/src/budget";
import type { ClientHistory, HistoryRange, RuleHistory, VmHistory } from "../worker/src/history";
import type { ActivityEvent, ActivityKpis, ActivityRange, EventType, RunRow } from "../worker/src/activity";
import type { RotationStatus } from "../worker/src/keyrotation";
import type { TopologyGraph } from "./topology/model";
import type { BackupStatus, ExportTable } from "../worker/src/backup";
import type { PageId } from "./widgets";
import type { LabCostItem, LabDef, LabExam, LabLevel, LabType, PeeringMode, ReadmeBlock, LAB_ACTIONS, LAB_END_REASONS, LAB_PEERINGS, LAB_SESSION_STATES, LAB_WARNING_KINDS } from "./labs";

/** Every refusal or failure. `field` names the input at fault, for a form. */
export interface ApiError {
  error: { code: string; message: string; field?: string };
}

/** Every action that worked. `message` is fit to show as-is; `warning` says what only half worked (saved, but Azure refused). */
export interface ApiOk {
  ok: true;
  message: string;
  warning?: string;
}

/** GET /api/v1/session */
export interface SessionResponse {
  user: string;
  build: string;
  now: string;
  /** Secret groups with something missing, and which names (presence only, never values). */
  setupMissing: Record<string, string[]>;
  /** Watchman notes nobody has read yet, newest first. */
  notes: Alert[];
}
/** GET /api/v1/overview */
export interface OverviewResponse {
  now: string;
  /** The stored state, exactly as the watchman and heartbeat left it. Holds no secrets. */
  snapshot: Snapshot;
  derived: {
    verifying: boolean;
    heartbeatStale: boolean;
    selftestFailures: string[];
    clientsOnline: number;
    clientsEnabled: number;
    publicIp6: string | null;
    dnsParked: boolean;
  };
  config: {
    dnsName: string;
    port: number;
    subnet: string;
    subnet6: string;
    loopbackIp: string;
    region: string;
    vmSize: string;
    vnetCidr: string;
    homeLanCidr: string;
    hourlyRateGbp: number;
    standbyRateGbp: number;
    autoDestroyDefaultHours: number;
    expiryAction: "destroy" | "hibernate";
    standbyMaxDays: number;
  };
  actions: { canDispatch: boolean; lockHolder: string | null };
  near: { country: string | null; region: string | null };
  profiles: Profile[];
  speedtests: SpeedTest[];
  site: { id: number; name: string; routes: string } | null;
  nextScheduledStart: string | null;
  budget: BudgetStatus;
  deployment: {
    id: string;
    requestedBy: string | null;
    finishedAt: string | null;
    githubRunUrl: string | null;
    hasSshPassword: boolean;
    sshAllowedFrom: string | null;
    peersLoaded: number | null;
  } | null;
  stateBackups: { count: number; newest: string | null } | null;
  typicalSeconds: { deploy: number | null; destroy: number | null };
  /** Can the deploy form's current target (region and size) be deployed? null until the collectors have looked (area X1). */
  capacity: CapacityCheck | null;
}

/** GET /api/v1/ssh-password */
export interface SshPasswordResponse {
  password: string;
}

/** GET /api/v1/history?scope=vm&range= */
export type VmHistoryResponse = VmHistory;
/** GET /api/v1/history?scope=client&id=&range= */
export type ClientHistoryResponse = ClientHistory;
/** GET /api/v1/clients */
export interface ClientsResponse {
  now: string;
  running: boolean;
  /** When the VM last reported (the age of the live columns), or null. */
  heartbeatAt: string | null;
  clients: ClientView[];
  kpis: ClientKpis;
  nextIp: string | null;
  nextIp6: string | null;
  serverPub: string | null;
  config: { subnet: string; subnet6: string; loopbackIp: string; vnetCidr: string; homeLanCidr: string; dnsName: string; port: number };
  /** Who talked to what this session, all clients. */
  talkers: Talker[];
  /** Throughput this session, one sample per heartbeat (bytes/s). */
  trafficHist: { t: string; rx: number; tx: number }[];
}

/** GET /api/v1/clients/:id */
export interface ClientDetailResponse {
  client: ClientView;
  talkers: Talker[];
  changes: AuditEntry[];
}

/** POST /api/v1/clients and POST /api/v1/clients/:id/rekey */
export interface ClientConfigResponse {
  peer: Peer;
  /** The client's config, with __CLIENT_PRIVATE_KEY__ where the browser puts the private key it made. */
  template: string;
}

/** PUT /api/v1/clients/:id */
export interface ClientEditResponse {
  peer: Peer;
}

// ── Firewall ──

/** One rule in the table, with what the VM reports for it. */
export interface FirewallRuleRow extends FwRule {
  /** 1 for the first rule, in the order the VM tries them. */
  place: number;
  fromLabel: string;
  toLabel: string;
  service: string;
  /** [packets, bytes] since counters were last cleared, or null when the VM has not counted any. */
  hits: [number, number] | null;
  lastHit: string | null;
  /** Why the VM cannot apply this rule, or null. */
  problem: string | null;
}

/** GET /api/v1/firewall */
export interface FirewallResponse {
  now: string;
  running: boolean;
  defaultAction: "deny" | "allow";
  policy: { hash: string; state: PolicyState; text: string };
  rules: FirewallRuleRow[];
  defaultHits: [number, number] | null;
  defaultLastHit: string | null;
  countersClearedAt: string | null;
  drops: { recent: { at: string; src: string; dst: string; proto: string; dport: number | null; fromName: string; toName: string }[]; last24h: number } & FirewallDropStats;
  zones: { zone: Zone; label: string; v4: string[]; v6: string[]; negate: boolean }[];
  testVm: { ip: string | null; enabled: boolean };
  forwards: (Forward & { connections: [number, number] | null; lastHit: string | null })[];
  captures: Capture[];
  capture: { busy: boolean; ifaces: Record<string, string> };
  publicIp: string | null;
  dnsName: string;
  kpis: { rules: number; enabled: number; defaultAction: "deny" | "allow"; drops24h: number; published: number; captureBusy: boolean };
  /** The live rule set's version (fw_policy.live_version); Apply sends it back as `baseVersion`. */
  version: number;
  /** The unpublished draft, or null when there is none (an edit that leaves nothing changed deletes it). */
  draft: FirewallDraft | null;
}

// ── Firewall draft (spec §6) ──

/** One rule of the draft, as the table shows it. `id` is the live rule's id for a copied rule, so a rule keeps its id with or without a draft. */
export interface DraftRuleRow extends FwRule {
  /** The live rule this one edits; null for a rule added in the draft. */
  liveId: number | null;
  /** 1 for the first rule, in the draft's order. */
  place: number;
  fromLabel: string;
  toLabel: string;
  service: string;
  /** Why the VM could not apply this rule, or null. */
  problem: string | null;
  /** How it differs from live; null when unchanged. */
  mark: "added" | "changed" | "moved" | null;
}

/** What Apply would change. Places are 1-based. */
export interface DraftDiff {
  added: { id: number; name: string; place: number }[];
  /** `place` is the rule's place in the live list. */
  removed: { id: number; name: string; place: number }[];
  changed: { id: number; name: string; fields: { field: string; before: string; after: string }[] }[];
  moved: { id: number; name: string; from: number; to: number }[];
  defaultChanged: { before: "allow" | "deny"; after: "allow" | "deny" } | null;
}

/** GET /api/v1/firewall `draft`. `stale` is true when the live rules changed after the draft began (Apply would be refused with 409). */
export interface FirewallDraft {
  baseVersion: number;
  stale: boolean;
  defaultAction: "allow" | "deny";
  rules: DraftRuleRow[];
  diff: DraftDiff;
  /** Number of changes in `diff` (added + removed + changed + moved + default). */
  changes: number;
}

/** POST /api/v1/firewall/draft/rules; PUT /api/v1/firewall/draft/rules/:id takes any part of it. */
export interface DraftRuleBody {
  name: string;
  from: SimEnd;
  to: SimEnd;
  proto: "any" | "tcp" | "udp" | "icmp";
  /** Only for tcp/udp: "443", "80,443", "8000-8100". */
  ports?: string;
  action: "allow" | "deny";
  enabled?: boolean;
  log?: boolean;
}

/** POST /api/v1/firewall/draft/rules/:id/move: one step, or to a 0-based index in the draft list. */
export type DraftMoveBody = { dir: "up" | "down" } | { to: number };

/** PUT /api/v1/firewall/draft/default */
export interface DraftDefaultBody {
  action: "allow" | "deny";
}

/** POST /api/v1/firewall/draft/from-drop: "Allow" on a recent drop (fields as in `drops.recent`). */
export interface DraftFromDropBody {
  src: string;
  dst: string;
  proto: string;
  dport: number | null;
}

/** POST /api/v1/firewall/draft/apply. 409 when `baseVersion` is no longer the live version; 422 (field `rules`) for a broken rule. */
export interface DraftApplyBody {
  baseVersion: number;
}

// ── Activity ──

/** GET /api/v1/activity?range=24h&kind=&q=&page= */
export interface ActivityResponse {
  range: ActivityRange;
  now: string;
  kpis: ActivityKpis;
  timeline: { start: string; counts: Record<EventType, number> }[];
  /** Runs requested in the range, newest first (up to 200). No secrets. */
  runs: RunRow[];
  notes: Alert[];
  /** Runs, notes and changes as one list, newest first. */
  all: ActivityEvent[];
  /** The change log: one page, with the filter that produced it. `lines` is each change worded in plain English. */
  changes: { rows: (AuditEntry & { lines: string[] })[]; more: boolean; page: number; kind: string; q: string };
}

/** GET /api/v1/runs/:id */
export interface RunDetailResponse {
  run: RunRow;
  steps: Step[];
  /** True while this is the run in progress; its steps then come live from the VM's snapshot. */
  active: boolean;
}

/** GET /api/v1/runs/:id/log */
export interface RunLogResponse {
  /** The log text: GitHub's style, one "<ISO time> <text>" per line, "##[group]" markers. May be "" while a run has just started. */
  log: string;
  /**
   * Where it came from. "live": sent by the workflow while it ran (secrets
   * hidden on the runner), the only log there is until the run finishes.
   * "github": GitHub's full job log, once the run has finished.
   */
  source: "live" | "github";
  /** The run is still going: the live log will grow, so keep polling. */
  active: boolean;
  /** When the last piece of the live log arrived; null for GitHub's log or before anything arrived. */
  updatedAt: string | null;
}

// ── Cost ──

/** GET /api/v1/cost?range=month|7d|30d */
export interface CostResponse {
  now: string;
  range: "month" | "7d" | "30d";
  meta: { currency: "GBP"; timezone: "UTC"; azureLagHours: 24; hourlyRateGbp: number; standbyRateGbp: number; asOfDay: string | null };
  /** The VM running now: what it has cost so far, estimated (Azure's figures lag). */
  session: { running: boolean; since: string | null; estimateGbp: number | null };
  standby: { since: string; perDayGbp: number } | null;
  /** This month's actual spend from Azure. */
  monthToDate: number;
  /** Null until Azure has listed a day of this month. */
  projection: { gbp: number; basis: string } | null;
  budget: BudgetStatus;
  daily: CostDay[];
  previous: CostDay[];
  sessions: SessionRow[];
  insights: string[];
  /** Null with neither Azure's split nor any session in the range. See `CostBreakdown`. */
  breakdown: CostBreakdown | null;
}

// ── Settings and backups ──

/** The settings a deploy uses today (stored overrides and defaults merged). */
export interface SettingsValues {
  region: string;
  vmSize: string;
  testVm: boolean;
  autoDestroyDefaultHours: number;
  expiryAction: "destroy" | "hibernate";
  standbyMaxDays: number;
  idleDestroyMinutes: number;
  monthlyBudgetGbp: number;
  hourlyRateGbp: number;
  standbyRateGbp: number;
  sshAllowedCidr: string;
  firewallDefault: "deny" | "allow";
}

/** GET /api/v1/settings */
export interface SettingsResponse {
  values: SettingsValues;
  /** Only the settings the screen may change, as stored. */
  overrides: Record<string, string>;
  overridable: string[];
  regions: Record<string, string>;
  vmSizes: string[];
  /** `deployed`: the running (or Standby) VM was built from this profile. */
  profiles: (Profile & { deployed: boolean })[];
  schedules: (Schedule & { daysText: string; profileName: string | null })[];
  nextScheduledStart: string | null;
  /** Secret groups with something missing, and which names (never values). */
  setup: { group: string; missing: string[] }[];
  /** Phones signed up for alerts, without their push keys. */
  phones: { id: number; label: string | null; created_at: string; last_ok: string | null; last_error: string | null }[];
  webhook: boolean;
  repo: string | null;
  key: { publicKey: string | null; short: string; rotation: RotationStatus };
  backups: BackupStatus;
  lock: { held: boolean; runId: string | null; since: string | null };
  vapidPublic: string | null;
  notifyError: { at: string; why: string } | null;
  publicUrl: string;
  /** Where cost estimates take the hourly rate from: Azure's list price, or the fixed rates (setting rate_source; area X1). */
  rateSource: "azure" | "fixed";
  /** The price for the configured region and size, with where it came from. */
  price: PriceInfo;
}

/** POST /api/v1/backup/restore/preview */
export interface RestorePreviewResponse {
  token: string;
  exportedAt: string;
  /** Rows per table in the file, and rows held now. Never the rows themselves. */
  file: Record<ExportTable, number>;
  current: Record<ExportTable, number>;
  labels: Record<ExportTable, string>;
}

// ── Phone alerts ──

/** GET /api/v1/push/status?endpoint= (a phone's keys are never sent) */
export interface PushStatusResponse {
  registered: boolean;
  id: number | null;
  last_error: string | null;
  /** The dashboard's public key, for a phone that has to sign up again. */
  vapid: string | null;
}

// ── Simulator ──

/** One end of a simulated flow, the same kinds a firewall rule uses. */
export interface SimEnd {
  kind: "any" | "zone" | "client" | "cidr";
  value: string;
}

/** POST /api/v1/firewall/simulate */
export interface SimRequest {
  from: SimEnd;
  to: SimEnd;
  proto: "tcp" | "udp" | "icmp";
  port?: number | null;
  /** Test against the live rules (default) or the draft; "draft" with no draft is 400 field `policy`. */
  policy?: "live" | "draft";
}

/** A rule named in a simulation result; `place` is its row number on the Firewall screen. */
export interface SimRuleRef {
  id: number;
  name: string;
  place: number;
}

/** What the firewall would do with one flow. */
export interface SimResult {
  verdict: "allow" | "deny";
  /** The rule that decided it; null when no rule matched and the default decided. */
  matched: SimRuleRef | null;
  reason: string;
  /** Rules that cover only part of the flow ("depends on the exact address"); evaluation went past them. */
  partial: SimRuleRef[];
  /** What the simulation cannot see, in plain English; null when nothing is left out. */
  limited: string | null;
}

// ── Cost breakdown ──

/**
 * Where the money went, for the chosen range: by type (compute, network,
 * disk, other) and by Azure region. `basis` says whether it is Azure's
 * actual split ("azure", with types) or the sessions' estimate ("estimate",
 * regions only, no types). Shares are percentages to one decimal place and
 * add up to 100 within rounding; a slice with nothing in it is left out.
 * `asOfDay` is the latest day of Azure data in the split (null for an estimate).
 * Part of `CostResponse.breakdown`.
 */
export interface CostBreakdown {
  byType: { type: "compute" | "network" | "disk" | "other"; gbp: number; pct: number }[];
  byRegion: { location: string; name: string; gbp: number; pct: number }[];
  basis: "azure" | "estimate";
  asOfDay: string | null;
}

// ── Health check ──

/** POST /api/v1/health-check answers the ordinary ApiOk. The request and its result are in GET /overview's snapshot: selftest_req while pending, then selftest. */
export type HealthCheckResponse = ApiOk;

// ── Firewall history ──

/** GET /api/v1/history?scope=rule&id=<counter key>&range= (the key is "r<id>", "default" or "f<id>") */
export type RuleHistoryResponse = RuleHistory;

/** Hit history added to each row of GET /firewall `rules` (merged into FirewallRuleRow). */
export interface FirewallRuleRow {
  /** Packets matched in the last 24 hours, or null when no hit history has been recorded at all yet. */
  hits24h: number | null;
  /** Packets per hour over the last 24 hours, oldest first: 24 entries, null for an hour the VM was not running (no data, not 0); [] when no hit history has been recorded at all. */
  trend24h: (number | null)[];
  /** True when this is one of the rules a fresh install starts with (same name and ends). */
  starter: boolean;
}

/** Hit history for the default action, added to GET /firewall (merged into FirewallResponse). */
export interface FirewallResponse {
  defaultHits24h: number | null;
  /** As a rule's trend24h. */
  defaultTrend24h: (number | null)[];
}

/** What `drops` in GET /firewall gains: statistics over the last 24 hours. */
export interface FirewallDropStats {
  /** Different source addresses that were dropped. */
  uniqueSources24h: number;
  /** Total drops in the 24 hours before the last 24, for the "vs the day before" figure. */
  previous24h: number;
  /** Drops per hour over the last 24 hours, oldest first; always 24 entries, null for an hour the VM was not running (no data, not 0). */
  hourly24h: (number | null)[];
}

/** GET /api/v1/activity gains `previous` (merged into ActivityResponse). */
export interface ActivityResponse {
  /** The same figures for the equally long period just before the selected range. */
  previous: ActivityKpis;
}

// ── Widget preferences (spec 2026-10-03-widgets-design.md, section 6) ─────

/** One saved setting: enum and bool and number values, a multi-select's choices, or a threshold pair (null = off). */
export type SettingValue = string | number | boolean | string[] | { warn: number | null; bad: number | null };

/**
 * One page's widget preferences, sparse: only what differs from the
 * defaults in shared/widgets.ts. `{}` is "everything as it ships".
 */
export interface PagePrefs {
  layout?: {
    /** Row id -> that row's item keys (widget ids and stack ids) in the user's order. */
    order?: Record<string, string[]>;
    /** Hidden widget ids (never a pinned or a default-off widget). */
    hidden?: string[];
    /** Default-off widgets turned on (schema 2), oldest first: an over-full row loses its newest. Never a widget that is on by default. */
    shown?: string[];
  };
  /** Widget id -> its settings version and the values that differ from its defaults. */
  widgets?: Record<string, { v: number; s: Record<string, SettingValue> }>;
}

/** A page's saved preferences. `version` 0 = never saved (then updatedAt is null and prefs is {}). */
export interface PrefsPage {
  version: number;
  updatedAt: string | null;
  prefs: PagePrefs;
}

/** GET /api/v1/prefs: every widget page for the signed-in user, normalised against the current schemas. */
export interface PrefsResponse {
  pages: Record<PageId, PrefsPage>;
}

/**
 * PUT /api/v1/prefs/:page. `baseVersion` is the version the change was made
 * on (0 for a page never saved). `schema` is 2 (PREFS_SCHEMA in
 * shared/widgets.ts); without it the save is from an older dashboard that
 * would drop `layout.shown`, and the Worker answers 409 outdated.
 */
export interface PrefsPutBody {
  schema: 2;
  baseVersion: number;
  prefs: PagePrefs;
}

// ── Azure insights (spec 2026-10-04-azure-insights-design.md, section 8) ──
// Every route sits behind the login and the same-origin check, reads D1 and
// the snapshot only (never Azure, except POST bootlog and a capacity cache
// miss), and without Azure credentials answers `configured: false` with
// every feed not_configured. "No data" is always null, never 0.

/** The collector's feeds (worker/src/insights/feeds/<id>.ts), in priority order in FEEDS (shared/azureMetrics.ts). */
export type FeedId = "health" | "vmMetrics" | "pipMetrics" | "metricDefs" | "activity" | "serviceHealth" | "capacity" | "prices" | "bootLog";
/** ok; error (the last run failed); not_configured (no Azure credentials); skipped (the run's budget ran out: still due); idle (never run yet). */
export type FeedState = "ok" | "error" | "not_configured" | "skipped" | "idle";

/** One feed's health, for a widget's footer ("Azure · 3 min ago", amber after 3 cadences: feedIsStale in shared/azureMetrics.ts). */
export interface FeedStatus {
  id: FeedId;
  title: string;
  status: FeedState;
  lastOkAt: string | null;
  /** The last error in plain words, never a URL. */
  error: string | null;
  /** Minutes between runs now; null = on demand (boot log). */
  cadenceMin: number | null;
}

/** What Azure says about the VM: Resource Health plus the instance view. */
export interface AzureHealth {
  state: "Available" | "Degraded" | "Unavailable" | "Unknown";
  title: string | null;
  summary: string | null;
  /** Resource Health's reasonType ("Unplanned", "Customer initiated", ...). */
  reason: string | null;
  /** When the current state began. */
  since: string | null;
  /** "VM running", "VM deallocated", ... as Azure words it. */
  power: string | null;
  /** "Provisioning succeeded", ... */
  provisioning: string | null;
  vmAgent: { status: string | null; version: string | null } | null;
  /** Boot diagnostics on (true), off (false: "turns on with the next deploy"), or not known. */
  bootDiagnostics: boolean | null;
  /** Azure's own notes on the VM (Activity Log, category ResourceHealth), newest first. */
  annotations: { at: string; title: string }[];
  checkedAt: string;
}

export type ScheduledEventType = "Reboot" | "Redeploy" | "Freeze" | "Preempt" | "Terminate";

/** A maintenance event Azure has scheduled for this VM (from the VM's metadata service, via the heartbeat). Read only: wg-admin never approves one. */
export interface ScheduledEvent {
  id: string;
  type: ScheduledEventType;
  /** "Scheduled" or "Started". */
  status: string;
  notBefore: string | null;
  source: string | null;
  description: string | null;
  durationS: number | null;
}

/** The VM's own figures, from the heartbeat (agent_version 7 and later). */
export interface AgentVitals {
  /** The heartbeat they came with. */
  at: string;
  memUsedPct: number | null;
  diskUsedPct: number | null;
  diskFreeBytes: number | null;
  load1: number | null;
  ncpu: number | null;
  stealPct: number | null;
  uptimeS: number | null;
  conntrack: { count: number; max: number } | null;
  updates: { pending: number; security: number; at: string } | null;
  /** The internet check: icmp, or tcp to port 53 when ping is blocked. lossPct 100 on every target = no internet. */
  net: { at: string; method: "icmp" | "tcp"; targets: { ip: string; rttMs: number | null; lossPct: number | null }[] } | null;
}

/** An Azure Service Health event touching VMs or networking (SERVICE_HEALTH_SERVICES). */
export interface ServiceEvent {
  trackingId: string;
  type: "ServiceIssue" | "PlannedMaintenance";
  status: "Active" | "Resolved";
  level: string | null;
  title: string;
  summary: string | null;
  services: string[];
  startsAt: string | null;
  endsAt: string | null;
  updatedAt: string;
}

/** GET /api/v1/azure/summary: polled every 30 s by Overview and the shell. */
export interface AzureSummaryResponse {
  /** All four service principal values are set. */
  configured: boolean;
  /** The configured region; `name` as Azure names it ("UK South"), for "Azure issue in UK South". */
  region: { id: string; name: string };
  /** Every feed, in priority order. */
  feeds: FeedStatus[];
  health: AzureHealth | null;
  /** Azure's scheduled events for this VM, soonest first. */
  maintenance: ScheduledEvent[];
  /** Active ServiceIssues affecting VMs or networking in this region: the top-bar pill shows while this is not empty. */
  serviceIssues: ServiceEvent[];
  vitals: AgentVitals | null;
  /** current: the VM's agent sends vitals; needsDeploy: a running VM's agent is older than 7; none: no VM or no heartbeat. */
  agent: "current" | "needsDeploy" | "none";
  /** The newest 5-minute slot's headline figures. */
  latest: {
    cpuPct: number | null;
    creditsLeft: number | null;
    /**
     * Where the CPU credits have gone over the last hour of slots (the newest
     * against the oldest at least 10 minutes earlier, by more than 1 credit);
     * null with too few readings. The verdict warns about credits only while
     * they fall (shared/verdict.ts).
     */
    creditsTrend?: "falling" | "flat" | "rising" | null;
    memFreeBytes: number | null;
    vipAvailPct: number | null;
    underDdos: boolean | null;
    at: string | null;
  };
}

export type AzureMetricsResource = "vm" | "pip" | "vitals";

/** GET /api/v1/azure/metrics?resource=vm|pip|vitals&range=1h|24h|7d|30d. Columns: "t" then VM_COLUMNS, PIP_COLUMNS or VITALS_COLUMNS (shared/azureMetrics.ts). */
export interface AzureMetricsResponse {
  resource: AzureMetricsResource;
  range: HistoryRange;
  /** Seconds per point: vm and pip at least 300 (Azure's 5-minute slots), vitals as hist_vm. */
  step: number;
  columns: string[];
  /** One object per point, keyed by column; "t" is the slot start (ISO). A missing figure is null. */
  points: Record<string, number | string | null>[];
}

export type AzureChangesRange = "24h" | "7d" | "30d" | "90d";
export type AzureChangesWho = "all" | "others" | "wgadmin";

/** One operation in the Azure Activity Log (grouped by correlation id: the final status wins). */
export interface AzureChangeRow {
  id: string;
  at: string;
  /** Azure's operationName, e.g. Microsoft.Network/networkSecurityGroups/securityRules/write. */
  operation: string;
  status: string;
  caller: string | null;
  /** wgadmin: wg-admin's own service principal; person: an email address; azure: the platform. */
  callerKind: "wgadmin" | "person" | "azure";
  /** A plain name from AZURE_RESOURCE_KINDS' labels (shared/azureMetrics.ts). */
  resourceType: string;
  resourceName: string | null;
}

/** GET /api/v1/azure/changes?range=24h|7d|30d|90d&who=all|others|wgadmin (defaults 7d, all). Newest first. */
export interface AzureChangesResponse {
  range: AzureChangesRange;
  feed: FeedStatus;
  rows: AzureChangeRow[];
}

export type AzureServiceHealthRange = "7d" | "30d" | "90d";

/** GET /api/v1/azure/service-health?range=7d|30d|90d (default 30d): this region's events, active first. */
export interface AzureServiceHealthResponse {
  events: ServiceEvent[];
  feed: FeedStatus;
}

/** GET /api/v1/azure/capacity?region=&size=, and OverviewResponse.capacity: can the next deploy get this size here? */
export interface CapacityCheck {
  region: string;
  size: string;
  /** Offered to this subscription in this region; null = not known yet. */
  available: boolean | null;
  /** Azure's restriction reason, e.g. NotAvailableForSubscription. */
  reason: string | null;
  /** vCPUs the deploy needs (the size's, plus 1 for the test VM); null until the SKU list is read. */
  vcpusNeeded: number | null;
  family: { name: string; used: number; limit: number } | null;
  total: { used: number; limit: number } | null;
  /** false: show the warning ("Deploy anyway"); true: fine; null: not known. */
  ok: boolean | null;
  /** The warning or the quiet line, in plain words (spec 10.2). */
  message: string | null;
  fetchedAt: string | null;
}

/** GET /api/v1/azure/price?region=&size=, and SettingsResponse.price. GBP per hour, Linux pay-as-you-go list prices. */
export interface PriceInfo {
  region: string;
  size: string;
  vmGbpPerHour: number | null;
  /** The E4 disk's monthly price / 730. */
  diskGbpPerHour: number | null;
  ipGbpPerHour: number | null;
  /** VM + disk + IP (azure), or the fixed hourly rate. */
  totalGbpPerHour: number | null;
  /** Disk + IP (azure), or the fixed standby rate. */
  standbyGbpPerHour: number | null;
  fetchedAt: string | null;
  /** An Azure price exists but is more than 7 days old. */
  stale: boolean;
  /** Where the totals come from. */
  source: "azure" | "fixed";
  /** Why the fixed rates apply, when they do; null otherwise. */
  reason: string | null;
}

/** GET and POST /api/v1/azure/bootlog: the VM's serial log, redacted, at most the last 64 KB. Never a URL. POST is limited to one a minute (429 slow_down). */
export interface BootLogResponse {
  fetchedAt: string | null;
  bytes: number;
  truncated: boolean;
  /** How many secrets were replaced with ‹redacted›. */
  redactions: number;
  text: string | null;
  /** Why there is no log: "Boot diagnostics turn on with the next deploy", "No VM", "Azure isn't connected...". */
  reason: string | null;
}

/** GET /api/v1/azure/diagnostics: each feed with its timing, and the metric names Azure emits (null until read). No secrets. */
export interface AzureDiagnosticsResponse {
  configured: boolean;
  feeds: (FeedStatus & { lastTryAt: string | null; nextDueAt: string | null })[];
  metricNames: { vm: string[] | null; pip: string[] | null };
}

// ── Labs (spec 2026-10-04-labs-design.md §7.2, §10; plan L0) ──────────────
// Every route sits behind the login and the same-origin check and reads D1,
// the KV records the lab watch and the orphan sweep leave, and the bundled
// catalogue; never Azure or the workflow host, except POST
// /labs/permissions/check and GET /labs/:id `resources` while a lab runs.
// "No data" is null, never 0. Times are ISO UTC. A body with a key the route
// does not take is refused (400 bad_input, `field` = that key).

export type LabSessionState = (typeof LAB_SESSION_STATES)[number];
export type LabPeering = (typeof LAB_PEERINGS)[number];
export type LabEndReason = (typeof LAB_END_REASONS)[number];
export type LabAction = (typeof LAB_ACTIONS)[number];
export type LabWarningKind = (typeof LAB_WARNING_KINDS)[number];

/**
 * One deploy-modal warning (§9.2). `overridable`: "Deploy anyway" is offered
 * (budget: send overBudgetOk; capacity: send capacityOk). pricey and slow are
 * information (overridable false, never blocking); unavailable blocks Deploy.
 */
export interface LabWarning {
  kind: LabWarningKind;
  message: string;
  overridable: boolean;
}

/** A lab run (lab_runs), without its secrets (token hash, admin password, payload). */
export interface LabRunRow {
  id: string;
  sessionId: string;
  labId: string;
  action: LabAction;
  /** queued | running | succeeded | failed | cancelled, as the gateway's runs. */
  status: string;
  requestedAt: string;
  requestedBy: string | null;
  reason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  githubRunUrl: string | null;
  error: string | null;
  /** Steps done of the steps this action runs (LAB_STEPS filtered by `on`), for "Deploying 3/16". Null before the first step. */
  step: { done: number; of: number; name: string | null } | null;
}

/** A session (lab_sessions), as every lab screen shows it. Never the admin password. */
export interface LabSession {
  id: string;
  labId: string;
  labVersion: number;
  /** The lab's title, or its id when it has left the catalogue. */
  title: string;
  state: LabSessionState;
  /** A release test (§11.2). */
  test: boolean;
  region: string;
  secondaryRegion: string | null;
  slot: number | null;
  cidr: string | null;
  peering: LabPeering;
  requestedAt: string;
  readyAt: string | null;
  endedAt: string | null;
  autoDestroyAt: string | null;
  maxUntil: string;
  estGbpH: number;
  /** £ so far: the estimate while live; once ended, the estimate until Azure has the day after it ended, then the actual (`costBasis`). */
  costGbp: number | null;
  costBasis: "estimate" | "actual";
  endReason: LabEndReason | null;
  note: string | null;
  /** The lab's Terraform outputs once ready (no secrets; users are names, not passwords). */
  outputs: { privateIps: Record<string, string>; connect: string[]; users: Record<string, string> } | null;
  /** What the clean check found left behind (ended_dirty), else null. */
  leftovers: string[] | null;
  /** The run in progress (deploy, destroy, peer, unpeer or test), else null. */
  activeRun: LabRunRow | null;
}

/** A release test (lab_release_tests). A version is released when its newest test has result "pass" (which needs clean). */
export interface LabReleaseTest {
  labId: string;
  version: number;
  at: string;
  runId: string;
  result: "pass" | "fail";
  clean: boolean;
  deploySeconds: number | null;
  destroySeconds: number | null;
  estGbp: number | null;
  leftovers: string[];
}

/** A catalogue card (GET /labs). */
export interface LabCard {
  id: string;
  number: number;
  version: number;
  title: string;
  summary: string;
  /** The primary exam (the id's prefix); the catalogue groups by it. */
  exam: LabExam;
  /** Every exam the lab belongs to, the primary first (ruling 39): LabDef.exams. */
  exams: LabExam[];
  skillAreas: string[];
  level: LabLevel;
  type: LabType;
  prerequisites: string[];
  peering: PeeringMode;
  /** £/h now (fresh retail prices where the lab has them, else authored): estimateGbpH. */
  estGbpH: number;
  /** costMarker(estGbpH, deploy_min). */
  marker: "£" | "££" | "£££";
  /** The item that makes it pricey, with its £/h; null when lab.yaml's pricey is null. */
  pricey: { item: string; gbpH: number } | null;
  timing: { deployMin: number; destroyMin: number; sessionH: number; maxH: number };
  /** The live session (deploying, running, failed or tearing_down), else null. */
  running: LabSession | null;
  lastSession: LabSession | null;
  /** Sessions of LAB_COVERAGE_MIN minutes or more, ever ("Ran 2×"). */
  runs: number;
  lastReleaseTest: LabReleaseTest | null;
  /** The current version has a passing release test; false shows "Untested v<version>". */
  released: boolean;
  /** Why Deploy is disabled (permissions, no free slot, labs_max_running); null when it can deploy. */
  unavailable: string | null;
  /**
   * Every reason Deploy would be refused before its confirmation (labs redesign spec §6.1), in
   * deployLab's order: github, role, graph, slots, max_running, leftovers, budget. [] when it can
   * deploy now. The app's readiness comes from these, never from raw permission flags.
   */
  blockers: LabBlocker[];
  /** The lab's learning content (labs/_learning/<id>.yaml), or null when it has none yet. */
  learning: LabLearning | null;
  /** Planned resources: TopoKind -> count, from the lab's planned diagram; null when it has none. */
  resources: Record<string, number> | null;
}

/** Why a lab cannot be deployed now (labs redesign spec §6.1). An app that meets a kind it does not know treats it as unavailable. */
export type LabBlockerKind = "github" | "role" | "graph" | "slots" | "max_running" | "leftovers" | "budget";
export interface LabBlocker {
  kind: LabBlockerKind;
  /** The sentence deployLab refuses with. */
  message: string;
}

/** A card's learning content (LabLearningDef in camelCase). */
export interface LabLearning {
  objective: string;
  learn: [string, string, string];
  /** Learning time in minutes (not deploy time, not session length). */
  learningMin: number;
}

/** Settings → Labs → Check permissions (§8.2): each null until checked. The Worker keeps it in KV `labs:permissions`. */
export interface LabPermissions {
  checkedAt: string | null;
  /** The governance custom role is assigned to the service principal. */
  role: boolean | null;
  /** Graph can read users (/users?$top=1). */
  users: boolean | null;
  /** Graph can read groups (/groups?$top=1). */
  groups: boolean | null;
  /** What failed, in plain words; null when all passed or never checked. */
  message: string | null;
}

/** Leftovers the hourly sweep found for one lab (§7.5). The Worker keeps the list in KV `labs:orphans` (LabOrphan[]). */
export interface LabOrphan {
  /** The catalogue id the names belong to (labIdFromName); null when it cannot be told. */
  labId: string | null;
  names: string[];
  /** First seen by the sweep. */
  since: string;
}

/** GET /api/v1/labs */
export interface LabsResponse {
  now: string;
  labs: LabCard[];
  /** Live sessions (deploying, running, failed, tearing_down), oldest first: the running strip. */
  running: LabSession[];
  slots: { used: number; total: number };
  maxRunning: number;
  permissions: LabPermissions;
  orphans: LabOrphan[];
  /**
   * The watchman tears labs down at their timer or hard stop by itself (the 5-minute cron dispatching
   * the lab workflow, which needs GitHub): canDispatch. "Auto-cleanup on" is shown only when true.
   */
  autoCleanup: boolean;
}

/** One priced line of GET /labs/:id. */
export interface LabCostLine extends LabCostItem {
  /** £/h for one, as used: the fresh retail price, else the authored gbp_h. */
  gbpH: number;
  source: "azure" | "authored";
  /** Seconds since the retail price was fetched; null for an authored price (none, or over 7 days old). */
  priceAge: number | null;
}

/** GET /api/v1/labs/:id (404 not_found for an id not in the catalogue). */
export interface LabDetail {
  card: LabCard;
  readme: ReadmeBlock[];
  /** Each item priced, and the £/h total (= card.estGbpH). */
  cost: { items: LabCostLine[]; gbpH: number };
  connectivity: LabDef["connectivity"];
  identity: LabDef["identity"];
  /** Warnings for a deploy now (§9.2); [] while a session is live. */
  warnings: LabWarning[];
  /** Deploy form defaults: region from Settings, the peer tick from labs_default_peering (forced on for required, false for off), hours = session_h. */
  defaults: { region: string; peer: boolean; hours: number };
  /** The gateway is running or in Standby, so peering can happen now (else "will peer when the gateway is next running"). */
  gatewayUp: boolean;
  session: LabSession | null;
  /** The live session's runs, newest first; [] with no live session. */
  runs: LabRunRow[];
  /** Resources in rg-lab-<id>* from ARM while running; null otherwise or when ARM did not answer. */
  resources: { name: string; type: string; group: string; state: string | null }[] | null;
  /** The portal page of rg-lab-<id> while a session is live, else null. */
  portalUrl: string | null;
}

/** POST /api/v1/labs/:id/deploy. 422 confirm_required for an unconfirmed budget or capacity warning; 409 while the lab's lock is held. */
export interface LabDeployBody {
  /** Whole hours, 1 to 12 and at most the lab's max_h. */
  hours: number;
  /** Peer to the gateway (ignored for peering off, forced for required). */
  peer: boolean;
  /** An Azure region name; default the Settings region. */
  region?: string;
  overBudgetOk?: boolean;
  capacityOk?: boolean;
}

/** POST /api/v1/labs/:id/extend: whole hours (1 to 12), or to max_until. Refused past max_until, saying until when. */
export type LabExtendBody = { hours: number } | { toMax: true };

/** POST /api/v1/labs/:id/destroy (also cancels a deploy in progress first). */
export interface LabDestroyBody {
  confirm: true;
}

/** PUT /api/v1/labs/sessions/:sid/note: at most LAB_NOTE_MAX (2000) characters; "" clears it. */
export interface LabNoteBody {
  note: string;
}

/** POST /api/v1/labs/orphans/cleanup: a destroy run for that lab id's leftovers (snake_case as in spec §7.2). */
export interface LabOrphanCleanupBody {
  lab_id: string;
}

/** GET /api/v1/labs/sessions?lab=&limit= (limit 1 to 200, default 50): newest first. */
export interface LabSessionsResponse {
  sessions: LabSession[];
}

/** One exam's coverage (GET /labs/coverage). A lab is "run" with a session of LAB_COVERAGE_MIN minutes or more. */
export interface LabCoverage {
  exam: LabExam;
  areas: { key: string; name: string; labs: { id: string; number: number; title: string; run: boolean }[]; run: number; available: number }[];
}

/**
 * GET /api/v1/labs/coverage: one entry per LAB_EXAMS member that has skill areas, in that order
 * (AZ-104, AZ-305, AZ-700). A lab counts under every area it names, so a lab tagged for another
 * exam (ruling 39) counts in each exam it belongs to; each area's labs go by number.
 */
export interface LabCoverageResponse {
  exams: LabCoverage[];
}

/** GET /api/v1/labs/:id/secret: only while the lab's session is running (else 409 not_running). Fetched on Show, never cached. */
export interface LabSecretResponse {
  adminPassword: string;
  /** Entra users the lab made: name -> user principal name (the lab's `users` output). */
  users: Record<string, string>;
}

/**
 * GET /api/v1/labs/:id/topology (lab topology spec §6.6): the running lab's live diagram from one Resource Graph
 * query of its own groups, cached 30 s. Always 200 with a status; anything but "ok" means the app shows the planned
 * graph with `message` as a banner. 404 not_found for an id outside the catalogue.
 */
export interface LabTopologyResponse {
  status: "ok" | "not_running" | "no_azure" | "failed" | "throttled";
  /** Plain words for the banner (null when ok). */
  message: string | null;
  live: TopologyGraph | null;
  fetchedAt: string | null;
  /** More than ARG_TOP rows: the first page only. */
  truncated: boolean;
}

/** POST /api/v1/labs/permissions/check */
export interface LabPermissionsCheckResponse extends ApiOk {
  permissions: LabPermissions;
}

/** One lab's spend this month (CostResponse.labs): Azure's actual so far plus live and not-yet-billed estimates. */
export interface LabCostRow {
  labId: string;
  title: string;
  /** From lab_cost_days; null when Azure has listed nothing for it this month. */
  actualGbp: number | null;
  /** Live sessions' cost so far, plus ended sessions Azure has not caught up with; null when none. */
  estimateGbp: number | null;
  totalGbp: number;
  sessions: number;
  running: boolean;
}

/** OverviewResponse.labs: what the banner, the topology and the runningLabs widget need. */
export interface LabsSummary {
  /** Live sessions, oldest first. Empty: the Overview looks exactly as before. */
  running: LabSession[];
  /** Σ estGbpH of `running`. */
  gbpH: number;
  /** Sessions with peering waiting or disconnected ("Re-peer N labs" once the gateway runs). */
  rePeer: number;
}

/** GET /api/v1/overview gains `labs`. */
export interface OverviewResponse {
  labs: LabsSummary;
}

/** GET /api/v1/cost gains `labs`: this month per lab, largest first; [] with none. */
export interface CostResponse {
  labs: LabCostRow[];
}

/** Settings → Labs (stored as labs_max_running and labs_default_peering; labsSettingsFrom in shared/labs.ts). */
export interface SettingsValues {
  /** 1 to 5, default 3. */
  labsMaxRunning: number;
  /** The Deploy form's "Peer to gateway" tick for optional labs; default on. */
  labsDefaultPeering: boolean;
}
