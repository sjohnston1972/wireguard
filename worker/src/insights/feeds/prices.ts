// insights/feeds/prices.ts
//
// Plain English: Azure's retail list prices in GBP (prices.azure.com, no
// sign-in), daily for each region in use, one region per run. One call asks
// for every VM size wg-admin may build, the E4 and S4 disks and the static
// IPv4 address together (an OR filter); next pages, if any, are followed on
// prices.azure.com only, up to three calls. Linux pay-as-you-go only: names
// with Windows, Spot or Low Priority are skipped, and so are units other
// than "1 Hour" and "1/Month". Stored in az_prices; see insights/price.ts.

import type { FeedModule } from "../runner";
import type { FeedCtx } from "../types";
import { listProfiles } from "../../db";
import { DAY, MIN, iso, num, str } from "../common";
import { sizesOfInterest } from "./capacity";

const PRICES_URL = "https://prices.azure.com/api/retail/prices";
const PRICES_API = "2023-01-01-preview";
const MAX_PAGES = 3;
const METERS: Record<string, { item: string; unit: string }> = {
  "E4 LRS Disk": { item: "disk:E4", unit: "1/Month" },
  "S4 LRS Disk": { item: "disk:S4", unit: "1/Month" },
  "Standard IPv4 Static Public IP": { item: "ip:v4", unit: "1 Hour" },
};
const NOT_LINUX_PAYG = /Windows|Spot|Low Priority/i;

export interface PriceItem {
  item: string;
  gbp: number;
  unit: string;
  meter: string;
}

/** The query string (spaces as %20). */
export function pricesQuery(region: string, sizes: string[]): string {
  const any = [...sizes.map((s) => `armSkuName eq '${s}'`), ...Object.keys(METERS).map((m) => `meterName eq '${m}'`)].join(" or ");
  const filter = `armRegionName eq '${region}' and priceType eq 'Consumption' and (${any})`;
  return `api-version=${PRICES_API}&currencyCode=${encodeURIComponent("'GBP'")}&$filter=${encodeURIComponent(filter)}`;
}

/** The price items worth keeping, one per item (a primary meter region first). */
export function normalisePrices(reply: unknown, sizes: string[]): PriceItem[] {
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
    if (!item) continue;
    const primary = i.isPrimaryMeterRegion !== false;
    const have = out.get(item);
    if (!have || (primary && !have.primary)) out.set(item, { row: { item, gbp, unit, meter }, primary });
  }
  return [...out.values()].map((x) => x.row);
}

export async function fetchPrices(ctx: FeedCtx, region: string, sizes: string[]): Promise<unknown[]> {
  let next: string | null = `${PRICES_URL}?${pricesQuery(region, sizes)}`;
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

/** Regions in use whose prices were last read more than a day ago (or never). */
async function staleRegions(ctx: FeedCtx): Promise<string[]> {
  const profiles = await listProfiles(ctx.env).catch(() => []);
  const regions = [...new Set([ctx.cfg.region, ...profiles.map((p) => p.region)])];
  const out: string[] = [];
  for (const r of regions) {
    const have = await ctx.db.prepare("SELECT MIN(fetched_at) AS at FROM az_prices WHERE region = ?1").bind(r).first<{ at: string | null }>();
    if (!have?.at || !(ctx.now.getTime() - Date.parse(have.at) < DAY)) out.push(r);
  }
  return out;
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
    const rows = normalisePrices({ Items: await fetchPrices(ctx, region, sizes) }, sizes);
    if (!rows.length) throw new Error(`Azure's price list had no GBP pay-as-you-go prices for ${region}.`);
    await storePrices(ctx.db, region, rows, ctx.now.toISOString());
    return { status: "ok", error: null, nextDueAt: stale.length > 1 ? iso(ctx.now.getTime() + 5 * MIN) : null };
  },
};

export default prices;
