import type { CostResponse } from "@shared/api";

// Test data for the Cost view's tests (and nothing else). Hosts and users are
// the usual placeholders; money is GBP and days are UTC, as the API says.

const sessions: CostResponse["sessions"] = [
  { runId: "run-3", started: "2026-10-02T09:41:00.000Z", ended: null, durationSeconds: 8400, region: "uksouth", vmSize: "Standard_B1s", estimatedGbp: 0.2, perHourGbp: 0.0144, stillRunning: true },
  { runId: "run-2", started: "2026-09-26T13:34:00.000Z", ended: "2026-09-26T13:46:00.000Z", durationSeconds: 727, region: "northeurope", vmSize: "Standard_B1s", estimatedGbp: 0.003, perHourGbp: 0.0144, stillRunning: false },
  { runId: "run-1", started: "2026-09-25T10:52:00.000Z", ended: "2026-09-25T14:52:00.000Z", durationSeconds: 14400, region: "uksouth", vmSize: "Standard_B2s", estimatedGbp: 0.063, perHourGbp: 0.0158, stillRunning: false },
];

/** A month with one reported day, an Azure split, three sessions (one running) and an idle VM. */
export function costFixture(over: Partial<CostResponse> = {}): CostResponse {
  return {
    now: "2026-10-02T12:00:00.000Z",
    range: "month",
    meta: { currency: "GBP", timezone: "UTC", azureLagHours: 24, hourlyRateGbp: 0.0144, standbyRateGbp: 0.002, asOfDay: "2026-10-01" },
    session: { running: true, since: "2026-10-02T09:41:00.000Z", estimateGbp: 0.2 },
    standby: null,
    monthToDate: 0.3,
    projection: { gbp: 9.3, basis: "£0.30 over the 1 day Azure has reported so far this month, carried on at the same pace to all 31 days." },
    budget: { budget: 10, actual: 0.3, session: 0.2, total: 0.5, pct: 5, level: "ok", month: "2026-10", alerted: 0 },
    daily: [{ day: "2026-10-01", gbp: 0.3, fetched_at: "2026-10-02T03:00:00.000Z" }],
    previous: [
      { day: "2026-09-01", gbp: 0.1, fetched_at: "2026-10-01T03:00:00.000Z" },
      { day: "2026-09-02", gbp: 0.2, fetched_at: "2026-10-01T03:00:00.000Z" },
    ],
    sessions,
    insights: ["Standby costs about £0.05 a day for the disk and address."],
    breakdown: {
      byType: [
        { type: "compute", gbp: 0.18, pct: 60 },
        { type: "network", gbp: 0.07, pct: 23.3 },
        { type: "disk", gbp: 0.05, pct: 16.7 },
      ],
      byRegion: [
        { location: "uksouth", name: "UK South (London)", gbp: 0.24, pct: 80 },
        { location: "northeurope", name: "North Europe (Dublin)", gbp: 0.06, pct: 20 },
      ],
      basis: "azure",
      asOfDay: "2026-10-01",
    },
    ...over,
  } as CostResponse;
}

/** Nothing from Azure, nothing run: every figure is unknown, not zero. */
export function emptyCostFixture(over: Partial<CostResponse> = {}): CostResponse {
  return costFixture({
    meta: { currency: "GBP", timezone: "UTC", azureLagHours: 24, hourlyRateGbp: 0.0144, standbyRateGbp: 0.002, asOfDay: null },
    session: { running: false, since: null, estimateGbp: null },
    monthToDate: 0,
    projection: null,
    budget: { budget: 0, actual: 0, session: 0, total: 0, pct: 0, level: "none", month: "2026-10", alerted: 0 },
    daily: [],
    previous: [],
    sessions: [],
    insights: [],
    breakdown: null,
    ...over,
  });
}
