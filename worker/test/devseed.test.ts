// devseed.test.ts
//
// Plain English: the local scenario seeder. First the lock on the door (the
// seed route must not exist anywhere but a developer's own PC with the login
// bypass on), then each scenario: seed it, ask the real API what it sees, and
// check the answer is consistent and matches the story the scenario tells.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv } from "./harness";
import { api } from "./api-helpers";
import worker from "../src/index";
import type { Env } from "../src/env";
import { SCENARIOS } from "../src/devseed";
import { freezeDevClock } from "../src/devclock";
import { listRuns } from "../src/db";
import { getSnapshot } from "../src/state";

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const NOW = "2026-10-02T14:00:00.000Z";

beforeEach(() => {
  // Only the clock is faked: the API reads "now" itself, so it must agree with the seed.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function seedAt(env: Env, host: string, scenario: string | null, method = "POST") {
  const qs = new URLSearchParams({ now: NOW });
  if (scenario !== null) qs.set("scenario", scenario);
  const r = await worker.fetch(new Request(`http://${host}/__dev/seed?${qs}`, { method }), env, ctx);
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, json, text };
}

function devEnv(overrides: Partial<Env> = {}) {
  return makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: "http://localhost:8787", ...overrides });
}

async function seed(env: Env, scenario: string) {
  const r = await seedAt(env, "localhost:8787", scenario);
  expect(r.status, r.text).toBe(200);
  return r;
}

