// labs-read.test.ts
//
// Plain English: plan L2.7. What the Labs tab and the Overview read: the
// catalogue cards (estimate, live and last session, "Ran 2×", release tests,
// "Untested"), one lab's detail (readme, priced items, warnings, resources
// from ARM while it runs), history and coverage (sessions of 15 minutes or
// more), the note, the password (only while running) and the Overview summary.

import { afterEach, describe, expect, it, vi } from "vitest";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { api, advance, deployLab, freeze, labDispatches, labEnv, report, runningLab, secrets, session, MIN, NOW, TEST_CATALOGUE, TEST_LABS } from "./labs-helpers";
import type { Env } from "../src/env";
import { LAB_UNITS, labItem, normalisePrices, NOT_LINUX_PAYG } from "../src/insights/feeds/prices";
import { gbpHFrom, labGbpH, pricedItems, readLabPrices, retailPrice } from "../src/labs/prices";
import type { PriceRow } from "../src/insights/price";
import { costMarker, estimateGbpH } from "../../shared/labs";
import * as verify from "../../scripts/labs-verify.mjs";

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** An ended session, ready for `minutes`, straight into D1. */
async function ended(env: Env, id: string, lab: string, readyAt: string, minutes: number, state = "ended") {
  const end = new Date(Date.parse(readyAt) + minutes * MIN).toISOString();
  await env.DB.prepare(
    `INSERT INTO lab_sessions (id, lab_id, lab_version, state, test, region, peering, name_prefix, requested_at, ready_at, ended_at, max_until, est_gbp_h, est_gbp, end_reason)
     VALUES (?1, ?2, CAST(1 AS INTEGER), ?3, CAST(0 AS INTEGER), 'uksouth', 'off', 'l05abcde', ?4, ?4, ?5, ?5, 0.01, 0.001, 'manual')`,
  )
    .bind(id, lab, state, readyAt, end)
    .run();
}

