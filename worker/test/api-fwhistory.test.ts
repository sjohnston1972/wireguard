// api-fwhistory.test.ts
//
// Plain English: the firewall's hit history. Each heartbeat's counter
// increases are kept per rule per minute (hist_fw), folded into 5-minute
// summaries after 48 hours and expired after 30 days; the Firewall screen
// reads 24-hour hit totals, a trend and drop statistics off it; the history
// API serves one rule's chart; and Activity compares with the previous period.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, apiEnv } from "./api-helpers";
import { fwDeltas, recordHeartbeat, rollUp, readRuleHistory } from "../src/history";
import { fwHitsLast24h } from "../src/fwview";
import { lastGhRun } from "./harness";
import * as db from "../src/db";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";
import type { AgentReport, FirewallStatus, Traffic } from "../src/state";
import type { Env } from "../src/env";

let env: Env;
beforeEach(() => {
  ({ env } = apiEnv());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rows = async (sql: string) => (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;
const status = (hash: string | null, counters: Record<string, [number, number]>): FirewallStatus => ({ applied_hash: hash, error: null, counters, counters_at: null, last_hit: {}, drops: [] });

describe("schema", () => {
  it("has hist_fw, without a separate row store", async () => {
    const cols = (await rows("SELECT name FROM pragma_table_info('hist_fw')")).map((r) => r.name);
    expect(cols).toEqual(["res", "t", "rule", "packets", "bytes"]);
    const sql = (await rows("SELECT sql FROM sqlite_master WHERE name = 'hist_fw'"))[0].sql as string;
    expect(sql).toMatch(/WITHOUT ROWID/);
  });
});

describe("fwDeltas (what each counter gained since the last report)", () => {
  it("is the increase on the same rule set", () => {
    const prev = status("h1", { r1: [10, 1000], default: [5, 300] });
    expect(fwDeltas(prev, { hash: "h1", counters: { r1: [14, 1900], default: [5, 300] } })).toEqual([{ rule: "r1", packets: 4, bytes: 900 }]);
  });
  it("counts from zero when a counter went down (the VM rebooted)", () => {
    const prev = status("h1", { r1: [100, 9000] });
    expect(fwDeltas(prev, { hash: "h1", counters: { r1: [3, 200] } })).toEqual([{ rule: "r1", packets: 3, bytes: 200 }]);
  });
  it("counts from zero for every counter when the rule set changed", () => {
    const prev = status("h1", { r1: [100, 9000], default: [50, 10] });
    expect(fwDeltas(prev, { hash: "h2", counters: { r1: [120, 9500], default: [50, 10] } })).toEqual([
      { rule: "r1", packets: 120, bytes: 9500 },
      { rule: "default", packets: 50, bytes: 10 },
    ]);
  });
  it("counts the whole counter for a new counter and for the first report", () => {
    expect(fwDeltas(status("h1", {}), { hash: "h1", counters: { r2: [7, 70] } })).toEqual([{ rule: "r2", packets: 7, bytes: 70 }]);
    expect(fwDeltas(null, { hash: "h1", counters: { r2: [7, 70] } })).toEqual([{ rule: "r2", packets: 7, bytes: 70 }]);
  });
  it("gives nothing for unchanged counters, a missing report, or junk", () => {
    const prev = status("h1", { r1: [10, 1000] });
    expect(fwDeltas(prev, { hash: "h1", counters: { r1: [10, 1000] } })).toEqual([]);
    expect(fwDeltas(prev, null)).toEqual([]);
    expect(fwDeltas(prev, undefined)).toEqual([]);
    expect(fwDeltas(prev, { hash: "h1", counters: { r1: "x", r2: [-4, 1], r3: [1.9, NaN], bad: [1] } as never })).toEqual([{ rule: "r3", packets: 1, bytes: 0 }]);
  });
  it("never goes negative when only the bytes went down", () => {
    const prev = status("h1", { r1: [10, 1000] });
    expect(fwDeltas(prev, { hash: "h1", counters: { r1: [12, 500] } })).toEqual([{ rule: "r1", packets: 2, bytes: 500 }]);
  });
});

const report = (at: string): AgentReport => ({ at, hostname: "vm", uptime_seconds: 1, load: "0 0 0", listen_port: 51820, server_public_key: "S=", loopback: null, wan6: null, dns: null, peers: [] }) as AgentReport;
const traffic: Traffic = { at: "2026-10-02T10:00:00Z", rx: 0, tx: 0, rx_rate: 0, tx_rate: 0, peers_online: 0 };
const beat = (at: string, fwHits: { rule: string; packets: number; bytes: number }[]) => recordHeartbeat(env, { report: report(at), prev: null, rtt: null, traffic, drops: [], fwHits });

describe("recordHeartbeat: firewall hits", () => {
  it("adds into the minute, one row per rule that went up", async () => {
    await beat("2026-10-02T10:03:10Z", [{ rule: "r1", packets: 4, bytes: 400 }, { rule: "default", packets: 1, bytes: 60 }]);
    await beat("2026-10-02T10:03:40Z", [{ rule: "r1", packets: 2, bytes: 100 }]);
    await beat("2026-10-02T10:04:10Z", [{ rule: "r1", packets: 1, bytes: 10 }]);
    expect(await rows("SELECT res, t, rule, packets, bytes FROM hist_fw ORDER BY t, rule")).toEqual([
      { res: 60, t: "2026-10-02T10:03:00Z", rule: "default", packets: 1, bytes: 60 },
      { res: 60, t: "2026-10-02T10:03:00Z", rule: "r1", packets: 6, bytes: 500 },
      { res: 60, t: "2026-10-02T10:04:00Z", rule: "r1", packets: 1, bytes: 10 },
    ]);
  });
  it("writes no firewall row when nothing went up", async () => {
    await beat("2026-10-02T10:03:10Z", []);
    expect(await rows("SELECT * FROM hist_fw")).toEqual([]);
  });
  it("adds one statement per rising counter to the heartbeat's batch, none when idle", async () => {
    const real = env.DB.batch.bind(env.DB);
    const sizes: number[] = [];
    vi.spyOn(env.DB, "batch").mockImplementation(async (s: D1PreparedStatement[]) => {
      sizes.push(s.length);
      return real(s);
    });
    await beat("2026-10-02T10:03:10Z", [{ rule: "r1", packets: 1, bytes: 1 }]);
    await beat("2026-10-02T10:03:40Z", []);
    vi.mocked(env.DB.batch).mockRestore();
    expect(sizes).toEqual([2, 1]);
  });
});

describe("rollUp: hist_fw", () => {
  const NOW = new Date("2026-10-05T12:00:00Z");
  it("folds raw rows older than 48 hours into 5-minute summaries, keeps recent ones, expires old summaries", async () => {
    const ins = (res: number, t: string, rule: string, p: number, b: number) => env.DB.prepare("INSERT INTO hist_fw (res, t, rule, packets, bytes) VALUES (?1, ?2, ?3, ?4, ?5)").bind(res, t, rule, p, b).run();
    await ins(60, "2026-10-03T11:50:00Z", "r1", 1, 10);
    await ins(60, "2026-10-03T11:52:00Z", "r1", 2, 20);
    await ins(60, "2026-10-03T11:52:00Z", "default", 5, 50);
    await ins(60, "2026-10-05T11:00:00Z", "r1", 9, 90); // recent: stays raw
    await ins(300, "2026-10-03T11:50:00Z", "r1", 100, 1000); // an earlier fold into the same slot: added to
    await ins(300, "2026-09-04T11:55:00Z", "r1", 1, 1); // older than 30 days
    await rollUp(env, NOW);
    expect(await rows("SELECT res, t, rule, packets, bytes FROM hist_fw ORDER BY res, t, rule")).toEqual([
      { res: 60, t: "2026-10-05T11:00:00Z", rule: "r1", packets: 9, bytes: 90 },
      { res: 300, t: "2026-10-03T11:50:00Z", rule: "default", packets: 5, bytes: 50 },
      { res: 300, t: "2026-10-03T11:50:00Z", rule: "r1", packets: 103, bytes: 1030 },
    ]);
  });

  it("reads hist_fw by index only, in the tidy-up and in every read", async () => {
    const seen: string[] = [];
    const real = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      seen.push(sql);
      return real(sql);
    });
    await rollUp(env, NOW);
    await readRuleHistory(env, "r1", "30d", NOW);
    await fwHitsLast24h(env, NOW.getTime());
    vi.mocked(env.DB.prepare).mockRestore();
    const fw = seen.filter((s) => s.includes("hist_fw"));
    expect(fw.length).toBeGreaterThanOrEqual(5);
    for (const sql of fw) {
      const n = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      const plan = await real(`EXPLAIN QUERY PLAN ${sql}`).bind(...Array(n).fill("2026-10-01T00:00:00Z")).all<{ detail: string }>();
      expect(plan.results.map((r) => r.detail).filter((d) => /^SCAN hist_fw/.test(d)), sql).toEqual([]);
    }
  });
});

// ── The heartbeat, end to end ──

const DUMP = (lines: string[]) => ["PRIV\tS=\t51820\toff", ...lines].join("\n");

async function running(e: Env, world: ReturnType<typeof apiEnv>["world"]) {
  const run = await startDeploy(e, { hours: 4, requesterIp: null, requestedBy: "dev@localhost" });
  const sec = await issueRunSecrets(e, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(e, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return sec.body.agent_token as string;
}

describe("the heartbeat records firewall hits", () => {
  it("stores increases, counts a reset from zero, and writes nothing when idle", async () => {
    const w = apiEnv();
    env = w.env;
    const token = await running(env, w.world);
    const hb = (hash: string, counters: Record<string, [number, number]>) => handleAgent(env, token, { dump: DUMP([]), firewall: { hash, counters } });
    const total = async (rule: string) => Number((await rows(`SELECT COALESCE(SUM(packets), 0) AS n FROM hist_fw WHERE rule = '${rule}'`))[0].n);
    await hb("h1", { r1: [10, 1000], default: [2, 100] }); // first report: whole counters
    expect(await total("r1")).toBe(10);
    await hb("h1", { r1: [10, 1000], default: [2, 100] }); // idle
    expect(await total("r1")).toBe(10);
    await hb("h1", { r1: [15, 1500], default: [2, 100] }); // +5
    expect(await total("r1")).toBe(15);
    await hb("h1", { r1: [3, 200], default: [2, 100] }); // the VM rebooted: counts from zero
    expect(await total("r1")).toBe(18);
    await hb("h2", { r1: [4, 300], default: [0, 0] }); // new rule set: counts from zero
    expect(await total("r1")).toBe(22);
    expect(await total("default")).toBe(2);
    expect(await rows("SELECT packets FROM hist_fw WHERE packets <= 0")).toEqual([]);
  });

  it("never costs the VM its heartbeat when the recorder fails", async () => {
    const w = apiEnv();
    env = w.env;
    const token = await running(env, w.world);
    await env.DB.prepare("DROP TABLE hist_fw").run();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await handleAgent(env, token, { dump: DUMP([]), firewall: { hash: "h1", counters: { r1: [1, 1] } } });
    err.mockRestore();
    expect(r.status).toBe(200);
  });
});

// ── GET /firewall ──

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const MIN = 60_000, HOUR = 3_600_000;
const hit = (rule: string, agoMs: number, packets: number, now: number) => env.DB.prepare("INSERT INTO hist_fw (res, t, rule, packets, bytes) VALUES (60, ?1, ?2, ?3, ?3)").bind(iso(Math.floor((now - agoMs) / MIN) * MIN), rule, packets).run();
const drop = (agoMs: number, src: string, n: number, now: number) => env.DB.prepare("INSERT INTO hist_drops (t, src, dst, proto, dport, n) VALUES (?1, ?2, '10.13.13.2', 'TCP', 22, ?3)").bind(iso(Math.floor((now - agoMs) / MIN) * MIN), src, n).run();
/** A minute the VM was up and heartbeating. */
const vmUp = (agoMs: number, now: number) => env.DB.prepare("INSERT INTO hist_vm (res, t, expected, received) VALUES (60, ?1, 1, 1)").bind(iso(Math.floor((now - agoMs) / MIN) * MIN)).run();

describe("GET /firewall: hit history and drop statistics", () => {
  it("has no hits history (null, empty trend) before anything was recorded, and no drops per hour while the VM never ran", async () => {
    const r = await api(env, "GET", "/firewall");
    expect(r.status).toBe(200);
    expect(r.json.rules[0]).toMatchObject({ hits24h: null, trend24h: [] });
    expect(r.json).toMatchObject({ defaultHits24h: null, defaultTrend24h: [] });
    expect(r.json.drops).toMatchObject({ last24h: 0, uniqueSources24h: 0, previous24h: 0, hourly24h: Array(24).fill(null) });
  });

  it("hours when the VM was not running are null, not 0, in the hit trends and the drops per hour", async () => {
    const now = Date.now();
    await vmUp(10 * MIN, now); // the newest hour (index 23)
    await vmUp(2 * HOUR + 10 * MIN, now); // index 21: up, nothing happened
    await vmUp(5 * HOUR + 10 * MIN, now); // index 18
    const [starter] = await db.listFwRules(env);
    await hit(`r${starter.id}`, 10 * MIN, 5, now);
    await hit(`r${starter.id}`, 5 * HOUR + 10 * MIN, 7, now);
    await drop(10 * MIN, "203.0.113.1", 4, now);
    const r = await api(env, "GET", "/firewall");
    const expected = (vals: Record<number, number>) => Array.from({ length: 24 }, (_, i) => vals[i] ?? null);
    expect(r.json.rules.find((x: { id: number }) => x.id === starter.id).trend24h).toEqual(expected({ 18: 7, 21: 0, 23: 5 }));
    expect(r.json.defaultTrend24h).toEqual(expected({ 18: 0, 21: 0, 23: 0 }));
    expect(r.json.drops.hourly24h).toEqual(expected({ 18: 0, 21: 0, 23: 4 }));
  });

  it("gives 24-hour hits and an hourly trend per rule and for the default, and flags the starter rules", async () => {
    const now = Date.now();
    await db.addFwRule(env, { enabled: 1, name: "Mine", src_kind: "any", src_value: "", dst_kind: "any", dst_value: "", proto: "any", ports: "", action: "allow", log: 0 });
    const rules = await db.listFwRules(env);
    const starter = rules[0];
    const mine = rules.find((r) => r.name === "Mine")!;
    await hit(`r${starter.id}`, 10 * MIN, 5, now); // the newest hour
    await hit(`r${starter.id}`, 11 * MIN, 2, now);
    await hit(`r${starter.id}`, 5 * HOUR + 10 * MIN, 7, now);
    await hit(`r${starter.id}`, 25 * HOUR, 99, now); // outside the 24 hours
    await hit("default", 90 * MIN, 3, now);
    const r = await api(env, "GET", "/firewall");
    const s = r.json.rules.find((x: { id: number }) => x.id === starter.id);
    expect(s.hits24h).toBe(14);
    expect(s.trend24h).toHaveLength(24);
    expect(s.trend24h.reduce((a: number, b: number | null) => a + (b ?? 0), 0)).toBe(14);
    expect(s.trend24h[23]).toBe(7);
    expect(s.starter).toBe(true);
    const m = r.json.rules.find((x: { id: number }) => x.id === mine.id);
    expect(m).toMatchObject({ hits24h: 0, starter: false }); // history exists, this rule did not match
    expect(r.json.defaultHits24h).toBe(3);
    expect(r.json.defaultTrend24h.reduce((a: number, b: number | null) => a + (b ?? 0), 0)).toBe(3);
  });

  it("a renamed starter rule is no longer a starter", async () => {
    const [first] = await db.listFwRules(env);
    await db.updateFwRule(env, first.id, { name: "Clients to the internet (mine)" });
    const r = await api(env, "GET", "/firewall");
    expect(r.json.rules.find((x: { id: number }) => x.id === first.id).starter).toBe(false);
  });

  it("counts unique sources, the previous 24 hours and drops per hour", async () => {
    const now = Date.now();
    await drop(10 * MIN, "203.0.113.1", 4, now);
    await drop(2 * HOUR, "203.0.113.1", 1, now);
    await drop(3 * HOUR, "203.0.113.2", 2, now);
    await drop(30 * HOUR, "203.0.113.9", 6, now); // the day before
    await drop(40 * HOUR, "203.0.113.8", 1, now); // the day before
    await drop(50 * HOUR, "203.0.113.7", 50, now); // two days back: neither
    const r = await api(env, "GET", "/firewall");
    expect(r.json.drops).toMatchObject({ last24h: 7, uniqueSources24h: 2, previous24h: 7 });
    expect(r.json.drops.hourly24h).toHaveLength(24);
    expect(r.json.drops.hourly24h.reduce((a: number, b: number | null) => a + (b ?? 0), 0)).toBe(7);
    expect(r.json.drops.hourly24h[23]).toBe(4);
  });

  it("the new reads use the time index, not a scan", async () => {
    const seen: string[] = [];
    const real = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      seen.push(sql);
      return real(sql);
    });
    await api(env, "GET", "/firewall");
    vi.mocked(env.DB.prepare).mockRestore();
    const mine = seen.filter((s) => /hist_(drops|fw|vm)/.test(s));
    expect(mine.length).toBeGreaterThanOrEqual(4);
    for (const sql of mine) {
      const n = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      const plan = await real(`EXPLAIN QUERY PLAN ${sql}`).bind(...Array(n).fill("2026-10-01T00:00:00Z")).all<{ detail: string }>();
      expect(plan.results.map((p) => p.detail).filter((d) => /^SCAN hist_/.test(d)), sql).toEqual([]);
    }
  });
});

// ── GET /history?scope=rule ──

describe("GET /history?scope=rule", () => {
  it("gives a rule's points with the same ranges and steps", async () => {
    const now = Date.now();
    await hit("r5", 10 * MIN, 4, now);
    await hit("r5", 20 * MIN, 1, now);
    await hit("r6", 10 * MIN, 9, now);
    const r = await api(env, "GET", "/history?scope=rule&id=r5&range=24h");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ range: "24h", step: 300 });
    expect(r.json.points.reduce((a: number, p: { packets: number }) => a + p.packets, 0)).toBe(5);
    expect(r.json.points.every((p: { bytes: number }) => p.bytes > 0)).toBe(true);
    expect(r.json.latest).toBe(r.json.points.at(-1).t);
    expect((await api(env, "GET", "/history?scope=rule&id=default&range=1h")).status).toBe(200);
    expect((await api(env, "GET", "/history?scope=rule&id=f3&range=7d")).status).toBe(200);
  });
  it("is empty, not zeros, when nothing was recorded", async () => {
    const r = await api(env, "GET", "/history?scope=rule&id=r9&range=30d");
    expect(r.status).toBe(200);
    expect(r.json.points).toEqual([]);
    expect(r.json.latest).toBeNull();
  });
  it("refuses an id that is not a counter key, naming the field", async () => {
    for (const id of ["", "x1", "r", "r0", "r-1", "r1;DROP", "R1", "default2"]) {
      const r = await api(env, "GET", `/history?scope=rule&id=${encodeURIComponent(id)}&range=24h`);
      expect(r.status, id).toBe(400);
      expect(r.json.error.field).toBe("id");
    }
    expect((await api(env, "GET", "/history?scope=rule&range=24h")).status).toBe(400);
  });
  it("still serves the other scopes and names rule in the scope message", async () => {
    expect((await api(env, "GET", "/history?scope=vm&range=1h")).status).toBe(200);
    const bad = await api(env, "GET", "/history?scope=nope&range=1h");
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain("rule");
  });
});

