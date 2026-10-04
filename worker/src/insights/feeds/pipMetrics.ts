// insights/feeds/pipMetrics.ts
//
// Plain English: Azure Monitor's platform metrics for pip-wg, the IPv4
// public IP (packets, bytes and SYNs at Azure's edge, DDoS mitigation, data
// path availability), one call every 5 minutes while the IP exists (running
// or Standby), into hist_az_pip. See metrics.ts.

import type { FeedModule } from "../runner";
import { paths } from "../common";
import { runMetrics } from "./metrics";

export { normaliseMetrics as normalisePipMetrics, storeMetrics } from "./metrics";

const pipMetrics: FeedModule = {
  id: "pipMetrics",
  title: "Public IP metrics",
  cadenceMin: 5,
  when: "vm",
  calls: 1,
  arm: true,
  async run(ctx) {
    await runMetrics(ctx, "pip", paths(ctx.env, ctx.cfg).pip);
    return { status: "ok", error: null };
  },
};

export default pipMetrics;
