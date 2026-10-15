// insights/aws/feeds/housekeeping.ts
//
// Plain English: the daily tidy-up of what the AWS feeds keep, with Azure's
// retention (insights/feeds/housekeeping.ts). No outside calls.
//   - CloudWatch metric slots: 30 days.
//   - CloudTrail rows: 90 days.
//   - Status feed events: 90 days after their last update.
//   - Capacity readings and prices for a region not read in 30 days.
//   - The boot log: 7 days after the tear-down.
//   - The once-per-window markers (capacity-try:*, bootlog-try) after a day.
// Spec 2026-10-15-aws-insights-design.md, section 5.

import { DAY, iso, slotOf } from "../../common";
import type { AwsFeed } from "../types";

const housekeeping: AwsFeed = {
  id: "aws.housekeeping",
  title: "Housekeeping",
  cadenceMin: 1440,
  when: "always",
  calls: 0,
  async run(ctx) {
    const now = ctx.now.getTime();
    const db = ctx.db;
    const stmts = [
      db.prepare("DELETE FROM hist_aws_vm WHERE t < ?1").bind(slotOf(now - 30 * DAY)),
      db.prepare("DELETE FROM aws_activity WHERE at < ?1").bind(iso(now - 90 * DAY)),
      db.prepare("DELETE FROM aws_service_events WHERE updated_at < ?1").bind(iso(now - 90 * DAY)),
      db.prepare("DELETE FROM aws_capacity WHERE fetched_at < ?1").bind(iso(now - 30 * DAY)),
      db.prepare("DELETE FROM aws_prices WHERE fetched_at < ?1").bind(iso(now - 30 * DAY)),
      db.prepare("DELETE FROM aws_latest WHERE (key LIKE 'capacity-try:%' OR key = 'bootlog-try') AND updated_at < ?1").bind(iso(now - DAY)),
    ];
    const since = Date.parse(ctx.snap.since ?? "");
    if (ctx.snap.state === "destroyed" && Number.isFinite(since) && now - since > 7 * DAY) stmts.push(db.prepare("DELETE FROM aws_latest WHERE key = 'bootlog'"));
    await db.batch(stmts);
    return { status: "ok", error: null };
  },
};

export default housekeeping;
