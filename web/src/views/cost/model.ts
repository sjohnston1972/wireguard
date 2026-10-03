import type { CostResponse } from "@shared/api";
import type { Bar } from "@/components";
import { thresholdTone } from "@shared/widgets";

// Pure helpers for the Cost view. Days are UTC strings ("2026-10-02"); money is GBP.

export type CostRange = CostResponse["range"];

export const RANGE_OPTIONS: { value: CostRange; label: string }[] = [
  { value: "month", label: "This month" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

export const parseRange = (v: string | null): CostRange => (v === "7d" || v === "30d" ? v : "month");

/** £0.50, or £0.003 for the small figures a one-hour session has. */
export function gbp(n: number): string {
  const a = Math.abs(n);
  return `£${n.toFixed(a > 0 && a < 0.1 ? 3 : 2)}`;
}

/** "<1%" for a sliver, otherwise a whole number. */
export function pctText(p: number): string {
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-03" -> "3 Sep". */
export function dayLabel(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

/** "2026-10-02T09:41:00Z" -> "2 Oct, 09:41" (UTC, as the cost days are). */
export function startedLabel(iso: string): string {
  return `${dayLabel(iso.slice(0, 10))}, ${iso.slice(11, 16)}`;
}

/** 8400 -> "2h 20m", 727 -> "12m 7s", 0 -> "0s". */
export function durationLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utcDay = (now: string) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const span = (from: number, to: number): string[] => {
  const out: string[] = [];
  for (let t = from; t <= to; t += DAY_MS) out.push(iso(t));
  return out;
};

/** The days a range covers and the same-sized stretch before it (the Worker's costWindow, as day lists). */
export function windowDays(range: CostRange, now: string): { days: string[]; prev: string[] } {
  const today = utcDay(now);
  const d = new Date(today);
  if (range === "month") {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const prevEnd = Date.UTC(y, m, 0);
    return { days: span(Date.UTC(y, m, 1), today), prev: span(Date.UTC(y, m - 1, 1), Math.min(Date.UTC(y, m - 1, d.getUTCDate()), prevEnd)) };
  }
  const n = range === "7d" ? 7 : 30;
  const from = today - (n - 1) * DAY_MS;
  return { days: span(from, today), prev: span(from - n * DAY_MS, from - DAY_MS) };
}

const daysInMonth = (now: string) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
};

export interface SpendSeries {
  bars: Bar[];
  /** Same length as bars: the previous period, null where Azure listed no day. */
  previous: Array<number | null>;
  forecast: Bar[];
  /** The monthly budget spread over the month's days, or undefined with no budget. */
  budgetPerDay: number | undefined;
}

/** Daily actuals for every day of the range (a day Azure has not listed is a gap), the previous period, and the projection's pace to month end. */
export function spendSeries(c: CostResponse): SpendSeries {
  const { days, prev } = windowDays(c.range, c.now);
  const got = new Map(c.daily.map((d) => [d.day, d.gbp]));
  const before = new Map(c.previous.map((d) => [d.day, d.gbp]));
  const bars = days.map((d) => ({ label: dayLabel(d), value: got.has(d) ? got.get(d)! : null }));
  const previous = days.map((_, i) => (prev[i] !== undefined && before.has(prev[i]) ? before.get(prev[i])! : null));
  let forecast: Bar[] = [];
  if (c.range === "month" && c.projection) {
    const perDay = c.projection.gbp / daysInMonth(c.now);
    const last = utcDay(c.now);
    const end = Date.UTC(new Date(last).getUTCFullYear(), new Date(last).getUTCMonth() + 1, 0);
    forecast = span(last + DAY_MS, end).map((d) => ({ label: dayLabel(d), value: perDay }));
  }
  return { bars, previous, forecast, budgetPerDay: c.budget.budget > 0 ? c.budget.budget / daysInMonth(c.now) : undefined };
}

/** This month's running total by day (month range only): null for days Azure has not reported, and a straight pace line to month end. */
export function cumulativeSeries(c: CostResponse): { bars: Bar[]; forecast: Bar[] } | null {
  if (c.range !== "month" || c.daily.length === 0) return null;
  const { days } = windowDays("month", c.now);
  const got = new Map(c.daily.map((d) => [d.day, d.gbp]));
  const lastKnown = Math.max(...c.daily.map((d) => days.indexOf(d.day)));
  let sum = 0;
  const bars: Bar[] = days.map((d, i) => {
    sum += got.get(d) ?? 0;
    return { label: dayLabel(d), value: i <= lastKnown ? sum : null };
  });
  let forecast: Bar[] = [];
  if (c.projection) {
    const total = daysInMonth(c.now);
    const perDay = c.projection.gbp / total;
    const t = new Date(utcDay(c.now));
    const rest = span(utcDay(c.now) + DAY_MS, Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), total));
    const ahead = [...days.slice(lastKnown + 1), ...rest];
    forecast = ahead.map((d, k) => ({ label: dayLabel(d), value: sum + perDay * (k + 1) }));
  }
  return { bars, forecast };
}

/** Whether any actual figure exists to show; false means "no data", never £0. */
export const hasActuals = (c: CostResponse): boolean => c.meta.asOfDay !== null || c.daily.length > 0 || c.monthToDate > 0;

/** Percentage change of the range against the previous one, or null when either side has no days. */
export function changeVsPrevious(c: CostResponse): number | null {
  if (!c.daily.length || !c.previous.length) return null;
  const now = c.daily.reduce((s, d) => s + d.gbp, 0);
  const before = c.previous.reduce((s, d) => s + d.gbp, 0);
  return before > 0 ? ((now - before) / before) * 100 : null;
}

export const TYPE_LABEL: Record<"compute" | "network" | "disk" | "other", string> = {
  compute: "Compute (VM)",
  network: "Network (egress)",
  disk: "Disk (managed)",
  other: "Other",
};

export type Level = "ok" | "warn" | "bad";

/**
 * The forecast as a share of the budget, as a tone; null with no projection or
 * no budget. Today's pill says "Over budget" only when the projection is above
 * the budget, so exactly 100 % stays on track.
 */
export function forecastLevel(projectionGbp: number | null | undefined, budgetGbp: number, thr: { warn: number | null; bad: number | null }): Level | null {
  if (projectionGbp === null || projectionGbp === undefined || !(budgetGbp > 0)) return null;
  const pct = Math.round((projectionGbp / budgetGbp) * 10000) / 100;
  return thresholdTone(pct, pct === 100 && thr.bad === 100 ? { warn: thr.warn, bad: null } : thr, "above");
}
