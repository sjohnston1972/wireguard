import type { ActivityResponse, RunDetailResponse } from "@shared/api";
import type { ActivityKpis, ActivityRange, EventType } from "../../../../worker/src/activity";
import type { Delta, StepState, PillStatus, Tone } from "@/components";

// The Activity view's plain logic: wording, time formatting, the "vs previous
// period" figures, the brush window and the run log. No React in here.

export type Tab = "runs" | "all" | "changes" | "notes";
export const TABS: { value: Tab; label: string }[] = [
  { value: "runs", label: "Runs" },
  { value: "all", label: "All activity" },
  { value: "changes", label: "Config changes" },
  { value: "notes", label: "Watchman notes" },
];
export const DEFAULT_TAB: Tab = "runs";
export const DEFAULT_RANGE: ActivityRange = "7d";

export const RANGES: { value: ActivityRange; label: string; long: string }[] = [
  { value: "1h", label: "Last hour", long: "hour" },
  { value: "6h", label: "Last 6 hours", long: "6 hours" },
  { value: "24h", label: "Last 24 hours", long: "24 hours" },
  { value: "7d", label: "Last 7 days", long: "7 days" },
  { value: "30d", label: "Last 30 days", long: "30 days" },
];

export const isRange = (v: string | null): v is ActivityRange => RANGES.some((r) => r.value === v);
export const isTab = (v: string | null): v is Tab => TABS.some((t) => t.value === v);

export const RANGE_MS: Record<ActivityRange, number> = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };

