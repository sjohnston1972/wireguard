// Pure helpers for the Overview: words, sums and shapes from the /overview
// answer. Nothing here fetches or renders.

import type { OverviewResponse } from "@shared/api";
import type { Step as UiStep, StepState } from "@/components";
import type { Snapshot, Step } from "../../../../worker/src/state";
import { REGIONS } from "../../../../worker/src/region";

export type State = Snapshot["state"];

/**
 * The /overview answer with every field the view reads present. A partial
 * answer (an older Worker, a test's small fixture) is filled with empties,
 * never with invented values: no data stays "no data".
 */
export function normalise(o: OverviewResponse): OverviewResponse {
  const s = (o.snapshot ?? {}) as Partial<Snapshot>;
  const c = (o.config ?? {}) as Partial<OverviewResponse["config"]>;
  return {
    ...o,
    now: o.now ?? new Date().toISOString(),
    snapshot: {
      ...(s as Snapshot),
      state: (s.state ?? "destroyed") as State,
      steps: s.steps ?? [],
      latency: s.latency ?? {},
      traffic_hist: s.traffic_hist ?? [],
      run_id: s.run_id ?? null,
      since: s.since ?? null,
      log_tail: s.log_tail ?? null,
      error: s.error ?? null,
      agent: s.agent ?? null,
      azure: s.azure ?? null,
      selftest: s.selftest ?? null,
      last_agent_at: s.last_agent_at ?? null,
      speedtest_req: s.speedtest_req ?? null,
      region: s.region ?? null,
      vm_size: s.vm_size ?? null,
    },
    derived: { verifying: false, heartbeatStale: false, selftestFailures: [], clientsOnline: 0, clientsEnabled: 0, publicIp6: null, dnsParked: false, ...((o.derived ?? {}) as Partial<OverviewResponse["derived"]>) },
    config: { dnsName: "", port: 0, subnet: "", subnet6: "", loopbackIp: "", region: "", vmSize: "", vnetCidr: "", homeLanCidr: "", hourlyRateGbp: 0, standbyRateGbp: 0, autoDestroyDefaultHours: 0, expiryAction: "destroy", standbyMaxDays: 0, ...c },
    actions: o.actions ?? { canDispatch: false, lockHolder: null },
    near: o.near ?? { country: null, region: null },
    profiles: o.profiles ?? [],
    speedtests: o.speedtests ?? [],
    site: o.site ?? null,
    nextScheduledStart: o.nextScheduledStart ?? null,
    budget: o.budget ?? { budget: 0, actual: 0, session: 0, total: 0, pct: 0, level: "none", month: "", alerted: 0 },
    deployment: o.deployment ?? null,
    stateBackups: o.stateBackups ?? null,
    typicalSeconds: o.typicalSeconds ?? { deploy: null, destroy: null },
  };
}

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
