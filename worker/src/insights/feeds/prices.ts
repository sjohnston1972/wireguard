// insights/feeds/prices.ts
//
// Plain English: Azure's retail list prices in GBP (prices.azure.com, no
// sign-in), daily for each region in use, one region per run. It asks for
// every VM size wg-admin may build, the E4 and S4 disks and the static IPv4
// address (OR filters), in as few calls as Azure allows: a filter may make at
// most 20 comparisons and a URL may be at most about 2,000 characters, so the
// asks are split into batches (priceUrls) and the answers merged. Each
// batch's next pages, if any, are followed on prices.azure.com only, up to
// three calls a batch. Linux pay-as-you-go only: names
// with Windows, Spot or Low Priority are skipped, and so are units other
// than "1 Hour" and "1/Month". Stored in az_prices; see insights/price.ts.
//
// Labs (labs spec §9.1): every lab cost item's retail meter is asked for by
// name too and stored as item "lab:<meter>"; a lab's VM sizes (retail.sku)
// are among the sizes of interest; each lab's secondary region is read as well.

import type { FeedModule } from "../runner";
import type { FeedCtx } from "../types";
import { listProfiles } from "../../db";
import { DAY, MIN, iso, num, str } from "../common";
import { TEST_VM_SIZE, labVmSizes, sizesOfInterest } from "./capacity";
import { catalogue } from "../../labs/catalogue";
import { VM_SIZES } from "../../settings";

const PRICES_URL = "https://prices.azure.com/api/retail/prices";
const PRICES_API = "2023-01-01-preview";
const MAX_PAGES = 3;
const METERS: Record<string, { item: string; unit: string }> = {
  "E4 LRS Disk": { item: "disk:E4", unit: "1/Month" },
  "S4 LRS Disk": { item: "disk:S4", unit: "1/Month" },
  "Standard IPv4 Static Public IP": { item: "ip:v4", unit: "1 Hour" },
};
/** Rows skipped as not Linux pay-as-you-go (scripts/labs-verify.mjs uses the same; a test keeps them equal). */
export const NOT_LINUX_PAYG = /Windows|Spot|Low Priority/i;

export interface PriceItem {
  item: string;
  gbp: number;
  unit: string;
  meter: string;
}

/** A lab cost item's meter (labs spec §9.1) is stored as this item: "lab:<meter name>". */
export const labItem = (meter: string) => `lab:${meter}`;
/**
 * Units a lab meter may be priced in (each turns into £ per hour, labs/prices.ts).
 * Azure writes hourly two ways: "1 Hour" (VMs, public IPs) and "1/Hour"
 * (Application Gateway, among others). scripts/labs-verify.mjs uses the same list.
 */
export const LAB_UNITS = ["1 Hour", "1/Hour", "1/Day", "1/Month"];
/** An OData string literal ('' for a quote). */
const odata = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Every lab cost item's retail meter in the catalogue (labs spec §9.1), each once. */
export function labMeters(): string[] {
  return [...new Set(catalogue().labs.flatMap((l) => l.cost.items.map((i) => i.retail?.meter).filter((m): m is string => !!m)))];
}

/**
 * Azure's price list refuses a $filter with more than 20 comparisons (400,
 * "Invalid OData parameters supplied"), however short; measured 2026-10-08.
 * Each request spends 2 on the region and price type, leaving 18 asks.
 */
export const MAX_FILTER_COMPARISONS = 20;
const ASKS_PER_REQUEST = MAX_FILTER_COMPARISONS - 2;
/** Azure answers 404 past 2,048 characters of URL (measured 2026-10-08); each request stays under this. */
export const MAX_PRICE_URL = 2000;

/** Every ask, each once: the sizes, the three fixed meters, the labs' meters. */
function asks(sizes: string[], meters: string[]): string[] {
  const named = [...new Set([...Object.keys(METERS), ...meters])];
  return [...new Set([...sizes.map((s) => `armSkuName eq ${odata(s)}`), ...named.map((m) => `meterName eq ${odata(m)}`)])];
}

function queryOf(region: string, any: string[]): string {
  const filter = `armRegionName eq ${odata(region)} and priceType eq 'Consumption' and (${any.join(" or ")})`;
  return `api-version=${PRICES_API}&currencyCode=${encodeURIComponent("'GBP'")}&$filter=${encodeURIComponent(filter)}`;
}

/** One query string for everything (spaces as %20). `meters`: the labs' retail meters, asked for by name too. Too big for Azure once there are more than 18 asks: the feed uses priceUrls. */
export function pricesQuery(region: string, sizes: string[], meters: string[] = []): string {
  return queryOf(region, asks(sizes, meters));
}

/** The request URLs for one region: every ask once, split so that no request passes Azure's 20 comparisons or 2,000 characters. */
export function priceUrls(region: string, sizes: string[], meters: string[] = []): string[] {
  const url = (any: string[]) => `${PRICES_URL}?${queryOf(region, any)}`;
  const out: string[] = [];
  let batch: string[] = [];
  for (const a of asks(sizes, meters)) {
    if (batch.length && (batch.length >= ASKS_PER_REQUEST || url([...batch, a]).length > MAX_PRICE_URL)) {
      out.push(url(batch));
      batch = [];
    }
    if (url([a]).length > MAX_PRICE_URL) throw new Error("A price asked for has a name too long for Azure's price list.");
    batch.push(a);
  }
  if (batch.length) out.push(url(batch));
  return out;
}

