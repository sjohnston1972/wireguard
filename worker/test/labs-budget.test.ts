// labs-budget.test.ts
//
// Plain English: plan L2.4. Labs share the month's budget: running labs count
// to their timers, the 80% note says how much went on labs, and at 100% the
// lab watch tears every lab down (never the gateway). Azure's per-lab spend
// arrives daily; a session shows its estimate until then. Prices come from
// Azure's list when fresh, and the deploy modal warns about budget, capacity,
// price and time.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { budgetFigures, budgetStatus, checkBudget } from "../src/budget";
import { effectiveConfig } from "../src/settings";
import { getSnapshot, saveSnapshot } from "../src/state";
import { runLabWatch } from "../src/labs/watch";
import { normalisePrices, pricesQuery } from "../src/insights/feeds/prices";
import { api, advance, deployLab, freeze, ghIdFor, labDispatches, labEnv, labRun, rows, runningLab, secrets, session, HOUR, NOW } from "./labs-helpers";
import type { Env } from "../src/env";

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const idle = { state: "destroyed" as const, running_since: null, auto_destroy_at: null };
const iso = (ms: number) => new Date(ms).toISOString();

/** A finished session of a lab, straight into D1. */
async function pastSession(env: Env, id: string, lab: string, from: string, to: string, gbpH: number) {
  await env.DB.prepare(
    `INSERT INTO lab_sessions (id, lab_id, lab_version, state, test, region, peering, name_prefix, requested_at, ready_at, ended_at, max_until, est_gbp_h, est_gbp, end_reason)
     VALUES (?1, ?2, CAST(1 AS INTEGER), 'ended', CAST(0 AS INTEGER), 'uksouth', 'off', 'l05abcde', ?3, ?3, ?4, ?4, ?5, ?6, 'manual')`,
  )
    .bind(id, lab, from, to, gbpH, (gbpH * (Date.parse(to) - Date.parse(from))) / HOUR)
    .run();
}

describe("budget (L2.4)", () => {
  it("budgetFigures adds each running lab's est_gbp_h to its timer", () => {
    const now = new Date(NOW);
    const t = now.getTime();
    const labs = [
      { state: "running", requested_at: iso(t - HOUR), auto_destroy_at: iso(t + 2 * HOUR), max_until: iso(t + 5 * HOUR), est_gbp_h: 0.4 },
      // Still deploying: no timer yet, so to its maximum lifetime.
      { state: "deploying", requested_at: iso(t), auto_destroy_at: null, max_until: iso(t + 4 * HOUR), est_gbp_h: 0.1 },
    ];
    const f = budgetFigures({ budget: 10, days: [{ day: "2026-10-01", gbp: 1 }], snap: idle, hourlyRate: 0.5, now, labs, labDays: [{ day: "2026-10-02", gbp: 2 }] });
    // Azure has listed to the end of the 2nd, so each lab counts from when it started.
    expect(f.session).toBeCloseTo(0.4 * 3 + 0.1 * 4, 6);
    expect(f.actual).toBeCloseTo(3, 6);
    expect(f.total).toBeCloseTo(4.6, 6);
    // Without labs nothing changes.
    expect(budgetFigures({ budget: 10, days: [{ day: "2026-10-01", gbp: 1 }], snap: idle, hourlyRate: 0.5, now }).total).toBe(1);
  });

  it("budgetStatus reads running labs and Azure's lab days from D1", async () => {
    freeze();
    const { env, world } = await labEnv();
    await runningLab(env, world, "az305-28-hub-spoke-fw", { hours: 2, peer: true });
    await env.DB.prepare("INSERT INTO lab_cost_days (day, rg, lab_id, gbp, fetched_at) VALUES ('2026-10-01', 'rg-lab-az104-05-storage', 'az104-05-storage', 1.5, ?1)").bind(NOW).run();
    const b = await budgetStatus(env, undefined, undefined, new Date(NOW));
    expect(b.actual).toBeCloseTo(1.5, 6);
    expect(b.session).toBeCloseTo(0.42 * 2, 6);
  });

  it("budget at 100% destroys running labs, cancels deploying ones and never dispatches wg.yml", async () => {
    freeze();
    const { env, world } = await labEnv();
    await api(env, "PUT", "/settings", { labs_max_running: 5 });
    await saveSnapshot(env, { state: "running", running_since: NOW, auto_destroy_at: iso(Date.parse(NOW) + 4 * HOUR) });
    const a = await runningLab(env, world, "az104-05-storage");
    const b = await deployLab(env, "az104-07-files");
    await secrets(env, world, b.json.runId);
    // The month goes over budget; one more lab is deployed anyway, on purpose.
    await db.upsertCostDay(env, "2026-10-01", 25);
    const c = await deployLab(env, "az104-06-blob-security", { hours: 1, peer: false, overBudgetOk: true });
    expect(c.status).toBe(200);
    const lines = await runLabWatch(env, new Date());
    expect((await session(env, a.sid))!).toMatchObject({ state: "tearing_down", end_reason: "budget" });
    expect((await session(env, b.json.sessionId))!).toMatchObject({ state: "tearing_down", end_reason: "budget" });
    expect(await labRun(env, b.json.runId)).toMatchObject({ status: "cancelled" });
    expect(world.calls.some((x) => x.method === "POST" && x.path.endsWith(`/actions/runs/${ghIdFor(world, b.json.runId)}/cancel`))).toBe(true);
    // Deployed with "Deploy anyway": left alone.
    expect((await session(env, c.json.sessionId))!.state).toBe("deploying");
    // The gateway: untouched.
    expect(world.dispatches.filter((d) => d.workflow !== "lab.yml")).toHaveLength(0);
    expect((await getSnapshot(env)).state).toBe("running");
    expect(lines.join(" ")).toMatch(/budget/i);
    const note = (await rows(env, "SELECT kind, message FROM alerts WHERE message LIKE '%budget%' AND message LIKE '%lab%'"))[0];
    expect(note).toBeTruthy();
    // The next run does not tear them down twice.
    await runLabWatch(env, new Date());
    expect(labDispatches(world).filter((d) => d.action === "destroy")).toHaveLength(2);
  });

  it("the 80% note names lab spend", async () => {
    freeze();
    const { env } = await labEnv();
    await db.upsertCostDay(env, "2026-10-01", 5);
    await env.DB.prepare("INSERT INTO lab_cost_days (day, rg, lab_id, gbp, fetched_at) VALUES ('2026-10-02', 'rg-lab-az104-05-storage', 'az104-05-storage', 3.5, ?1)").bind(NOW).run();
    const note = await checkBudget(env, await effectiveConfig(env), new Date(NOW));
    expect(note).toMatch(/80%/);
    const alert = (await rows(env, "SELECT message FROM alerts WHERE kind = 'budget'"))[0];
    expect(alert.message).toMatch(/£3\.50 of it on labs/);
  });
});

