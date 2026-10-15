// labs/prices.ts
//
// Plain English: what a lab costs an hour (labs spec §9.1). Each cost item is
// gbp_h × qty. Where lab.yaml names Azure's list price for an item (a meter,
// or a VM size), the price feed keeps it in az_prices (insights/feeds/
// prices.ts: "lab:<meter>", or the size itself), and a price under 7 days old
// replaces the authored figure. Older or missing: the authored gbp_h, and the
// modal says so (source "authored"). GBP list prices before discounts and VAT.
//
// An item with `region: secondary` (labs batch 3, ruling 26: a replica disk, a
// geo-secondary database) is priced in the session's secondary region, which
// is the lab's regions.secondary (engine.ts copies it onto the session). The
// feed reads every lab's secondary region daily, so its rows are there too.
//
// AWS labs from aws_prices (AWS labs spec §6 Prices, §9): an item with an
// aws_price is priced from the lab price feed's row (insights/aws/feeds/
// labPrices.ts, item awsPriceKey(ref)) in London, AWS_LAB_REGIONS[0], or in
// the lab's secondary region for `region: secondary` items, whatever region
// the caller passed (that is Azure's). "Hrs" is per hour; "GB-Mo" is × gb ÷
// 730. Under 7 days old it replaces gbp_h and the line's source reads "aws".

import type { Env } from "../env";
import { readPrices, PRICE_STALE_MS, HOURS_PER_MONTH, type PriceRow } from "../insights/price";
import { labItem } from "../insights/feeds/prices";
import { readAwsPrices } from "../insights/aws/feeds/prices";
import { catalogue } from "./catalogue";
import { AWS_LAB_REGIONS, awsPriceKey, estimateGbpH, type LabCostItem, type LabDef } from "../../../shared/labs";
import type { LabCostLine } from "../../../shared/api";

/** A stored price as £ per hour, or null when its unit is not a time. */
function perHour(r: Pick<PriceRow, "gbp" | "unit">): number | null {
  if (!Number.isFinite(r.gbp)) return null;
  if (r.unit === "1 Hour" || r.unit === "1/Hour") return r.gbp;
  if (r.unit === "1/Day") return r.gbp / 24;
  if (r.unit === "1/Month") return r.gbp / HOURS_PER_MONTH;
  return null;
}

/** A row's age in ms when it is fresh enough to use (7 days), else null. */
function freshAge(row: PriceRow, now: Date): number | null {
  const age = now.getTime() - Date.parse(row.fetched_at);
  return Number.isFinite(age) && age <= PRICE_STALE_MS ? age : null;
}

/**
 * The fresh list price of one item, with its age in seconds; null to use the
 * authored gbp_h. `region` is the session's; an item with `region: "secondary"`
 * is priced at `secondaryRegion` instead (none: the authored figure).
 */
export function retailPrice(item: LabCostItem, rows: PriceRow[], region: string, now: Date, secondaryRegion: string | null = null): { gbpH: number; age: number } | null {
  const r = item.retail;
  if (!r) return null;
  const at = item.region === "secondary" ? secondaryRegion : region;
  if (!at) return null;
  const row = r.sku ? rows.find((x) => x.region === at && x.item === r.sku) : r.meter ? rows.find((x) => x.region === at && x.item === labItem(r.meter!)) : undefined;
  if (!row) return null;
  if (r.unit && !r.sku && row.unit !== r.unit) return null;
  const age = freshAge(row, now);
  if (age === null) return null;
  const gbpH = perHour(row);
  return gbpH === null ? null : { gbpH, age: Math.max(0, Math.round(age / 1000)) };
}

/**
 * AWS's fresh list price of one item of an AWS lab (its aws_price), with its age in seconds; null to use the
 * authored gbp_h. The row is the lab price feed's, at `region` (or `secondaryRegion` for a `region: "secondary"`
 * item), in the reference's unit and under 7 days old: "Hrs" per hour, "GB-Mo" × gb ÷ 730.
 */
