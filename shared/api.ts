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
import type { ClientHistory, VmHistory } from "../worker/src/history";
import type { RuleHistory } from "../worker/src/history";
import type { ActivityEvent, ActivityKpis, ActivityRange, EventType, RunRow } from "../worker/src/activity";
import type { RotationStatus } from "../worker/src/keyrotation";
import type { BackupStatus, ExportTable } from "../worker/src/backup";

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
  log: string;
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

// ── Firewall history ──

/** GET /api/v1/history?scope=rule&id=<counter key>&range= (the key is "r<id>", "default" or "f<id>") */
export type RuleHistoryResponse = RuleHistory;

/** Hit history added to each row of GET /firewall `rules` (merged into FirewallRuleRow). */
export interface FirewallRuleRow {
  /** Packets matched in the last 24 hours, or null when no hit history has been recorded at all yet. */
  hits24h: number | null;
  /** Packets per hour over the last 24 hours, oldest first; always 24 numbers (all zero when there is no history). */
  trend24h: number[];
  /** True when this is one of the rules a fresh install starts with (same name and ends). */
  starter: boolean;
}

/** Hit history for the default action, added to GET /firewall (merged into FirewallResponse). */
export interface FirewallResponse {
  defaultHits24h: number | null;
  defaultTrend24h: number[];
}

/** What `drops` in GET /firewall gains: statistics over the last 24 hours. */
export interface FirewallDropStats {
  /** Different source addresses that were dropped. */
  uniqueSources24h: number;
  /** Total drops in the 24 hours before the last 24, for the "vs the day before" figure. */
  previous24h: number;
  /** Drops per hour over the last 24 hours, oldest first; always 24 numbers. */
  hourly24h: number[];
}

/** GET /api/v1/activity gains `previous` (merged into ActivityResponse). */
export interface ActivityResponse {
  /** The same figures for the equally long period just before the selected range. */
  previous: ActivityKpis;
}
