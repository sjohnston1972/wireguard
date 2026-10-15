// insights/aws/feeds/prices.ts
//
// Plain English: AWS's list prices for what cloudlabs runs in AWS: the
// instance type per hour, the gp3 disk per GB-month and the public IPv4
// address per hour (the Price List API, GetProducts, in us-east-1), converted
// to GBP with config.aws.usdToGbp and stored in aws_prices; and awsPriceInfo,
// which turns them into Settings' AWS list price line (SettingsResponse.awsPrice).
// Spec 2026-10-15-aws-insights-design.md, section 4.6.
//
// Read daily for the AWS region and the configured instance type, three
// calls (one per product, each filtered by exact attribute matches).
// PriceList is an array of JSON strings, each one product with its terms, so
// every entry is parsed a second time; only the OnDemand terms' USD price is
// taken (never Reserved). Of the two public IPv4 products (in use, idle) the
// in-use one is kept. Running = instance + the 8 GB gp3 disk (GB-month / 730)
// + the address; stopped = the disk + the address. USD list prices before
// any free tier, credits or VAT, so not the invoice.

import type { Config } from "../../../env";
import type { PriceInfo } from "../../../../../shared/api";
import { awsRegionName } from "../../../../../shared/azureMetrics";
import { HOURS_PER_MONTH, PRICE_STALE_MS, type PriceRow } from "../../price";
import type { PriceItem } from "../../feeds/prices";
import { num, str } from "../../common";
import type { AwsFeed, AwsFeedCtx } from "../types";

/** The AWS server's disk: 8 GB of gp3 (infra). */
export const AWS_DISK_GB = 8;
/** The Price List API answers only in us-east-1 (and two others); prices for every region come from there. */
const PRICING = { service: "pricing", region: "us-east-1", host: "api.pricing.us-east-1.amazonaws.com", target: "AWSPriceListService.GetProducts" } as const;
/** The three products asked for. */
export type AwsPriceAsk = "instance" | "gp3" | "ip";
/** What each product is stored as, with the unit AWS prices it in and the unit stored. */
const STORED: Record<AwsPriceAsk, { awsUnit: string; unit: string; words: string }> = {
  instance: { awsUnit: "Hrs", unit: "1 Hour", words: "the instance" },
  gp3: { awsUnit: "GB-Mo", unit: "GB-Mo", words: "the gp3 disk" },
  ip: { awsUnit: "Hrs", unit: "1 Hour", words: "the public IPv4 address" },
};

interface GetProductsBody {
  ServiceCode: "AmazonEC2" | "AmazonVPC";
  FormatVersion: "aws_v1";
  MaxResults: number;
  Filters: { Type: "TERM_MATCH"; Field: string; Value: string }[];
}

const body = (fields: Record<string, string>, ServiceCode: GetProductsBody["ServiceCode"] = "AmazonEC2"): GetProductsBody => ({
  ServiceCode,
  FormatVersion: "aws_v1",
  MaxResults: 20,
  Filters: Object.entries(fields).map(([Field, Value]) => ({ Type: "TERM_MATCH", Field, Value })),
});

/** The GetProducts request body for each product (spec 4.6). */
export function awsPriceBodies(region: string, size: string): Record<AwsPriceAsk, GetProductsBody> {
  return {
    instance: body({ instanceType: size, regionCode: region, operatingSystem: "Linux", tenancy: "Shared", preInstalledSw: "NA", capacitystatus: "Used" }),
    gp3: body({ productFamily: "Storage", volumeApiName: "gp3", regionCode: region }),
    // The public IPv4 charge is listed under AmazonVPC, with no productFamily (checked live 2026-10-15).
    ip: body({ regionCode: region, group: "VPCPublicIPv4Address" }, "AmazonVPC"),
  };
}

/** The three answers, as AWS sent them. 3 calls. */
export async function fetchAwsPrices(ctx: AwsFeedCtx, region: string, size: string): Promise<Record<AwsPriceAsk, unknown>> {
  const bodies = awsPriceBodies(region, size);
  const ask = (k: AwsPriceAsk) => ctx.json<unknown>({ ...PRICING, body: bodies[k] });
  return { instance: await ask("instance"), gp3: await ask("gp3"), ip: await ask("ip") };
}

interface Product {
  attributes: Record<string, unknown>;
  /** The OnDemand USD prices in the wanted unit. */
  usd: number[];
}

/** Each PriceList entry parsed (it is a JSON string), with its OnDemand USD prices in `unit`; entries that aren't JSON are skipped. */
function products(reply: unknown, unit: string): Product[] {
  const list = (reply as { PriceList?: unknown })?.PriceList;
  if (!Array.isArray(list)) return [];
  const out: Product[] = [];
  for (const entry of list.slice(0, 100)) {
    let p: any;
    try {
      p = typeof entry === "string" ? JSON.parse(entry) : null;
    } catch {
      continue;
    }
    const attributes = p?.product?.attributes;
    if (!attributes || typeof attributes !== "object") continue;
    const usd: number[] = [];
    for (const term of Object.values<any>(p?.terms?.OnDemand ?? {})) {
      for (const dim of Object.values<any>(term?.priceDimensions ?? {})) {
        const v = num(dim?.pricePerUnit?.USD);
        if (dim?.unit === unit && v !== null && v >= 0) usd.push(v);
      }
    }
    out.push({ attributes, usd });
  }
  return out;
}

/** The one product's row: its highest OnDemand price (past any free tier) in GBP, or null. */
function rowOf(p: Product | undefined, item: string, ask: AwsPriceAsk, usdToGbp: number): PriceItem | null {
  if (!p || !p.usd.length) return null;
  const meter = str(p.attributes.usagetype, 80) ?? "";
  return { item, gbp: Math.max(...p.usd) * usdToGbp, unit: STORED[ask].unit, meter };
}

