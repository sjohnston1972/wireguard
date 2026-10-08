// insights-prices.test.ts
//
// Plain English: Azure's retail list prices and the rate source (plan
// X1.7). Linux pay-as-you-go GBP prices for the VM sizes, the E4 and S4
// disks and the static IPv4 address; every cost estimate uses them unless
// Settings says "fixed" (or an hourly override was saved before this
// existed), and falls back to the fixed rates, saying why, when there is no
// fresh price.
import { describe, it, expect, afterEach, vi } from "vitest";
import { MAX_FILTER_COMPARISONS, MAX_PRICE_URL, labMeters, normalisePrices, priceRequests, priceUrls, pricesQuery } from "../src/insights/feeds/prices";
import { TEST_VM_SIZE, labVmSizes } from "../src/insights/feeds/capacity";
import { catalogue } from "../src/labs/catalogue";
import { VM_SIZES } from "../src/settings";
import { priceInfo, rateSource, readPrices } from "../src/insights/price";
import { runInsights } from "../src/insights/runner";
import { effectiveConfig, fixedConfig } from "../src/settings";
import { saveSnapshot } from "../src/state";
import { api, base } from "./api-helpers";
import { azureEnv, allNotDue, setFeed, feedRows, callsTo, countD1, fixture, json, running, NOW, ago, MIN, NO_AZURE } from "./insights-helpers";
import type { Env } from "../src/env";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A filter without its string literals ('' is a quote inside one), so a quote in a name is not read as syntax. */
const bare = (filter: string) => filter.replace(/'(?:[^']|'')*'/g, "''");
/** How many comparisons ("eq") a filter makes: Azure refuses more than 20. */
const comparisons = (filter: string) => (bare(filter).match(/\beq\b/g) ?? []).length;
/** The OR'd asks inside a filter's parentheses, each as written. */
function orTerms(filter: string): string[] {
  const inner = filter.slice(filter.indexOf("(") + 1, -1);
  const out: string[] = [];
  let cur = "";
  for (const part of inner.split(" or ")) {
    cur = cur ? `${cur} or ${part}` : part;
    if (((cur.match(/'/g) ?? []).length) % 2 === 0) {
      out.push(cur);
      cur = "";
    }
  }
  return out;
}

const SIZES = ["Standard_B1s","Standard_B1ls", "Standard_B1ms", "Standard_B2s", "Standard_B2ats_v2"];

async function seedPrices(env: Env, region: string, at: string, vm: Record<string, number> = { Standard_B1s: 0.0093, Standard_B1ls: 0.0047 }) {
  const put = (item: string, gbp: number, unit: string, meter: string) => env.DB.prepare("INSERT INTO az_prices (region, item, gbp, unit, meter, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(region, item, gbp, unit, meter, at).run();
  for (const [size, gbp] of Object.entries(vm)) await put(size, gbp, "1 Hour", size.replace("Standard_", ""));
  await put("disk:E4", 1.97, "1/Month", "E4 LRS Disk");
  await put("disk:S4", 1.22, "1/Month", "S4 LRS Disk");
  await put("ip:v4", 0.0037, "1 Hour", "Standard IPv4 Static Public IP");
}

describe("prices", () => {
  it("Linux pay-as-you-go only: Windows, Spot and Low Priority skipped", () => {
    const rows = normalisePrices(fixture("prices-uksouth"), SIZES);
    const by = Object.fromEntries(rows.map((r) => [r.item, r]));
    expect(by["Standard_B1s"]).toEqual({ item: "Standard_B1s", gbp: 0.0093, unit: "1 Hour", meter: "B1s" });
    expect(by["Standard_B2ats_v2"]).toMatchObject({ gbp: 0.0076 });
    expect(by["disk:E4"]).toEqual({ item: "disk:E4", gbp: 1.97, unit: "1/Month", meter: "E4 LRS Disk" }); // not the per-10K-transactions meter
    expect(by["disk:S4"]).toMatchObject({ gbp: 1.22 });
    expect(by["ip:v4"]).toMatchObject({ gbp: 0.0037, unit: "1 Hour" });
    expect(rows.map((r) => r.item).sort()).toEqual(["Standard_B1ls", "Standard_B1ms", "Standard_B1s", "Standard_B2ats_v2", "Standard_B2s", "disk:E4", "disk:S4", "ip:v4"]);
    expect(rows.some((r) => /Windows|Spot|Low Priority/.test(r.meter))).toBe(false);
  });

  it("GBP only, stale after 7 days", async () => {
    const usd = fixture("prices-uksouth");
    for (const i of usd.Items) i.currencyCode = "USD";
    expect(normalisePrices(usd, SIZES)).toEqual([]);

    const { env } = azureEnv();
    const cfg = await fixedConfig(env);
    await seedPrices(env, "uksouth", ago(6 * 24 * 60));
    let p = priceInfo(await readPrices(env.DB, "uksouth"), cfg, "uksouth", "Standard_B1s", "azure", NOW);
    expect(p).toMatchObject({ source: "azure", stale: false, reason: null });
    await env.DB.prepare("UPDATE az_prices SET fetched_at = ?1").bind(ago(8 * 24 * 60)).run();
    p = priceInfo(await readPrices(env.DB, "uksouth"), cfg, "uksouth", "Standard_B1s", "azure", NOW);
    expect(p).toMatchObject({ source: "fixed", stale: true, totalGbpPerHour: 0.0157, standbyGbpPerHour: 0.0064, vmGbpPerHour: 0.0093 });
    expect(p.reason).toMatch(/more than 7 days old/);

    // The query: GBP, the region, pay-as-you-go, the sizes, both disks and the IP in one OR filter.
    const q = new URLSearchParams(pricesQuery("uksouth", ["Standard_B1s"]));
    expect(q.get("currencyCode")).toBe("'GBP'");
    expect(q.get("api-version")).toBe("2023-01-01-preview");
    expect(q.get("$filter")).toBe("armRegionName eq 'uksouth' and priceType eq 'Consumption' and (armSkuName eq 'Standard_B1s' or meterName eq 'E4 LRS Disk' or meterName eq 'S4 LRS Disk' or meterName eq 'Standard IPv4 Static Public IP')");
  });

  it("total is VM plus E4 over 730 plus IPv4; standby is disk plus IP; test VM is B1ls plus S4", async () => {
    const { env } = azureEnv();
    await seedPrices(env, "uksouth", ago(60));
    const cfg = await fixedConfig(env);
    const p = priceInfo(await readPrices(env.DB, "uksouth"), cfg, "uksouth", "Standard_B1s", "azure", NOW);
    expect(p.vmGbpPerHour).toBe(0.0093);
    expect(p.diskGbpPerHour).toBeCloseTo(1.97 / 730, 9);
    expect(p.ipGbpPerHour).toBe(0.0037);
    expect(p.totalGbpPerHour).toBeCloseTo(0.0093 + 1.97 / 730 + 0.0037, 9);
    expect(p.standbyGbpPerHour).toBeCloseTo(1.97 / 730 + 0.0037, 9);
    expect(p).toMatchObject({ region: "uksouth", size: "Standard_B1s", source: "azure", fetchedAt: ago(60) });
    const eff = await effectiveConfig(env);
    expect(eff.testVmRateGbp).toBeCloseTo(0.0047 + 1.22 / 730, 9);
  });

  it("rate_source defaults to fixed when an hourly override is stored, else azure", () => {
    expect(rateSource({})).toBe("azure");
    expect(rateSource({ hourly_rate_gbp: "0.02" })).toBe("fixed");
    expect(rateSource({ hourly_rate_gbp: "0.02", rate_source: "azure" })).toBe("azure");
    expect(rateSource({ rate_source: "fixed" })).toBe("fixed");
    expect(rateSource({ rate_source: "weird" })).toBe("azure");
  });

  it("any saved fixed-rate override (hourly, standby or test VM) keeps the fixed rates unless Steven chose azure", async () => {
    expect(rateSource({ standby_rate_gbp: "0.004" })).toBe("fixed");
    expect(rateSource({ test_vm_rate_gbp: "0.006" })).toBe("fixed");
    expect(rateSource({ standby_rate_gbp: "", hourly_rate_gbp: "" })).toBe("azure"); // cleared, not saved
    expect(rateSource({ standby_rate_gbp: "0.004", rate_source: "azure" })).toBe("azure");
    expect(rateSource({ test_vm_rate_gbp: "0.006", rate_source: "azure" })).toBe("azure");
    // Through Settings: saving only the Standby rate keeps the source fixed.
    const { env } = azureEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: base });
    expect((await api(env, "PUT", "/settings", { standby_rate_gbp: "0.004" })).status).toBe(200);
    expect((await api(env, "GET", "/settings")).json.rateSource).toBe("fixed");
  });

  it("effectiveConfig uses the Azure price for the deployed region and size", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { env } = azureEnv();
    await seedPrices(env, "uksouth", ago(60));
    await seedPrices(env, "westeurope", ago(60), { Standard_B2s: 0.04, Standard_B1ls: 0.005 });
    // Destroyed: the configured region and size (uksouth, B1s).
    let cfg = await effectiveConfig(env);
    expect(cfg.hourlyRateGbp).toBeCloseTo(0.0093 + 1.97 / 730 + 0.0037, 9);
    expect(cfg.standbyRateGbp).toBeCloseTo(1.97 / 730 + 0.0037, 9);
    // Running in westeurope on a B2s from a profile: that is what costs money now.
    await running(env, { region: "westeurope", vm_size: "Standard_B2s" });
    cfg = await effectiveConfig(env);
    expect(cfg.hourlyRateGbp).toBeCloseTo(0.04 + 1.97 / 730 + 0.0037, 9);
    expect(cfg.region).toBe("uksouth"); // the settings themselves are unchanged
    // Fixed chosen: the fixed rates.
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('rate_source', 'fixed')").run();
    cfg = await effectiveConfig(env);
    expect(cfg.hourlyRateGbp).toBe(0.0157);
    expect(cfg.standbyRateGbp).toBe(0.0064);
  });

  it("no fresh GBP price falls back to fixed with a reason", async () => {
    const { env } = azureEnv();
    const cfg = await fixedConfig(env);
    const p = priceInfo([], cfg, "uksouth", "Standard_B2s", "azure", NOW);
    expect(p).toEqual({ region: "uksouth", size: "Standard_B2s", vmGbpPerHour: null, diskGbpPerHour: null, ipGbpPerHour: null, totalGbpPerHour: 0.0157, standbyGbpPerHour: 0.0064, fetchedAt: null, stale: false, source: "fixed", reason: expect.stringMatching(/No Azure price for Standard_B2s in UK South/) });
    expect((await effectiveConfig(env)).hourlyRateGbp).toBe(0.0157);
    const chosen = priceInfo([], cfg, "uksouth", "Standard_B2s", "fixed", NOW);
    expect(chosen.reason).toMatch(/Settings/);
  });

  it("with the fixed rates chosen the price still carries Azure's list figures when it has them, so Settings can offer the choice", async () => {
    const { env } = azureEnv();
    await seedPrices(env, "uksouth", ago(60));
    const cfg = await fixedConfig(env);
    const p = priceInfo(await readPrices(env.DB, "uksouth"), cfg, "uksouth", "Standard_B1s", "fixed", NOW);
    expect(p).toMatchObject({ source: "fixed", totalGbpPerHour: 0.0157, standbyGbpPerHour: 0.0064, vmGbpPerHour: 0.0093, ipGbpPerHour: 0.0037, fetchedAt: ago(60), stale: false, reason: expect.stringMatching(/Settings/) });
    // Nothing priced: no figures, as before.
    expect(priceInfo([], cfg, "uksouth", "Standard_B1s", "fixed", NOW)).toMatchObject({ vmGbpPerHour: null, fetchedAt: null });
  });

  it("the feed reads each region in use daily, one per run, in one call per batch", async () => {
    const { env, az } = azureEnv();
    await env.DB.prepare("DELETE FROM profiles").run();
    await allNotDue(env);
    await setFeed(env, "prices", { status: "ok", next_due_at: ago(1) });
    await runInsights(env, NOW);
    const calls = callsTo(az, "prices.azure.com");
    const batches = priceRequests();
    expect(calls).toHaveLength(batches);
    for (const c of calls) {
      expect(c.headers.authorization).toBeUndefined(); // no token to the price API
      expect(c.url).not.toMatch(/\+/);
    }
    expect((await feedRows(env)).prices.status).toBe("ok");
    const rows = (await env.DB.prepare("SELECT item, gbp FROM az_prices WHERE region = 'uksouth' ORDER BY item").all<{ item: string; gbp: number }>()).results;
    expect(rows.find((r) => r.item === "ip:v4")!.gbp).toBe(0.0037);
    // Next pages are followed (prices.azure.com only), up to three calls a batch.
    az.handlers.push((c) => {
      if (c.u.hostname !== "prices.azure.com") return undefined;
      const page = fixture("prices-uksouth");
      page.NextPageLink = `https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$skip=${Number(c.u.searchParams.get("$skip") ?? 0) + 100}`;
      return json(page);
    });
    await setFeed(env, "prices", { status: "ok", next_due_at: ago(1) });
    await env.DB.prepare("DELETE FROM az_prices").run();
    await runInsights(env, NOW);
    expect(callsTo(az, "prices.azure.com")).toHaveLength(batches + 3 * batches);
  });

  it("the feed reads every region's freshness in one statement and still picks the first stale region", async () => {
    const { env, az } = azureEnv();
    await env.DB.prepare("DELETE FROM profiles").run();
    await env.DB.prepare("INSERT INTO profiles (name, region, vm_size) VALUES ('US', 'eastus', 'Standard_B2s')").run();
    // uksouth fresh, eastus never read, ukwest (a lab's secondary region) two days old.
    await seedPrices(env, "uksouth", ago(10));
    await seedPrices(env, "ukwest", ago(2 * 24 * 60));
    await allNotDue(env);
    await setFeed(env, "prices", { status: "ok", next_due_at: ago(1) });
    const d1 = countD1(env);
    await runInsights(env, NOW);
    d1.stop();
    // The freshness read: MIN(fetched_at) per region, every region in one statement.
    expect(d1.sql.filter((s) => /^SELECT .*MIN\(fetched_at\).* FROM az_prices/.test(s))).toHaveLength(1);
    const calls = callsTo(az, "prices.azure.com");
    expect(calls).toHaveLength(priceRequests());
    for (const c of calls) expect(decodeURIComponent(c.url)).toContain("armRegionName eq 'eastus'");
    // Another stale region (ukwest) remains, so the feed comes back in five minutes.
    expect((await feedRows(env)).prices.next_due_at).toBe(new Date(NOW.getTime() + 5 * MIN).toISOString());
  });

  it("every request for the full real catalogue stays inside Azure's limits (20 comparisons, 2,000 characters) and asks for everything once", () => {
    const meters = labMeters();
    // Every region in use: the configured one, a profile's, each lab's secondary, and a long region name.
    const regions = [...new Set(["uksouth", "eastus", "australiasoutheast", ...catalogue().labs.map((l) => l.regions.secondary).filter((r): r is string => !!r)])];
    // The sizes the feed asks for, plus profile sizes not in the list.
    const sizes = [...new Set([...VM_SIZES, TEST_VM_SIZE, ...labVmSizes(), "Standard_D2s_v5", "Standard_D4as_v5"])];
    for (const region of regions) {
      const urls = priceUrls(region, sizes, meters);
      const asked: string[] = [];
      for (const url of urls) {
        expect(url.length, url).toBeLessThanOrEqual(MAX_PRICE_URL);
        expect(url.startsWith("https://prices.azure.com/api/retail/prices?")).toBe(true);
        expect(url).not.toMatch(/[ +]/);
        const q = new URL(url).searchParams;
        expect(q.get("currencyCode")).toBe("'GBP'");
        const filter = q.get("$filter")!;
        expect(filter.startsWith(`armRegionName eq '${region}' and priceType eq 'Consumption' and (`)).toBe(true);
        expect(filter.endsWith(")")).toBe(true);
        expect(comparisons(filter), filter).toBeLessThanOrEqual(MAX_FILTER_COMPARISONS);
        asked.push(...orTerms(filter));
      }
      // Every size, the three fixed meters and every lab meter, each in exactly one request.
      const want = [...sizes.map((s) => `armSkuName eq '${s}'`), ...[...new Set(["E4 LRS Disk", "S4 LRS Disk", "Standard IPv4 Static Public IP", ...meters])].map((m) => `meterName eq '${m.replace(/'/g, "''")}'`)];
      expect(asked.sort()).toEqual(want.sort());
    }
  });

  it("regression: labs batch 4 put 23 comparisons in one filter and Azure refused it (400); now split into requests of at most 20", () => {
    const sizes = [...new Set([...VM_SIZES, TEST_VM_SIZE, ...labVmSizes()])];
    // What the feed sent until now: one filter for everything (Azure: "Invalid OData parameters supplied" past 20 comparisons).
    const one = new URLSearchParams(pricesQuery("uksouth", sizes, labMeters())).get("$filter")!;
    expect(comparisons(one)).toBeGreaterThan(MAX_FILTER_COMPARISONS);
    const urls = priceUrls("uksouth", sizes, labMeters());
    expect(urls.length).toBeGreaterThan(1);
    for (const u of urls) expect(comparisons(new URL(u).searchParams.get("$filter")!)).toBeLessThanOrEqual(MAX_FILTER_COMPARISONS);
    // Exactly 18 asks fit one request (2 + 18 = 20 comparisons); the 19th starts a second.
    const many = Array.from({ length: 19 }, (_, i) => `Standard_X${i}`);
    expect(priceUrls("uksouth", many.slice(0, 15)).map((u) => comparisons(new URL(u).searchParams.get("$filter")!))).toEqual([20]);
    expect(priceUrls("uksouth", many).every((u) => comparisons(new URL(u).searchParams.get("$filter")!) <= 20)).toBe(true);
    // Long meter names split on length too (Azure answers 404 past 2,048 characters), and a quote is doubled, not counted as a split.
    const long = Array.from({ length: 15 }, (_, i) => `A Very Long Meter Name For Some Premium Secured Virtual Hub Deployment In A Secondary Region ${i} O'Brien`);
    const longUrls = priceUrls("uksouth", [], long);
    expect(longUrls.length).toBeGreaterThan(1);
    for (const u of longUrls) {
      expect(u.length).toBeLessThanOrEqual(MAX_PRICE_URL);
      expect(new URL(u).searchParams.get("$filter")).toContain("O''Brien");
    }
    expect(longUrls.flatMap((u) => orTerms(new URL(u).searchParams.get("$filter")!)).filter((t) => t.includes("O''Brien"))).toHaveLength(15);
  });

  it("the feed sends one request per batch and stores what every batch answered", async () => {
    const { env, az } = azureEnv();
    await env.DB.prepare("DELETE FROM profiles").run();
    await allNotDue(env);
    await setFeed(env, "prices", { status: "ok", next_due_at: ago(1) });
    // Each batch answers only what it asked for (as Azure does): the VM sizes in one, the lab meters in another.
    az.handlers.push((c) => {
      if (c.u.hostname !== "prices.azure.com") return undefined;
      const f = c.u.searchParams.get("$filter") ?? "";
      const all = fixture("prices-uksouth").Items as Record<string, unknown>[];
      const lab = { currencyCode: "GBP", type: "Consumption", retailPrice: 0.5, unitOfMeasure: "1 Hour", meterName: "VpnGw1AZ", productName: "VPN Gateway", skuName: "VpnGw1AZ", isPrimaryMeterRegion: true };
      const items = all.filter((i) => (typeof i.armSkuName === "string" && f.includes(`'${i.armSkuName}'`)) || f.includes(`'${i.meterName}'`));
      if (f.includes("'VpnGw1AZ'")) items.push(lab);
      return json({ Items: items, NextPageLink: null });
    });
    await runInsights(env, NOW);
    const calls = callsTo(az, "prices.azure.com");
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.url.length).toBeLessThanOrEqual(MAX_PRICE_URL);
      expect(comparisons(new URL(c.url).searchParams.get("$filter")!)).toBeLessThanOrEqual(MAX_FILTER_COMPARISONS);
    }
    expect((await feedRows(env)).prices).toMatchObject({ status: "ok", error: null });
    const items = (await env.DB.prepare("SELECT item FROM az_prices WHERE region = 'uksouth'").all<{ item: string }>()).results.map((r) => r.item);
    expect(items).toEqual(expect.arrayContaining(["Standard_B1s", "ip:v4", "disk:E4", "lab:VpnGw1AZ"]));
  });

  it("settings PUT accepts rate_source", async () => {
    const { env } = azureEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: base });
    let s = await api(env, "GET", "/settings");
    expect(s.json.rateSource).toBe("azure");
    expect(s.json.price).toMatchObject({ source: "fixed", reason: expect.any(String) });
    expect((await api(env, "PUT", "/settings", { rate_source: "fixed" })).status).toBe(200);
    s = await api(env, "GET", "/settings");
    expect(s.json.rateSource).toBe("fixed");
    expect(s.json.overrides.rate_source).toBe("fixed");
    const bad = await api(env, "PUT", "/settings", { rate_source: "cheap" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.field).toBe("rate_source");
    // With fresh prices and the Azure source, Settings shows the Azure price, but the form keeps the fixed rates.
    await api(env, "PUT", "/settings", { rate_source: "azure" });
    await seedPrices(env, "uksouth", new Date().toISOString());
    s = await api(env, "GET", "/settings");
    expect(s.json.price).toMatchObject({ source: "azure", vmGbpPerHour: 0.0093 });
    expect(s.json.values.hourlyRateGbp).toBe(0.0157);
    const { env: off } = azureEnv({ ...NO_AZURE, AUTH_DEV_BYPASS: "1", PUBLIC_URL: base });
    expect((await api(off, "GET", "/settings")).json.price.source).toBe("fixed");
    await saveSnapshot(off, { state: "destroyed" });
  });
});
