// cloud/awsCost.ts
//
// Plain English: what AWS billed for everything tagged wg-admin=vpn, per day,
// month to date (reaching back into last month for the first 3 days, as the
// Azure pull does). Cost Explorer charges about 1p a question, so the watchman
// asks once a day. It needs the wg-admin tag activated as a cost allocation
// tag; until then it simply answers zero.

import type { Env } from "../env";
import { costTimeframe } from "../azure";
import { awsJson } from "./awsApi";

export async function awsCostMonthToDate(env: Env, now = new Date()): Promise<{ day: string; usd: number }[]> {
  const tf = costTimeframe(now);
  const start = tf.timeframe === "MonthToDate" ? `${now.toISOString().slice(0, 7)}-01` : tf.timePeriod.from.slice(0, 10);
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10); // exclusive
  const r = await awsJson<{ ResultsByTime?: { TimePeriod: { Start: string }; Total?: { UnblendedCost?: { Amount: string } } }[] }>(env, {
    service: "ce",
    region: "us-east-1",
    host: "ce.us-east-1.amazonaws.com",
    target: "AWSInsightsIndexService.GetCostAndUsage",
    body: { TimePeriod: { Start: start, End: end }, Granularity: "DAILY", Metrics: ["UnblendedCost"], Filter: { Tags: { Key: "wg-admin", Values: ["vpn"] } } },
  });
  return (r.ResultsByTime ?? []).map((x) => ({ day: x.TimePeriod.Start, usd: Number(x.Total?.UnblendedCost?.Amount ?? 0) || 0 }));
}
