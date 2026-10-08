// demo-vibrant.test.ts
//
// Plain English: what Steven asked of the demo on 2026-10-08, "a vibrant busy
// dashboard", proved through the real demo path (the DemoStore serving the
// app's own code), at the moment it is seeded and long after:
//   - nothing goes stale: the heartbeat is fresh and the key metrics are not
//     greyed (heartbeatStale false), whenever the demo is looked at;
//   - about six clients are connected, of a longer list;
//   - the firewall's hits and drops fill the last 24 hours, and every history
//     range has points up to now;
//   - the costs are clearly visible, but this month, its forecast and the
//     budget picture stay under £50 with a budget of about £60 (nothing "over").
import { describe, it, expect, afterEach, vi } from "vitest";
import { makeEnv, demoInstance } from "./harness";
import { DEMO_DAILY_ROWS, DEMO_STALE_MS, type DemoStore } from "../src/demo/store";

type Json = any;

const NOW = "2026-10-08T10:00:00.000Z";
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const base = "https://wg-admin.example";

afterEach(() => {
  vi.useRealTimers();
});

async function get(store: DemoStore, path: string): Promise<Json> {
  const r = await store.serve(new Request(`${base}/api/v1${path}`), "dev@localhost");
  expect(r.status, path).toBe(200);
  return JSON.parse(await r.text());
}

/** Everything the demo must show at the real time `nowMs` (the fake clock is set there). */
async function expectLively(store: DemoStore, nowMs: number): Promise<void> {
  const ov = await get(store, "/overview");
  // The answer speaks of now, not of the seed time.
  expect(Math.abs(Date.parse(ov.now) - nowMs)).toBeLessThanOrEqual(MIN);
  expect(ov.snapshot.state).toBe("running");
  expect(ov.derived.heartbeatStale).toBe(false);
  const beatAge = nowMs - Date.parse(ov.snapshot.last_agent_at);
  expect(beatAge).toBeGreaterThanOrEqual(0);
  expect(beatAge).toBeLessThan(2 * MIN);
  // About six connected, of a longer list.
  expect(ov.derived.clientsOnline).toBeGreaterThanOrEqual(6);
  expect(ov.derived.clientsOnline).toBeLessThanOrEqual(7);
  expect(ov.derived.clientsEnabled).toBeGreaterThanOrEqual(10);

  const clients = await get(store, "/clients");
  expect(clients.clients.length).toBeGreaterThanOrEqual(10);

  // Firewall: hits and drops across the whole last 24 hours.
  const fw = await get(store, "/firewall");
  expect(fw.running).toBe(true);
  expect(fw.drops.last24h).toBeGreaterThan(100);
  expect(fw.drops.recent.length).toBeGreaterThan(5);
  expect(nowMs - Date.parse(fw.drops.recent[0].at)).toBeLessThan(15 * MIN);
  expect(fw.drops.hourly24h.filter((n: number | null) => (n ?? 0) > 0).length).toBeGreaterThanOrEqual(18);
  expect(fw.drops.previous24h).toBeGreaterThan(0);
  const busiest = fw.rules[0];
  expect(busiest.trend24h.filter((n: number | null) => (n ?? 0) > 0).length).toBeGreaterThanOrEqual(20);
  expect(fw.defaultTrend24h.filter((n: number | null) => (n ?? 0) > 0).length).toBeGreaterThanOrEqual(18);

  // History: every range the widgets offer has points, the newest close to now.
  for (const [range, fresh] of [["1h", 5 * MIN], ["24h", 10 * MIN], ["7d", 40 * MIN], ["30d", 3 * HOUR]] as const) {
    const h = await get(store, `/history?scope=vm&range=${range}`);
    const minPoints = { "1h": 25, "24h": 120, "7d": 80, "30d": 90 }[range];
    expect(h.points.length, `vm ${range}`).toBeGreaterThanOrEqual(minPoints);
    expect(nowMs - Date.parse(h.latest), `vm ${range} latest`).toBeLessThan(fresh);
    expect(h.availability.pct, `vm ${range} availability`).toBeGreaterThan(95);
    // Traffic is moving at every point (a heartbeat gap of 10 minutes or more would read as no rate).
    const moving = h.points.filter((p: Json) => (p.tx_rate ?? 0) > 0).length;
    expect(moving / h.points.length, `vm ${range} traffic`).toBeGreaterThan(0.95);
    const rule = await get(store, `/history?scope=rule&id=r${busiest.id}&range=${range}`);
    expect(rule.points.filter((p: Json) => p.packets > 0).length, `rule ${range}`).toBeGreaterThanOrEqual(range === "1h" ? 20 : 20);
  }

  // Cost: clearly visible, under £50 for the month, a budget of about £60, nothing over.
  const cost = await get(store, "/cost?range=month");
  expect(cost.session.estimateGbp).toBeGreaterThan(1);
  expect(cost.meta.hourlyRateGbp).toBeGreaterThan(0.05);
  expect(cost.monthToDate).toBeLessThan(50);
  expect(cost.projection.gbp).toBeGreaterThan(20);
  expect(cost.projection.gbp).toBeLessThan(50);
  expect(cost.budget.budget).toBeGreaterThanOrEqual(55);
  expect(cost.budget.budget).toBeLessThanOrEqual(65);
  expect(cost.budget.total).toBeLessThan(50);
  expect(cost.budget.level).not.toBe("over");
  const days = cost.daily.filter((d: Json) => d.gbp > 0.5);
  expect(days.length).toBeGreaterThanOrEqual(Math.min(5, new Date(nowMs).getUTCDate() - 1));
  const last30 = await get(store, "/cost?range=30d");
  expect(last30.daily.filter((d: Json) => d.gbp > 0.3).length).toBeGreaterThanOrEqual(20);
  expect(last30.labs ?? cost.labs).toBeDefined();
}