export function awsListPrice(item: LabCostItem, rows: PriceRow[], region: string, now: Date, secondaryRegion: string | null): { gbpH: number; age: number } | null {
  const ref = item.aws_price;
  if (!ref) return null;
  const at = item.region === "secondary" ? secondaryRegion : region;
  if (!at) return null;
  const key = awsPriceKey(ref);
  const row = rows.find((x) => x.region === at && x.item === key && x.unit === ref.unit);
  if (!row || !Number.isFinite(row.gbp)) return null;
  const age = freshAge(row, now);
  if (age === null) return null;
  const gbpH = ref.unit === "GB-Mo" ? (row.gbp * (ref.gb ?? 0)) / HOURS_PER_MONTH : row.gbp;
  return { gbpH, age: Math.max(0, Math.round(age / 1000)) };
}

/**
 * One item's fresh list price for `def` and where it came from: AWS's for an AWS lab (in London, whatever `region`
 * says), else Azure's in `region`; null to use the authored gbp_h.
 */
export function listPrice(def: LabDef, item: LabCostItem, rows: PriceRow[], region: string, now: Date): { gbpH: number; age: number; source: "azure" | "aws" } | null {
  if (def.cloud === "aws") {
    const p = awsListPrice(item, rows, AWS_LAB_REGIONS[0], now, def.regions.secondary);
    return p ? { ...p, source: "aws" } : null;
  }
  const p = retailPrice(item, rows, region, now, def.regions.secondary);
  return p ? { ...p, source: "azure" } : null;
}

/** Each item priced, for the modal (LabDetail.cost). */
export function pricedItems(def: LabDef, rows: PriceRow[], region: string, now: Date): LabCostLine[] {
  return def.cost.items.map((i) => {
    const p = listPrice(def, i, rows, region, now);
    return { ...i, gbpH: p ? p.gbpH : i.gbp_h, source: p ? p.source : "authored", priceAge: p ? p.age : null };
  });
}

/** £/h from already-read price rows (the region's and, for `region: secondary` items, the lab's secondary region's; an AWS lab's from aws_prices). */
export function gbpHFrom(def: LabDef, rows: PriceRow[], region: string, now: Date): number {
  return estimateGbpH(def.cost.items, (i) => listPrice(def, i, rows, region, now)?.gbpH ?? null);
}

/** The AWS lab price feed's rows (aws_prices items starting "lab:"); a failed read is none. */
async function awsLabRows(env: Env): Promise<PriceRow[]> {
  return (await readAwsPrices(env.DB).catch(() => [] as PriceRow[])).filter((r) => r.item.startsWith("lab:"));
}

/** The price rows the Labs tab needs: `region`'s, every catalogue lab's secondary region's, and the AWS lab price rows (a failed read is none). */
export async function readLabPrices(env: Env, region: string): Promise<PriceRow[]> {
  const regions = [...new Set([region, ...catalogue().labs.filter((l) => l.cloud !== "aws").map((l) => l.regions.secondary).filter((r): r is string => !!r)])];
  const all = await Promise.all([...regions.map((r) => readPrices(env.DB, r).catch(() => [] as PriceRow[])), awsLabRows(env)]);
  return all.flat();
}

/** £/h for a lab in a region now (reads az_prices for the region and the lab's secondary region, or an AWS lab's aws_prices rows; a price problem means the authored figures). */
export async function labGbpH(env: Env, def: LabDef, region: string, now: Date): Promise<number> {
  if (def.cloud === "aws") return gbpHFrom(def, await awsLabRows(env), region, now);
  const regions = [...new Set([region, def.regions.secondary].filter((r): r is string => !!r))];
  const rows = (await Promise.all(regions.map((r) => readPrices(env.DB, r).catch(() => [] as PriceRow[])))).flat();
  return gbpHFrom(def, rows, region, now);
}
