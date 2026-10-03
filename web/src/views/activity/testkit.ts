import type { ActivityResponse, RunDetailResponse } from "@shared/api";
import type { ActivityKpis, EventType } from "../../../../worker/src/activity";

// Test data for the Activity view's tests (and nothing else imports this).
// Addresses are TEST-NET, the user is dev@localhost.

export const NOW = "2026-10-02T12:00:00.000Z";
const T = (hhmm: string, day = "02") => `2026-10-${day}T${hhmm}:00.000Z`;

export const kpis = (over: Partial<ActivityKpis> = {}): ActivityKpis => ({
  deploys: 4,
  medianDeploySeconds: 138,
  successRate: { success: 44, finished: 46, pct: 96 },
  failedRuns: 2,
  configChanges: 7,
  watchmanProblems: 1,
  ...over,
});

export const emptyKpis = (): ActivityKpis => ({
  deploys: 0,
  medianDeploySeconds: null,
  successRate: { success: 0, finished: 0, pct: null },
  failedRuns: 0,
  configChanges: 0,
  watchmanProblems: 0,
});

const zero = (): Record<EventType, number> => ({ deploy: 0, destroy: 0, failure: 0, config: 0, firewall: 0, watchman: 0 });

/** 28 six-hour buckets ending at NOW, with a few events in the last ones. */
export function timelineFixture(): ActivityResponse["timeline"] {
  const end = Date.parse(NOW);
  return Array.from({ length: 28 }, (_, i) => {
    const counts = zero();
    if (i === 20) counts.deploy = 2;
    if (i === 21) {
      counts.deploy = 1;
      counts.failure = 1;
    }
    if (i === 24) counts.destroy = 3;
    if (i === 26) counts.config = 2;
    return { start: new Date(end - (28 - i) * 6 * 3_600_000).toISOString(), counts };
  });
}

export const runRows = (): ActivityResponse["runs"] => [
  { id: "run-4", action: "apply", status: "running", requested_at: T("11:50"), requested_by: "dev@localhost", started_at: T("11:51"), finished_at: null, github_run_url: "https://github.example/runs/4", public_ip: null, reason: null, error: null, durationSeconds: null, sessionCostGbp: null, source: "dashboard" },
  { id: "run-3", action: "destroy", status: "success", requested_at: T("10:00"), requested_by: "dev@localhost", started_at: T("10:00"), finished_at: T("10:02"), github_run_url: "https://github.example/runs/3", public_ip: "203.0.113.7", reason: "auto-destroy", error: null, durationSeconds: 139, sessionCostGbp: null, source: "auto-destroy" },
  { id: "run-2", action: "apply", status: "success", requested_at: T("08:00"), requested_by: "dev@localhost", started_at: T("08:00"), finished_at: T("08:02"), github_run_url: "https://github.example/runs/2", public_ip: "203.0.113.7", reason: null, error: null, durationSeconds: 138, sessionCostGbp: 0.01, source: "dashboard" },
  { id: "run-1", action: "apply", status: "failure", requested_at: T("06:00", "01"), requested_by: "watchman", started_at: T("06:00", "01"), finished_at: T("06:04", "01"), github_run_url: null, public_ip: null, reason: null, error: "terraform apply failed", durationSeconds: 240, sessionCostGbp: null, source: "watchman" },
];

export const noteRows = (): ActivityResponse["notes"] => [
  { id: 11, at: T("09:30"), kind: "drift", message: "Firewall rules differ from the VM", run_id: null, acknowledged: 0 },
  { id: 10, at: T("05:00", "01"), kind: "unreachable", message: "No heartbeat for 10 minutes", run_id: null, acknowledged: 1 },
];

export const changeRows = (): ActivityResponse["changes"]["rows"] => [
  { id: 31, at: T("10:19"), user: "dev@localhost", action: "firewall.rule", target: "Allow DNS", before_json: JSON.stringify({ enabled: 1, port: "53" }), after_json: JSON.stringify({ enabled: 0, port: "53" }), lines: ["enabled: 1 → 0"] },
  { id: 30, at: T("10:17"), user: "dev@localhost", action: "settings.autoDestroy", target: "", before_json: null, after_json: JSON.stringify({ minutes: 30 }), lines: ["minutes = 30"] },
];

