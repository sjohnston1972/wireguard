// shared/api.ts
//
// Plain English: the shapes of the dashboard's data API (/api/v1), shared by
// the Worker that answers and the app (web/) that asks, so both sides agree
// on every field. Types only: nothing here runs.

import type { Alert, AuditEntry, Peer, Profile, SpeedTest } from "../worker/src/db";
import type { Snapshot, Talker } from "../worker/src/state";
import type { ClientView, ClientKpis } from "../worker/src/clients";
import type { BudgetStatus } from "../worker/src/budget";
import type { VmHistory, ClientHistory } from "../worker/src/history";
import type { Schedule } from "../worker/src/db";
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
