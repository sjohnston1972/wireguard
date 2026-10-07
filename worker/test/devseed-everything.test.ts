// devseed-everything.test.ts
//
// Plain English: the dev seeder's `everything` story (issue #96), one stage
// set that fills every widget on every page. It is checked the way the app
// sees it: seed, read every API the pages read, then walk the widget registry
// (shared/widgets.ts) and ask, widget by widget, whether its data is there.
// A widget added to the registry without a check here fails the test, so a
// new widget cannot ship without the everything story giving it data.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { makeEnv } from "./harness";
import { api } from "./api-helpers";
import worker from "../src/index";
import type { Env } from "../src/env";
import { SCENARIOS } from "../src/devseed";
import { WIDGETS } from "../../shared/widgets";
import { LAB_LIVE_STATES } from "../../shared/labs";

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const NOW = "2026-10-02T14:00:00.000Z";

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

async function seedEverything(env: Env): Promise<Json> {
  const r = await worker.fetch(new Request(`http://localhost:8787/__dev/seed?scenario=everything&now=${NOW}`, { method: "POST" }), env, ctx);
  const text = await r.text();
  expect(r.status, text).toBe(200);
  return JSON.parse(text);
}

async function look(env: Env): Promise<Seen> {
  const overview = await get(env, "/overview");
  const clients = await get(env, "/clients");
  const activity = await get(env, "/activity?range=7d");
  const runId = overview.snapshot.run_id as string;
  const site = clients.clients.find((c: Json) => c.isSite) ?? clients.clients[0];
  const log = await api(env, "GET", `/runs/${encodeURIComponent(runId)}/log`);
  return {
    overview,
    session: await get(env, "/session"),
    vmHist: await get(env, "/history?scope=vm&range=24h"),
    clients,
    clientDetails: await Promise.all(clients.clients.map((c: Json) => get(env, `/clients/${c.id}`))),
    clientHist: await get(env, `/history?scope=client&range=24h&id=${site.id}`),
    firewall: await get(env, "/firewall"),
    activity,
    activity30: await get(env, "/activity?range=30d"),
    runDetail: await get(env, `/runs/${encodeURIComponent(runId)}`),
    runLog: { status: log.status, json: log.json },
    costMonth: await get(env, "/cost?range=month"),
    cost30: await get(env, "/cost?range=30d"),
    settings: await get(env, "/settings"),
    azureSummary: await get(env, "/azure/summary"),
    vmMetrics: await get(env, "/azure/metrics?resource=vm&range=24h"),
    pipMetrics: await get(env, "/azure/metrics?resource=pip&range=24h"),
    vitalsMetrics: await get(env, "/azure/metrics?resource=vitals&range=24h"),
    azureChanges: await get(env, "/azure/changes?range=7d&who=all"),
    serviceHealth: await get(env, "/azure/service-health?range=30d"),
    bootLog: await get(env, "/azure/bootlog"),
    labs: await get(env, "/labs"),
    coverage: await get(env, "/labs/coverage"),
    labSessions: await get(env, "/labs/sessions?limit=200"),
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
  "overview.events": (s) => s.activity.all.filter((e: Json) => Date.parse(NOW) - Date.parse(e.at) <= 86_400_000).length >= 3,
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

describe("the everything scenario (issue #96)", () => {
  let seen: Seen;
  let env: Env;
  let callsWhileSeeding: unknown[];

  beforeAll(async () => {
    // Only the clock is faked: the API reads "now" itself, so it must agree with the seed.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const made = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: "http://localhost:8787" });
    env = made.env;
    await seedEverything(env);
    callsWhileSeeding = [...made.world.calls];
    seen = await look(env);
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
  });

  it("seeds without a single outside call (no Azure, no GitHub, no DNS)", () => {
    expect(callsWhileSeeding).toEqual([]);
  });

  it("keeps to made-up addresses and names: no github.com, no real tenant", async () => {
    const dump = JSON.stringify(seen);
    expect(dump).not.toMatch(/github\.com\/[^"]*\/actions/);
    const runs = (await env.DB.prepare("SELECT github_run_url FROM runs").all<{ github_run_url: string | null }>()).results;
    for (const r of runs) if (r.github_run_url) expect(r.github_run_url).toMatch(/^https:\/\/ci\.example\.invalid\//);
  });
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
