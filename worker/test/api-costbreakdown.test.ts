// api-costbreakdown.test.ts
//
// Plain English: Azure's actual cost split by type and region. The daily
// pull stores one row per day, service and location (and running it twice
// changes nothing); a failing split query leaves the plain daily figures
// alone; the Cost page's data adds the split for the range, as shares that
// add up, falling back to the sessions' estimate and then to nothing; old
// rows expire; and the reads and deletes use the table's key.
import { describe, it, expect, vi, afterEach } from "vitest";
import { api, apiEnv } from "./api-helpers";
import { runScheduled } from "../src/monitor";
import { costType, breakdownOf } from "../src/costview";
import * as db from "../src/db";

const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 8);
const rows = [
  { day: `${month}01`, service: "Virtual Machines", location: "UK South", gbp: 0.4 },
  { day: `${month}01`, service: "Bandwidth", location: "UK South", gbp: 0.1 },
  { day: `${month}01`, service: "Storage", location: "UK South", gbp: 0.2 },
  { day: `${month}01`, service: "Azure DNS", location: "", gbp: 0.05 },
  { day: `${month}01`, service: "Virtual Machines", location: "North Europe", gbp: 0.25 },
];
const stored = async (env: any) => (await env.DB.prepare("SELECT day, category, location, gbp FROM cost_breakdown ORDER BY day, category, location").all()).results;

describe("costType", () => {
  it("maps Azure's service names to the four groups", () => {
    expect(costType("Virtual Machines")).toBe("compute");
    for (const n of ["Bandwidth", "Virtual Network", "IP Addresses", "Load Balancer"]) expect(costType(n)).toBe("network");
    for (const n of ["Storage", "Managed Disks"]) expect(costType(n)).toBe("disk");
    expect(costType("Azure DNS")).toBe("other");
    expect(costType("")).toBe("other");
  });
  it("ignores case", () => expect(costType("virtual machines")).toBe("compute"));
});

describe("the daily pull", () => {
  it("stores the split rows, locations tidied, and keeps the plain daily figures", async () => {
    const { env, world } = apiEnv();
    world.costRows = rows;
    await runScheduled(env);
    expect(await stored(env)).toEqual([
      { day: `${month}01`, category: "Azure DNS", location: "", gbp: 0.05 },
      { day: `${month}01`, category: "Bandwidth", location: "uksouth", gbp: 0.1 },
      { day: `${month}01`, category: "Storage", location: "uksouth", gbp: 0.2 },
      { day: `${month}01`, category: "Virtual Machines", location: "northeurope", gbp: 0.25 },
      { day: `${month}01`, category: "Virtual Machines", location: "uksouth", gbp: 0.4 },
    ]);
    expect((await db.costDays(env, `${month}01`)).map((d) => d.gbp)).toEqual([1]);
  });

  it("is idempotent: pulling again gives the same rows", async () => {
    const { env, world } = apiEnv();
    world.costRows = rows;
    await runScheduled(env);
    const first = await stored(env);
    await env.STATUS.delete("cost:fetched_day");
    await env.STATUS.delete("cost:breakdown_day");
    await runScheduled(env);
    expect(await stored(env)).toEqual(first);
  });

  it("a failing split query leaves cost_days filled, and is tried again next time", async () => {
    const { env, world } = apiEnv();
    world.costRows = rows;
    world.costGroupedFail = 500;
    const notes = await runScheduled(env);
    expect((await db.costDays(env, `${month}01`)).map((d) => d.gbp)).toEqual([1]);
    expect(await stored(env)).toEqual([]);
    expect(notes.join("\n")).toMatch(/cost breakdown/);
    world.costGroupedFail = undefined;
    await runScheduled(env);
    expect((await stored(env)).length).toBe(5);
  });

  it("sends the same scope as the daily query, grouped by service and location", async () => {
    const { env, world } = apiEnv();
    world.costRows = rows;
    const bodies: any[] = [];
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (i: any, init?: RequestInit) => {
      if (String(i?.url ?? i).includes("CostManagement")) bodies.push(JSON.parse(String(init?.body)));
      return inner(i, init);
    });
    await runScheduled(env);
    expect(bodies).toHaveLength(2);
    const [plain, grouped] = bodies;
    expect(grouped.dataset.grouping).toEqual([{ type: "Dimension", name: "ServiceName" }, { type: "Dimension", name: "ResourceLocation" }]);
    expect({ ...grouped, dataset: { ...grouped.dataset, grouping: undefined } }).toEqual({ ...plain, dataset: { ...plain.dataset, grouping: undefined } });
  });
});

