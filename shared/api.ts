// shared/api.ts
//
// Plain English: the shapes of the dashboard's data API (/api/v1), shared by
// the Worker that answers and the app (web/) that asks, so both sides agree
// on every field. Types only: nothing here runs.

import type { Alert, AuditEntry, Capture, Peer, Profile, SpeedTest } from "../worker/src/db";
import type { FwRule, Forward, Zone } from "../worker/src/firewall";
import type { PolicyState } from "../worker/src/fwview";
import type { Snapshot, Talker } from "../worker/src/state";
import type { ClientView, ClientKpis } from "../worker/src/clients";
import type { BudgetStatus } from "../worker/src/budget";
import type { VmHistory, ClientHistory } from "../worker/src/history";

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
  drops: { recent: { at: string; src: string; dst: string; proto: string; dport: number | null; fromName: string; toName: string }[]; last24h: number };
  zones: { zone: Zone; label: string; v4: string[]; v6: string[]; negate: boolean }[];
  testVm: { ip: string | null; enabled: boolean };
  forwards: (Forward & { connections: [number, number] | null; lastHit: string | null })[];
  captures: Capture[];
  capture: { busy: boolean; ifaces: Record<string, string> };
  publicIp: string | null;
  dnsName: string;
  kpis: { rules: number; enabled: number; defaultAction: "deny" | "allow"; drops24h: number; published: number; captureBusy: boolean };
}
