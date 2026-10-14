// insights/aws/feeds/prices.ts
//
// Plain English: AWS's list prices for what cloudlabs runs in AWS: the
// instance type per hour, the gp3 disk per GB-month and the public IPv4
// address per hour (the Price List API, GetProducts, in us-east-1), converted
// to GBP with config.aws.usdToGbp and stored in aws_prices; and awsPriceInfo,
// which turns them into Settings' AWS list price line (SettingsResponse.awsPrice).
// Spec 2026-10-15-aws-insights-design.md, section 4.6.
//
// A stub until its task builds it (AWS insights plan, Task 4): the contract
// (id, cadence, when, calls) and awsPriceInfo's signature are final; run()
// answers "Not built yet." and awsPriceInfo throws.

import type { Config } from "../../../env";
import type { PriceInfo } from "../../../../../shared/api";
import type { PriceRow } from "../../price";
import type { AwsFeed } from "../types";

/**
 * The AWS list price for `size` in `region` from aws_prices rows (the same
 * row shape readPrices answers for az_prices): total = instance + gp3 × 8 GB
 * / 730 + IPv4; standby = gp3 × 8 / 730 + IPv4; stale after 7 days;
 * source "aws".
 */
export function awsPriceInfo(rows: PriceRow[], cfg: Config, region: string, size: string, now: Date): PriceInfo {
  void rows;
  void cfg;
  void region;
  void size;
  void now;
  throw new Error("Not built yet.");
}

const prices: AwsFeed = {
  id: "aws.prices",
  title: "List prices",
  cadenceMin: 1440,
  when: "always",
  calls: 3,
  async run() {
    return { status: "error", error: "Not built yet." };
  },
};

export default prices;