/**
 * The rows worth keeping from the three answers: `size` (per hour),
 * "disk:gp3" (per GB-month) and "ip:v4" (per hour, the in-use address), in
 * GBP. A product missing from its answer is left out.
 */
export function normaliseAwsPrices(replies: Partial<Record<AwsPriceAsk, unknown>>, size: string, usdToGbp: number): PriceItem[] {
  const priced = (ask: AwsPriceAsk) => products(replies[ask], STORED[ask].awsUnit).filter((p) => p.usd.length);
  const attr = (p: Product, k: string) => (typeof p.attributes[k] === "string" ? (p.attributes[k] as string) : "");
  const instance = priced("instance").find((p) => attr(p, "instanceType") === size && attr(p, "operatingSystem") === "Linux");
  const disk = priced("gp3").find((p) => attr(p, "volumeApiName") === "gp3");
  const ips = priced("ip").filter((p) => attr(p, "group") === "VPCPublicIPv4Address");
  const ip = ips.find((p) => /InUse/i.test(attr(p, "usagetype"))) ?? ips.find((p) => !/Idle/i.test(attr(p, "usagetype")));
  return [rowOf(instance, size, "instance", usdToGbp), rowOf(disk, "disk:gp3", "gp3", usdToGbp), rowOf(ip, "ip:v4", "ip", usdToGbp)].filter((r): r is PriceItem => r !== null);
}

export async function storeAwsPrices(db: D1Database, region: string, rows: PriceItem[], at: string): Promise<void> {
  if (!rows.length) return;
  await db.batch(
    rows.map((r) =>
      db
        .prepare("INSERT INTO aws_prices (region, item, gbp, unit, meter, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (region, item) DO UPDATE SET gbp = excluded.gbp, unit = excluded.unit, meter = excluded.meter, fetched_at = excluded.fetched_at")
        .bind(region, r.item, r.gbp, r.unit, r.meter, at),
    ),
  );
}

/** The stored AWS prices (of one region, or all), in the row shape readPrices answers for Azure. */
export async function readAwsPrices(db: D1Database, region?: string): Promise<PriceRow[]> {
  const q = region ? db.prepare("SELECT region, item, gbp, unit, fetched_at FROM aws_prices WHERE region = ?1").bind(region) : db.prepare("SELECT region, item, gbp, unit, fetched_at FROM aws_prices");
  return (await q.all<PriceRow>()).results;
}

/** Tidy float noise only, keeping every meaningful digit (as insights/price.ts). */
const round = (n: number) => Math.round(n * 1e12) / 1e12;

/**
 * The AWS list price for `size` in `region` from aws_prices rows (the same
 * row shape readPrices answers for az_prices): total = instance + gp3 × 8 GB
 * / 730 + IPv4; standby = gp3 × 8 / 730 + IPv4; stale after 7 days;
 * source "aws". With a price missing: the fixed AWS rates, with why.
 */
export function awsPriceInfo(rows: PriceRow[], cfg: Config, region: string, size: string, now: Date): PriceInfo {
  const of = (item: string, unit: string) => rows.find((r) => r.region === region && r.item === item && r.unit === unit && Number.isFinite(r.gbp));
  const parts = [of(size, "1 Hour"), of("disk:gp3", "GB-Mo"), of("ip:v4", "1 Hour")];
  const [vmRow, diskRow, ipRow] = parts;
  if (!vmRow || !diskRow || !ipRow) {
    const reason = `No AWS price for ${size} in ${awsRegionName(region)} yet, so the fixed rates apply.`;
    return { region, size, vmGbpPerHour: null, diskGbpPerHour: null, ipGbpPerHour: null, totalGbpPerHour: cfg.aws.hourlyRateGbp, standbyGbpPerHour: cfg.aws.standbyRateGbp, fetchedAt: null, stale: false, source: "fixed", reason };
  }
  const vm = vmRow.gbp;
  const disk = (diskRow.gbp * AWS_DISK_GB) / HOURS_PER_MONTH;
  const ip = ipRow.gbp;
  const oldest = parts.map((p) => p!.fetched_at).sort()[0]!;
  const stale = !(now.getTime() - Date.parse(oldest) <= PRICE_STALE_MS);
  return { region, size, vmGbpPerHour: round(vm), diskGbpPerHour: round(disk), ipGbpPerHour: round(ip), totalGbpPerHour: round(vm + disk + ip), standbyGbpPerHour: round(disk + ip), fetchedAt: oldest, stale, source: "aws", reason: null };
}

const prices: AwsFeed = {
  id: "aws.prices",
  title: "List prices",
  cadenceMin: 1440,
  when: "always",
  calls: 3,
  async run(ctx) {
    const region = ctx.region;
    const size = ctx.cfg.aws.instanceType;
    const rows = normaliseAwsPrices(await fetchAwsPrices(ctx, region, size), size, ctx.cfg.aws.usdToGbp);
    await storeAwsPrices(ctx.db, region, rows, ctx.now.toISOString());
    const have = new Set(rows.map((r) => r.item));
    const missing = (
      [
        [size, "instance"],
        ["disk:gp3", "gp3"],
        ["ip:v4", "ip"],
      ] as const
    ).filter(([item]) => !have.has(item));
    if (missing.length) return { status: "error", error: `AWS's price list had no price for ${missing.map(([, ask]) => (ask === "instance" ? size : STORED[ask].words)).join(", ")} in ${region}.` };
    return { status: "ok", error: null };
  },
};

export default prices;
