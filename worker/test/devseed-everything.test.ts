// devseed-everything.test.ts
//
// Plain English: the dev seeder's `everything` story (issue #96), one stage
// set that fills every widget on every page. It is checked the way the app
// sees it: seed, read every API the pages read, then walk the widget registry
// (shared/widgets.ts) and ask, widget by widget, whether its data is there.
// A widget added to the registry without a check here fails the test, so a
// new widget cannot ship without the everything story giving it data.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { makeEnv, demoInstance } from "./harness";
import { api } from "./api-helpers";
import worker from "../src/index";
import type { Env } from "../src/env";
import { SCENARIOS } from "../src/devseed";
import { WIDGETS } from "../../shared/widgets";
import { LAB_LIVE_STATES } from "../../shared/labs";
import { insightsShown } from "../src/insights/read";
import { DEVSEED_KV } from "../src/devmarks";

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
/** The screenshot moment (npm run shots -- --freeze-time), the second of a month; and mid-month, with more of the month behind it. */
const NOW = "2026-10-02T14:00:00.000Z";
const MID_MONTH = "2026-10-20T14:00:00.000Z";

type Json = any;

/** Every answer the seven pages read, fetched once. */
interface Seen {
  overview: Json;
  session: Json;
  vmHist: Json;
  clients: Json;
  clientDetails: Json[];
  clientHist: Json;
  firewall: Json;
  activity: Json;
  activity30: Json;
  runDetail: Json;
  runLog: { status: number; json: Json };
  costMonth: Json;
  cost30: Json;
  settings: Json;
  azureSummary: Json;
  vmMetrics: Json;
  pipMetrics: Json;
  vitalsMetrics: Json;
  azureChanges: Json;
  serviceHealth: Json;
  bootLog: Json;
  labs: Json;
  coverage: Json;
  labSessions: Json;
}

async function get(env: Env, path: string): Promise<Json> {
  const r = await api(env, "GET", path);
  expect(r.status, `${path}: ${r.text.slice(0, 300)}`).toBe(200);
  return r.json;
}

/** How look() reads one /api/v1 path: through the Worker (api), or through demo mode's store (DemoStore.serve). */
type Reader = (path: string) => Promise<{ status: number; json: Json; text: string }>;
const viaWorker = (env: Env): Reader => (path) => api(env, "GET", path);

async function seedEverything(env: Env, now = NOW): Promise<Json> {
  const r = await worker.fetch(new Request(`http://localhost:8787/__dev/seed?scenario=everything&now=${now}`, { method: "POST" }), env, ctx);
  const text = await r.text();
  expect(r.status, text).toBe(200);
  return JSON.parse(text);
}

async function look(read: Reader): Promise<Seen> {
  const get = async (path: string) => {
    const r = await read(path);
    expect(r.status, `${path}: ${r.text.slice(0, 300)}`).toBe(200);
    return r.json;
  };
  const overview = await get("/overview");
  const clients = await get("/clients");
  const activity = await get("/activity?range=7d");
  const runId = overview.snapshot.run_id as string;
  const site = clients.clients.find((c: Json) => c.isSite) ?? clients.clients[0];
  const log = await read(`/runs/${encodeURIComponent(runId)}/log`);
  return {
    overview,
    session: await get("/session"),
    vmHist: await get("/history?scope=vm&range=24h"),
    clients,
    clientDetails: await Promise.all(clients.clients.map((c: Json) => get(`/clients/${c.id}`))),
    clientHist: await get(`/history?scope=client&range=24h&id=${site.id}`),
    firewall: await get("/firewall"),
    activity,
    activity30: await get("/activity?range=30d"),
    runDetail: await get(`/runs/${encodeURIComponent(runId)}`),
    runLog: { status: log.status, json: log.json },
    costMonth: await get("/cost?range=month"),
    cost30: await get("/cost?range=30d"),
    settings: await get("/settings"),
    azureSummary: await get("/azure/summary"),
    vmMetrics: await get("/azure/metrics?resource=vm&range=24h"),
    pipMetrics: await get("/azure/metrics?resource=pip&range=24h"),
    vitalsMetrics: await get("/azure/metrics?resource=vitals&range=24h"),
    azureChanges: await get("/azure/changes?range=7d&who=all"),
    serviceHealth: await get("/azure/service-health?range=30d"),
    bootLog: await get("/azure/bootlog"),
    labs: await get("/labs"),
    coverage: await get("/labs/coverage"),
    labSessions: await get("/labs/sessions?limit=200"),
  };
}