describe("the seed route's guard", () => {
  it("is 404 without the bypass, even on localhost", async () => {
    const { env } = makeEnv({ PUBLIC_URL: "http://localhost:8787" });
    for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787"]) expect((await seedAt(env, host, "empty")).status).toBe(404);
  });

  it("is 404 when the bypass is anything but exactly 1", async () => {
    for (const v of ["0", "true", "", "yes"]) {
      const { env } = makeEnv({ AUTH_DEV_BYPASS: v, PUBLIC_URL: "http://localhost:8787" });
      expect((await seedAt(env, "localhost:8787", "empty")).status, `bypass=${v}`).toBe(404);
    }
  });

  it("is 404 on a non-localhost host, even with the bypass", async () => {
    const { env } = devEnv();
    for (const host of ["wg-admin.clydeford.net", "wg-admin.example", "localhost.evil.example", "127.0.0.1.evil.example", "192.168.1.5:8787", "0.0.0.0:8787"]) {
      const r = await seedAt(env, host, "empty");
      expect(r.status, host).toBe(404);
      expect(r.text.toLowerCase()).not.toContain("scenario");
    }
  });

  it("is 404 with neither", async () => {
    const { env } = makeEnv();
    expect((await seedAt(env, "wg-admin.clydeford.net", "empty")).status).toBe(404);
  });

  it("is 200 with both, on localhost, 127.0.0.1 and [::1]", async () => {
    for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787"]) {
      const { env } = devEnv();
      const r = await seedAt(env, host, "empty");
      expect(r.status, host).toBe(200);
      expect(r.json).toMatchObject({ ok: true, scenario: "empty" });
    }
  });

  it("answers only POST", async () => {
    const { env } = devEnv();
    expect((await seedAt(env, "localhost:8787", "empty", "GET")).status).toBe(404);
  });

  it("refuses an unknown or missing scenario with a 400 that lists the real ones (guard passed)", async () => {
    const { env } = devEnv();
    const bad = await seedAt(env, "localhost:8787", "nope");
    expect(bad.status).toBe(400);
    expect(bad.json.scenarios).toEqual([...SCENARIOS]);
    expect((await seedAt(env, "localhost:8787", null)).status).toBe(400);
  });

  it("does not change anything when refused", async () => {
    const { env } = makeEnv({ PUBLIC_URL: "http://localhost:8787" });
    await seedAt(env, "localhost:8787", "running");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM peers").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("scenarios", () => {
  it("lists exactly the seven the plan names", () => {
    expect([...SCENARIOS].sort()).toEqual(["busy-month", "deploying", "destroyed", "empty", "failed", "running", "standby"].sort());
  });

  it("every scenario wipes drafts and resets fw_policy", async () => {
    const { env } = devEnv();
    await seed(env, "running");
    for (const s of SCENARIOS) {
      // Leave things as a long-used install would: a later version and an extra draft rule.
      await env.DB.prepare("UPDATE fw_policy SET live_version = 9 WHERE id = 1").run();
      await env.DB.prepare("INSERT INTO fw_draft_rules (live_id, position, name, src_kind, dst_kind, proto, action, created_at) VALUES (NULL, 999, 'leftover', 'any', 'any', 'any', 'deny', '2026-01-01')").run();
      await seed(env, s);
      const pol = await env.DB.prepare("SELECT live_version, draft_base, draft_default, apply_token FROM fw_policy WHERE id = 1").first();
      const names = (await env.DB.prepare("SELECT name FROM fw_draft_rules").all<{ name: string }>()).results.map((r) => r.name);
      expect(names, s).not.toContain("leftover");
      if (s === "running") {
        expect(pol, s).toEqual({ live_version: 1, draft_base: 1, draft_default: "deny", apply_token: null });
      } else {
        expect(pol, s).toEqual({ live_version: 1, draft_base: null, draft_default: null, apply_token: null });
        expect(names, s).toEqual([]);
        expect((await api(env, "GET", "/firewall")).json.draft, s).toBeNull();
      }
    }
  }, 30_000);

  it("running has a two-change draft (one edited rule, one added)", async () => {
    const { env } = devEnv();
    await seed(env, "running");
    const fw = (await api(env, "GET", "/firewall")).json;
    expect(fw.version).toBe(1);
    expect(fw.policy.state).toBe("applied");
    expect(fw.draft).toMatchObject({ baseVersion: 1, stale: false, changes: 2 });
    expect(fw.draft.diff.changed).toHaveLength(1);
    expect(fw.draft.diff.added).toHaveLength(1);
    expect(fw.draft.diff.removed).toEqual([]);
    expect(fw.draft.diff.moved).toEqual([]);
    expect(fw.draft.diff.defaultChanged).toBeNull();
    expect(fw.draft.rules.filter((r: { mark: string | null }) => r.mark).map((r: { mark: string }) => r.mark).sort()).toEqual(["added", "changed"]);
    // Apply would go through: neither change is a rule the VM could not load.
    expect(fw.draft.rules.filter((r: { mark: string | null; problem: string | null }) => r.mark && r.problem)).toEqual([]);
    // The live rules are as seeded: the draft has not been applied.
    expect(fw.rules.length).toBe(fw.draft.rules.length - 1);
  });

  it("empty: no clients, destroyed, no history", async () => {
    const { env } = devEnv();
    await seed(env, "empty");
    expect((await api(env, "GET", "/overview")).json.snapshot.state).toBe("destroyed");
    const c = (await api(env, "GET", "/clients")).json;
    expect(c.clients).toEqual([]);
    expect(c.kpis.total).toBe(0);
    const h = (await api(env, "GET", "/history?scope=vm&range=7d")).json;
    expect(h.points).toEqual([]);
    expect(h.availability.pct).toBeNull();
  });

  it("destroyed: 4 clients with the home site, 7 days of history from earlier sessions, none online", async () => {
    const { env } = devEnv();
    await seed(env, "destroyed");
    const o = (await api(env, "GET", "/overview")).json;
    expect(o.snapshot.state).toBe("destroyed");
    expect(o.derived.clientsOnline).toBe(0);
    const c = (await api(env, "GET", "/clients")).json;
    expect(c.clients).toHaveLength(4);
    expect(c.clients.some((x: any) => x.isSite && x.name === "home-site")).toBe(true);
    const h = (await api(env, "GET", "/history?scope=vm&range=7d")).json;
    expect(h.points.length).toBeGreaterThan(20);
    const oldest = Date.parse(h.points[0].t);
    expect(Date.parse(NOW) - oldest).toBeGreaterThan(5 * 86_400_000);
    // Nothing is recorded while destroyed: the last sample is not recent.
    expect(Date.parse(NOW) - Date.parse(h.latest)).toBeGreaterThan(3_600_000);
    const sessions = (await api(env, "GET", "/cost")).json.sessions;
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s: any) => !s.stillRunning)).toBe(true);
  });

  it("running: clients online and offline, a week of history, firewall hits and drops, captures, a speed test, budget at 40%", async () => {
    const { env } = devEnv();
    await seed(env, "running");
    const o = (await api(env, "GET", "/overview")).json;
    expect(o.snapshot.state).toBe("running");
    expect(o.derived.clientsOnline).toBeGreaterThanOrEqual(3);
    expect(o.derived.clientsEnabled).toBeGreaterThan(o.derived.clientsOnline);
    expect(o.derived.heartbeatStale).toBe(false);
    expect(o.derived.selftestFailures).toEqual([]);
    expect(o.snapshot.public_ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(o.speedtests.length).toBeGreaterThan(0);
    expect(o.budget.level).toBe("ok");
    expect(Math.round(o.budget.pct)).toBe(40);
    expect(o.snapshot.traffic_hist.length).toBeGreaterThan(10);

    const c = (await api(env, "GET", "/clients")).json;
    expect(c.running).toBe(true);
    expect(c.kpis.online).toBe(o.derived.clientsOnline);
    expect(c.kpis.avgLatencyMs).toBeGreaterThan(10);
    expect(c.kpis.avgLatencyMs).toBeLessThan(40);
    expect(c.talkers.length).toBeGreaterThan(0);
    expect(c.clients.map((x: any) => x.name)).toEqual(expect.arrayContaining(["home-site", "phone", "gaming-pc", "laptop"]));

    const fw = (await api(env, "GET", "/firewall")).json;
    expect(fw.policy.state).toBe("applied");
    expect(fw.drops.last24h).toBeGreaterThan(50);
    expect(fw.drops.recent.length).toBeGreaterThan(3);
    expect(fw.drops.recent.some((d: any) => d.proto.toLowerCase() === "tcp" && d.dport === 8080)).toBe(true);
    expect(fw.rules.some((r: any) => r.hits && r.hits[0] > 0)).toBe(true);
    // Rule hit history, so the Firewall screen's Hits 24h column and its trend have data.
    expect(fw.rules.some((r: any) => r.hits24h > 0)).toBe(true);
    expect(fw.rules.find((r: any) => r.hits24h > 0).trend24h).toHaveLength(24);
    expect(fw.defaultHits24h).toBeGreaterThan(0);
    expect(fw.captures.length).toBeGreaterThan(0);
    expect(fw.forwards.length).toBeGreaterThan(0);

    const h = (await api(env, "GET", "/history?scope=vm&range=7d")).json;
    expect(h.points.length).toBeGreaterThan(20);
    expect(h.availability.pct).toBeGreaterThan(95);
    expect(Date.parse(NOW) - Date.parse(h.latest)).toBeLessThan(35 * 60_000);
    const home = c.clients.find((x: any) => x.name === "home-site");
    const ch = (await api(env, "GET", `/history?scope=client&range=24h&id=${home.id}`)).json;
    expect(ch.points.length).toBeGreaterThan(5);
    const lat = ch.points.map((p: any) => p.latency_avg).filter((x: number | null) => x !== null);
    expect(Math.min(...lat)).toBeGreaterThan(8);
    expect(Math.max(...lat)).toBeLessThan(60);

    const cost = (await api(env, "GET", "/cost")).json;
    expect(cost.session.running).toBe(true);
    expect(cost.daily.length).toBeGreaterThan(0);
    // pennies a day, not pounds
    expect(Math.max(...cost.daily.map((d: any) => d.gbp))).toBeLessThan(1);
  });

  it("deploying: a run in progress with 12 steps (6 done) and a log tail", async () => {
    const { env } = devEnv();
    await seed(env, "deploying");
    const o = (await api(env, "GET", "/overview")).json;
    expect(o.snapshot.state).toBe("deploying");
    expect(o.snapshot.steps).toHaveLength(12);
    expect(o.snapshot.steps.filter((s: any) => s.conclusion === "success")).toHaveLength(6);
    expect(o.snapshot.steps.filter((s: any) => s.status === "in_progress")).toHaveLength(1);
    expect(o.snapshot.log_tail).toMatch(/INFO/);
    // GitHub's own line format (a UTC timestamp), so the screen shows it on the same clock as the steps.
    expect(o.snapshot.log_tail.split("\n")[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[INFO\] /);
    expect(o.snapshot.run_id).toBeTruthy();
    const run = (await api(env, "GET", `/runs/${o.snapshot.run_id}`)).json;
    expect(run.active).toBe(true);
    expect(run.run.status).toBe("running");
    expect(run.steps).toHaveLength(12);
  });

  it("failed: a failed deploy with its error, steps kept on the run, and a failure note", async () => {
    const { env } = devEnv();
    await seed(env, "failed");
    const o = (await api(env, "GET", "/overview")).json;
    expect(o.snapshot.state).toBe("failed");
    expect(o.snapshot.error).toBeTruthy();
    const run = (await api(env, "GET", `/runs/${o.snapshot.run_id}`)).json;
    expect(run.run.status).toBe("failure");
    expect(run.run.error).toBeTruthy();
    expect(run.active).toBe(false);
    expect(run.steps.some((s: any) => s.conclusion === "failure")).toBe(true);
    const a = (await api(env, "GET", "/activity?range=24h")).json;
    expect(a.kpis.failedRuns).toBeGreaterThan(0);
    expect(a.notes.some((n: any) => n.kind === "failure")).toBe(true);
  });

  it("standby: deallocated, clients known but not online, standby cost shown", async () => {
    const { env } = devEnv();
    await seed(env, "standby");
    const o = (await api(env, "GET", "/overview")).json;
    expect(o.snapshot.state).toBe("standby");
    expect(o.snapshot.standby_since).toBeTruthy();
    expect(o.derived.clientsOnline).toBe(0);
    expect(o.derived.clientsEnabled).toBeGreaterThan(0);
    const cost = (await api(env, "GET", "/cost")).json;
    expect(cost.standby).not.toBeNull();
  });

  it("busy-month: 30 days of runs, notes, changes and cost days", async () => {
    const { env } = devEnv();
    await seed(env, "busy-month");
    const a = (await api(env, "GET", "/activity?range=30d")).json;
    expect(a.timeline.length).toBeGreaterThan(0);
    expect(a.timeline.reduce((n: number, b: any) => n + Object.values(b.counts).reduce((x: number, y: any) => x + y, 0), 0)).toBeGreaterThan(30);
    expect(a.runs.length).toBeGreaterThan(20);
    expect(a.notes.length).toBeGreaterThan(5);
    expect(a.changes.rows.length).toBeGreaterThan(5);
    expect(a.kpis.deploys).toBeGreaterThan(8);
    expect(a.kpis.failedRuns).toBeGreaterThan(0);
    const cost = (await api(env, "GET", "/cost?range=30d")).json;
    expect(cost.daily.length).toBeGreaterThan(20);
    expect(cost.sessions.length).toBeGreaterThan(8);
  });

  it("replaces what was there: seeding empty after running leaves nothing behind", async () => {
    const { env } = devEnv();
    await seed(env, "running");
    await seed(env, "empty");
    expect((await api(env, "GET", "/overview")).json.snapshot.state).toBe("destroyed");
    for (const t of ["peers", "runs", "alerts", "audit", "cost_days", "speedtests", "captures", "hist_vm", "hist_client", "hist_drops", "hist_fw", "fw_forwards"]) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>();
      expect(n!.n, t).toBe(0);
    }
  });

  it("is deterministic: the same scenario and time give identical rows", async () => {
    const dump = async () => {
      const { env } = devEnv();
      await seed(env, "running");
      const out: Record<string, unknown> = {};
      for (const t of ["peers", "runs", "alerts", "audit", "cost_days", "hist_vm", "hist_client", "hist_drops"]) {
        out[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results.map((r: any) => ({ ...r, fetched_at: undefined }));
      }
      const snap = (await api(env, "GET", "/overview")).json.snapshot;
      return { out, snap: { ...snap, updated_at: undefined } };
    };
    const a = await dump();
    const b = await dump();
    expect(b).toEqual(a);
    expect((a.out.hist_client as unknown[]).length).toBeGreaterThan(50);
  });
});

