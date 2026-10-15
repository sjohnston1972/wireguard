// insights/aws/feeds/labPrices.ts
//
// Plain English: AWS's list prices for what AWS labs run (AWS labs spec §6
// Prices). Every cost item of an AWS lab in the catalogue may name its price
// (lab.yaml aws_price: a Price List service code, a unit and the attribute
// filters that pick exactly one product). Each distinct reference is asked
// for in each region it is used: the session's region, or the lab's
// secondary region for a `region: secondary` item. The session region here
// is London (AWS_LAB_REGIONS[0]), where the estimate reads it. The answer is kept in
// aws_prices under awsPriceKey(ref) ("lab:" + 16 hex), in GBP at
// config.aws.usdToGbp, and the Labs tab's estimate uses it while it is under
// 7 days old (labs/prices.ts).
//
// Every 60 minutes, at most 5 GetProducts calls a run: the references with
// no row first, then the oldest, and only those older than 3 days, so the
// whole list is kept fresh a few at a time inside the shared run budget. A
// reference must match exactly one product with an OnDemand USD price in its
// unit; none or several store nothing (the authored figure stays) and the
// feed reads error, naming each one. USD list prices before any free tier,
// credits or VAT.

import { AWS_LAB_REGIONS, awsPriceKey, awsUsagePrefix, type AwsPriceRef, type LabDef } from "../../../../../shared/labs";
import { catalogue } from "../../../labs/catalogue";
import { str } from "../../common";
import type { PriceItem } from "../../feeds/prices";
import type { AwsFeed } from "../types";
import { products, readAwsPrices, storeAwsPrices } from "./prices";

/** One reference to ask for: its aws_prices item, the region and the reference itself. */
export interface AwsPriceAskRow {
  item: string;
  region: string;
  ref: AwsPriceRef;
}

/** A lab price row is refreshed once it is older than this. */
export const LAB_PRICE_REFRESH_MS = 3 * 86_400_000;
/** At most this many GetProducts calls a run. */
const MAX_ASKS = 5;
/** The Price List API answers in us-east-1, for every region. */
const PRICING = { service: "pricing", region: "us-east-1", host: "api.pricing.us-east-1.amazonaws.com", target: "AWSPriceListService.GetProducts" } as const;

/** Every distinct (item, region) the AWS labs price: each aws_price at the session region, or at the lab's secondary region for `region: "secondary"` items. */
export function labPriceAsks(labs: readonly LabDef[], sessionRegion: string): AwsPriceAskRow[] {
  const out = new Map<string, AwsPriceAskRow>();
  for (const lab of labs) {
    if (lab.cloud !== "aws") continue;
    for (const i of lab.cost.items) {
      if (!i.aws_price) continue;
      const region = i.region === "secondary" ? lab.regions.secondary : sessionRegion;
      if (!region) continue;
      const item = awsPriceKey(i.aws_price);
      out.set(`${item}|${region}`, { item, region, ref: i.aws_price });
    }
  }
  return [...out.values()];
}

/** The GetProducts request for a reference in a region: its filters ({usage} in a usagetype filled with the region's prefix) plus regionCode, TERM_MATCH each. */
export function labPriceBody(ref: AwsPriceRef, region: string): { ServiceCode: string; FormatVersion: "aws_v1"; MaxResults: number; Filters: { Type: "TERM_MATCH"; Field: string; Value: string }[] } {
  const filters = Object.entries(ref.filters).map(([Field, v]) => ({ Type: "TERM_MATCH" as const, Field, Value: Field === "usagetype" && v.includes("{usage}") ? v.replace(/\{usage\}/g, awsUsagePrefix(region)) : v }));
  return { ServiceCode: ref.service, FormatVersion: "aws_v1", MaxResults: 100, Filters: [...filters, { Type: "TERM_MATCH", Field: "regionCode", Value: region }] };
}

const labPrices: AwsFeed = {
  id: "aws.labPrices",
  title: "Lab list prices",
  cadenceMin: 60,
  when: "always",
  calls: MAX_ASKS,
  async run(ctx) {
    // London, the region labs/prices.ts prices AWS labs at (AWS_LAB_REGIONS[0]), so the rows stored are the rows
    // read, whatever AWS_REGION says (and a region with no known usage-type prefix is never asked for).
    const asks = labPriceAsks(catalogue().labs, AWS_LAB_REGIONS[0]);
    const fetched = new Map((await readAwsPrices(ctx.db)).filter((r) => r.item.startsWith("lab:")).map((r) => [`${r.item}|${r.region}`, r.fetched_at]));
    const now = ctx.now.getTime();
    // Missing first (age Infinity), then the oldest; only those due.
    const due = asks
      .map((a) => {
        const at = Date.parse(fetched.get(`${a.item}|${a.region}`) ?? "");
        return { a, age: Number.isFinite(at) ? now - at : Infinity };
      })
      .filter((x) => x.age > LAB_PRICE_REFRESH_MS)
      .sort((x, y) => y.age - x.age)
      .slice(0, MAX_ASKS);
    const problems: string[] = [];
    const at = ctx.now.toISOString();
    for (const { a } of due) {
      let body: ReturnType<typeof labPriceBody>;
      try {
        body = labPriceBody(a.ref, a.region);
      } catch {
        problems.push(`${a.item} in ${a.region}: no usage-type prefix known for the region`);
        continue;
      }
      const reply = await ctx.json<unknown>({ ...PRICING, body });
      const priced = products(reply, a.ref.unit).filter((p) => p.usd.length);
      if (priced.length !== 1) {
        problems.push(`${a.item} in ${a.region}: ${priced.length} products`);
        continue;
      }
      const p = priced[0]!;
      // The highest OnDemand price: past any free tier.
      const row: PriceItem = { item: a.item, gbp: Math.max(...p.usd) * ctx.cfg.aws.usdToGbp, unit: a.ref.unit, meter: str(p.attributes.usagetype, 80) ?? "" };
      await storeAwsPrices(ctx.db, a.region, [row], at);
    }
    if (problems.length) return { status: "error", error: `AWS's price list did not give exactly one product for ${problems.join("; ")}.` };
    return { status: "ok", error: null };
  },
};

export default labPrices;