describe("the demo is busy and never goes stale", () => {
  it("fresh, 11 hours later (no re-seed: the clock moves), and 3 days later with no re-seed allowed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const { env } = makeEnv();
    const { store, state } = demoInstance(env);
    expect((await store.refresh(NOW)).ok).toBe(true);
    await expectLively(store, Date.parse(NOW));

    // 11 h 17 min 42 s later: under the 12-hour re-seed, so the same data, on the moved clock.
    const later = Date.parse(NOW) + 11 * HOUR + 17 * MIN + 42_000;
    vi.setSystemTime(new Date(later));
    await expectLively(store, later);
    expect((await store.status(new Date(later).toISOString())).refreshedAt).toBe(NOW);

    // 3 days later, today's refresh allowance already spent: the old data, still live.
    const much = Date.parse(NOW) + 3 * DAY + 5 * HOUR + 3 * MIN;
    vi.setSystemTime(new Date(much));
    state.sql.exec("UPDATE _demo_meta SET v = ?1 WHERE k = 'day'", new Date(much).toISOString().slice(0, 10));
    state.sql.exec("UPDATE _demo_meta SET v = ?1 WHERE k = 'rowsToday'", String(DEMO_DAILY_ROWS));
    await expectLively(store, much);
    expect((await store.status(new Date(much).toISOString())).refreshedAt).toBe(NOW);
  }, 300_000);

  it("a read over 12 hours after the seed re-seeds, budget permitting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const { env } = makeEnv();
    const { store } = demoInstance(env);
    expect((await store.refresh(NOW)).ok).toBe(true);
    const later = new Date(Date.parse(NOW) + DEMO_STALE_MS + HOUR).toISOString();
    vi.setSystemTime(new Date(later));
    await get(store, "/overview");
    expect((await store.status(later)).refreshedAt).toBe(later);
  }, 300_000);

  it("a store seeded with an older story re-seeds on the next read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const { env } = makeEnv();
    const { store, state } = demoInstance(env);
    expect((await store.refresh(NOW)).ok).toBe(true);
    state.sql.exec("DELETE FROM _demo_meta WHERE k = 'storyVersion'");
    const later = new Date(Date.parse(NOW) + 20 * MIN).toISOString();
    vi.setSystemTime(new Date(later));
    await get(store, "/overview");
    expect((await store.status(later)).refreshedAt).toBe(later);
  }, 300_000);

  for (const when of ["2026-11-01T06:00:00.000Z", "2026-11-02T09:30:00.000Z", "2026-10-17T13:00:00.000Z", "2026-10-31T22:45:00.000Z", "2027-02-28T20:00:00.000Z"]) {
    it(`seeded on ${when.slice(0, 10)}: the month, its forecast and the budget picture stay under £50, with a budget of £60`, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(when));
      const { env } = makeEnv();
      const { store } = demoInstance(env);
      expect((await store.refresh(when)).ok).toBe(true);
      const cost = await get(store, "/cost?range=month");
      expect(cost.monthToDate).toBeLessThan(50);
      // The 1st of a month has no Azure day of its own yet: no forecast at all, never a wrong one.
      if (cost.projection) expect(cost.projection.gbp).toBeLessThan(50);
      expect(cost.budget.budget).toBe(60);
      expect(cost.budget.total).toBeLessThan(50);
      expect(cost.budget.level).toBe("ok");
      expect(cost.session.estimateGbp).toBeGreaterThan(1);
      const last30 = await get(store, "/cost?range=30d");
      expect(Math.max(...last30.daily.map((d: Json) => d.gbp))).toBeLessThanOrEqual(1.5);
    }, 300_000);
  }

  it("one refresh stays within the budget, so two can run in a day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const { env } = makeEnv();
    const { store } = demoInstance(env);
    expect((await store.refresh(NOW)).ok).toBe(true);
    const st = await store.status(NOW);
    // rowsToday + 2 × lastRows must leave room for a second refresh today.
    // With room to spare: a real Durable Object counted about 8% more rows than this harness for the same seed (2026-10-08).
    expect(st.lastRows * 3.3).toBeLessThanOrEqual(DEMO_DAILY_ROWS);
  }, 300_000);
});
