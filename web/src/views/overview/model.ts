// Pure helpers for the Overview: words, sums and shapes from the /overview
// answer. Nothing here fetches or renders.

import type { OverviewResponse } from "@shared/api";
import type { LogLevel, LogLine, Step as UiStep, StepState } from "@/components";
import type { Snapshot, Step } from "../../../../worker/src/state";
import { REGIONS } from "../../../../worker/src/region";

export type State = Snapshot["state"];

export const STATE_WORD: Record<State, string> = {
  running: "Running",
  deploying: "Deploying",
  destroying: "Tearing down",
  hibernating: "Hibernating",
  standby: "Standby",
  resuming: "Resuming",
  failed: "Failed",
  destroyed: "Destroyed",
};

export type Tone = "green" | "amber" | "red" | "grey";
export const STATE_TONE: Record<State, Tone> = {
  running: "green",
  deploying: "amber",
  destroying: "amber",
  hibernating: "amber",
  resuming: "amber",
  standby: "grey",
  failed: "red",
  destroyed: "grey",
};

/** A GitHub run is in progress (deploy or tear-down), so Cancel applies. */
export const inGithubRun = (state: State) => state === "deploying" || state === "destroying";
export const isBusy = (state: State) => state === "deploying" || state === "destroying" || state === "hibernating" || state === "resuming";

export const isDone = (s: Step) => s.status === "completed";

/** "6 of 12 steps completed" and the percentage; null when GitHub has listed no steps yet. */
export function stepProgress(steps: Step[]): { done: number; total: number; pct: number } | null {
  if (!steps.length) return null;
  const done = steps.filter(isDone).length;
  return { done, total: steps.length, pct: Math.round((done / steps.length) * 100) };
}

export function stepState(s: Step): StepState {
  if (s.status === "in_progress") return "running";
  if (s.status !== "completed") return "pending";
  if (s.conclusion === "failure" || s.conclusion === "cancelled" || s.conclusion === "timed_out") return "failed";
  if (s.conclusion === "skipped") return "skipped";
  return "done";
}