// Azure's figures lag by up to a day, and the pull runs soon after UTC
// midnight, so month to date on the 1st would never go back for the last
// day or two of the month before. For the first 3 days of a month both
// queries reach back to the 1st of the previous month.
describe("the month boundary", () => {
  const capture = () => {
    const bodies: any[] = [];
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (i: any, init?: RequestInit) => {
      if (String(i?.url ?? i).includes("CostManagement")) bodies.push(JSON.parse(String(init?.body)));
      return inner(i, init);
    });
    return bodies;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("on the 2nd, both queries cover the 1st of the previous month to today, and late figures overwrite the earlier ones", async () => {
    const { env, world } = apiEnv();
    await db.upsertCostDay(env, "2026-10-31", 0.1); // pulled on the 31st, before Azure had the whole day
    await db.upsertCostBreakdown(env, [{ day: "2026-10-31", category: "Virtual Machines", location: "uksouth", gbp: 0.1 }]);
    world.costRows = [
      { day: "2026-10-31", service: "Virtual Machines", location: "UK South", gbp: 0.5 },
      { day: "2026-11-01", service: "Virtual Machines", location: "UK South", gbp: 0.3 },
    ];
    const bodies = capture();
    await runScheduled(env, new Date("2026-11-02T00:30:00Z"));
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b.timeframe).toBe("Custom");
      expect(b.timePeriod).toEqual({ from: "2026-10-01T00:00:00Z", to: "2026-11-02T23:59:59Z" });
    }
    expect(await db.costDays(env, "2026-10-01")).toMatchObject([{ day: "2026-10-31", gbp: 0.5 }, { day: "2026-11-01", gbp: 0.3 }]);
    expect(await stored(env)).toEqual([
      { day: "2026-10-31", category: "Virtual Machines", location: "uksouth", gbp: 0.5 },
      { day: "2026-11-01", category: "Virtual Machines", location: "uksouth", gbp: 0.3 },
    ]);
  });

  it("on the 1st of January it reaches back into December of the year before", async () => {
    const { env, world } = apiEnv();
    world.costRows = [];
    const bodies = capture();
    await runScheduled(env, new Date("2027-01-01T00:30:00Z"));
    expect(bodies.map((b) => b.timePeriod)).toEqual([
      { from: "2026-12-01T00:00:00Z", to: "2027-01-01T23:59:59Z" },
      { from: "2026-12-01T00:00:00Z", to: "2027-01-01T23:59:59Z" },
    ]);
  });

  it("on the 15th, both queries are month to date as before", async () => {
    const { env, world } = apiEnv();
    world.costRows = [];
    const bodies = capture();
    await runScheduled(env, new Date("2026-11-15T00:30:00Z"));
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b.timeframe).toBe("MonthToDate");
      expect(b.timePeriod).toBeUndefined();
    }
  });
});

describe("expiry", () => {
  it("drops rows older than 400 days and keeps the rest", async () => {
    const { env } = apiEnv();
    const now = new Date("2026-10-02T12:00:00Z");
    await db.upsertCostBreakdown(env, [
      { day: "2025-08-27", category: "Storage", location: "uksouth", gbp: 1 }, // 401 days back
      { day: "2025-08-28", category: "Storage", location: "uksouth", gbp: 1 }, // 400 days back
    ]);
    await db.pruneCostBreakdown(env, now);
    expect((await stored(env)).map((r: any) => r.day)).toEqual(["2025-08-28"]);
  });
});