describe("read routes (L2.7)", () => {
  it("GET /labs cards carry estimate, running session, last session, last release test and Untested", async () => {
    freeze();
    const { env, world } = await labEnv();
    await ended(env, "ls-20261003090000-aaaaaa", "az104-07-files", "2026-10-03T09:00:00.000Z", 20);
    await ended(env, "ls-20261003120000-bbbbbb", "az104-07-files", "2026-10-03T12:00:00.000Z", 5);
    await env.DB.prepare("INSERT INTO lab_release_tests (lab_id, version, at, run_id, result, deploy_seconds, destroy_seconds, est_gbp, leftovers_json) VALUES ('az104-07-files', CAST(1 AS INTEGER), '2026-10-02T10:00:00.000Z', 'lab-test-x', 'fail', CAST(200 AS INTEGER), CAST(100 AS INTEGER), 0.002, '[\"rg-lab-az104-07-files\"]')").run();
    const up = await runningLab(env, world, "az104-05-storage");
    const l = (await api(env, "GET", "/labs")).json;
    const card = (id: string) => l.labs.find((c: { id: string }) => c.id === id);
    expect(card("az104-05-storage")).toMatchObject({ estGbpH: 0.01, marker: "£", running: { id: up.sid, state: "running", costBasis: "estimate" }, released: false, lastReleaseTest: null });
    expect(card("az104-07-files")).toMatchObject({ running: null, lastSession: { id: "ls-20261003120000-bbbbbb", state: "ended" }, runs: 1, released: false, lastReleaseTest: { result: "fail", clean: false, leftovers: ["rg-lab-az104-07-files"] } });
    expect(card("az305-28-hub-spoke-fw")).toMatchObject({ estGbpH: 0.42, marker: "££", pricey: { item: "Azure Firewall Basic", gbpH: 0.4 } });
    expect(l.running.map((s: { id: string }) => s.id)).toEqual([up.sid]);
    expect(l.slots).toEqual({ used: 1, total: 32 });
    // A running session counts as run once it has been up 15 minutes.
    advance(15 * MIN);
    expect((await api(env, "GET", "/labs")).json.labs.find((c: { id: string }) => c.id === "az104-05-storage").runs).toBe(1);
    // Never the password, the token hash or the payload.
    expect(JSON.stringify(l)).not.toMatch(/admin_password|adminPassword|callback_token|payload/);
  });

  it("GET /labs/:id has readme blocks, priced items with source and age, warnings, resources from ARM while running", async () => {
    freeze();
    const { env, world } = await labEnv();
    let d = (await api(env, "GET", "/labs/az104-05-storage")).json;
    expect(d.readme).toEqual([{ t: "h", level: 2, text: "What it deploys" }]);
    expect(d.cost.items).toEqual([{ name: "Storage account", gbp_h: 0.01, gbpH: 0.01, source: "authored", priceAge: null }]);
    expect(d).toMatchObject({ session: null, runs: [], resources: null, portalUrl: null, warnings: [] });
    const armCalls = () => world.calls.filter((c) => c.host === "management.azure.com").length;
    expect(armCalls()).toBe(0); // not running: no Azure call
    const up = await runningLab(env, world, "az104-05-storage");
    world.labAzure.resources.push({ name: "stl05abcde", type: "Microsoft.Storage/storageAccounts", resourceGroup: "rg-lab-az104-05-storage", provisioningState: "Succeeded" });
    d = (await api(env, "GET", "/labs/az104-05-storage")).json;
    expect(d.session).toMatchObject({ id: up.sid, state: "running", outputs: { privateIps: { vm: "10.64.0.4" }, connect: ["ssh azureuser@10.64.0.4"] } });
    expect(d.runs.map((r: { action: string }) => r.action)).toEqual(["deploy"]);
    expect(d.resources).toEqual([{ name: "stl05abcde", type: "Microsoft.Storage/storageAccounts", group: "rg-lab-az104-05-storage", state: "Succeeded" }]);
    expect(d.portalUrl).toBe("https://portal.azure.com/#resource/subscriptions/sub/resourceGroups/rg-lab-az104-05-storage");
    expect(d.warnings).toEqual([]);
    expect(JSON.stringify(d)).not.toMatch(/admin_password|callback_token|payload_json/);
    // ARM refusing: resources is null, the rest still answers.
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("/resources?") ? new Response("{}", { status: 403 }) : real(input, init)));
    d = (await api(env, "GET", "/labs/az104-05-storage")).json;
    expect(d.resources).toBeNull();
    expect(d.session.id).toBe(up.sid);
  });

  it("sessions history and coverage count sessions of 15 minutes or more", async () => {
    freeze();
    const { env } = await labEnv();
    await ended(env, "ls-20261001090000-aaaaaa", "az104-05-storage", "2026-10-01T09:00:00.000Z", 20);
    await ended(env, "ls-20261002090000-bbbbbb", "az104-06-blob-security", "2026-10-02T09:00:00.000Z", 10);
    await ended(env, "ls-20261003090000-cccccc", "az305-28-hub-spoke-fw", "2026-10-03T09:00:00.000Z", 60, "ended_dirty");
    const h = (await api(env, "GET", "/labs/sessions")).json.sessions;
    expect(h.map((s: { id: string }) => s.id)).toEqual(["ls-20261003090000-cccccc", "ls-20261002090000-bbbbbb", "ls-20261001090000-aaaaaa"]);
    expect(h[0]).toMatchObject({ title: "Hub-spoke with Azure Firewall", state: "ended_dirty", endReason: "manual", costBasis: "estimate" });
    expect((await api(env, "GET", "/labs/sessions?limit=1")).json.sessions).toHaveLength(1);
    expect((await api(env, "GET", "/labs/sessions?lab=az104-05-storage")).json.sessions.map((s: { labId: string }) => s.labId)).toEqual(["az104-05-storage"]);
    const cov = (await api(env, "GET", "/labs/coverage")).json.exams;
    const storage = cov[0].areas.find((a: { key: string }) => a.key === "az104.storage");
    expect(storage).toMatchObject({ run: 1, available: 4 });
    expect(storage.labs.filter((x: { run: boolean }) => x.run).map((x: { id: string }) => x.id)).toEqual(["az104-05-storage"]);
    const infra = cov[1].areas.find((a: { key: string }) => a.key === "az305.infra");
    expect(infra).toMatchObject({ run: 1, available: 1 });
  });

  it("note is at most 2000 characters", async () => {
    freeze();
    const { env } = await labEnv();
    await ended(env, "ls-20261001090000-aaaaaa", "az104-05-storage", "2026-10-01T09:00:00.000Z", 20);
    expect((await api(env, "PUT", "/labs/sessions/ls-20261001090000-aaaaaa/note", { note: "x".repeat(2000) })).status).toBe(200);
    expect((await session(env, "ls-20261001090000-aaaaaa"))!.note).toHaveLength(2000);
    const long = await api(env, "PUT", "/labs/sessions/ls-20261001090000-aaaaaa/note", { note: "x".repeat(2001) });
    expect(long.status).toBe(400);
    expect(long.json.error.field).toBe("note");
    expect((await api(env, "PUT", "/labs/sessions/ls-20261001090000-aaaaaa/note", { note: "" })).json.message).toBe("Note cleared.");
    expect((await session(env, "ls-20261001090000-aaaaaa"))!.note).toBeNull();
    expect((await api(env, "PUT", "/labs/sessions/ls-nope/note", { note: "x" })).status).toBe(404);
  });

  it("secret answers only while running", async () => {
    freeze();
    const { env, world } = await labEnv();
    const r = await deployLab(env, "az104-05-storage");
    expect((await api(env, "GET", "/labs/az104-05-storage/secret")).status).toBe(409);
    const s = await secrets(env, world, r.json.runId);
    await report(env, r.json.runId, s.callback_token, "success", { users: { ann: "lab-az104-05-storage-ann@contoso.onmicrosoft.com" } });
    const ok = await api(env, "GET", "/labs/az104-05-storage/secret");
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ adminPassword: s.admin_password, users: { ann: "lab-az104-05-storage-ann@contoso.onmicrosoft.com" } });
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    await api(env, "POST", "/labs/az104-05-storage/destroy", { confirm: true });
    const torn = await api(env, "GET", "/labs/az104-05-storage/secret");
    expect(torn.status).toBe(409);
    expect(torn.json.error.code).toBe("not_running");
    expect(labDispatches(world)).toHaveLength(2);
  });

  it("overview labs summary", async () => {
    freeze();
    const { env, world } = await labEnv();
    const a = await runningLab(env, world, "az104-06-blob-security", { hours: 2, peer: true });
    advance(MIN);
    const b = await deployLab(env, "az104-07-files");
    const o = (await api(env, "GET", "/overview")).json.labs;
    expect(o.running.map((s: { id: string }) => s.id)).toEqual([a.sid, b.json.sessionId]);
    expect(o.running[1]).toMatchObject({ state: "deploying", activeRun: { action: "deploy", status: "queued" } });
    expect(o.gbpH).toBeCloseTo(0.0077 + 0.0117, 6);
    expect(o.rePeer).toBe(1); // lab 6 asked to peer and the gateway is not up
    void NOW;
  });
});

