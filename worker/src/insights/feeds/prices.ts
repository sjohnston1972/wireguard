// insights/feeds/prices.ts
//
// Plain English: Azure's retail list prices in GBP (prices.azure.com, no
// sign-in), daily for each region in use, one region per run. One call asks
// for every VM size wg-admin may build, the E4 and S4 disks and the static
// IPv4 address together (an OR filter); next pages, if any, are followed on
// prices.azure.com only, up to three calls. Linux pay-as-you-go only: names
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
import { sizesOfInterest } from "./capacity";
import { catalogue } from "../../labs/catalogue";

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

/** The query string (spaces as %20). `meters`: the labs' retail meters, asked for by name too. */
export function pricesQuery(region: string, sizes: string[], meters: string[] = []): string {
  const any = [...sizes.map((s) => `armSkuName eq '${s}'`), ...Object.keys(METERS).map((m) => `meterName eq '${m}'`), ...meters.filter((m) => !Object.hasOwn(METERS, m)).map((m) => `meterName eq ${odata(m)}`)].join(" or ");
  const filter = `armRegionName eq '${region}' and priceType eq 'Consumption' and (${any})`;
  return `api-version=${PRICES_API}&currencyCode=${encodeURIComponent("'GBP'")}&$filter=${encodeURIComponent(filter)}`;
}

/** The price items worth keeping, one per item (a primary meter region first). A lab meter is kept as "lab:<meter>". */
export function normalisePrices(reply: unknown, sizes: string[], meters: string[] = []): PriceItem[] {
  const items = (reply as { Items?: unknown })?.Items;
  if (!Array.isArray(items)) return [];
  const out = new Map<string, { row: PriceItem; primary: boolean }>();
  for (const raw of items.slice(0, 1000)) {
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

export async function fetchPrices(ctx: FeedCtx, region: string, sizes: string[], meters: string[] = []): Promise<unknown[]> {
  let next: string | null = `${PRICES_URL}?${pricesQuery(region, sizes, meters)}`;
  const all: unknown[] = [];
  for (let page = 0; page < MAX_PAGES && next; page++) {
    const r = await ctx.fetch(next);
    if (!r.ok) throw new Error(`Azure's price list refused the request (${r.status}).`);
    const j = (await r.json()) as { Items?: unknown; NextPageLink?: unknown };
    if (Array.isArray(j.Items)) all.push(...j.Items);
    const link = typeof j.NextPageLink === "string" ? j.NextPageLink : null;
    next = link && link.startsWith(`${PRICES_URL}?`) ? link : null;
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
  calls: 1,
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
