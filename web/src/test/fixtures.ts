import type { ActivityResponse, ClientsResponse, FirewallResponse, OverviewResponse, SessionResponse } from "@shared/api";

// Small, partial API answers for jsdom tests. They are cast: a test sets only
// what the code under test reads.

export const sessionFixture = (over: Partial<SessionResponse> = {}): SessionResponse => ({
  user: "dev@localhost",
  build: "test",
  now: "2026-10-02T12:00:00.000Z",
  setupMissing: {},
  notes: [],
  ...over,
});

export function overviewFixture(state = "running", over: { auto_destroy_at?: string | null; heartbeatStale?: boolean; region?: string } = {}): OverviewResponse {
  return {
    now: "2026-10-02T12:00:00.000Z",
    snapshot: { state, region: over.region ?? "uksouth", auto_destroy_at: over.auto_destroy_at ?? null, run_id: "r1" },
    derived: { heartbeatStale: over.heartbeatStale ?? false, verifying: false, selftestFailures: [], clientsOnline: 2, clientsEnabled: 3, publicIp6: null, dnsParked: false },
    config: { region: "uksouth" },
    deployment: null,
  } as unknown as OverviewResponse;
}

export const clientsFixture = (): ClientsResponse =>
  ({
    now: "2026-10-02T12:00:00.000Z",
    running: true,
    heartbeatAt: null,
    clients: [
      { id: 1, name: "Steven iPhone", ip: "10.13.13.2" },
      { id: 2, name: "Home site", ip: "10.13.13.3" },
    ],
  }) as unknown as ClientsResponse;

/** 24 hourly counts, oldest first; null for the hours the VM was not running (no data, not 0). */
const hourly = (scale: number, downFrom = 2, downTo = 5): (number | null)[] =>
  Array.from({ length: 24 }, (_, h) => (h >= downFrom && h < downTo ? null : ((h * 7) % 11) * scale));

export const firewallFixture = (): FirewallResponse =>
  ({
    now: "2026-10-02T12:00:00.000Z",
    rules: [
      { id: 7, name: "Allow DNS to resolver", place: 1, hits24h: 1240, trend24h: hourly(12), starter: true },
      { id: 8, name: "Block telemetry", place: 2, hits24h: null, trend24h: [], starter: false },
    ],
    defaultHits24h: 342,
    defaultTrend24h: hourly(3),
    drops: { recent: [], last24h: 342, uniqueSources24h: 18, previous24h: 305, hourly24h: hourly(3) },
  }) as unknown as FirewallResponse;

export const activityFixture = (): ActivityResponse =>
  ({
    range: "7d",
    now: "2026-10-02T12:00:00.000Z",
    runs: [{ id: "run-42", action: "apply", status: "success", requested_at: "2026-10-02T10:00:00.000Z" }],
    notes: [],
  }) as unknown as ActivityResponse;

/** The routes most shell tests need; spread and override per test. */
export const defaultRoutes = (): Record<string, unknown> => ({
  "GET /api/v1/session": sessionFixture(),
  "GET /api/v1/overview": overviewFixture(),
  "GET /api/v1/clients": clientsFixture(),
  "GET /api/v1/firewall": firewallFixture(),
  "GET /api/v1/activity": activityFixture(),
});