// ── Time and numbers ──

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "02 Oct, 10:22" in the viewer's time zone. */
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "10:24:27". */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "just now", "5m ago", "3h ago", "2d ago": how long before `nowMs` the moment was. */
export function fmtRelative(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** 138 -> "2m 18s", 45 -> "45s", 3840 -> "1h 4m". null stays null (the caller says "no data"). */
export function fmtDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** £1.20, £0.013: precision grows for small amounts. */
export function fmtGbp(v: number): string {
  return `£${v >= 0.1 ? v.toFixed(2) : v.toFixed(3)}`;
}

// ── "vs previous period" ──

/**
 * The change against the previous period as a tile delta, whenever the
 * previous period has a value: a percentage, "+n" from zero (no percentage of
 * nothing), or "same as previous period". No previous value, no delta.
 */
export function percentDelta(cur: number | null, prev: number | null, goodWhen: "up" | "down" | null): Delta | undefined {
  if (cur === null || prev === null) return undefined;
  const pct = prev === 0 ? null : Math.round((Math.abs(cur - prev) / prev) * 100);
  if (cur === prev || pct === 0) return { text: "same as previous period", direction: "flat", good: null };
  const direction = cur > prev ? "up" : "down";
  const good = goodWhen === null ? null : goodWhen === direction;
  if (pct === null) return { text: `+${cur} vs previous period`, direction, good };
  return { text: `${pct}% vs previous period`, direction, good };
}

/** Change in percentage points (success rate). */
export function pointsDelta(cur: number | null, prev: number | null): Delta | undefined {
  if (cur === null || prev === null) return undefined;
  if (cur === prev) return { text: "same as previous period", direction: "flat", good: null };
  return { text: `${Math.abs(cur - prev)} pts vs previous period`, direction: cur > prev ? "up" : "down", good: cur > prev };
}

export interface KpiView {
  deploys: { value: number; delta?: Delta };
  median: { value: string | null; delta?: Delta };
  success: { pct: number | null; success: number; finished: number; delta?: Delta };
  failed: { value: number; rate: number | null; delta?: Delta };
  changes: { value: number; delta?: Delta };
  watchman: { value: number; delta?: Delta };
}

export function kpiView(k: ActivityKpis, prev: ActivityKpis | undefined): KpiView {
  const p = prev;
  return {
    deploys: { value: k.deploys, delta: percentDelta(k.deploys, p?.deploys ?? null, null) },
    median: { value: fmtDuration(k.medianDeploySeconds), delta: percentDelta(k.medianDeploySeconds, p?.medianDeploySeconds ?? null, "down") },
    success: { pct: k.successRate.pct, success: k.successRate.success, finished: k.successRate.finished, delta: pointsDelta(k.successRate.pct, p?.successRate.pct ?? null) },
    failed: { value: k.failedRuns, rate: k.successRate.finished ? Math.round((k.failedRuns / k.successRate.finished) * 100) : null, delta: percentDelta(k.failedRuns, p?.failedRuns ?? null, "down") },
    changes: { value: k.configChanges, delta: percentDelta(k.configChanges, p?.configChanges ?? null, null) },
    watchman: { value: k.watchmanProblems, delta: percentDelta(k.watchmanProblems, p?.watchmanProblems ?? null, "down") },
  };
}

// ── Words ──

export type RunRow = ActivityResponse["runs"][number];
export type Change = ActivityResponse["changes"]["rows"][number];
export type Note = ActivityResponse["notes"][number];
export type EventRow = ActivityResponse["all"][number];

export const actionWord = (a: RunRow["action"]) => (a === "apply" ? "Deploy" : "Tear down");

const LAB_ACTION_WORD = { deploy: "Deploy lab", destroy: "Tear down lab", peer: "Peer lab", unpeer: "Unpeer lab", test: "Release test" } as const;
/** A run's action in words: a lab run says its own action ("Deploy lab"); `action` stays apply or destroy for the gateway-only views. */
export const runWord = (r: Pick<RunRow, "action" | "lab">) => (r.lab ? LAB_ACTION_WORD[r.lab.action] : actionWord(r.action));

/** The result pill for a run: a status, always with its word. */
export function resultPill(status: RunRow["status"]): { status: PillStatus; label: string } {
  switch (status) {
    case "success":
      return { status: "success", label: "Success" };
    case "failure":
      return { status: "failure", label: "Failed" };
    case "running":
      return { status: "running", label: "Running" };
    case "queued":
      return { status: "pending", label: "Queued" };
    default:
      return { status: "unknown", label: "Cancelled" };
  }
}

export const EVENT_TYPES: { value: EventType; label: string; tone: Tone }[] = [
  { value: "deploy", label: "Deploy", tone: "green" },
  { value: "destroy", label: "Tear down", tone: "blue" },
  { value: "failure", label: "Failure", tone: "red" },
  { value: "config", label: "Config", tone: "purple" },
  { value: "firewall", label: "Firewall", tone: "amber" },
  { value: "watchman", label: "Watchman", tone: "grey" },
];
export const typeInfo = (t: EventType) => EVENT_TYPES.find((e) => e.value === t)!;

/** "firewall.counters.clear" read as a sentence stays as the code; the notes kind reads as words. */
export const noteKind = (kind: string) => kind.replace(/_/g, " ");

// ── The brush window ──

export interface Window {
  from: number;
  to: number;
}

/** The brushed buckets as a time window [from, to) in epoch ms. */
export function windowOf(timeline: ActivityResponse["timeline"], range: ActivityRange, brush: { from: number; to: number }): Window | null {
  const a = timeline[brush.from];
  const b = timeline[brush.to];
  if (!a || !b) return null;
  const step = timeline.length > 1 ? Date.parse(timeline[1].start) - Date.parse(timeline[0].start) : RANGE_MS[range];
  return { from: Date.parse(a.start), to: Date.parse(b.start) + step };
}

export const inWindow = (iso: string, w: Window | null): boolean => {
  if (!w) return true;
  const t = Date.parse(iso);
  return t >= w.from && t < w.to;
};

/** "23 Sep 14:00 – 16:00" style label for the window. */
export function windowLabel(w: Window): string {
  return `${fmtWhen(new Date(w.from).toISOString())} to ${fmtWhen(new Date(w.to).toISOString())}`;
}

/** Bucket label for the timeline axis and tooltip. */
export function bucketLabel(iso: string, range: ActivityRange): string {
  const d = new Date(iso);
  if (range === "1h" || range === "6h" || range === "24h") return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (range === "7d") return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:00`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// ── Steps ──

export type ApiStep = RunDetailResponse["steps"][number];

/** A step's state; `active` false (the run is over): a step that never finished was not run, never "running". */
export function stepState(s: ApiStep, active = true): StepState {
  if (s.status !== "completed" && !active) return "notrun";
  if (s.status === "completed") {
    if (s.conclusion === "success") return "done";
    if (s.conclusion === "failure") return "failed";
    return "skipped"; // skipped or cancelled
  }
  if (s.status === "in_progress") return "running";
  return "pending";
}

export function stepSeconds(s: ApiStep): number | null {
  if (!s.started_at || !s.completed_at) return null;
  const v = (Date.parse(s.completed_at) - Date.parse(s.started_at)) / 1000;
  return Number.isFinite(v) && v >= 0 ? v : null;
}

// ── Change drawer ──

/** One side of a change as `key: value` lines (a plain value as one line). */
export function jsonLines(json: string | null): string[] {
  if (json === null) return [];
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [json];
  }
  const fmt = (x: unknown) => (x === null || x === undefined ? "none" : typeof x === "string" ? (x === "" ? "blank" : x) : JSON.stringify(x));
  if (v && typeof v === "object" && !Array.isArray(v)) return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${fmt(x)}`);
  return [fmt(v)];
}