describe("actual spend (L2.4)", () => {
  it("the daily unfiltered query keeps rg-lab- rows in lab_cost_days", async () => {
    freeze();
    const { env, world } = await labEnv();
    world.labAzure.costRows.push(
      { day: "2026-10-02", rg: "rg-lab-az104-05-storage", gbp: 0.25 },
      { day: "2026-10-03", rg: "RG-LAB-AZ104-07-FILES", gbp: 0.5 },
      { day: "2026-10-03", rg: "rg-wg-ondemand", gbp: 0.3 },
      { day: "2026-10-03", rg: "NetworkWatcherRG", gbp: 0 },
    );
    await runLabWatch(env, new Date());
    const got = await rows(env, "SELECT day, rg, lab_id, gbp FROM lab_cost_days ORDER BY day");
    expect(got).toEqual([
      { day: "2026-10-02", rg: "rg-lab-az104-05-storage", lab_id: "az104-05-storage", gbp: 0.25 },
      { day: "2026-10-03", rg: "rg-lab-az104-07-files", lab_id: "az104-07-files", gbp: 0.5 },
    ]);
    const queries = () => world.calls.filter((c) => c.path.toLowerCase().includes("costmanagement/query")).length;
    expect(queries()).toBe(1);
    // Once a day.
    await runLabWatch(env, new Date());
    expect(queries()).toBe(1);
  });

  it("a session shows estimate until the day after it ends, then actual split by duration", async () => {
    freeze("2026-10-04T20:00:00.000Z");
    const { env } = await labEnv();
    await pastSession(env, "ls-20261004100000-aaaaaa", "az104-05-storage", "2026-10-04T10:00:00.000Z", "2026-10-04T11:00:00.000Z", 0.01);
    await pastSession(env, "ls-20261004130000-bbbbbb", "az104-05-storage", "2026-10-04T13:00:00.000Z", "2026-10-04T16:00:00.000Z", 0.01);
    const list = async () => (await api(env, "GET", "/labs/sessions?lab=az104-05-storage")).json.sessions as { id: string; costGbp: number; costBasis: string }[];
    let s = await list();
    expect(s.map((x) => x.costBasis)).toEqual(["estimate", "estimate"]);
    expect(s[1].costGbp).toBeCloseTo(0.01, 6);
    // The next day Azure lists 40p for that day: split 1 h to 3 h.
    advance(16 * HOUR);
    s = await list();
    expect(s.map((x) => x.costBasis)).toEqual(["estimate", "estimate"]);
    await env.DB.prepare("INSERT INTO lab_cost_days (day, rg, lab_id, gbp, fetched_at) VALUES ('2026-10-04', 'rg-lab-az104-05-storage', 'az104-05-storage', 0.4, ?1)").bind(new Date().toISOString()).run();
    s = await list();
    expect(s.map((x) => x.costBasis)).toEqual(["actual", "actual"]);
    expect(s.find((x) => x.id.endsWith("bbbbbb"))!.costGbp).toBeCloseTo(0.3, 6);
    expect(s.find((x) => x.id.endsWith("aaaaaa"))!.costGbp).toBeCloseTo(0.1, 6);
  });

  it("cost labs rows: this month actual plus running estimates", async () => {
    freeze();
    const { env, world } = await labEnv();
    const add = (day: string, lab: string, gbp: number) => env.DB.prepare("INSERT INTO lab_cost_days (day, rg, lab_id, gbp, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(day, `rg-lab-${lab}`, lab, gbp, NOW).run();
    await add("2026-09-30", "az104-05-storage", 9);
    await add("2026-10-02", "az104-05-storage", 0.5);
    await add("2026-10-03", "az104-05-storage", 0.25);
    await runningLab(env, world, "az104-07-files");
    advance(2 * HOUR);
    const labs = (await api(env, "GET", "/cost")).json.labs as { labId: string; actualGbp: number | null; estimateGbp: number | null; totalGbp: number; running: boolean; sessions: number; title: string }[];
    expect(labs.map((l) => l.labId)).toEqual(["az104-05-storage", "az104-07-files"]);
    expect(labs[0]).toMatchObject({ actualGbp: 0.75, estimateGbp: null, totalGbp: 0.75, running: false, title: "Storage accounts" });
    expect(labs[1]).toMatchObject({ actualGbp: null, running: true, sessions: 1 });
    expect(labs[1].estimateGbp).toBeCloseTo(0.0117 * 2, 6);
  });
});

describe("prices and warnings (L2.4)", () => {
  const price = (env: Env, item: string, gbp: number, unit: string, at: string) =>
    env.DB.prepare("INSERT INTO az_prices (region, item, gbp, unit, meter, fetched_at) VALUES ('uksouth', ?1, ?2, ?3, ?4, ?5)").bind(item, gbp, unit, item, at).run();

  it("lab prices: retail meters stored as lab:<meter>, authored gbp_h after 7 days stale", async () => {
    freeze();
    const q = new URLSearchParams(pricesQuery("uksouth", ["Standard_B1s"], ["Standard Private Endpoint"]));
    expect(q.get("$filter")).toContain("meterName eq 'Standard Private Endpoint'");
    // Without lab meters the query is as before.
    expect(new URLSearchParams(pricesQuery("uksouth", ["Standard_B1s"])).get("$filter")).not.toContain("Private Endpoint");
    const items = normalisePrices({ Items: [{ currencyCode: "GBP", type: "Consumption", productName: "Private Link", skuName: "Standard", meterName: "Standard Private Endpoint", unitOfMeasure: "1 Hour", retailPrice: 0.008 }] }, ["Standard_B1s"], ["Standard Private Endpoint"]);
    expect(items).toEqual([{ item: "lab:Standard Private Endpoint", gbp: 0.008, unit: "1 Hour", meter: "Standard Private Endpoint" }]);

    const { env } = await labEnv();
    await price(env, "lab:Standard Private Endpoint", 0.008, "1 Hour", iso(Date.parse(NOW) - 86_400_000));
    let d = (await api(env, "GET", "/labs/az104-06-blob-security")).json;
    expect(d.cost.items[1]).toMatchObject({ gbpH: 0.008, source: "azure", priceAge: 86_400 });
    expect(d.cost.items[0]).toMatchObject({ gbpH: 0.0001, source: "authored", priceAge: null });
    expect(d.card.estGbpH).toBeCloseTo(0.0081, 6);
    expect(d.cost.gbpH).toBeCloseTo(0.0081, 6);
    // A deploy records the fresh price.
    const r = await deployLab(env, "az104-06-blob-security");
    expect((await session(env, r.json.sessionId))!.est_gbp_h).toBeCloseTo(0.0081, 6);
    // Eight days old: the authored figure again, and the modal says so.
    await env.DB.prepare("UPDATE az_prices SET fetched_at = ?1").bind(iso(Date.parse(NOW) - 8 * 86_400_000)).run();
    d = (await api(env, "GET", "/labs/az104-06-blob-security")).json;
    expect(d.cost.items[1]).toMatchObject({ gbpH: 0.0076, source: "authored", priceAge: null });
    // A VM size's list price (retail.sku).
    await price(env, "Standard_B1s", 0.0093, "1 Hour", NOW);
    d = (await api(env, "GET", "/labs/az104-07-files")).json;
    expect(d.cost.items[0]).toMatchObject({ gbpH: 0.0093, source: "azure", priceAge: 0 });
  });

  it("warnings: budget, capacity per vm size plus the gateway, pricey, slow; unavailable has no override", async () => {
    freeze();
    const { env } = await labEnv();
    await db.upsertCostDay(env, "2026-10-01", 9.5);
    const w = async (id: string) => (await api(env, "GET", `/labs/${id}`)).json.warnings as { kind: string; message: string; overridable: boolean }[];
    const fw = await w("az305-28-hub-spoke-fw");
    expect(fw.map((x) => [x.kind, x.overridable])).toEqual([["budget", true], ["pricey", false], ["slow", false]]);
    expect(fw[0].message).toMatch(/£10\.34 of £10\.00/);
    expect(fw[1].message).toBe("Pricey: Azure Firewall Basic, about £0.40/h.");
    expect(fw[2].message).toBe("Takes about 15 minutes to deploy and 10 to tear down.");
    // Capacity: one B-series vCPU left; lab 7's VM plus the gateway's (not running) need two.
    const doc = { sizes: [{ name: "Standard_B1s", available: true, reason: null, vcpus: 1, family: "standardBSFamily" }], usages: [{ family: "standardBSFamily", used: 9, limit: 10 }], cores: { used: 9, limit: 20 } };
    await env.DB.prepare("INSERT INTO az_capacity (region, json, fetched_at) VALUES ('uksouth', ?1, ?2)").bind(JSON.stringify(doc), NOW).run();
    await db.upsertCostDay(env, "2026-10-01", 1);
    const files = await w("az104-07-files");
    expect(files.map((x) => [x.kind, x.overridable])).toEqual([["capacity", true]]);
    expect(files[0].message).toMatch(/Standard_B1s/);
    expect(files[0].message).toMatch(/gateway/);
    // With the gateway running its vCPU is already counted as used: one is enough.
    await saveSnapshot(env, { state: "running", running_since: NOW });
    expect(await w("az104-07-files")).toEqual([]);
    // A size not offered at all.
    await env.DB.prepare("UPDATE az_capacity SET json = ?1").bind(JSON.stringify({ ...doc, sizes: [{ ...doc.sizes[0], available: false, reason: "NotAvailableForSubscription" }] })).run();
    expect((await w("az104-07-files"))[0].message).toMatch(/NotAvailableForSubscription/);
    // Unavailable: no "Deploy anyway".
    await env.STATUS.put("labs:permissions", JSON.stringify({ checkedAt: NOW, role: true, users: false, groups: false, message: null }));
    const blob = await w("az104-06-blob-security");
    expect(blob).toEqual([{ kind: "unavailable", message: expect.stringMatching(/Graph/), overridable: false }]);
  });

  it("deploy needs confirm_required overrides for budget and capacity", async () => {
    freeze();
    const { env, world } = await labEnv();
    await db.upsertCostDay(env, "2026-10-01", 9.5);
    const b = await deployLab(env, "az305-28-hub-spoke-fw", { hours: 2, peer: true });
    expect(b.status).toBe(422);
    expect(b.json.error.code).toBe("confirm_required");
    expect(b.json.error.message).toMatch(/£10\.34 of £10\.00/);
    expect(labDispatches(world)).toHaveLength(0);
    expect((await deployLab(env, "az305-28-hub-spoke-fw", { hours: 2, peer: true, capacityOk: true })).status).toBe(422);
    expect((await deployLab(env, "az305-28-hub-spoke-fw", { hours: 2, peer: true, overBudgetOk: true })).status).toBe(200);

    await db.upsertCostDay(env, "2026-10-01", 0);
    const doc = { sizes: [{ name: "Standard_B1s", available: false, reason: "NotAvailableForSubscription", vcpus: 1, family: "standardBSFamily" }], usages: [], cores: null };
    await env.DB.prepare("INSERT INTO az_capacity (region, json, fetched_at) VALUES ('uksouth', ?1, ?2)").bind(JSON.stringify(doc), NOW).run();
    const c = await deployLab(env, "az104-07-files");
    expect(c.status).toBe(422);
    expect(c.json.error.message).toMatch(/Standard_B1s/);
    expect((await deployLab(env, "az104-07-files", { hours: 2, peer: false, overBudgetOk: true })).status).toBe(422);
    expect((await deployLab(env, "az104-07-files", { hours: 2, peer: false, capacityOk: true })).status).toBe(200);
  });
});