// ── GET /activity previous ──

describe("GET /activity: previous period", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const run = async (id: string, status: string, requestedAgo: number, tookMs: number) => {
    await db.createRun(env, { id, action: "apply", status: status as never, requested_at: ago(requestedAgo), requested_by: "dev@localhost", callback_token_hash: "CBHASH", agent_token_hash: "AGHASH", payload_json: '{"x":"PAYLOADSECRET"}', auto_destroy_at: null, reason: null, ssh_password: "hunter2-secret" });
    await db.updateRun(env, id, { started_at: ago(requestedAgo), finished_at: ago(requestedAgo - tookMs) });
  };
  it("has the same figures for the equally long period just before the range", async () => {
    await run("now-ok", "success", 2 * HOUR, 20 * MIN);
    await run("prev-ok", "success", 30 * HOUR, 10 * MIN);
    await run("prev-ok2", "success", 40 * HOUR, 30 * MIN);
    await run("prev-bad", "failure", 41 * HOUR, 0);
    await run("older", "success", 60 * HOUR, 10 * MIN); // two periods back: in neither
    await env.DB.prepare("INSERT INTO alerts (at, kind, message) VALUES (?1, 'failure', 'old problem')").bind(ago(30 * HOUR)).run();
    await env.DB.prepare("INSERT INTO audit (at, user, action, target, before_json, after_json) VALUES (?1, 'dev@localhost', 'client.add', 'A', NULL, '{}'), (?2, 'dev@localhost', 'client.add', 'B', NULL, '{}')").bind(ago(35 * HOUR), ago(10 * MIN)).run();
    const r = await api(env, "GET", "/activity?range=24h");
    expect(r.status).toBe(200);
    expect(r.json.kpis).toMatchObject({ deploys: 1, configChanges: 1, watchmanProblems: 0 });
    expect(r.json.previous).toEqual({
      deploys: 2,
      medianDeploySeconds: 1200,
      successRate: { success: 2, finished: 3, pct: 67 },
      failedRuns: 1,
      configChanges: 1,
      watchmanProblems: 1,
    });
    expect(JSON.stringify(r.json)).not.toMatch(/hunter2|CBHASH|AGHASH|PAYLOADSECRET/);
  });
  it("is all zeros and no percentage when nothing happened before", async () => {
    const r = await api(env, "GET", "/activity?range=7d");
    expect(r.json.previous).toEqual({ deploys: 0, medianDeploySeconds: null, successRate: { success: 0, finished: 0, pct: null }, failedRuns: 0, configChanges: 0, watchmanProblems: 0 });
  });
});