export function activityResponse(over: Partial<ActivityResponse> = {}): ActivityResponse {
  return {
    range: "7d",
    now: NOW,
    kpis: kpis(),
    previous: kpis({ deploys: 2, medianDeploySeconds: 180, successRate: { success: 9, finished: 10, pct: 90 }, failedRuns: 2, configChanges: 14, watchmanProblems: 0 }),
    timeline: timelineFixture(),
    runs: runRows(),
    notes: noteRows(),
    all: [
      { at: T("10:19"), type: "firewall", title: "firewall.rule", detail: "Allow DNS", ref: { kind: "change", id: 31 } },
      { at: T("10:17"), type: "config", title: "settings.autoDestroy", detail: null, ref: { kind: "change", id: 30 } },
      { at: T("10:02"), type: "destroy", title: "Torn down", detail: "auto-destroy", ref: { kind: "run", id: "run-3" } },
      { at: T("09:30"), type: "watchman", title: "drift", detail: "Firewall rules differ from the VM", ref: { kind: "note", id: 11 } },
      { at: T("08:02"), type: "deploy", title: "Deployed", detail: null, ref: { kind: "run", id: "run-2" } },
      { at: T("06:04", "01"), type: "failure", title: "Deploy failure", detail: "terraform apply failed", ref: { kind: "run", id: "run-1" } },
    ],
    changes: { rows: changeRows(), more: false, page: 1, kind: "", q: "" },
    ...over,
  };
}

export const emptyActivity = (): ActivityResponse =>
  activityResponse({
    kpis: emptyKpis(),
    previous: emptyKpis(),
    timeline: timelineFixture().map((b) => ({ ...b, counts: zero() })),
    runs: [],
    notes: [],
    all: [],
    changes: { rows: [], more: false, page: 1, kind: "", q: "" },
  });

export const steps = (): RunDetailResponse["steps"] => [
  { name: "Init", status: "completed", conclusion: "success", started_at: T("11:51"), completed_at: "2026-10-02T11:52:00.000Z" },
  { name: "Plan", status: "completed", conclusion: "success", started_at: "2026-10-02T11:52:00.000Z", completed_at: "2026-10-02T11:52:28.000Z" },
  { name: "Apply", status: "in_progress", conclusion: null, started_at: "2026-10-02T11:52:28.000Z", completed_at: null },
  { name: "Health check", status: "queued", conclusion: null },
];

export const runDetail = (id: string, over: Partial<RunDetailResponse> = {}): RunDetailResponse => {
  const run = runRows().find((r) => r.id === id) ?? runRows()[0];
  return { run, steps: steps(), active: run.status === "running", ...over };
};

export const LOG = [
  "2026-10-02T11:51:02.1234567Z [INFO] Applying Terraform configuration...",
  "2026-10-02T11:51:05.0000000Z [INFO] azurerm_public_ip.wg: Creating...",
  "2026-10-02T11:51:09.0000000Z [WARN] retrying after a slow response",
  "2026-10-02T11:51:12.0000000Z [ERROR] quota check failed for 203.0.113.9",
].join("\n");

/** The routes the Activity view reads; spread over renderApp's defaults. */
export const activityRoutes = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  "GET /api/v1/activity": activityResponse(),
  "GET /api/v1/runs/run-4": runDetail("run-4"),
  // Fresh: a live log last updated over 30 s ago reads "Stalled".
  "GET /api/v1/runs/run-4/log": { log: LOG, source: "live", active: true, updatedAt: new Date().toISOString() },
  "GET /api/v1/runs/run-3": runDetail("run-3", { active: false }),
  "GET /api/v1/runs/run-3/log": { log: LOG, source: "github", active: false, updatedAt: null },
  "GET /api/v1/runs/run-2": runDetail("run-2", { active: false }),
  "GET /api/v1/runs/run-2/log": { log: LOG, source: "github", active: false, updatedAt: null },
  "GET /api/v1/runs/run-1": runDetail("run-1", { active: false }),
  ...over,
});
