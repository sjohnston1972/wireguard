// insights-routes.test.ts
//
// Plain English: every /api/v1/azure route answers its spec section 8 shape
// before anything is collected, through the real routes and the real
// collector modules (nothing mocked), with fetch replaced by a counter. Without
// credentials nothing reaches Azure; with credentials only a capacity cache
// miss does (spec 8: at most once per region per 10 minutes).
import { describe, it, expect, afterEach, vi } from "vitest";
import { makeEnv } from "./harness";
import { api, apiEnv, base } from "./api-helpers";
import type { Env } from "../src/env";
import { FEEDS } from "../../shared/azureMetrics";
import { FEED_TITLES } from "../src/insights/types";
import { NOW, azureEnv, callsTo } from "./insights-helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const NO_AZURE: Partial<Env> = { AZURE_TENANT_ID: undefined, AZURE_CLIENT_ID: undefined, AZURE_CLIENT_SECRET: undefined, AZURE_SUBSCRIPTION_ID: undefined };
// ── Routes (spec section 8) ─────────────────────────────────────────────────

/** A feed's cadence now (X1): the activity feed reads hourly while nothing is deployed and no run ended in the last 2 hours. */
const nowCadence = (f: { id: string; cadenceMin: number | null }) => (f.id === "activity" ? 60 : f.cadenceMin);
const feedShape = (status: string) => ({ id: expect.any(String), title: expect.any(String), status, lastOkAt: null, error: null, cadenceMin: expect.any(Number) });

/** The routes with the query each needs, and the shape it answers before any data exists. */
function routes(status: string, configured: boolean): [string, unknown][] {
  const feed = feedShape(status);
  return [
    [
      "/azure/summary",
      {
        configured,
        region: { id: "uksouth", name: "UK South" },
        feeds: FEEDS.map((f) => ({ ...feed, id: f.id, title: f.title, cadenceMin: nowCadence(f) })),
        health: null,
        maintenance: [],
        serviceIssues: [],
        vitals: null,
        agent: "none",
        latest: { cpuPct: null, creditsLeft: null, creditsTrend: null, memFreeBytes: null, vipAvailPct: null, underDdos: null, at: null },
      },
    ],
    ["/azure/metrics?resource=vm&range=24h", { resource: "vm", range: "24h", step: 300, columns: expect.arrayContaining(["t", "cpu_avg", "credits_min"]), points: [] }],
    ["/azure/metrics?resource=pip&range=1h", { resource: "pip", range: "1h", step: 300, columns: expect.arrayContaining(["t", "ddos_max", "vip_avail"]), points: [] }],
    ["/azure/metrics?resource=vitals&range=7d", { resource: "vitals", range: "7d", step: expect.any(Number), columns: expect.arrayContaining(["t", "mem_used_pct", "net_loss_pct"]), points: [] }],
    ["/azure/changes?range=7d&who=all", { range: "7d", feed: { ...feed, id: "activity", title: FEED_TITLES.activity }, rows: [] }],
    ["/azure/changes", { range: "7d", feed: { ...feed, id: "activity", title: FEED_TITLES.activity }, rows: [] }],
    ["/azure/service-health?range=30d", { events: [], feed: { ...feed, id: "serviceHealth", title: FEED_TITLES.serviceHealth } }],
    [
      "/azure/capacity?region=uksouth&size=Standard_B1s",
      { region: "uksouth", size: "Standard_B1s", available: null, reason: null, vcpusNeeded: null, family: null, total: null, ok: null, message: null, fetchedAt: null },
    ],
    [
      "/azure/price?region=uksouth&size=Standard_B1s",
      { region: "uksouth", size: "Standard_B1s", vmGbpPerHour: null, diskGbpPerHour: null, ipGbpPerHour: null, totalGbpPerHour: 0.0157, standbyGbpPerHour: 0.0064, fetchedAt: null, stale: false, source: "fixed", reason: expect.any(String) },
    ],
    ["/azure/diagnostics", { configured, feeds: FEEDS.map((f) => ({ ...feed, id: f.id, title: f.title, cadenceMin: nowCadence(f), lastTryAt: null, nextDueAt: null })), metricNames: { vm: null, pip: null } }],
    ["/azure/bootlog", { fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason: expect.any(String) }],
  ];
}