describe("seeded GitHub links", () => {
  it("no seeded URL points at github.com", async () => {
    const RE = /^https:\/\/ci\.example\.invalid\/actions\/runs\/\d+$/;
    let seen = 0;
    for (const scenario of SCENARIOS) {
      const { env } = devEnv();
      await seed(env, scenario);
      const urls = [...(await listRuns(env, 200)).map((r) => r.github_run_url), (await getSnapshot(env)).github_run_url].filter((u): u is string => !!u);
      for (const u of urls) expect(u, `${scenario}: ${u}`).toMatch(RE);
      seen += urls.length;
    }
    expect(seen).toBeGreaterThan(5);
  });
});

// For pixel-identical screenshots (npm run shots -- --freeze-time): the
// Worker's own clock must stand still at the seeded time too, or "updated
// 12 s ago" and every server-side age changes between two runs.
describe("the frozen clock for screenshots", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => freezeDevClock(null));

  async function seedFreeze(env: Env, host: string, freeze: boolean) {
    const qs = new URLSearchParams({ scenario: "running", now: NOW });
    if (freeze) qs.set("freeze", "1");
    const r = await worker.fetch(new Request(`http://${host}/__dev/seed?${qs}`, { method: "POST" }), env, ctx);
    return { status: r.status, text: await r.text() };
  }

  it("seed with freeze=1 pins the Worker's clock to the seeded now; a seed without it lets go", async () => {
    const { env } = devEnv();
    const r = await seedFreeze(env, "localhost:8787", true);
    expect(r.status, r.text).toBe(200);
    expect(Date.now()).toBe(Date.parse(NOW));
    expect(new Date().toISOString()).toBe(NOW);
    expect(new Date(0).toISOString()).toBe("1970-01-01T00:00:00.000Z");
    await new Promise((res) => setTimeout(res, 15));
    expect(Date.now()).toBe(Date.parse(NOW));
    expect((await api(env, "GET", "/session")).json.now).toBe(NOW);
    const again = await seedFreeze(env, "localhost:8787", false);
    expect(again.status, again.text).toBe(200);
    expect(Date.now()).not.toBe(Date.parse(NOW));
  }, 30_000);

  it("a refused seed never touches the clock", async () => {
    const { env } = makeEnv({ PUBLIC_URL: "http://localhost:8787" });
    expect((await seedFreeze(env, "localhost:8787", true)).status).toBe(404);
    expect(Date.now()).not.toBe(Date.parse(NOW));
    const dev = devEnv();
    expect((await seedFreeze(dev.env, "wg-admin.example:443", true)).status).toBe(404);
    expect(Date.now()).not.toBe(Date.parse(NOW));
  });
});
