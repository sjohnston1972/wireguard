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
