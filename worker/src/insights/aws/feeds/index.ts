// insights/aws/feeds/index.ts
//
// Plain English: every AWS feed, in the runner's priority order (AWS insights
// spec section 4): the server's own feeds first (health, metrics), then the
// change log, the region's status, capacity and prices, the boot log, and
// the daily prune last.

import type { AwsFeed } from "../types";
import health from "./health";
import metrics from "./metrics";
import activity from "./activity";
import serviceHealth from "./serviceHealth";
import capacity from "./capacity";
import prices from "./prices";
import bootLog from "./bootLog";
import housekeeping from "./housekeeping";

export const AWS_FEED_MODULES: readonly AwsFeed[] = [health, metrics, activity, serviceHealth, capacity, prices, bootLog, housekeeping];
