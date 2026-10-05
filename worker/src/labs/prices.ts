// labs/prices.ts
//
// Plain English: what a lab costs an hour (labs spec §9.1). Each cost item is
// gbp_h × qty. Where lab.yaml names Azure's list price for an item (a meter,
// or a VM size), the price feed keeps it in az_prices (insights/feeds/
// prices.ts: "lab:<meter>", or the size itself), and a price under 7 days old
// replaces the authored figure. Older or missing: the authored gbp_h, and the
// modal says so (source "authored"). GBP list prices before discounts and VAT.

import type { Env } from "../env";
import { readPrices, PRICE_STALE_MS, HOURS_PER_MONTH, type PriceRow } from "../insights/price";
import { labItem } from "../insights/feeds/prices";
import { estimateGbpH, type LabCostItem, type LabDef } from "../../../shared/labs";
import type { LabCostLine } from "../../../shared/api";

/** A stored price as £ per hour, or null when its unit is not a time. */
function perHour(r: Pick<PriceRow, "gbp" | "unit">): number | null {
  if (!Number.isFinite(r.gbp)) return null;
  if (r.unit === "1 Hour" || r.unit === "1/Hour") return r.gbp;
  if (r.unit === "1/Day") return r.gbp / 24;
  if (r.unit === "1/Month") return r.gbp / HOURS_PER_MONTH;
  return null;
}

/** The fresh list price of one item in a region, with its age in seconds; null to use the authored gbp_h. */
export function retailPrice(item: LabCostItem, rows: PriceRow[], region: string, now: Date): { gbpH: number; age: number } | null {
  const r = item.retail;
  if (!r) return null;
  const row = r.sku ? rows.find((x) => x.region === region && x.item === r.sku) : r.meter ? rows.find((x) => x.region === region && x.item === labItem(r.meter!)) : undefined;
  if (!row) return null;
  if (r.unit && !r.sku && row.unit !== r.unit) return null;
  const age = now.getTime() - Date.parse(row.fetched_at);
  if (!Number.isFinite(age) || age > PRICE_STALE_MS) return null;
  const gbpH = perHour(row);
  return gbpH === null ? null : { gbpH, age: Math.max(0, Math.round(age / 1000)) };
}

/** Each item priced, for the modal (LabDetail.cost). */
export function pricedItems(def: LabDef, rows: PriceRow[], region: string, now: Date): LabCostLine[] {
  return def.cost.items.map((i) => {
    const p = retailPrice(i, rows, region, now);
    return { ...i, gbpH: p ? p.gbpH : i.gbp_h, source: p ? "azure" : "authored", priceAge: p ? p.age : null };
  });
}

/** £/h from already-read price rows. */
export function gbpHFrom(def: LabDef, rows: PriceRow[], region: string, now: Date): number {
  return estimateGbpH(def.cost.items, (i) => retailPrice(i, rows, region, now)?.gbpH ?? null);
}

/** £/h for a lab in a region now (reads az_prices; a price problem means the authored figures). */
export async function labGbpH(env: Env, def: LabDef, region: string, now: Date): Promise<number> {
  const rows = await readPrices(env.DB, region).catch(() => [] as PriceRow[]);
  return gbpHFrom(def, rows, region, now);
}
