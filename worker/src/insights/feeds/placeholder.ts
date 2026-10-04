// insights/feeds/placeholder.ts
//
// Plain English: a feed that is declared but not built yet. It records an
// error and makes no outside call. Replaced feed by feed.

import type { FeedModule } from "../runner";
import type { InsightsFeedId, FeedWhen } from "../types";
import { FEEDS } from "../../../../shared/azureMetrics";

export function placeholder(id: InsightsFeedId, when: FeedWhen, calls: number, arm: boolean): FeedModule {
  const info = FEEDS.find((f) => f.id === id);
  return {
    id,
    title: info?.title ?? "Housekeeping",
    cadenceMin: info ? info.cadenceMin : 1440,
    when,
    calls,
    arm,
    async run() {
      return { status: "error", error: "Not built yet." };
    },
  };
}