const some = (xs: unknown) => Array.isArray(xs) && xs.length > 0;
const filled = (points: Json[], col: string) => points.some((p) => p[col] !== null && p[col] !== undefined);
const eventTotal = (a: Json, type: string) => a.timeline.reduce((n: number, b: Json) => n + (b.counts[type] ?? 0), 0);

/**
 * Each registered widget, and what it must find in the answers to be drawn
 * populated (never its empty, "no data" or "nothing yet" state). Keyed by
 * widget id: one entry per widget in shared/widgets.ts, no more, no fewer.
 */
const WIDGET_DATA: Record<string, (s: Seen) => boolean> = {
  // Overview
  "overview.status": (s) => s.overview.snapshot.state === "running" && !!s.overview.snapshot.running_since && !!s.overview.snapshot.auto_destroy_at,
  "overview.topology": (s) => s.overview.derived.clientsOnline > 0 && !!s.overview.site && some(s.overview.labs.running) && !!s.overview.snapshot.test_vm_ip,
  "overview.keyMetrics": (s) => !!s.overview.snapshot.public_ip && s.overview.derived.clientsOnline > 0 && s.vmHist.availability.pct !== null && s.overview.budget.level !== "none" && Object.keys(s.overview.snapshot.latency).length > 0,
  "overview.run": (s) => some(s.overview.snapshot.steps) && s.runLog.status === 200 && /\S/.test(s.runLog.json.log),
  "overview.traffic": (s) => some(s.overview.snapshot.traffic_hist) && some(s.vmHist.points),
  "overview.events": (s) => s.activity.all.filter((e: Json) => Date.parse(s.overview.now) - Date.parse(e.at) <= 86_400_000).length >= 3,
  "overview.speedTest": (s) => some(s.overview.speedtests),
  "overview.health": (s) => !!s.overview.snapshot.selftest && !!s.overview.snapshot.agent && s.overview.derived.heartbeatStale === false,
  "overview.costImpact": (s) => s.costMonth.session.estimateGbp !== null && s.costMonth.sessions.filter((x: Json) => !x.stillRunning).length > 0,
  "overview.notes": (s) => some(s.session.notes),
  "overview.vmPerformance": (s) => some(s.vmMetrics.points) && filled(s.vmMetrics.points, "cpu_avg"),
  "overview.azureHealth": (s) => !!s.azureSummary.health && some(s.azureSummary.maintenance) && some(s.azureSummary.serviceIssues),
  "overview.vitals": (s) => !!s.azureSummary.vitals && some(s.vitalsMetrics.points),
  "overview.runningLabs": (s) => some(s.overview.labs.running),

  // Clients
  "clients.kpis": (s) => s.clients.kpis.total > 0 && s.clients.kpis.online > 0 && s.clients.kpis.stale > 0 && s.clients.kpis.expiringSoon > 0 && s.clients.kpis.avgLatencyMs !== null,
  "clients.table": (s) => s.clients.clients.length >= 6 && s.clients.clients.some((c: Json) => c.live) && s.clients.clients.some((c: Json) => c.last_handshake_at),
  "clients.talkers": (s) => some(s.clients.talkers),
  "clients.statusDonut": (s) => s.clients.kpis.online > 0 && s.clients.kpis.online < s.clients.kpis.total && s.clients.kpis.expiringSoon > 0,
  "clients.sessionTraffic": (s) => some(s.clients.trafficHist) && some(s.clientHist.points),

  // Firewall
  "firewall.kpis": (s) => s.firewall.kpis.rules > 0 && s.firewall.kpis.drops24h > 0 && s.firewall.kpis.published > 0,
  "firewall.rules": (s) => s.firewall.rules.some((r: Json) => r.hits && r.hits[0] > 0) && !!s.firewall.draft && s.firewall.draft.changes > 0,
  "firewall.zones": (s) => some(s.firewall.zones),
  "firewall.simulator": (s) => some(s.firewall.rules) && some(s.clients.clients),
  "firewall.drops": (s) => some(s.firewall.drops.recent),
  "firewall.ports": (s) => some(s.firewall.forwards),
  "firewall.capture": (s) => some(s.firewall.captures),
  "firewall.publicIp": (s) => some(s.pipMetrics.points) && filled(s.pipMetrics.points, "packets"),

  // Activity
  "activity.kpis": (s) => s.activity.kpis.deploys > 0 && s.activity.kpis.failedRuns > 0 && s.activity.kpis.configChanges > 0 && s.activity.kpis.watchmanProblems > 0,
  "activity.timeline": (s) => ["deploy", "destroy", "failure", "config", "firewall", "watchman"].every((t) => eventTotal(s.activity, t) > 0),
  "activity.list": (s) => s.activity.all.length >= 20,
  "activity.stream": (s) => some(s.activity.all),
  "activity.changeLog": (s) => s.activity.changes.rows.length >= 5,
  "activity.runDetails": (s) => some(s.runDetail.steps),
  "activity.liveOutput": (s) => s.runLog.status === 200 && s.runLog.json.log.split("\n").length >= 10,
  "activity.azureChanges": (s) => s.azureChanges.rows.some((r: Json) => r.callerKind === "person") && s.azureChanges.rows.some((r: Json) => r.callerKind === "wgadmin"),
  "activity.serviceHealth": (s) => some(s.serviceHealth.events),

  // Cost
  "cost.kpis": (s) => s.costMonth.monthToDate > 0 && s.costMonth.session.estimateGbp !== null && s.costMonth.budget.level === "warn",
  "cost.spend": (s) => s.cost30.daily.length >= 28 && !!s.costMonth.projection,
  "cost.breakdown": (s) => !!s.costMonth.breakdown && s.costMonth.breakdown.byType.length > 1,
  "cost.forecast": (s) => !!s.costMonth.projection && s.costMonth.budget.budget > 0,
  "cost.split": (s) => !!s.costMonth.breakdown && s.costMonth.breakdown.byRegion.length > 1 && s.costMonth.breakdown.byType.length > 1,
  "cost.perSession": (s) => s.cost30.sessions.length >= 5,
  "cost.insights": (s) => some(s.costMonth.insights),
  "cost.sessions": (s) => s.cost30.sessions.length >= 5 && s.cost30.sessions.some((x: Json) => x.stillRunning),
  "cost.labs": (s) => some(s.costMonth.labs) && s.costMonth.labs.some((l: Json) => l.actualGbp !== null) && s.costMonth.labs.some((l: Json) => l.running),
};

