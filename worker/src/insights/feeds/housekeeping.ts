// insights/feeds/housekeeping.ts
//
// Plain English: the daily tidy-up of what the collector keeps (spec 6). No
// outside calls.
//   - Azure metric slots: 30 days.
//   - Activity Log rows: 90 days, as Azure keeps them.
//   - Service Health events: 90 days after their last update.
//   - Capacity readings and prices for a region not read in 30 days (a
//     region no longer in use); a price under that age stays, even stale,
//     because it explains why the fixed rates apply.
//   - The boot log: 7 days after the tear-down.
//   - The once-per-window markers (capacity-try:*, bootlog-try) after a day.

import type { FeedModule } from "../runner";
import { DAY, iso, slotOf } from "../common";

const housekeeping: FeedModule = {
  id: "housekeeping",
  title: "Housekeeping",
  cadenceMin: 1440,
  when: "always",
  calls: 0,
  arm: false,
  async run(ctx) {
    const now = ctx.now.getTime();
    const db = ctx.db;
    const stmts = [
      db.prepare("DELETE FROM hist_az_vm WHERE t < ?1").bind(slotOf(now - 30 * DAY)),
      db.prepare("DELETE FROM hist_az_pip WHERE t < ?1").bind(slotOf(now - 30 * DAY)),
      db.prepare("DELETE FROM az_activity WHERE at < ?1").bind(iso(now - 90 * DAY)),
      db.prepare("DELETE FROM az_service_events WHERE updated_at < ?1").bind(iso(now - 90 * DAY)),
      db.prepare("DELETE FROM az_capacity WHERE fetched_at < ?1").bind(iso(now - 30 * DAY)),
      db.prepare("DELETE FROM az_prices WHERE fetched_at < ?1").bind(iso(now - 30 * DAY)),
      db.prepare("DELETE FROM az_latest WHERE (key LIKE 'capacity-try:%' OR key = 'bootlog-try') AND updated_at < ?1").bind(iso(now - DAY)),
    ];
    const since = Date.parse(ctx.snap.since ?? "");
    if (ctx.snap.state === "destroyed" && Number.isFinite(since) && now - since > 7 * DAY) stmts.push(db.prepare("DELETE FROM az_latest WHERE key = 'bootlog'"));
    await db.batch(stmts);
    return { status: "ok", error: null };
  },
};

export default housekeeping;