describe("/api/v1/azure routes", () => {
  it("every /api/v1/azure route answers its spec 8 shape with configured false and no fetch", async () => {
    const { env } = apiEnv(NO_AZURE);
    const spy = vi.fn(async (..._a: unknown[]) => new Response("no network in tests", { status: 503 }));
    vi.stubGlobal("fetch", spy);
    for (const [path, want] of routes("not_configured", false)) {
      const r = await api(env, "GET", path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("Cache-Control"), path).toBe("no-store");
      expect(r.json, path).toEqual(want);
    }
    const post = await api(env, "POST", "/azure/bootlog");
    expect(post.status).toBe(200);
    expect(post.json).toEqual({ fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason: "Azure isn't connected. Add the service principal secrets to the Worker." });
    expect(spy).not.toHaveBeenCalled();
  });

  it("with Azure configured but nothing collected yet, every feed is idle and only a capacity cache miss reaches Azure", async () => {
    // The real routes and collector modules, with the pretend Azure counting every outside call.
    const { env, az } = azureEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: base });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const isCapacity = (path: string) => path.startsWith("/azure/capacity");
    for (const [path, want] of routes("idle", true).filter(([path]) => !isCapacity(path))) {
      const r = await api(env, "GET", path);
      expect(r.status, path).toBe(200);
      expect(r.json, path).toEqual(want);
    }
    expect(az.calls.map((c) => c.url)).toEqual([]);
    // A capacity cache miss for an offered region asks Azure once: sign-in, the SKU list and the usages (spec 7: 3 calls).
    const r = await api(env, "GET", "/azure/capacity?region=uksouth&size=Standard_B1s");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ region: "uksouth", size: "Standard_B1s", available: true, fetchedAt: NOW.toISOString() });
    const first = az.calls.length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(3);
    expect(callsTo(az, "Microsoft.Compute/skus")).toHaveLength(1);
    // Asked again (another size in the same region, still fresh): nothing more reaches Azure.
    await api(env, "GET", "/azure/capacity?region=uksouth&size=Standard_B2s");
    expect(az.calls.length).toBe(first);
  });

  it("refuses unknown query keys and values outside the spec's lists, naming the field", async () => {
    const { env } = apiEnv(NO_AZURE);
    const cases: [string, string][] = [
      ["/azure/summary?x=1", "x"],
      ["/azure/metrics?resource=disk&range=24h", "resource"],
      ["/azure/metrics?resource=vm&range=2h", "range"],
      ["/azure/metrics?resource=vm", "range"],
      ["/azure/metrics?resource=vm&range=24h&step=60", "step"],
      ["/azure/changes?range=1h", "range"],
      ["/azure/changes?who=me", "who"],
      ["/azure/service-health?range=24h", "range"],
      ["/azure/capacity?size=Standard_B1s", "region"],
      ["/azure/capacity?region=mars&size=Standard_B1s", "region"],
      ["/azure/capacity?region=uksouth", "size"],
      ["/azure/capacity?region=uksouth&size=Huge'1", "size"],
      ["/azure/price?region=uksouth&size=Standard_B1s&currency=USD", "currency"],
      ["/azure/bootlog?full=1", "full"],
      ["/azure/diagnostics?secrets=1", "secrets"],
    ];
    for (const [path, field] of cases) {
      const r = await api(env, "GET", path);
      expect(r.status, path).toBe(400);
      expect(r.json.error, path).toMatchObject({ code: "bad_input", field });
    }
    expect((await api(env, "GET", "/azure/nope")).status).toBe(404);
  });

  it("routes refuse cross-site requests", async () => {
    const { env } = apiEnv(NO_AZURE);
    const r = await api(env, "POST", "/azure/bootlog", undefined, { "Sec-Fetch-Site": "cross-site" });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("cross_site");
    // And every route is behind the login: no bypass, no Access token, no answer.
    const { env: closed } = makeEnv({ ...NO_AZURE, PUBLIC_URL: "http://localhost:8787" });
    for (const path of ["/azure/summary", "/azure/bootlog", "/azure/diagnostics"]) expect((await api(closed, "GET", path)).status, path).toBeGreaterThanOrEqual(401);
  });

  it("settings carry rateSource and price, and overview carries capacity, before the collectors exist", async () => {
    const { env } = apiEnv(NO_AZURE);
    const s = await api(env, "GET", "/settings");
    // X1 (spec 2.7): with no hourly override saved the source is azure; with no Azure price yet the totals are the fixed rates.
    expect(s.json.rateSource).toBe("azure");
    expect(s.json.price).toMatchObject({ region: "uksouth", size: "Standard_B1s", source: "fixed", totalGbpPerHour: 0.0157 });
    const o = await api(env, "GET", "/overview");
    expect(o.json.capacity).toBeNull();
  });
});
