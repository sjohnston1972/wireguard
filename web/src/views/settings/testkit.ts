import type { OverviewResponse, SettingsResponse } from "@shared/api";
import { overviewFixture } from "@/test/fixtures";

// Test-only answers for the Settings view (kept in the view's folder: the
// shared fixtures file is frozen). Partial, cast like the shared fixtures.

const PUB = "wqbe4S5UsZoeFARHVLSAR2KHjCU3DJ3Mc6iXQ+3yc=";

export function settingsFixture(over: Partial<SettingsResponse> = {}): SettingsResponse {
  return {
    values: {
      region: "uksouth",
      vmSize: "Standard_B1s",
      testVm: false,
      autoDestroyDefaultHours: 4,
      expiryAction: "destroy",
      standbyMaxDays: 7,
      idleDestroyMinutes: 0,
      monthlyBudgetGbp: 10,
      hourlyRateGbp: 0.0157,
      standbyRateGbp: 0.0064,
      sshAllowedCidr: "",
      firewallDefault: "deny",
    },
    overrides: {},
    overridable: [],
    regions: { uksouth: "UK South (London)", westeurope: "West Europe (Netherlands)" },
    vmSizes: ["Standard_B1s", "Standard_B2s"],
    profiles: [
      { id: 1, name: "Usual settings", region: "uksouth", vm_size: "Standard_B1s", sort: 1, deployed: true },
      { id: 2, name: "EU exit (Amsterdam)", region: "westeurope", vm_size: "Standard_B1s", sort: 2, deployed: false },
    ],
    schedules: [{ id: 7, days: "12345", start_time: "08:00", end_time: "18:00", profile_id: 1, enabled: 1, created_at: "2026-09-01T10:00:00.000Z", daysText: "Mon–Fri", profileName: "Usual settings" }],
    nextScheduledStart: "tomorrow 08:00",
    setup: [{ group: "DNS verification", missing: ["CLOUDFLARE_ZONE_ID"] }],
    phones: [{ id: 3, label: "Android phone (app)", created_at: "2026-09-20T10:00:00.000Z", last_ok: "2026-10-01T10:00:00.000Z", last_error: null }],
    webhook: false,
    repo: "example/wg",
    key: { publicKey: PUB, short: "wqbe4S5U…3yc=", rotation: { changedAt: null, previous: null, vmKey: null, clients: [] } },
    backups: {
      state: { count: 3, newest: "2026-10-01T03:00:00.000Z" },
      config: { count: 2, newest: "2026-10-01T03:00:00.000Z", days: ["2026-10-01", "2026-09-30"] },
      checked_at: "2026-10-02T11:59:00.000Z",
    },
    lock: { held: false, runId: null, since: null },
    vapidPublic: "BPUBLICKEY",
    notifyError: null,
    publicUrl: "https://wg.example.net",
    ...over,
  } as unknown as SettingsResponse;
}

/** A running overview with the numbers Settings reads (rates, budget, a self-test). */
export function runningOverview(over: { selftestAt?: string | null; selftestReqAt?: string | null; state?: string } = {}): OverviewResponse {
  const o = overviewFixture(over.state ?? "running") as unknown as Record<string, any>;
  o.snapshot.selftest = over.selftestAt ? { at: over.selftestAt, ms: 4200, handshake: true, tunnel: true, loopback: true, dns: true, internet: true, internet6: null } : null;
  o.snapshot.selftest_req = over.selftestReqAt ? { id: "abc", at: over.selftestReqAt } : null;
  o.snapshot.vm_size = "Standard_B1s";
  o.snapshot.profile = "Usual settings";
  o.snapshot.last_agent_at = "2026-10-02T11:59:40.000Z";
  o.config = { ...o.config, region: "uksouth", vmSize: "Standard_B1s", hourlyRateGbp: 0.0157, dnsName: "wg.example.net" };
  o.budget = { budget: 10, actual: 0.4, session: 0.1, total: 0.5, pct: 5, level: "ok", month: "2026-10", alerted: 0 };
  o.actions = { canDispatch: true, lockHolder: null };
  o.profiles = [];
  return o as unknown as OverviewResponse;
}

export const routesFor = (settings = settingsFixture(), overview = runningOverview()): Record<string, unknown> => ({
  "GET /api/v1/settings": settings,
  "GET /api/v1/overview": overview,
});