describe("breakdownOf", () => {
  it("shares add up to 100 within rounding, and leave out zero slices", () => {
    const b = breakdownOf(
      [
        { category: "Virtual Machines", location: "uksouth", gbp: 1 },
        { category: "Bandwidth", location: "uksouth", gbp: 1 },
        { category: "Storage", location: "northeurope", gbp: 1 },
        { category: "Azure DNS", location: "northeurope", gbp: 0 },
      ],
      "2026-10-01",
    )!;
    expect(b.byType.map((t) => t.type).sort()).toEqual(["compute", "disk", "network"]);
    expect(b.byType.reduce((a, t) => a + t.pct, 0)).toBeCloseTo(100, 0);
    expect(b.byRegion.map((r) => r.location).sort()).toEqual(["northeurope", "uksouth"]);
    expect(b.byRegion.find((r) => r.location === "uksouth")).toMatchObject({ name: "UK South (London)", gbp: 2 });
    expect([...b.byType, ...b.byRegion].every((x) => x.pct > 0)).toBe(true);
  });
});

describe("GET /cost breakdown", () => {
  const put = (env: any, r: { day: string; category: string; location: string; gbp: number }) => db.upsertCostBreakdown(env, [r]);

  it("is null with neither actuals nor sessions", async () => {
    const { env } = apiEnv();
    expect((await api(env, "GET", "/cost")).json.breakdown).toBeNull();
  });

  it("uses Azure's rows for the range, as azure", async () => {
    const { env } = apiEnv();
    await put(env, { day: `${month}01`, category: "Virtual Machines", location: "uksouth", gbp: 3 });
    await put(env, { day: `${month}01`, category: "Bandwidth", location: "uksouth", gbp: 1 });
    await put(env, { day: `${month}01`, category: "Azure DNS", location: "", gbp: 0.5 });
    await put(env, { day: "2020-01-01", category: "Storage", location: "uksouth", gbp: 99 });
    const b = (await api(env, "GET", "/cost?range=month")).json.breakdown;
    expect(b.basis).toBe("azure");
    expect(b.asOfDay).toBe(`${month}01`);
    expect(b.byType).toEqual([
      { type: "compute", gbp: 3, pct: 66.7 },
      { type: "network", gbp: 1, pct: 22.2 },
      { type: "other", gbp: 0.5, pct: 11.1 },
    ]);
    expect(b.byRegion.map((r: any) => [r.location, r.name, r.gbp])).toEqual([["uksouth", "UK South (London)", 4], ["", "Unassigned", 0.5]]);
    expect(b.byType.reduce((a: number, t: any) => a + t.pct, 0)).toBeCloseTo(100, 0);
  });

  it("falls back to the sessions' estimate by region, with no types", async () => {
    const { env } = apiEnv();
    const started = new Date(Date.now() - 600_000).toISOString();
    await db.createRun(env, { id: "run-a", action: "apply", status: "success", requested_at: started, requested_by: "steven", callback_token_hash: "x", agent_token_hash: "y", payload_json: JSON.stringify({ region: "northeurope" }), auto_destroy_at: null, reason: null, ssh_password: null });
    await db.updateRun(env, "run-a", { finished_at: started });
    const b = (await api(env, "GET", "/cost")).json.breakdown;
    expect(b.basis).toBe("estimate");
    expect(b.byType).toEqual([]);
    expect(b.asOfDay).toBeNull();
    expect(b.byRegion).toHaveLength(1);
    expect(b.byRegion[0]).toMatchObject({ location: "northeurope", name: "North Europe (Dublin)", pct: 100 });
    expect(b.byRegion[0].gbp).toBeGreaterThan(0);
  });
});

describe("the range read and the expiry use the key", () => {
  it("never scan the whole table", async () => {
    const { env } = apiEnv();
    const seen: string[] = [];
    const real = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      seen.push(sql);
      return real(sql);
    });
    await db.costBreakdownRange(env, "2026-10-01", "2026-10-31");
    await db.pruneCostBreakdown(env, new Date("2026-10-02T12:00:00Z"));
    vi.mocked(env.DB.prepare).mockRestore();
    const mine = seen.filter((s) => /cost_breakdown/.test(s) && !/^(CREATE|INSERT)/i.test(s.trim()));
    expect(mine.length).toBe(2);
    for (const sql of mine) {
      const n = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      const plan = await real(`EXPLAIN QUERY PLAN ${sql}`).bind(...Array(n).fill("2026-10-01")).all<{ detail: string }>();
      const details = plan.results.map((r) => r.detail);
      expect(details.filter((d) => /^SCAN cost_breakdown/.test(d)), sql).toEqual([]);
      expect(details.some((d) => /SEARCH cost_breakdown USING PRIMARY KEY/.test(d)), sql).toBe(true);
    }
  });
});