/** How many requests a region needs for today's catalogue and the built-in sizes (a profile's own size may add one). */
export function priceRequests(): number {
  return priceUrls("australiasoutheast", [...new Set([...VM_SIZES, TEST_VM_SIZE, ...labVmSizes()])], labMeters()).length;
}

/** The price items worth keeping, one per item (a primary meter region first). A lab meter is kept as "lab:<meter>". */
export function normalisePrices(reply: unknown, sizes: string[], meters: string[] = []): PriceItem[] {
  const items = (reply as { Items?: unknown })?.Items;
  if (!Array.isArray(items)) return [];
  const out = new Map<string, { row: PriceItem; primary: boolean }>();
  for (const raw of items.slice(0, 5000)) {
    const i = raw as Record<string, unknown>;
    if (i?.currencyCode !== "GBP" || i.type !== "Consumption") continue;
    const names = [i.productName, i.skuName, i.meterName].map((x) => (typeof x === "string" ? x : "")).join(" ");
    if (NOT_LINUX_PAYG.test(names)) continue;
    const gbp = num(i.retailPrice);
    const unit = str(i.unitOfMeasure, 20);
    const meter = str(i.meterName, 80);
    if (gbp === null || gbp < 0 || !unit || !meter) continue;
    let item: string | null = null;
    const m = METERS[meter];
    if (m) item = unit === m.unit ? m.item : null;
    else if (typeof i.armSkuName === "string" && sizes.includes(i.armSkuName) && unit === "1 Hour") item = i.armSkuName;
    else if (meters.includes(meter) && LAB_UNITS.includes(unit)) item = labItem(meter);
    if (!item) continue;
    const primary = i.isPrimaryMeterRegion !== false;
    const have = out.get(item);
    if (!have || (primary && !have.primary)) out.set(item, { row: { item, gbp, unit, meter }, primary });
  }
  return [...out.values()].map((x) => x.row);
}

/** Every row Azure answers for one region: one request per batch (priceUrls), each following its next pages up to three calls. */
export async function fetchPrices(ctx: FeedCtx, region: string, sizes: string[], meters: string[] = []): Promise<unknown[]> {
  const all: unknown[] = [];
  for (const first of priceUrls(region, sizes, meters)) {
    let next: string | null = first;
    for (let page = 0; page < MAX_PAGES && next; page++) {
      const r = await ctx.fetch(next);
      if (!r.ok) throw new Error(`Azure's price list refused the request (${r.status}).`);
      const j = (await r.json()) as { Items?: unknown; NextPageLink?: unknown };
      if (Array.isArray(j.Items)) all.push(...j.Items);
      const link = typeof j.NextPageLink === "string" ? j.NextPageLink : null;
      next = link && link.startsWith(`${PRICES_URL}?`) ? link : null;
    }
  }
  return all;
}

export async function storePrices(db: D1Database, region: string, rows: PriceItem[], at: string): Promise<void> {
  if (!rows.length) return;
  await db.batch(
    rows.map((r) =>
      db
        .prepare("INSERT INTO az_prices (region, item, gbp, unit, meter, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (region, item) DO UPDATE SET gbp = excluded.gbp, unit = excluded.unit, meter = excluded.meter, fetched_at = excluded.fetched_at")
        .bind(region, r.item, r.gbp, r.unit, r.meter, at),
    ),
  );
}

/** Regions in use whose prices were last read more than a day ago (or never): the configured one, the profiles', and each lab's secondary region. */
async function staleRegions(ctx: FeedCtx): Promise<string[]> {
  const profiles = await listProfiles(ctx.env).catch(() => []);
  const secondaries = catalogue().labs.map((l) => l.regions.secondary).filter((r): r is string => !!r);
  const regions = [...new Set([ctx.cfg.region, ...profiles.map((p) => p.region), ...secondaries])];
  // One statement for every region (GROUP BY), so a lab's secondary region adds no D1 round trip.
  const marks = regions.map((_, i) => `?${i + 1}`).join(", ");
  const rows = (
    await ctx.db
      .prepare(`SELECT region, MIN(fetched_at) AS at FROM az_prices WHERE region IN (${marks}) GROUP BY region`)
      .bind(...regions)
      .all<{ region: string; at: string | null }>()
  ).results;
  const at = new Map(rows.map((r) => [r.region, r.at]));
  return regions.filter((r) => {
    const have = at.get(r);
    return !have || !(ctx.now.getTime() - Date.parse(have) < DAY);
  });
}

const prices: FeedModule = {
  id: "prices",
  title: "Retail prices",
  cadenceMin: 1440,
  when: "always",
  // One call per batch (priceUrls); a next page or a profile's own size can take more, and the run's budget stops it there (skipped, stays due).
  get calls() {
    return priceRequests();
  },
  arm: false,
  async run(ctx) {
    const stale = await staleRegions(ctx);
    if (!stale.length) return { status: "ok", error: null };
    const region = stale[0]!;
    const sizes = await sizesOfInterest(ctx);
    const meters = labMeters();
    const rows = normalisePrices({ Items: await fetchPrices(ctx, region, sizes, meters) }, sizes, meters);
    if (!rows.length) throw new Error(`Azure's price list had no GBP pay-as-you-go prices for ${region}.`);
    await storePrices(ctx.db, region, rows, ctx.now.toISOString());
    return { status: "ok", error: null, nextDueAt: stale.length > 1 ? iso(ctx.now.getTime() + 5 * MIN) : null };
  },
};

export default prices;