describe("lab prices per region (batch 3, C0.6)", () => {
  const now = new Date("2026-10-05T09:00:00.000Z");
  const at = "2026-10-05T03:00:00.000Z";
  const s4 = (region: string, gbp: number): PriceRow => ({ region, item: labItem("S4 LRS Disk"), gbp, unit: "1/Month", fetched_at: at });
  const rows = [s4("uksouth", 1.2775), s4("ukwest", 1.46)];
  const primary = { name: "OS disk, S4", gbp_h: 0.0017, retail: { meter: "S4 LRS Disk", unit: "1/Month" } };
  const replica = { name: "Replica disk, S4", gbp_h: 0.0017, region: "secondary" as const, retail: { meter: "S4 LRS Disk", unit: "1/Month" } };
  const def = { ...TEST_LABS[0]!, id: "az305-26-site-recovery", regions: { secondary: "ukwest" }, cost: { items: [primary, replica], pricey: null } };

  it("a secondary-region item is priced at the session's secondary region", async () => {
    expect(retailPrice(replica, rows, "uksouth", now, "ukwest")?.gbpH).toBeCloseTo(1.46 / 730, 8);
    // No secondary region known (or no row there): the authored figure.
    expect(retailPrice(replica, rows, "uksouth", now, null)).toBeNull();
    expect(retailPrice(replica, rows, "uksouth", now)).toBeNull();
    expect(retailPrice(replica, [rows[0]!], "uksouth", now, "ukwest")).toBeNull();
    // The lab's own regions.secondary is the session's secondary region (engine.ts), so the modal and estimate use it.
    const lines = pricedItems(def, rows, "uksouth", now);
    expect(lines.map((l) => [l.name, l.source, Number(l.gbpH.toFixed(8))])).toEqual([
      ["OS disk, S4", "azure", Number((1.2775 / 730).toFixed(8))],
      ["Replica disk, S4", "azure", Number((1.46 / 730).toFixed(8))],
    ]);
    expect(gbpHFrom(def, rows, "uksouth", now)).toBeCloseTo((1.2775 + 1.46) / 730, 6);
    // labGbpH reads both regions' rows from az_prices.
    const { env } = await labEnv();
    await env.DB.prepare("INSERT INTO az_prices (region, item, gbp, unit, meter, fetched_at) VALUES ('uksouth', ?1, 1.2775, '1/Month', 'S4 LRS Disk', ?2), ('ukwest', ?1, 1.46, '1/Month', 'S4 LRS Disk', ?2)").bind(labItem("S4 LRS Disk"), at).run();
    expect(await labGbpH(env, def, "uksouth", now)).toBeCloseTo((1.2775 + 1.46) / 730, 6);
    // The cards, the modal and the warnings read the catalogue's secondary regions' rows too.
    expect((await readLabPrices(env, "uksouth")).map((r) => r.region)).toEqual(["uksouth"]);
    setCatalogueForTest({ ...TEST_CATALOGUE, labs: [...TEST_LABS, def] });
    expect((await readLabPrices(env, "uksouth")).map((r) => r.region).sort()).toEqual(["uksouth", "ukwest"]);
    const cards = (await api(env, "GET", "/labs")).json.labs as { id: string; estGbpH: number }[];
    expect(cards.find((l) => l.id === def.id)?.estGbpH).toBeCloseTo((1.2775 + 1.46) / 730, 6);
  });

  it("an item without region keeps the session's region", () => {
    expect(retailPrice(primary, rows, "uksouth", now, "ukwest")?.gbpH).toBeCloseTo(1.2775 / 730, 8);
    expect(retailPrice(primary, rows, "ukwest", now, null)?.gbpH).toBeCloseTo(1.46 / 730, 8);
    // A lab without a secondary region prices a secondary item at the authored figure.
    const single = { ...def, regions: { secondary: null } };
    expect(pricedItems(single, rows, "uksouth", now)[1]).toMatchObject({ source: "authored", gbpH: 0.0017 });
  });
});

