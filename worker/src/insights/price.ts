// insights/price.ts
//
// Plain English: what an hour of wg-admin costs, from Azure's list prices.
// Running = the VM + the E4 disk (a monthly price / 730) + the static IPv4
// address; Standby = the disk + the address; the test VM = a B1ls + an S4
// disk. GBP list prices before discounts and VAT, so not the invoice.
//
// The setting rate_source picks Azure's price or the fixed rates; with
// nothing saved it is "fixed" if any fixed-rate override (hourly, Standby
// or test VM rate) is saved, otherwise "azure". Under "azure", a price that is
// missing or more than 7 days old means the fixed rates apply, with the
// reason given. Settings and every cost estimate read this (settings.ts).
//
// Pure apart from readPrices; never imports settings.ts (settings.ts imports this).

import type { Config } from "../env";
import type { PriceInfo } from "../../../shared/api";
import { azureRegionName } from "../region";

export const HOURS_PER_MONTH = 730;
/** A stored price is used for 7 days. */
export const PRICE_STALE_MS = 7 * 86_400_000;
export const TEST_VM_SIZE = "Standard_B1ls";

export interface PriceRow {
  region: string;
  item: string;
  gbp: number;
  unit: string;
  fetched_at: string;
}

export type RateSource = "azure" | "fixed";

/**
 * The fixed-rate overrides: saving any of them means Steven set his own rates,
 * so the source stays "fixed" until he picks "azure". (test_vm_rate_gbp is not
 * saved by Settings today; it is here so one would follow the same rule.)
 */
export const FIXED_RATE_KEYS = ["hourly_rate_gbp", "standby_rate_gbp", "test_vm_rate_gbp"] as const;

/** The rate source from the stored settings (see the file comment). */
export function rateSource(stored: Record<string, string>): RateSource {
  if (stored.rate_source === "fixed" || stored.rate_source === "azure") return stored.rate_source;
  return FIXED_RATE_KEYS.some((k) => stored[k] !== undefined && stored[k] !== "") ? "fixed" : "azure";
}

export async function readPrices(db: D1Database, region?: string): Promise<PriceRow[]> {
  const q = region ? db.prepare("SELECT region, item, gbp, unit, fetched_at FROM az_prices WHERE region = ?1").bind(region) : db.prepare("SELECT region, item, gbp, unit, fetched_at FROM az_prices");
  return (await q.all<PriceRow>()).results;
}

/** A price row as GBP per hour (a monthly price over 730 hours), or null. */
function perHour(r: PriceRow | undefined): number | null {
  if (!r || !Number.isFinite(r.gbp)) return null;
  if (r.unit === "1 Hour") return r.gbp;
  if (r.unit === "1/Month") return r.gbp / HOURS_PER_MONTH;
  return null;
}

/** Tidy float noise only (0.1 + 0.2), keeping every meaningful digit. */
const round = (n: number) => Math.round(n * 1e12) / 1e12;

/** The fixed rates as a PriceInfo, with why they apply. */
export function fixedPrice(cfg: Config, region: string, size: string, reason: string): PriceInfo {
  return { region, size, vmGbpPerHour: null, diskGbpPerHour: null, ipGbpPerHour: null, totalGbpPerHour: cfg.hourlyRateGbp, standbyGbpPerHour: cfg.standbyRateGbp, fetchedAt: null, stale: false, source: "fixed", reason };
}

/**
 * The price for `size` in `region`. `cfg` carries the fixed rates (from
 * fixedConfig, never an Azure-priced config).
 */
export function priceInfo(rows: PriceRow[], cfg: Config, region: string, size: string, source: RateSource, now: Date): PriceInfo {
  const place = azureRegionName(region);
  const of = (item: string) => rows.find((r) => r.region === region && r.item === item);
  const parts = [of(size), of("disk:E4"), of("ip:v4")];
  const [vm, disk, ip] = parts.map(perHour);
  if (vm === null || disk === null || ip === null) {
    return fixedPrice(cfg, region, size, source === "fixed" ? "Settings use the fixed rates." : `No Azure price for ${size} in ${place} yet, so the fixed rates apply.`);
  }
  const oldest = parts.map((p) => p!.fetched_at).sort()[0]!;
  const priced = { vmGbpPerHour: round(vm), diskGbpPerHour: round(disk), ipGbpPerHour: round(ip), fetchedAt: oldest };
  const stale = !(now.getTime() - Date.parse(oldest) <= PRICE_STALE_MS);
  // Fixed chosen: the fixed rates, still carrying Azure's list figures (Settings offers the choice only when there are some).
  if (source === "fixed") return { ...fixedPrice(cfg, region, size, "Settings use the fixed rates."), ...priced, stale };
  if (stale) {
    return { ...fixedPrice(cfg, region, size, `Azure's prices for ${place} are more than 7 days old, so the fixed rates apply.`), ...priced, stale: true };
  }
  return { region, size, ...priced, totalGbpPerHour: round(vm + disk + ip), standbyGbpPerHour: round(disk + ip), stale: false, source: "azure", reason: null };
}

/** The test VM's hourly price (B1ls + S4) in a region, when fresh; else null. */
export function testVmPrice(rows: PriceRow[], region: string, now: Date): number | null {
  const of = (item: string) => rows.find((r) => r.region === region && r.item === item);
  const vm = of(TEST_VM_SIZE);
  const disk = of("disk:S4");
  const a = perHour(vm);
  const b = perHour(disk);
  if (a === null || b === null) return null;
  const oldest = [vm!.fetched_at, disk!.fetched_at].sort()[0]!;
  return now.getTime() - Date.parse(oldest) <= PRICE_STALE_MS ? round(a + b) : null;
}