describe.each([NOW, MID_MONTH])("the everything scenario (issue #96), seeded at %s", (now) => {
  let seen: Seen;
  let env: Env;
  let callsWhileSeeding: unknown[];

  beforeAll(async () => {
    // Only the clock is faked: the API reads "now" itself, so it must agree with the seed.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    const made = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: "http://localhost:8787" });
    env = made.env;
    await seedEverything(env, now);
    callsWhileSeeding = [...made.world.calls];
    seen = await look(viaWorker(env));
  }, 60_000);
  afterAll(() => {
    vi.useRealTimers();
  });

  it("is one of the scenarios", () => {
    expect(SCENARIOS).toContain("everything");
  });

  it("has a data check for every registered widget, and none for a widget that is not registered", () => {
    const ids = WIDGETS.map((w) => w.id).sort();
    expect(Object.keys(WIDGET_DATA).sort()).toEqual(ids);
  });

  it.each(WIDGETS.map((w) => [w.id, w.title] as const))("%s (%s) gets data", (id) => {
    const check = WIDGET_DATA[id];
    expect(check, `no data check for ${id}: give it data in the everything story and a check here`).toBeTypeOf("function");
    expect(check(seen), `${id} would show its empty state`).toBe(true);
  });

  it("Overview: the banner shows the running gateway with its labs, a scheduled reboot and an Azure issue", () => {
    expect(seen.overview.labs.running.length).toBeGreaterThanOrEqual(3);
    expect(seen.overview.labs.gbpH).toBeGreaterThan(0);
    expect(seen.azureSummary.maintenance[0].type).toBe("Reboot");
    expect(seen.overview.budget.level).toBe("warn");
  });

  it("Clients: several peers with handshakes, a re-keyed client, and every client's detail tabs filled", () => {
    expect(seen.clients.clients.length).toBeGreaterThanOrEqual(6);
    const rekeyed = seen.clientDetails.filter((d) => d.changes.some((c: Json) => c.action === "client.rekey"));
    expect(rekeyed.length).toBeGreaterThan(0);
    expect(seen.clientDetails.every((d) => d.changes.length > 0), "every client has a Changes tab entry").toBe(true);
    expect(seen.clientDetails.filter((d) => d.talkers.length > 0).length).toBeGreaterThan(2);
  });

  it("Activity: deploys and tear-downs that succeeded, failed and were cancelled, each with a log", async () => {
    const runs = seen.activity.runs as Json[];
    const kinds = new Set(runs.map((r) => `${r.action}:${r.status}`));
    for (const k of ["apply:success", "apply:failure", "apply:cancelled", "destroy:success", "destroy:failure"]) expect(kinds, k).toContain(k);
    for (const k of kinds) {
      const r = runs.find((x) => `${x.action}:${x.status}` === k)!;
      const log = await api(env, "GET", `/runs/${encodeURIComponent(r.id)}/log`);
      expect(log.status, `${k} ${r.id}`).toBe(200);
      expect(log.json.log, k).toMatch(/##\[group\]/);
    }
    // Notes of every kind the watchman writes about problems.
    const noteKinds = new Set((seen.activity30.notes as Json[]).map((n) => n.kind));
    for (const k of ["failure", "drift", "cost_guard", "unreachable", "idle", "info"]) expect(noteKinds, k).toContain(k);
  });

  it("Cost: a month of daily figures, the budget at its warning level, a forecast and lab spend", () => {
    expect(seen.cost30.daily.length).toBeGreaterThanOrEqual(28);
    expect(seen.costMonth.budget.pct).toBeGreaterThanOrEqual(80);
    expect(seen.costMonth.budget.pct).toBeLessThan(100);
  });

  it("Labs: live sessions in every live state, history, coverage, leftovers and release tests", () => {
    const live = new Set((seen.labs.running as Json[]).map((s) => s.state));
    for (const st of LAB_LIVE_STATES) expect(live, st).toContain(st);
    const all = new Set((seen.labSessions.sessions as Json[]).map((s) => s.state));
    expect(all).toContain("ended");
    expect(all).toContain("ended_dirty");
    expect(seen.labs.orphans.length).toBeGreaterThan(0);
    expect((seen.labs.labs as Json[]).filter((c) => c.lastReleaseTest).length).toBeGreaterThan(2);
    expect(seen.coverage.exams.some((e: Json) => e.areas.some((a: Json) => a.run > 0))).toBe(true);
    // Room for one more, so the catalogue still offers Deploy.
    expect(seen.labs.running.length).toBeLessThan(seen.labs.maxRunning);
    expect(seen.labs.permissions).toMatchObject({ role: true, users: true, groups: true });
  });

  it("Settings: values in every section, phones, backups, a schedule and the permission check", () => {
    const st = seen.settings;
    expect(Object.keys(st.overrides).length).toBeGreaterThanOrEqual(3);
    expect(st.profiles.length).toBeGreaterThan(0);
    expect(st.schedules.length).toBeGreaterThan(0);
    expect(st.phones.length).toBeGreaterThan(0);
    expect(st.backups.state.count).toBeGreaterThan(0);
    expect(st.backups.config.count).toBeGreaterThan(0);
    expect(seen.labs.permissions.checkedAt).not.toBeNull();
    // Security: the server key was rotated, and the stale tablet has not reconnected since.
    expect(st.key.rotation.changedAt).not.toBeNull();
    expect(st.key.rotation.clients.filter((c: Json) => !c.done).map((c: Json) => c.name)).toEqual(["tablet"]);
  });

  it("seeds without a single outside call (no Azure, no GitHub, no DNS)", () => {
    expect(callsWhileSeeding).toEqual([]);
  });

  it("keeps to made-up addresses and names: no github.com, no real tenant", async () => {
    const dump = JSON.stringify(seen);
    expect(dump).not.toMatch(/github\.com\/[^"]*\/actions/);
    const runs = (await env.DB.prepare("SELECT github_run_url FROM runs").all<{ github_run_url: string | null }>()).results;
    for (const r of runs) if (r.github_run_url) expect(r.github_run_url).toMatch(/^https:\/\/ci\.example\.invalid\//);
    // Clients dial in from TEST-NET-2; the VM's address is TEST-NET-3.
    for (const c of seen.clients.clients as Json[]) if (c.live?.endpoint) expect(c.live.endpoint, c.name).toMatch(/^198\.51\.100\.\d+:\d+$/);
    expect(seen.overview.snapshot.public_ip).toMatch(/^203\.0\.113\.\d+$/);
  });
});

// Demo mode (spec §9.9): the same walk, with every read answered by demo
// mode's store (DemoStore.serve) after its own refresh, against its demo
// environment (no secrets, no real binding). The demo shows every widget filled.
describe("the everything story served by demo mode's store", () => {
  let seen: Seen;
  let real: Env;
  let outbound: unknown[];

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    // The live Worker: no login bypass; Azure, GitHub and ntfy secrets set (the demo must not use them).
    const made = makeEnv({ PUBLIC_URL: "https://wg-admin.example" });
    real = made.env;
    const { store } = demoInstance(real);
    const r = await store.refresh(NOW);
    expect(r.ok).toBe(true);
    const read: Reader = async (path) => {
      const res = await store.serve(new Request(`https://wg-admin.example/api/v1${path}`), "someone@example.com");
      expect(res.headers.get("X-WG-Data")).toBe("demo");
      const text = await res.text();
      let json: Json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    };
    seen = await look(read);
    outbound = [...made.world.calls];
  }, 60_000);
  afterAll(() => {
    vi.useRealTimers();
  });

  it.each(WIDGETS.map((w) => [w.id, w.title] as const))("%s (%s) gets data in demo mode", (id) => {
    expect(WIDGET_DATA[id](seen), `${id} would show its empty state in demo mode`).toBe(true);
  });

  it("names the demo person, not dev@localhost, and calls nothing outside", () => {
    const dump = JSON.stringify(seen);
    expect(dump).not.toContain("dev@localhost");
    expect(dump).toContain("demo@example.com");
    expect(outbound).toEqual([]);
  });

  it("leaves the real stores empty", async () => {
    expect((await real.DB.prepare("SELECT COUNT(*) AS n FROM peers").first<{ n: number }>())!.n).toBe(0);
    expect((await real.STATE.list()).objects).toEqual([]);
  });
});

// The dev server runs from .env.example: no Azure credentials. The seeded
// Azure data must still show (the screens are what the story is for), and
// only there: the live Worker never has AUTH_DEV_BYPASS.
describe("the seeded Azure data on a dev server without Azure", () => {
  const noAzure = { AUTH_DEV_BYPASS: "1", PUBLIC_URL: "http://localhost:8787", AZURE_TENANT_ID: "", AZURE_CLIENT_ID: "", AZURE_CLIENT_SECRET: "", AZURE_SUBSCRIPTION_ID: "" };

  it("reads as connected after a seed, so the Azure widgets show it, and nothing is fetched", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    try {
      const { env, world } = makeEnv(noAzure);
      await seedEverything(env);
      const sum = await get(env, "/azure/summary");
      expect(sum.configured).toBe(true);
      expect(sum.feeds.every((f: Json) => f.status === "ok")).toBe(true);
      expect((await get(env, "/azure/changes?range=7d")).feed.status).toBe("ok");
      expect(world.calls).toEqual([]);
      // A story without Azure data still says Azure is not connected.
      const r = await worker.fetch(new Request(`http://localhost:8787/__dev/seed?scenario=running&now=${NOW}`, { method: "POST" }), env, ctx);
      expect(r.status).toBe(200);
      const plain = await get(env, "/azure/summary");
      expect(plain.configured).toBe(false);
      expect(plain.feeds.every((f: Json) => f.status === "not_configured")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("never without the dev bypass, nor without the seed's own marker", async () => {
    const { env } = makeEnv({ ...noAzure, AUTH_DEV_BYPASS: undefined });
    const ok = new Map([["health", { feed: "health", last_try_at: NOW, last_ok_at: NOW, status: "ok", error: null, next_due_at: null }]]);
    // No marker: the bypass alone (set on the live Worker by mistake, with stale ok rows) never shows Azure as connected.
    expect(await insightsShown({ ...env, AUTH_DEV_BYPASS: "1" }, ok)).toBe(false);
    await env.STATUS.put(DEVSEED_KV.insights, "1");
    expect(await insightsShown(env, ok)).toBe(false);
    expect(await insightsShown({ ...env, AUTH_DEV_BYPASS: "1" }, ok)).toBe(true);
    expect(await insightsShown({ ...env, AUTH_DEV_BYPASS: "1" }, new Map())).toBe(false);
  });

  it("with the bypass and ok feed rows but no seed marker, the summary and diagnostics say Azure isn't connected", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    try {
      const { env } = makeEnv(noAzure);
      await seedEverything(env);
      expect((await get(env, "/azure/diagnostics")).configured).toBe(true);
      // As if the live Worker had the bypass on and stale ok rows: no marker, because only the seed route writes it.
      await env.STATUS.delete(DEVSEED_KV.insights);
      const sum = await get(env, "/azure/summary");
      expect(sum.configured).toBe(false);
      expect(sum.feeds.every((f: Json) => f.status === "not_configured")).toBe(true);
      expect((await get(env, "/azure/diagnostics")).configured).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);
});

// wrangler.toml binds STATE to the production bucket: the seeder must never
// touch the real backup prefixes, whatever it writes for its own story.
describe("the seeded backups stay out of the real backup prefixes", () => {
  it("no story's wipe deletes backups/ or config-backups/, and everything's backups live under devseed/", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    try {
      const { env } = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: "http://localhost:8787" });
      const real = ["backups/20260901T100000Z-apply.tfstate", "config-backups/2026-09-01.json"];
      for (const k of real) await env.STATE.put(k, "{}");
      const keys = async (prefix = "") => (await env.STATE.list({ prefix })).objects.map((o) => o.key);
      for (const s of SCENARIOS) {
        const r = await worker.fetch(new Request(`http://localhost:8787/__dev/seed?scenario=${s}&now=${NOW}`, { method: "POST" }), env, ctx);
        expect(r.status, s).toBe(200);
        for (const k of real) expect(await keys(k), `${s} kept ${k}`).toEqual([k]);
        expect((await keys("backups/")).length, s).toBe(1);
        expect((await keys("config-backups/")).length, s).toBe(1);
      }
      // everything last: its backups are all under devseed/, and the dev server's Settings reads them there.
      const r = await worker.fetch(new Request(`http://localhost:8787/__dev/seed?scenario=everything&now=${NOW}`, { method: "POST" }), env, ctx);
      expect(r.status).toBe(200);
      const seeded = await keys("devseed/");
      expect(seeded.length).toBeGreaterThan(5);
      expect((await keys()).filter((k) => !k.startsWith("devseed/")).sort()).toEqual([...real].sort());
      const st = await get(env, "/settings");
      expect(st.backups.state.count).toBe(seeded.filter((k) => k.startsWith("devseed/backups/")).length);
      expect(st.backups.config.days.length).toBe(seeded.filter((k) => k.startsWith("devseed/config-backups/")).length);
      const day = st.backups.config.days[0];
      expect((await api(env, "GET", `/backup/config/${day}`)).status).toBe(200);
      // A story without the marker reads the real prefixes again.
      await worker.fetch(new Request(`http://localhost:8787/__dev/seed?scenario=running&now=${NOW}`, { method: "POST" }), env, ctx);
      expect((await get(env, "/settings")).backups.config.days).toEqual(["2026-09-01"]);
      expect(await keys("devseed/")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);
});

describe("the everything scenario is repeatable", () => {
  it("the same time gives identical rows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    try {
      const dump = async () => {
        const { env } = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: "http://localhost:8787" });
        await seedEverything(env);
        const out: Record<string, unknown> = {};
        for (const t of ["peers", "runs", "alerts", "audit", "cost_days", "cost_breakdown", "run_live_log", "lab_sessions", "lab_runs", "lab_cost_days", "push_subs", "settings"]) {
          out[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results.map((r: any) => ({ ...r, fetched_at: undefined }));
        }
        return out;
      };
      expect(await dump()).toEqual(await dump());
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);
});