/** "12s", "1m 04s"; empty when the step has not finished (or never started). */
export function stepDuration(s: Step): string {
  if (!s.started_at || !s.completed_at) return "";
  const secs = Math.max(0, Math.round((Date.parse(s.completed_at) - Date.parse(s.started_at)) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}

/** "10:22:14" in UK time. */
export function clock(isoTime: string | null | undefined): string {
  if (!isoTime) return "";
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Europe/London" });
}

/** "10:22" in UK time. */
export function hhmm(isoTime: string | null | undefined): string {
  return clock(isoTime).slice(0, 5);
}

export function uiSteps(steps: Step[]): UiStep[] {
  return steps.map((s, i) => ({ id: String(i), label: s.name, state: stepState(s), duration: stepDuration(s), time: clock(s.started_at) }));
}

/** The first failed step, with its 1-based place. */
export function failedStep(steps: Step[]): { place: number; name: string } | null {
  const i = steps.findIndex((s) => stepState(s) === "failed");
  return i < 0 ? null : { place: i + 1, name: steps[i].name };
}

export function currentStep(steps: Step[]): Step | null {
  return steps.find((s) => s.status === "in_progress") ?? null;
}

/** "2m 28s", "45s", "1h 03m". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "usually about 4 min" from the median of recent runs; null when there is no history to judge by. Never a countdown. */
export function usually(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return "usually under a minute";
  return `usually about ${Math.round(seconds / 60)} min`;
}

export function gbp(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "no data";
  return `£${v.toFixed(digits)}`;
}

/** "UK South (London)" from the code; the code when unknown. */
export const regionFull = (code: string | null | undefined): string => (code ? REGIONS[code] ?? code : "");
/** "UK South" */
export const regionShort = (code: string | null | undefined): string => regionFull(code).replace(/\s*\(.*\)\s*$/, "");

const REGION_COUNTRY: Record<string, string> = {
  uksouth: "GB", ukwest: "GB", northeurope: "IE", westeurope: "NL", francecentral: "FR", germanywestcentral: "DE", switzerlandnorth: "CH",
  italynorth: "IT", spaincentral: "ES", norwayeast: "NO", swedencentral: "SE", polandcentral: "PL", eastus: "US", westus2: "US",
  canadacentral: "CA", mexicocentral: "MX", brazilsouth: "BR", uaenorth: "AE", southafricanorth: "ZA", centralindia: "IN",
  southeastasia: "SG", eastasia: "HK", japaneast: "JP", koreacentral: "KR", australiaeast: "AU",
};
/** "GB" for uksouth; null when unknown. */
export const regionCountry = (code: string | null | undefined): string | null => (code ? REGION_COUNTRY[code] ?? null : null);

/** Hours from now until midnight in London, to two places (the "until midnight" chip). */
export function hoursUntilMidnightLondon(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const left = 24 - h - m / 60;
  return Math.max(0.25, Math.round(left * 100) / 100);
}

/** Duration chips shared by Deploy, Resume and Extend. Value "0" is no limit. */
export function hourChoices(prefix = ""): { value: string; label: string }[] {
  return [
    ...[1, 2, 4, 8].map((h) => ({ value: String(h), label: `${prefix}${h}h` })),
    { value: "midnight", label: "until midnight" },
    { value: "0", label: "no limit" },
  ];
}

/** A chip value as the API's hours: a number, or null for no limit. */
export function chipHours(v: string): number | null {
  if (v === "midnight") return hoursUntilMidnightLondon();
  const n = Number(v);
  return n > 0 ? n : null;
}

/** The default duration chip: the configured auto-destroy hours when it is one of the chips, else 4h. */
export function defaultHoursChip(o: OverviewResponse): string {
  const h = o.config.autoDestroyDefaultHours;
  if (h === 0) return "0";
  return [1, 2, 4, 8].includes(h) ? String(h) : "4";
}

/** "3h 12m", "45m", "1d 2h", "under a minute". */
export function formatSpan(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "under a minute";
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Profiles other than the one running now (the Move choices). */
export function moveTargets(o: OverviewResponse) {
  const region = o.snapshot.region ?? o.config.region;
  const size = o.snapshot.vm_size ?? o.config.vmSize;
  return o.profiles.filter((p) => !(p.region === region && p.vm_size === size));
}

// ── Topology ──

export type NodeStatus = "healthy" | "degraded" | "down" | "unknown";
export const NODE_WORD: Record<NodeStatus, string> = { healthy: "Healthy", degraded: "Degraded", down: "Down", unknown: "Unknown" };
const RANK: Record<NodeStatus, number> = { healthy: 0, unknown: 1, degraded: 2, down: 3 };
export const worst = (...s: NodeStatus[]): NodeStatus => s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "healthy" as NodeStatus);

export interface NodeView {
  status: NodeStatus;
  /** The word shown with the colour (status word, or the state's when it explains better). */
  word: string;
  /** Why, in a few words (also part of the accessible name). */
  why: string;
}

export interface TopologyView {
  clients: NodeView;
  endpoint: NodeView;
  azure: NodeView;
  edges: [NodeStatus, NodeStatus];
  overall: NodeView;
}

export function topology(o: OverviewResponse): TopologyView {
  const s = o.snapshot;
  const d = o.derived;
  const running = s.state === "running";
  const stale = running && d.heartbeatStale;

  let clients: NodeView;
  if (!running) clients = { status: "unknown", word: NODE_WORD.unknown, why: "VM not running" };
  else if (stale) clients = { status: "unknown", word: NODE_WORD.unknown, why: "no recent heartbeat" };
  else if (d.clientsEnabled === 0) clients = { status: "unknown", word: NODE_WORD.unknown, why: "no clients configured" };
  else if (d.clientsOnline === 0) clients = { status: "degraded", word: NODE_WORD.degraded, why: "no client online" };
  else clients = { status: "healthy", word: NODE_WORD.healthy, why: `${d.clientsOnline} online` };

  let endpoint: NodeView;
  const problems: string[] = [];
  if (running) {
    if (!s.dns_live) problems.push("DNS does not point at the VM");
    if (d.selftestFailures.length) problems.push(`self-test: ${d.selftestFailures.join(", ")}`);
    if (s.agent && s.agent.listen_port === null) problems.push("WireGuard is not listening");
  }
  if (s.state === "failed") endpoint = { status: "down", word: "Failed", why: "the last run failed" };
  else if (!running) endpoint = { status: "unknown", word: s.state === "destroyed" ? "Not deployed" : STATE_WORD[s.state], why: STATE_WORD[s.state] };
  else if (stale || !s.last_agent_at) endpoint = { status: "down", word: NODE_WORD.down, why: "no heartbeat for over 2 minutes" };
  else if (problems.length) endpoint = { status: "degraded", word: NODE_WORD.degraded, why: problems.join("; ") };
  else endpoint = { status: "healthy", word: NODE_WORD.healthy, why: "heartbeat fresh" };

  let azure: NodeView;
  const az = s.azure;
  if (!az) azure = { status: "unknown", word: NODE_WORD.unknown, why: "not checked yet" };
  else if (az.error) azure = { status: "degraded", word: NODE_WORD.degraded, why: `check failed: ${az.error}` };
  else if (!az.exists) azure = { status: s.state === "destroyed" ? "unknown" : "degraded", word: s.state === "destroyed" ? "Empty" : NODE_WORD.degraded, why: "nothing in the resource group" };
  else if (s.state === "running") azure = { status: "healthy", word: "Online", why: `${az.resources.length} resources` };
  else if (s.state === "failed" || s.state === "destroyed") azure = { status: "degraded", word: "Leftovers", why: `${az.resources.length} resources still there` };
  else azure = { status: "unknown", word: STATE_WORD[s.state], why: `${az.resources.length} resources` };

  const edge1: NodeStatus = !running ? "unknown" : stale ? "down" : clients.status;
  const edge2: NodeStatus = !running ? "unknown" : endpoint.status;
  const known = (n: NodeStatus): NodeStatus => (n === "unknown" ? "healthy" : n);
  const overallStatus: NodeStatus = running ? worst(known(clients.status), endpoint.status, known(azure.status)) : s.state === "failed" ? "down" : "unknown";
  const overall: NodeView = { status: overallStatus, word: running || s.state === "failed" ? NODE_WORD[overallStatus] : STATE_WORD[s.state], why: "" };
  return { clients, endpoint, azure, edges: [edge1, edge2], overall };
}

// ── Metrics ──

export type MetricRange = "live" | "1h" | "24h" | "7d" | "30d";
export const RANGE_WORD: Record<MetricRange, string> = { live: "live", "1h": "last hour", "24h": "last 24 h", "7d": "last 7 days", "30d": "last 30 days" };
export const historyRange = (r: MetricRange): "1h" | "24h" | "7d" | "30d" => (r === "live" ? "1h" : r);

/** Mean of each client's latest round-trip time; null with none. */
export function latencyNow(lat: Record<string, number[]>): number | null {
  const last = Object.values(lat)
    .map((a) => a[a.length - 1])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!last.length) return null;
  return Math.round(last.reduce((a, b) => a + b, 0) / last.length);
}

/** The average across clients, sample by sample (aligned at the newest), for a sparkline. */
export function latencySeries(lat: Record<string, number[]>): number[] {
  const arrs = Object.values(lat).filter((a) => a.length);
  const n = Math.max(0, ...arrs.map((a) => a.length));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const vals = arrs.map((a) => a[a.length - n + i]).filter((v): v is number => typeof v === "number");
    if (vals.length) out.push(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return out;
}

export function peak(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
}

/** "1.2 KB/s" */
export function rate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return "no data";
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
}

// ── Run log ──

export interface ParsedLog {
  lines: LogLine[];
  /** Where GitHub marks a group ("##[group]Title"): the title and the line it starts at. */
  groups: { title: string; index: number }[];
}

const LEVELS = new Set(["INFO", "WARN", "ERROR", "DEBUG"]);

/**
 * A run's log as LogView lines. GitHub's markers become levels
 * ("##[error]" ERROR, "##[warning]" WARN) and group titles; the dev
 * seed's "10:24:27 INFO text" lines keep their time and level.
 */
export function parseLog(text: string | null | undefined): ParsedLog {
  const lines: LogLine[] = [];
  const groups: ParsedLog["groups"] = [];
  if (!text) return { lines, groups };
  for (const raw of text.split("\n")) {
    const l = raw.replace(/\r$/, "");
    if (!l.trim() || l.startsWith("##[endgroup]")) continue;
    const id = String(lines.length);
    const marker = /^##\[(group|error|warning|debug|notice|command)\](.*)$/.exec(l);
    if (marker) {
      const [, kind, rest] = marker;
      if (kind === "group") {
        groups.push({ title: rest.trim(), index: lines.length });
        lines.push({ id, level: "INFO", text: `▸ ${rest.trim()}` });
      } else lines.push({ id, level: kind === "error" ? "ERROR" : kind === "warning" ? "WARN" : kind === "debug" ? "DEBUG" : "INFO", text: rest });
      continue;
    }
    const seeded = /^(\d{2}:\d{2}:\d{2}) (INFO|WARN|ERROR|DEBUG) (.*)$/.exec(l);
    if (seeded && LEVELS.has(seeded[2])) {
      lines.push({ id, time: seeded[1], level: seeded[2] as LogLevel, text: seeded[3] });
      continue;
    }
    lines.push({ id, level: /^error\b/i.test(l.trim()) ? "ERROR" : "INFO", text: l });
  }
  return { lines, groups };
}

/** The log line a step's output starts at: its GitHub group by name, else by order, else by time. Null when unknown. */
export function stepLine(steps: Step[], i: number, log: ParsedLog): number | null {
  const name = steps[i]?.name.toLowerCase();
  if (!name) return null;
  const byName = log.groups.find((g) => g.title.toLowerCase() === name) ?? log.groups.find((g) => g.title.toLowerCase().includes(name) || name.includes(g.title.toLowerCase()));
  if (byName) return byName.index;
  if (log.groups.length === steps.length) return log.groups[i].index;
  const start = steps[i].started_at?.slice(11, 19);
  if (start) {
    const at = log.lines.findIndex((l) => l.time !== undefined && l.time >= start);
    if (at >= 0) return at;
  }
  return null;
}

export type StepFilter = "all" | "running" | "done" | "pending";
export function stepMatches(s: Step, f: StepFilter): boolean {
  if (f === "all") return true;
  if (f === "running") return s.status === "in_progress";
  if (f === "done") return s.status === "completed";
  return s.status !== "completed" && s.status !== "in_progress";
}

/** "3 s ago" from two times; null when `at` is missing. */
export function ageOf(at: string | null | undefined, now: number): string | null {
  if (!at) return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
