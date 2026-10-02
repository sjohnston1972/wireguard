// api-history.test.ts
//
// Plain English: reading the history back for a time range: one point per
// step (a minute for the last hour, 5 minutes for a day, 30 minutes for a
// week, 2 hours for 30 days), availability as heartbeats received out of
// those expected, and "no data" as no data, never as 0 or 100 %.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv } from "./api-helpers";
import { readVmHistory, readClientHistory } from "../src/history";
import type { Env } from "../src/env";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const NOW = new Date("2026-10-05T12:00:00Z");
const vm = (env: Env, res: number, t: string, expected: number, received: number, rx: number) =>
  env.DB.prepare("INSERT INTO hist_vm (res, t, expected, received, rx_rate, rx_rate_max, peers_online, dns_up) VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1, 1)").bind(res, t, expected, received, rx).run();

describe("readVmHistory", () => {
  it("gives one point per minute for the last hour, with availability", async () => {
    const { env } = apiEnv();
    await vm(env, 60, "2026-10-05T11:10:00Z", 1, 1, 100);
    await vm(env, 60, "2026-10-05T11:11:00Z", 1, 0, 0);
    await vm(env, 60, "2026-10-05T10:59:00Z", 1, 1, 5); // before the hour: left out
    const h = await readVmHistory(env, "1h", NOW);
    expect(h.step).toBe(60);
    expect(h.from).toBe("2026-10-05T11:00:00Z");
    expect(h.points.map((p) => [p.t, p.received, p.rx_rate])).toEqual([["2026-10-05T11:10:00Z", 1, 100], ["2026-10-05T11:11:00Z", 0, 0]]);
    expect(h.availability).toEqual({ expected: 2, received: 1, pct: 50 });
    expect(h.latest).toBe("2026-10-05T11:10:00Z");
  });

  it("combines raw minutes and 5-minute summaries over a week, in 30-minute points", async () => {
    const { env } = apiEnv();
    await vm(env, 300, "2026-09-30T08:00:00Z", 5, 5, 10);
    await vm(env, 300, "2026-09-30T08:05:00Z", 5, 4, 30);
    await vm(env, 60, "2026-10-05T11:31:00Z", 1, 1, 50);
    const h = await readVmHistory(env, "7d", NOW);
    expect(h.step).toBe(1800);
    expect(h.points.map((p) => [p.t, p.expected, p.received, p.rx_rate])).toEqual([
      ["2026-09-30T08:00:00Z", 10, 9, 20],
      ["2026-10-05T11:30:00Z", 1, 1, 50],
    ]);
    expect(h.availability.pct).toBe(90.9);
  });

  it("says no data, not 0 % or 100 %, when nothing was recorded", async () => {
    const { env } = apiEnv();
    const h = await readVmHistory(env, "24h", NOW);
    expect(h.points).toEqual([]);
    expect(h.availability).toEqual({ expected: 0, received: 0, pct: null });
    expect(h.latest).toBeNull();
  });

  it("reads by index, never a whole table", async () => {
    const { env } = apiEnv();
    const seen: string[] = [];
    const real = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      seen.push(sql);
      return real(sql);
    });
    await readVmHistory(env, "30d", NOW);
    await readClientHistory(env, 7, "30d", NOW);
    vi.mocked(env.DB.prepare).mockRestore();
    for (const sql of seen) {
      const n = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      const plan = await real(`EXPLAIN QUERY PLAN ${sql}`).bind(...Array(n).fill(1)).all<{ detail: string }>();
      expect(plan.results.map((r) => r.detail).filter((d) => /^SCAN hist_/.test(d)), sql).toEqual([]);
    }
  });
});

describe("readClientHistory", () => {
  it("gives one client's points only", async () => {
    const { env } = apiEnv();
    const row = (peer: number, t: string, online: number, lat: number | null, rx: number) =>
      env.DB.prepare("INSERT INTO hist_client (res, t, peer_id, online, handshake_age, latency_avg, latency_max, rx, tx) VALUES (60, ?1, ?2, ?3, 10, ?4, ?4, ?5, 0)").bind(t, peer, online, lat, rx).run();
    await row(7, "2026-10-05T11:50:00Z", 1, 20, 1000);
    await row(7, "2026-10-05T11:51:00Z", 1, 40, 500);
    await row(9, "2026-10-05T11:50:00Z", 1, 5, 99);
    const h = await readClientHistory(env, 7, "1h", NOW);
    expect(h.points).toEqual([
      { t: "2026-10-05T11:50:00Z", online: 1, latency_avg: 20, latency_max: 20, rx: 1000, tx: 0 },
      { t: "2026-10-05T11:51:00Z", online: 1, latency_avg: 40, latency_max: 40, rx: 500, tx: 0 },
    ]);
    expect(h.latest).toBe("2026-10-05T11:51:00Z");
  });
});

describe("GET /history", () => {
  it("answers the VM's history", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { env } = apiEnv();
    await vm(env, 60, "2026-10-05T11:59:00Z", 1, 1, 7);
    const r = await api(env, "GET", "/history?scope=vm&range=1h");
    expect(r.status).toBe(200);
    expect(r.json.points).toHaveLength(1);
    expect(r.json.availability.pct).toBe(100);
  });

  it("refuses a bad range or scope (400) and an unknown client (404)", async () => {
    const { env } = apiEnv();
    expect((await api(env, "GET", "/history?scope=vm&range=2y")).json.error.field).toBe("range");
    expect((await api(env, "GET", "/history?scope=disk&range=1h")).json.error.field).toBe("scope");
    expect((await api(env, "GET", "/history?scope=client&range=1h&id=abc")).json.error.field).toBe("id");
    expect((await api(env, "GET", "/history?scope=client&range=1h&id=42")).status).toBe(404);
  });
});