describe("lab prices (batch 2, B0.6)", () => {
  it('a lab meter priced per "1/Hour" is kept by the feed and read as £ per hour', () => {
    // App Gateway Basic's meters come per "1/Hour", not "1 Hour" (uksouth, Retail Prices API).
    const meter = "Basic Fixed Cost";
    const reply = {
      Items: [
        { currencyCode: "GBP", type: "Consumption", productName: "Application Gateway Basic", skuName: "Basic", armRegionName: "uksouth", meterName: meter, retailPrice: 0.0187, unitOfMeasure: "1/Hour", isPrimaryMeterRegion: true },
      ],
    };
    const rows = normalisePrices(reply, [], [meter]);
    expect(rows).toEqual([{ item: labItem(meter), gbp: 0.0187, unit: "1/Hour", meter }]);
    const now = new Date("2026-10-05T09:00:00.000Z");
    const stored: PriceRow[] = rows.map((r) => ({ region: "uksouth", item: r.item, gbp: r.gbp, unit: r.unit, fetched_at: "2026-10-05T03:00:00.000Z" }));
    const item = { name: "Application Gateway Basic, fixed", gbp_h: 0.02, retail: { meter, unit: "1/Hour" } };
    expect(retailPrice(item, stored, "uksouth", now)?.gbpH).toBeCloseTo(0.0187, 6);
    // The other units still convert: a day's price over 24 hours, a month's over 730.
    expect(retailPrice({ ...item, retail: { meter, unit: "1/Day" } }, [{ ...stored[0]!, unit: "1/Day", gbp: 2.4 }], "uksouth", now)?.gbpH).toBeCloseTo(0.1, 6);
    expect(retailPrice({ ...item, retail: { meter, unit: "1/Month" } }, [{ ...stored[0]!, unit: "1/Month", gbp: 7.3 }], "uksouth", now)?.gbpH).toBeCloseTo(0.01, 6);
  });

  it("labs-verify's units and Windows filter equal the price feed's", () => {
    expect([...verify.LAB_UNITS]).toEqual([...LAB_UNITS]);
    expect([...LAB_UNITS].sort()).toEqual(["1 Hour", "1/Day", "1/Hour", "1/Month"]);
    expect(verify.NOT_LINUX_PAYG.source).toBe(NOT_LINUX_PAYG.source);
    expect(verify.NOT_LINUX_PAYG.flags).toBe(NOT_LINUX_PAYG.flags);
  });

  it("the content suite's estimate and marker equal shared/labs.ts", async () => {
    const content = await import("../../scripts/test/fixtures/labs/estimate.mjs");
    for (const items of [[{ name: "a", gbp_h: 0.0092, qty: 3 }, { name: "b", gbp_h: 0.0018 }], [{ name: "c", gbp_h: 0.123456789 }], []]) {
      expect(content.estimateGbpH(items)).toBe(estimateGbpH(items));
    }
    for (const [h, d] of [[0.049, 5], [0.05, 5], [0.499, 12], [0.5, 1], [0.01, 30], [0, 0]] as const) expect(content.costMarker(h, d)).toBe(costMarker(h, d));
  });
});
